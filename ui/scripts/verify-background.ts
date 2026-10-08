// Quaver — 默认主题「背景」功能（关闭背景 / 专辑封面 / 自定义图片 + 模糊强度）的护栏。
// 跑：  node scripts/verify-background.ts
//
// 两头抓：
//   • 读盘侧（electron/background.ts）纯逻辑 + 一条真 HTTP 端到端：路径只认 quaver.conf、
//     扩展名白名单、普通文件与体积上限，四种不可用情形各自的状态码；顺带跑一遍打包态的
//     真服务（native-server.ts），确认 /api/bg 真的把图吐出来了。
//   • 源码级接线断言：三档 UI 与滑块区间、/api/bg 在 dev 与打包态都接上、背景层不再由 shell
//     硬编码、CSS 三档规则齐全；尤其**背景图路径绝不允许从渲染层来**（本功能唯一的开放文件
//     读取风险面），以及「模糊强度不得退回写死值」这类回潮。
//
// 反向断言（readXxx 在变异样本上必须为 false）是防「断言自己写错、永远为真」——本仓库踩过
// 一次 verify 脚本自毁（断言读源码文本做正则，被批量替换打坏后静默变绿）。
import { closeSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BG_DIALOG_EXTENSIONS, BACKGROUND_MAX_BYTES, backgroundInfo, backgroundMime, backgroundPath, backgroundResponse } from "../electron/background.ts";
import { BG_IMAGE_EXTS, configFile, defaults, writeValues } from "../electron/config.ts";
import { startQuaverServer } from "../electron/native-server.ts";

let pass = 0, fail = 0;
const section = (t) => console.log(`\n=== ${t} ===`);
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const UI = fileURLToPath(new URL("..", import.meta.url));
const src = (rel: string) => readFileSync(join(UI, rel), "utf8");
/** 从 needle 处往后截一段：用来把「这条路由/这个处理器」的代码单独拎出来断言。 */
const after = (s: string, needle: string, n = 700) => {
  const i = s.indexOf(needle);
  return i < 0 ? "" : s.slice(i, i + n);
};

const ROOT = mkdtempSync(join(tmpdir(), "quaver-bg-"));
const DIR = join(ROOT, "Quaver Music");
// 素材：读盘侧不做图像解码，所以内容随便写；扩展名与文件类型才是被校验的东西
const PNG = join(ROOT, "wall.png");
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
writeFileSync(PNG, PNG_BYTES);
const JPG_UPPER = join(ROOT, "UP.JPG");
writeFileSync(JPG_UPPER, PNG_BYTES);
const TXT = join(ROOT, "notes.txt");
writeFileSync(TXT, "nope");
const AS_DIR = join(ROOT, "looks-like.png");
mkdirSync(AS_DIR);
// 超限图：稀疏文件（ftruncate 只写 i_size）——不必真占 40MB，也不占用 /tmp 那块 10MB 的 tmpfs
const HUGE = join(ROOT, "huge.png");
{
  const fd = openSync(HUGE, "w");
  ftruncateSync(fd, BACKGROUND_MAX_BYTES + 1);
  closeSync(fd);
}
const GONE = join(ROOT, "moved-away.jpg");

const envIn = (dir: string) => ({ QUAVER_CONFIG_DIR: dir });

// ——— 扩展名 → mime（白名单是「不许读别的文件」的第一道闸）———
section("扩展名白名单 → mime");
eq("jpg", backgroundMime("/x/a.jpg"), "image/jpeg");
eq("jpeg 大小写不敏感", backgroundMime("/x/a.JPEG"), "image/jpeg");
eq("png", backgroundMime("a.png"), "image/png");
eq("webp", backgroundMime("a.webp"), "image/webp");
eq("gif", backgroundMime("a.gif"), "image/gif");
eq("bmp", backgroundMime("a.bmp"), "image/bmp");
eq("avif", backgroundMime("a.avif"), "image/avif");
eq("txt 不给 mime", backgroundMime("secret.txt"), null);
eq("无扩展名不给 mime（/etc/passwd 这类）", backgroundMime("/etc/passwd"), null);
eq("双扩展名只看最后一个", backgroundMime("a.jpg.txt"), null);
eq("空值不给 mime", backgroundMime(""), null);
check("对话框过滤器与 schema 白名单同源（不许各写一份）",
  JSON.stringify(BG_DIALOG_EXTENSIONS) === JSON.stringify([...BG_IMAGE_EXTS]), JSON.stringify(BG_DIALOG_EXTENSIONS));

