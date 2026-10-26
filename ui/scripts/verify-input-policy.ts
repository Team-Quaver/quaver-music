// 「全局输入治理」的静态断言：中键不许跳转/开新窗 + 鼠标点击不留焦点
//
// 桌面客户端的输入口径收在两处：
//   • 主进程 electron/main.ts：setWindowOpenHandler 一律拒绝新窗口（中键/Ctrl+点击
//     链接、window.open、target=_blank 的共同来源），will-navigate 拦下离开应用
//     origin 的顶层导航 —— 应用内只剩 hash 路由与同 origin 整页跳转两条正路。
//   • 渲染层 src/main.ts：中键在链接上就地拦（浏览器 dev 态没有主进程兜底），
//     左键按下按钮类元素不转移焦点（否则空格键会被焦点按钮吞掉 —— 将来空格=暂停、
//     回车=导航确认都建立在焦点不被鼠标点击偷走之上）。
// 口径只许在这一处，不许在业务组件里再长出第二份。反向断言盯住两条底线：
// 输入类控件不得进「焦点抑制」的选择器（搜索框要打字、音量条靠 activeElement 判键控），
// 渲染层不许出现 window.open（开新窗口在本应用没有合法场景）。
//
// 用法：node scripts/verify-input-policy.ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

let fails = 0;
let checks = 0;

const ok = (name, cond, note = "") => {
  checks++;

  if (cond) console.log(`PASS ${name}${note ? " — " + note : ""}`);
  else { fails++; console.log(`FAIL ${name}${note ? " — " + note : ""}`); }
};

// 去注释后的源码（正则断言只看代码，不看注释里的字面示例）
const plain = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const mainMjs = plain(read("electron/main.ts"));
const mainTs = plain(read("src/main.ts"));
const nativeDrop = plain(read("src/components/NativeDrop.ts"));

// —— 主进程：关死浏览器式全局导航 ——
ok("main.ts: setWindowOpenHandler 一律拒绝（新窗口没有合法场景）",
  /setWindowOpenHandler\(/.test(mainMjs) && /action:\s*"deny"/.test(mainMjs));

ok("main.ts: will-navigate 有拦（preventDefault），离开应用 origin 的顶层导航不许走",
  /will-navigate/.test(mainMjs) && /e\.preventDefault\(\)/.test(mainMjs));

ok("main.ts: 同 origin 顶层导航放行（登录流程 location.href='/login.html' 要能用）",
  /origin === appOrigin/.test(mainMjs));

// —— 渲染层：焦点不被鼠标点击偷走 ——
ok("main.ts: Tab 遍历仍被全局拦下（焦点治理的既有底线，不许回退）",
  /e\.key === "Tab"/.test(mainTs));

ok("main.ts: 左键按下按钮类元素不转移焦点（button / [role=button] / a）",
  /e\.button === 0 && interactive\(e\.target\)\) e\.preventDefault\(\)/.test(mainTs)
  && /closest\("button, \[role=\\"button\\"\], a"\)/.test(mainTs));

ok("main.ts: 焦点抑制的选择器不含输入类控件（input/textarea/select 要能拿焦点打字）",
  !/closest\("[^"]*(input|textarea|select)/.test(mainTs));

// —— 渲染层：中键就地拦（浏览器 dev 态兜底）——
ok("main.ts: 中键 mousedown 在链接上拦掉（自动滚动起点 + 开新窗的按下阶段）",
  /e\.button === 1 && linkish\(e\.target\)\) e\.preventDefault\(\)/.test(mainTs));

ok("main.ts: auxclick 兜底拦掉中键「新窗口打开」缺省动作",
  /auxclick/.test(mainTs) && /e\.button === 1/.test(mainTs));

ok("main.ts: 渲染层不出现 window.open（Electron 侧 deny-all，dev 态也不许开新窗）",
  !/window\.open\(/.test(mainTs));

// —— 自绘下拉必须压过触发它的模态窗 ——
// EQ / 更新弹窗分别是 84 / 85，而普通右键菜单层是 80。下拉如果固定 80，
// 在模态里会「看得见 select，却看不到弹层」，表现就是预设点了没反应。
ok("NativeDrop: 下拉层按触发 select 的祖先 z-index 动态抬层（不写死 80）",
  /function overlayZFor\(el: HTMLElement\): number/.test(nativeDrop)
  && /getComputedStyle\(node\)\.zIndex/.test(nativeDrop)
  && /layer\.style\.zIndex = String\(overlayZFor\(sel\)\)/.test(nativeDrop));

// —— 自绘 Tooltip 的命中必须从任意 Element 向上找宿主 ——
// SVGElement 不是 HTMLElement：沿用 `instanceof HTMLElement` 时，指针落在图标 <svg>/<path>
// 上会命不中，落在按钮留白里才中 —— 同一排按钮就表现成「Tooltip 随机出现」。
ok("NativeDrop: Tooltip 命中从 Element 向上找宿主（图标 <svg>/<path> 也算悬停）",
  /function tooltipHostOf\(el: Element \| null\): HTMLElement \| null/.test(nativeDrop)
  && /el\?\.closest<HTMLElement>\("\[data-tooltip\]"\)/.test(nativeDrop)
  && /e instanceof Element \? tooltipHostOf\(e\)/.test(nativeDrop)
  && /return tooltipHostOf\(raw\)/.test(nativeDrop)
  && !/raw instanceof HTMLElement \? raw\.closest/.test(nativeDrop));

ok("NativeDrop: 桌面歌词独立页也启动同一套 Tooltip（不再只有原生 title）",
  /bootNativeOverlays\(\)/.test(read("src/desktop-lyrics.ts"))
  && /from "\.\/components\/NativeDrop"/.test(read("src/desktop-lyrics.ts")));

ok("Playback controls: 画廊/桌面歌词/队列/上一首都有自绘提示源",
  /id="pb-gallery" title="画廊模式"/.test(read("src/components/PlayerBar.ts"))
  && /const galleryTip = galleryOn \? "退出画廊模式"/.test(read("src/components/PlayerBar.ts"))
  && /id="pb-dl" title="桌面歌词"/.test(read("src/components/PlayerBar.ts"))
  && /id="pb-queue" title="播放队列"/.test(read("src/components/PlayerBar.ts"))
  && /prev\.dataset\.tooltip = canPrev \? "上一首"/.test(read("src/components/PlayerBar.ts")));

console.log(`\n${checks - fails}/${checks} passed${fails ? ` — ${fails} FAILED` : ""}`);

process.exit(fails ? 1 : 0);
