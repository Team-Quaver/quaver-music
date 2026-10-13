// Quaver — 应用页面的 Content-Security-Policy（策略文本 + 注入方式，唯一真相）
//
// 为什么由主进程贴响应头，而不是每个 html 写 <meta>：
//   1. 页面有 8 个入口，且由两套服务端交付（打包态 native-server.ts、开发态 vite preview/dev
//      + relay.ts）；meta 要抄 8 份，还管不到插件运行期动态 import 进来的脚本。主进程在
//      session 的 webRequest 上统一贴，一处改动全站生效。
//   2. 顺带停掉 Electron 的安全警告：非打包态只要「页面没有 CSP」或「CSP 里有 unsafe-eval」，
//      Electron 就朝控制台刷一条 `Electron Security Warning (Insecure Content-Security-Policy)`
//      （`pnpm run app` 时 [renderer:warning] 那两行就是它）。这条策略两样都不占 —— 是靠
//      **真的有一条 CSP** 消掉的，不是 ELECTRON_DISABLE_SECURITY_WARNINGS 静音。
//
// 姿态：**网络放开、脚本收紧**。这是个插件宿主 —— 第三方音源直链、封面外链、插件自己的
// API 请求都发生在同一张页面上，把 connect/img/media 钉死在本机 origin 等于把生态打死。
// 真正要管的是「页面里的代码是从哪儿来的」：
//   • script-src 只有同源 + blob:，**不开 unsafe-inline / unsafe-eval**
//       - 同源 = 构建产物，以及 /api/sparkle/plugin/<id>/<file>（第三方插件按磁盘文件走
//         同源 URL 动态 import，SDK 不承认「字符串求值」那种写法）；
//       - blob: 只服务于「装本地插件前先执行一遍、读它的 default export 元数据」
//         （src/sparkle/settings.ts 的 installLocalFlow），那段代码本来就要跑，
//         换成内联或 data: 并不会更安全；
//       - 于是 innerHTML 里混进来的 <script>、onclick="…"、eval(...) 一律失效：曲名/歌手名/
//         插件返回的文本这类不可信内容，即使哪天漏了转义也升不成代码（转义照旧是必须的，
//         这条只是兜底）。
//     页面里剩下的唯一脚本入口是「薄跳转层」，已挪成外链 public/redirect.js ——
//     留在 html 里的内联 <script> 在这条策略下会被直接拦掉，跳转层就哑了。
//   • style-src 需要 'unsafe-inline'：Sparkle 主题/插件运行期注入 <style> 与内联 style 属性
//     （views.ts 与各插件的 innerHTML 里都有 style="…"）。样式不是代码，放开不影响上一条。
//   • object-src 'none' / frame-ancestors 'none' / base-uri 'self' / form-action 'self'：
//     没有 plugin/iframe/表单的使用场景，全关 —— 把本窗嵌进别人的页面 = 拿歌词与封面当钓鱼画布。
// 验证：node scripts/verify-csp.ts（策略文本 + 跳转层无内联脚本残留 + 主进程确实挂了钩子）。
// 加/改指令前先想清楚对应功能还走不走得通，别只为了让警告闭嘴往 script-src 塞 unsafe-*。

/** 逐条指令（顺序即输出顺序；拆开成数组是为了 verify 能逐条点名断言） */
export const APP_CSP_DIRECTIVES: string[] = [
  "default-src 'self'",
  "script-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https: http:",
  "font-src 'self' data:",
  // connect：应用自己的流量全走同源 /api/*（含更新检查的中继）+ 本机其它端口
  // （vite dev 的 HMR 与 QUAVER_URL 指向的 dev server 都可能是另一个端口）；远端只为了
  // **插件**那两条口子（GitHub  releases 探测、第三方音源的取头字节探测 streaminfo）。
  // 与 media-src 同宽（音源直链可能是 http）：探测被拦只会降级成「未知采样率」，
  // 但既然播放本身允许这个 URL，没道理让探测差别待。
  "connect-src 'self' blob: https: http: ws://127.0.0.1:* ws://localhost:*",
  // media：<audio> 的播放流。官方链路是同源 /api/stream/…，但 SDK 明确允许插件交出
  // 可直接挂给播放器的绝对 URL（SparkleStreamResult.url），开发态的 fake-audio 还用 data: 占位
  "media-src 'self' blob: data: https: http:",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
];

/** 最终头值（Chromium 认 `;` 分隔的常规 CSP 序列） */
export const APP_CSP = APP_CSP_DIRECTIVES.join("; ");

type HeaderBag = Record<string, string[]>;

/** 只用到的那一个方法按结构声明（不 import electron：本模块要能被裸 node 载入做单测） */
export interface SessionLike {
  webRequest: {
    onHeadersReceived(
      filters: { urls: string[] },
      listener: (
        details: { url: string; responseHeaders?: HeaderBag },
        callback: (result: { responseHeaders?: HeaderBag }) => void,
      ) => void,
    ): void;
  };
}

/**
 * 给「应用自己 origin」的响应贴 CSP，其余原样放过。
 * 既有的 CSP 头（若有）先剔掉再贴：两份策略同时存在时浏览器取交集，留着旧的那份只会更难查。
 */
export function cspHeadersFor(url: string, appOrigin: string, responseHeaders?: HeaderBag): HeaderBag | undefined {
  let sameOrigin = false;
  try {
    sameOrigin = new URL(url).origin === appOrigin;
  } catch {
    sameOrigin = false;
  }
  if (!sameOrigin) return responseHeaders;
  const out: HeaderBag = {};
  for (const [key, value] of Object.entries(responseHeaders ?? {})) {
    if (key.toLowerCase() !== "content-security-policy") out[key] = value;
  }
  out["Content-Security-Policy"] = [APP_CSP];
  return out;
}

/**
 * 挂钩子。返回 false = 没挂上（不是错误：file:// 之类没有 HTTP 响应头可贴），
 * 调用方照常启动 —— CSP 缺失是安全姿态的降级，不该把应用锁死在启动画面。
 */
export function installAppCsp(session: SessionLike, appOrigin: string, log: (msg: string, ...rest: unknown[]) => void = () => {}): boolean {
  if (!session) { log("[quaver] CSP 未挂：拿不到 session"); return false; }
  if (!session.webRequest) { log("[quaver] CSP 未挂：session.webRequest 不可用"); return false; }
  if (!/^https?:\/\/[^/]+$/.test(appOrigin)) { log("[quaver] CSP 未挂：origin 不是纯 http(s) 源 =", appOrigin); return false; }
  session.webRequest.onHeadersReceived({ urls: [`${appOrigin}/*`] }, (details, callback) => {
    callback({ responseHeaders: cspHeadersFor(details.url, appOrigin, details.responseHeaders) });
  });
  log("[quaver] CSP 已挂到", appOrigin);
  return true;
}