// ——— 路径只来自 quaver.conf ———
section("路径只来自 quaver.conf");
eq("配置目录里还没有配置文件 → 空路径", backgroundPath(envIn(join(ROOT, "noconf"))), "");
check("而且一条只读请求不会顺手把配置模板写出来",
  !existsSync(configFile(envIn(join(ROOT, "noconf")))));
eq("没有配置文件时响应 404", backgroundResponse(envIn(join(ROOT, "noconf"))).status, 404);

process.env.QUAVER_CONFIG_DIR = DIR;
eq("默认（未选图）→ 空路径", backgroundPath(), "");
eq("默认 → 404", backgroundResponse().status, 404);
eq("写入路径后读得回来", (writeValues({ "Style.BackgroundImage": PNG }), backgroundPath()), PNG);
eq("读了配置就会落一份模板（正常路径）", existsSync(configFile()), true);

// ——— 四种不可用情形 ———
section("不可用情形各自的状态码");
eq("正常图片 → 200", backgroundResponse().status, 200);
eq("正常图片 → mime 按扩展名", backgroundResponse().type, "image/png");
check("正常图片 → 字节原样吐出", backgroundResponse().body.equals(PNG_BYTES));
check("正常图片 → info.exists", backgroundInfo().exists === true);

writeValues({ "Style.BackgroundImage": JPG_UPPER });
eq("大写扩展名也认（按扩展名给小写 mime）", backgroundResponse().type, "image/jpeg");

writeValues({ "Style.BackgroundImage": TXT });
eq("非图片扩展名 → 404", backgroundResponse().status, 404);
check("非图片扩展名 → 说清原因", /格式/.test(backgroundInfo().error ?? ""), backgroundInfo().error);
check("非图片扩展名 → exists=false", backgroundInfo().exists === false);

writeValues({ "Style.BackgroundImage": AS_DIR });
check("目录冒充图片 → 不当普通文件", /普通文件/.test(backgroundInfo().error ?? ""), backgroundInfo().error);
eq("目录冒充图片 → 404", backgroundResponse().status, 404);

writeValues({ "Style.BackgroundImage": HUGE });
check("超过体积上限 → 拒绝（不然一次请求就能把主进程读爆）",
  /MB/.test(backgroundInfo().error ?? ""), backgroundInfo().error);
eq("超限 → 404", backgroundResponse().status, 404);

writeValues({ "Style.BackgroundImage": GONE });
check("文件被挪走 → 提示不可用", /不存在/.test(backgroundInfo().error ?? ""), backgroundInfo().error);
eq("文件被挪走 → 404（界面侧据此提示重选）", backgroundResponse().status, 404);

writeValues({ "Style.BackgroundImage": "" });
eq("清空 → 回到未设置（404）", backgroundResponse().status, 404);
writeValues({ "Style.BackgroundImage": PNG });

// ——— 端到端：打包态的真服务 ———
section("端到端（native-server 的 /api/bg）");
{
  const s = await startQuaverServer({ dist: join(ROOT, "dist"), port: 0 });
  try {
    const ok = await fetch(new URL("/api/bg", s.url));
    eq("GET /api/bg → 200", ok.status, 200);
    eq("content-type 是图片", ok.headers.get("content-type"), "image/png");
    eq("不带缓存（换图后同 URL 也要拿到新的）", ok.headers.get("cache-control"), "no-store");
    check("body 是那张图", Buffer.from(await ok.arrayBuffer()).equals(PNG_BYTES));

    // query 只当缓存击穿用：**不能**用它指定读哪个文件（否则就是开放文件读取）
    const evil = await fetch(new URL("/api/bg?u=" + encodeURIComponent(TXT), s.url));
    check("带参数也不换文件（仍是配置里那张图）", evil.status === 200 && Buffer.from(await evil.arrayBuffer()).equals(PNG_BYTES));

    writeValues({ "Style.BackgroundImage": TXT });
    const bad = await fetch(new URL("/api/bg", s.url));
    eq("配置成非图片 → 404", bad.status, 404);
    writeValues({ "Style.BackgroundImage": PNG });
  } finally {
    s.close();
  }
}

// ——— 源码护栏 · 渲染层 ———
section("源码护栏 · 渲染层");
const ambient = src("src/lib/ambient.ts");
const views = src("src/views.ts");
const css = src("src/style.css");
const shell = src("src/shell.ts");

const bgBlock = /id="bg-cards"([\s\S]*?)<\/div>/.exec(views)?.[1] ?? "";
check("背景分组能取到（防正则失配让下面全绿）", bgBlock.length > 50, String(bgBlock.length));
check("三档卡片齐全", ["off", "cover", "custom"].every((m) => bgBlock.includes(`data-opt="${m}"`)), bgBlock.replace(/\s+/g, " ").slice(0, 160));
check("「选择图片…」就在自定义卡片旁边（同一个选项卡组里，不是另起一行）",
  bgBlock.includes('id="bg-pick"') && bgBlock.indexOf('data-opt="custom"') < bgBlock.indexOf('id="bg-pick"'));
check("选图按钮只在自定义档出现", views.includes("bgPick.hidden = !isCustom"));
check("滑块区间用常量插值（改区间不会只改一半）", views.includes('min="${BG_BLUR_MIN}" max="${BG_BLUR_MAX}"'));
check("关闭背景时滑块禁用（有背景才谈得上模糊）", views.includes('bgBlur.disabled = mode === "off"'));
check("选「自定义」但还没有图 → 直接弹选图，不落进空状态",
  views.includes('next === "custom" && !getBackgroundImage() && !(await pickBgImage())'));
check("背景三处改动都即时生效（applyBackground）", (views.match(/applyBackground\(\)/g) ?? []).length >= 4);
check("图片文件现状问主进程（渲染层看不到磁盘）", views.includes("bgBridge.info()"));
check("没有桥（浏览器 dev）时给提示，不静默失败", /bgBridge\?\.pick \? BG_HINT/.test(views));

check("背景层由 ambient 模块建", /className = "ambient"/.test(ambient));
check("shell 只留界面染色（不再自己建环境层）", !/className = "ambient"/.test(shell) && !/ambient-art/.test(shell));
check("shell 启动时拉起背景层", /^\s*bootBackground\(\);$/m.test(shell));
check("换曲跟着换图", /player\.on\(applyBackground\)/.test(ambient));
check("模式写在 data-mode 上（CSS 三档靠它）", /layer\.dataset\.mode = mode/.test(ambient));
check("模糊强度写进 --ambient-blur", /setProperty\("--ambient-blur"/.test(ambient));
check("扩边系数随模糊收放（不模糊就不白裁一圈图）", /1 \+ \(blur \/ 70\) \* SCALE_AT_70/.test(ambient));
check("自定义图走同源端点（不把图塞进 data: URL / 不过 IPC 传 buffer）", ambient.includes('const BG_ROUTE = "/api/bg"'));
check("图源指纹挡住「拖滑块重拉一张 4K 壁纸」", ambient.includes("if (key === artKey) return;"));
check("自定义图带序号击穿缓存（原地替换同一路径的图也能刷新）", ambient.includes("${BG_ROUTE}?v=${++bgRev}"));

check("环境层模糊来自变量（不许退回写死值）", /filter: blur\(var\(--ambient-blur/.test(css));
check("关闭档整层不画", /\.ambient\[data-mode="off"\] \{ display: none; \}/.test(css));
check("自定义档满不透明（用户挑的图不该被压成 .55）", /\.ambient\[data-mode="custom"\] \.ambient-art\.ready \{ opacity: 1; \}/.test(css));
check("自定义档不额外调色（saturate/brightness 只留给封面环境色）",
  /\.ambient\[data-mode="custom"\] \.ambient-art \{ filter: blur\(var\(--ambient-blur/.test(css));
check("扩边走变量", /transform: scale\(var\(--ambient-scale/.test(css));
eq("CSS 兜底模糊与 schema 默认同值（改一处要改两处）",
  Number(/--ambient-blur: (\d+)px/.exec(css)?.[1]), Number(defaults()["Style.BackgroundBlur"]));
check("滑块盖得住通用 input 规则（否则长成一个带框的方块）", css.includes(".set-row__ctrl input.set-blur"));
// .opt-card 是 inline-flex → 作者样式压过 UA 的 [hidden]{display:none}，不显式关掉就藏不住
// 断言不写死整行：那条规则是共用的一条（高亮颜色也往里加了 .opt-cards[hidden]），
// 逐个列出选择器反而会随别人加项而误红 —— 只卡「两端 + display:none」。
check("隐藏的卡片/文件名真能藏住（[hidden] 显式 override）",
  /\.opt-card\[hidden\][^}]*\.bg-file\[hidden\][^}]*\{\s*display:\s*none;\s*\}/.test(css));
check("「选择图片…」用虚边框的「动作」样式与档位卡区分",
  /\.opt-card\.action \{ border-style: dashed;/.test(css) && views.includes('class="opt-card action" id="bg-pick"'));

// 反向：这些「回潮写法」必须能被断言逮到，否则上面的 check 是假的
const hardBlur = (s) => /\.ambient-art \{[\s\S]*?filter: blur\(70px\)/.test(s);
check("…反向：环境层写死 blur(70px) 会被逮住", hardBlur(".ambient-art {\n  filter: blur(70px) saturate(1.5);\n}"));
check("…当前源码里确实没有写死", !hardBlur(css));
const builtInShell = (s) => /className = "ambient"/.test(s) || /ambient-art/.test(s);
check("…反向：shell 又自己建环境层会被逮住", builtInShell('layer.className = "ambient";'));

// ——— 源码护栏 · 服务端与主进程 ———
section("源码护栏 · 服务端与主进程");
const relay = src("src/relay.ts");
const native = src("electron/native-server.ts");
const main = src("electron/main.ts");
const preload = src("electron/preload.cts");

const relayBg = after(relay, 'path === "bg"', 400);
check("dev/preview 接了 /api/bg", relayBg.includes("backgroundResponse()"), relayBg.slice(0, 120));
check("…且不带缓存", relayBg.includes('"no-store"'));
const nativeBg = after(native, 'sub === "/bg"', 400);
check("打包态接了 /api/bg", nativeBg.includes("backgroundResponse()"), nativeBg.slice(0, 120));
check("…且不带缓存", nativeBg.includes('"no-store"'));

const bgSrc = src("electron/background.ts");
check("读盘侧不看任何请求参数（路径只来自配置）", !/searchParams|req\.|URLSearchParams/.test(bgSrc));

const mainBg = after(main, 'ipcMain.handle("quaver:background"', 2400);
check("主进程有 quaver:background 处理器", mainBg.includes("backgroundInfo()"), mainBg.slice(0, 120));
check("选图走原生对话框 + 同一份格式白名单",
  mainBg.includes("dialog.showOpenDialog") && mainBg.includes("BG_DIALOG_EXTENSIONS"));
check("选中的路径写进 quaver.conf", mainBg.includes('"Style.BackgroundImage"'));
// 本功能唯一的开放文件读取面：路径一旦能从渲染层传进来，页面（含被 XSS 的）就能指定读任意文件
const takesRendererPath = (s) => /\bmsg\??\.(path|file|dir)\b/.test(s);
check("**不从渲染层收路径**", !takesRendererPath(mainBg));
check("…反向：真从渲染层收路径的写法会被逮住", takesRendererPath('const p = msg.path;'));
check("preload 暴露 quaverBackground（pick/info）",
  /exposeInMainWorld\("quaverBackground"/.test(preload) && preload.includes('{ op: "pick" }') && preload.includes('{ op: "info" }'));
check("globals.d.ts 声明了桥（TS 侧才敢直接用）", src("src/globals.d.ts").includes("quaverBackground"));

// ——— 源码护栏 · 配置 ———
section("源码护栏 · 配置");
check("schema 三键齐全",
  ["Style.Background", "Style.BackgroundImage", "Style.BackgroundBlur"].every((k) => k in defaults()));
eq("模式默认关闭背景（只有主题底色）", defaults()["Style.Background"], "off");
eq("自定义图默认未选择", defaults()["Style.BackgroundImage"], "");
eq("模糊默认 70", defaults()["Style.BackgroundBlur"], "70");
check("渲染层 FALLBACK 与 schema 同步（改一处要改两处）",
  ['"Style.Background": "off"', '"Style.BackgroundImage": ""', '"Style.BackgroundBlur": "70"']
    .every((line) => src("src/lib/config.ts").includes(line)));

rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
delete process.env.QUAVER_CONFIG_DIR;
console.log(`\n${fail === 0 ? "✅" : "❌"} verify-background: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
