// Quaver — 热键链路单测（纯 Node，不需要 Electron / 真桌面环境）。
//
// 四层保障，按依赖方向排：
//   1. 配置值域（electron/config.mjs isHotkey）：合法/非法/停用（空串）
//   2. accelerator 规范化（src/lib/prefs.ts）：KeyboardEvent 形态 → "Ctrl+Alt+F5" 串
//      （vite build 现打包 prefs —— 同 verify-prefs-map 的做法）
//   3. 门户触发串映射（electron/global-hotkeys.mjs）：Ctrl+P → CTRL+p（XKB 基础层小写！）
//   4. D-Bus 线级（electron/xdg-portal.mjs）：
//      a. 编解码往返（大端/小端、a{sv}、a(sa{sv)}、o s t a{sv} 信号体）
//      b. 规范算例：数组长度不含首元素垫片（dbus-broker 以 invalid body 踢线的教训）
//      c. PortalShortcuts 对 mock 总线全流程：SASL → Hello → CreateSession → Bind →
//         Activated 回调；以及 BindShortcuts 被拒 → unsupported 降级判定
// 跑：node scripts/verify-hotkeys.mjs
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { build as viteBuild } from "vite";
import {
  PortalShortcuts, buildMessage, parseMessage, encodeValue, parseBusAddress, sigEnd, Writer,
} from "../electron/xdg-portal.mjs";
import { acceleratorToPortalTrigger } from "../electron/global-hotkeys.mjs";

const UI_ROOT = fileURLToPath(new URL("..", import.meta.url));
let pass = 0, fail = 0;
const section = (t) => console.log(`\n=== ${t} ===`);
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 6000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(40);
  }
  return fn();
};

// ——— 1. 配置值域 ———
section("config.mjs isHotkey 值域");
{
  const { writeValues, defaults, template } = await import(join(UI_ROOT, "electron/config.mjs"));
  const dir = mkdtempSync(join(tmpdir(), "quaver-hk-conf-"));
  process.env.QUAVER_CONFIG_DIR = dir;
  writeFileSync(join(dir, "quaver.conf"), template());
  eq("默认 Ctrl+Alt+F5", defaults()["Hotkeys.Global.Toggle"], "Ctrl+Alt+F5");
  eq("默认焦点 Ctrl+Q", defaults()["Hotkeys.Focus.Quit"], "Ctrl+Q");
  eq("空串合法（停用）", writeValues({ "Hotkeys.Global.Toggle": "" }), ["Hotkeys.Global.Toggle"]);
  eq("合法组合写入", writeValues({ "Hotkeys.Global.Toggle": "Ctrl+Shift+9", "Hotkeys.Focus.Prev": "Ctrl+Left" }),
    ["Hotkeys.Global.Toggle", "Hotkeys.Focus.Prev"]);
  // 裸键允许（手改配置的高级用法：F 键当全局热键很常见）；录制器永远不产出裸键
  eq("裸 F 键允许（手改配置）", writeValues({ "Hotkeys.Global.Toggle": "F5" }), ["Hotkeys.Global.Toggle"]);
  eq("未知键名拒绝", writeValues({ "Hotkeys.Global.Toggle": "Ctrl+PrtSc" }), []);
  eq("重复修饰键拒绝", writeValues({ "Hotkeys.Global.Toggle": "Ctrl+Ctrl+P" }), []);
  eq("未知修饰键拒绝", writeValues({ "Hotkeys.Global.Toggle": "Hyper+P" }), []);
  eq("空段拒绝（a+P）", writeValues({ "Hotkeys.Global.Toggle": "+P" }), []);
  rmSync(dir, { recursive: true, force: true });
}

// ——— 2. accelerator 规范化（vite 打包 prefs）———
section("prefs.ts acceleratorFromEvent / set·getHotkey");
{
  const dir = mkdtempSync(join(tmpdir(), "quaver-hk-prefs-"));
  writeFileSync(join(dir, "entry.ts"), `export * from ${JSON.stringify(join(UI_ROOT, "src/lib/prefs.ts"))};\n`);
  await viteBuild({
    configFile: false, logLevel: "error",
    build: { write: false, target: "esnext", outDir: join(dir, "out"),
      lib: { entry: join(dir, "entry.ts"), formats: ["es"], fileName: () => "bundle.mjs" } },
  }).then((res) => {
    writeFileSync(join(dir, "bundle.mjs"), res[0].output.find((o) => o.type === "chunk").code);
  });
  globalThis.localStorage = {
    store: new Map(),
    getItem(k) { return this.store.has(k) ? this.store.get(k) : null; },
    setItem(k, v) { void this.store.set(k, String(v)); },
    removeItem(k) { void this.store.delete(k); },
  };
  globalThis.document = {
    documentElement: { dataset: {}, classList: { toggle() {} }, style: { setProperty() {}, removeProperty() {} } },
    body: { classList: { toggle() {} } },
    addEventListener() {}, visibilityState: "visible",
  };
  globalThis.window = { matchMedia: () => ({ matches: false, addEventListener() {} }), addEventListener() {}, setTimeout, clearTimeout };
  const P = await import(join(dir, "bundle.mjs"));

  const ev = (key, mods = {}) => ({ key, ctrlKey: !!mods.c, altKey: !!mods.a, shiftKey: !!mods.s, metaKey: !!mods.m });
  eq("Ctrl+P", P.acceleratorFromEvent(ev("p", { c: 1 })), "Ctrl+P");
  eq("大写键也归 Ctrl+P（shift 位并入修饰）", P.acceleratorFromEvent(ev("P", { c: 1, s: 1 })), "Ctrl+Shift+P");
  eq("Ctrl+Alt+F5", P.acceleratorFromEvent(ev("F5", { c: 1, a: 1 })), "Ctrl+Alt+F5");
  eq("方向键", P.acceleratorFromEvent(ev("ArrowLeft", { c: 1 })), "Ctrl+Left");
  eq("修饰键固定序", P.acceleratorFromEvent(ev(" ", { a: 1, s: 1, c: 1, m: 1 })), "Ctrl+Alt+Shift+Super+Space");
  eq("裸键不录", P.acceleratorFromEvent(ev("p")), null);
  eq("纯修饰键不录", P.acceleratorFromEvent(ev("Control", { c: 1 })), null);
  eq("未知键不录", P.acceleratorFromEvent(ev("", { c: 1 })), null);
  eq("音量上", P.acceleratorFromEvent(ev("ArrowUp", { c: 1 })), "Ctrl+Up");

  // 写读往返（浏览器 dev 形态：落 localStorage）
  P.setHotkey("Global", "toggle", "Ctrl+Alt+G");
  eq("setHotkey 落到 Hotkeys.Global.Toggle", JSON.parse(localStorage.getItem("quaver.conf.v1"))["Hotkeys.Global.Toggle"], "Ctrl+Alt+G");
  eq("getHotkey 读回", P.getHotkey("Global", "toggle"), "Ctrl+Alt+G");
  P.setHotkey("Focus", "quit", "");
  eq("空串停用", P.getHotkey("Focus", "quit"), "");
  // 多词键名两端一致（首字母大写法会拼错 VolUp，回归锚）
  eq("volup 键名 = schema 的 VolUp", P.hotkeyConfKey("Global", "volup"), "Hotkeys.Global.VolUp");
  eq("voldown 键名 = schema 的 VolDown", P.hotkeyConfKey("Global", "voldown"), "Hotkeys.Global.VolDown");
  const { GLOBAL_CONF_KEYS } = await import(join(UI_ROOT, "electron/global-hotkeys.mjs"));
  const { schemaIndex } = await import(join(UI_ROOT, "electron/config.mjs"));
  const idx = schemaIndex();
  eq("主进程 GLOBAL_CONF_KEYS 与渲染层 hotkeyConfKey 一致", GLOBAL_CONF_KEYS,
    Object.fromEntries(["toggle", "prev", "next", "volup", "voldown"].map((a) => [a, P.hotkeyConfKey("Global", a)])));
  check("全部热键键名都存在于 schema",
    ["toggle", "prev", "next", "volup", "voldown"].every((a) => idx[P.hotkeyConfKey("Global", a)])
    && ["toggle", "quit", "prev", "next", "volup", "voldown"].every((a) => idx[P.hotkeyConfKey("Focus", a)]));
  rmSync(dir, { recursive: true, force: true });
}

// ——— 3. 门户触发串映射 ———
section("global-hotkeys.mjs acceleratorToPortalTrigger");
eq("Ctrl+Alt+F5 → CTRL+ALT+F5", acceleratorToPortalTrigger("Ctrl+Alt+F5"), "CTRL+ALT+F5");
eq("字母转基础层小写", acceleratorToPortalTrigger("Ctrl+P"), "CTRL+p");
eq("方向键保持 keysym 名", acceleratorToPortalTrigger("Ctrl+Alt+Left"), "CTRL+ALT+Left");
eq("Super → LOGO", acceleratorToPortalTrigger("Super+A"), "LOGO+a");
eq("Space → keysym 小写", acceleratorToPortalTrigger("Ctrl+Shift+Space"), "CTRL+SHIFT+space");
eq("PageUp → Page_Up", acceleratorToPortalTrigger("Ctrl+PageUp"), "CTRL+Page_Up");
eq("空串/停用", acceleratorToPortalTrigger(""), "");
eq("未知修饰键 → 空（跳过注册）", acceleratorToPortalTrigger("Fn+P"), "");

// ——— 4. D-Bus 线级 ———
section("xdg-portal.mjs 编解码");
{
  // 规范 worked example：大端、单个 u64 元素 5、8 字节对齐 → n=8 且垫片不计入
  const w = new Writer("B");
  encodeValue(w, "at", [5n]);
  eq("数组长度不含首元素垫片（规范算例）", w.buffer().toString("hex"),
    "00000008000000000000000000000005");
  eq("空数组 n=0", (() => { const w2 = new Writer("B"); encodeValue(w2, "a{sv}", {}); return w2.buffer().toString("hex"); })(), "00000000");

  // 完整消息往返（大端 + 小端——门户端 GLib 常发小端）
  const match = "type='signal',interface='org.freedesktop.portal.Request',member='Response'";
  for (const endian of ["B", "l"]) {
    const msg = buildMessage({
      type: 1, serial: 42, destination: "org.freedesktop.DBus", path: "/org/freedesktop/DBus",
      interface: "org.freedesktop.DBus", member: "AddMatch", sig: "s", body: [match],
    }, endian);
    const back = parseMessage(msg);
    check(`${endian}: AddMatch 往返`, back.member === "AddMatch" && back.sig === "s" && back.body[0] === match && back.serial === 42);
  }
  const sig = buildMessage({
    type: 4, serial: 7, destination: null, path: "/org/freedesktop/portal/desktop",
    interface: "org.freedesktop.portal.GlobalShortcuts", member: "Activated", sig: "osta{sv}",
    body: ["/org/freedesktop/portal/desktop/session/1_1/quaver", "toggle", 1730000000000000, { activation_token: { sig: "s", value: "tok" } }],
  });
  const sigBack = parseMessage(sig);
  const [sigSession, sigId, sigTs, sigOpts] = sigBack.body;
  const sigDict = Object.fromEntries(sigOpts ?? []);
  check("Activated 信号体往返（o s t a{sv}）",
    sigSession === "/org/freedesktop/portal/desktop/session/1_1/quaver" && sigId === "toggle"
    && sigTs === 1730000000000000 && sigDict.activation_token === "tok");
  const bind = buildMessage({
    type: 1, serial: 9, path: "/org/freedesktop/portal/desktop", interface: "org.freedesktop.portal.GlobalShortcuts",
    member: "BindShortcuts", sig: "oa(sa{sv})sa{sv}",
    body: ["/org/x/session/1", [["toggle", { description: { sig: "s", value: "暂停/播放" }, preferred_trigger: { sig: "s", value: "CTRL+ALT+F5" } }]], "", {}],
  });
  const bindBack = parseMessage(bind);
  const bindDict = Object.fromEntries(bindBack.body[1][0][1] ?? []);
  check("BindShortcuts v2 体往返",
    bindBack.body[1][0][0] === "toggle" && bindDict.description === "暂停/播放"
    && bindDict.preferred_trigger === "CTRL+ALT+F5" && bindBack.body[2] === "" && Array.isArray(bindBack.body[3]) && bindBack.body[3].length === 0);
  eq("parseBusAddress 首个 unix 段优先（abstract 合法）", parseBusAddress("unix:abstract=/x,guid=1;unix:path=/run/user/0/bus", {}),
    { kind: "abstract", path: "/x" });
  eq("parseBusAddress abstract", parseBusAddress("unix:abstract=/run/dbus-x", {}), { kind: "abstract", path: "/run/dbus-x" });
  eq("parseBusAddress XDG 兜底", parseBusAddress(undefined, { XDG_RUNTIME_DIR: "/run/user/7" }), { kind: "unix", path: "/run/user/7/bus" });
  eq("sigEnd 完整类型（含型闭区间）", [sigEnd("a{sv}a", 0), sigEnd("(ii)s", 0)], [4, 3]);
}

// ——— 5. mock 总线全流程 ———
/** 最小门户 mock：SASL + Hello/AddMatch/CreateSession/BindShortcuts/Activated。
 *  bindMode: "v2"（正常）｜ "never"（v2 与 v1 都回 UnknownMethod → 客户端应判 unsupported）。 */
function startMockBus({ bindMode = "v2" } = {}) {
  const path = join(mkdtempSync(join(tmpdir(), "quaver-hk-bus-")), "bus");
  const server = createServer((socket) => {
    let acc = Buffer.alloc(0);
    let binary = false;
    let authed = false; // 已回 OK，等 BEGIN 行
    let serial = 100;
    let sessionPath = "";
    // sig/body 缺省回落到 opts 内的同名字段：response() 把 sig/body 放 opts 传，
    // reply() 直接传参 —— 别让未传的 undefined 形参把 opts 里的值覆盖掉
    const send = (opts, sig = opts.sig, body = opts.body) => socket.write(buildMessage({ ...opts, serial: ++serial, sig, body }));
    socket.on("data", (chunk) => {
      acc = Buffer.concat([acc, chunk]);
      if (!binary) {
        const s = acc.toString("utf8");
        if (!authed) {
          if (!s.includes("AUTH ")) return; // 等 AUTH 行
          socket.write("OK 0123456789abcdef0123456789abcdef\r\n");
          authed = true;
          acc = Buffer.alloc(0);
          return;
        }
        const begin = acc.indexOf(Buffer.from("BEGIN\r\n", "utf8"));
        if (begin < 0) return;
        binary = true;
        acc = acc.subarray(begin + 7); // 直接切 Buffer：过一遍 utf8 字符串会把二进制字节弄脏
      }
      while (true) {
        let m;
        try { m = parseMessage(acc); } catch { acc = Buffer.alloc(0); return; }
        if (!m) return;
        acc = acc.subarray(m.consumed);
        const reply = (sig, body) => send({ type: 2, replySerial: m.serial }, sig, body); // 回复指向**调用方**的 serial（m.replySerial 是回复才有的字段）
        const response = (reqPath, results) => send({
          type: 4, path: reqPath, interface: "org.freedesktop.portal.Request", member: "Response",
          sig: "ua{sv}", body: [0, results],
        });
        if (m.member === "Hello") reply("s", [":1.mock"]);
        else if (m.member === "AddMatch") reply("", []);
        else if (m.member === "CreateSession") {
          const token = Object.fromEntries(m.body[0] ?? []).handle_token;
          const reqPath = `/org/freedesktop/portal/desktop/request/mock/${token}`;
          reply("o", [reqPath]);
          sessionPath = `/org/freedesktop/portal/desktop/session/mock/quaver`;
          response(reqPath, { session_handle: { sig: "s", value: sessionPath } });
        } else if (m.member === "BindShortcuts") {
          if (bindMode === "never") {
            send({ type: 3, replySerial: m.serial, errorName: "org.freedesktop.DBus.Error.UnknownMethod" }, "s", ["no such method"]);
            continue;
          }
          const token = Object.fromEntries(m.body[3] ?? []).handle_token;
          const reqPath = `/org/freedesktop/portal/desktop/request/mock/${token}`;
          reply("o", [reqPath]);
          // 解码后的 a{sv} 是键值对数组（Object.fromEntries 后才是对象）；
          // 回程再编码时 a{sv} 的值必须是 variant 包裹（{sig, value}）
          const shorts = m.body[1].map(([id, pairs]) => {
            const o = Object.fromEntries(pairs ?? []);
            return [id, {
              description: { sig: "s", value: o.description ?? "" },
              trigger_description: { sig: "s", value: o.preferred_trigger ?? "" },
            }];
          });
          response(reqPath, { shortcuts: { sig: "a(sa{sv})", value: shorts } });
          // 绑成即发一次 Activated（toggle），验证信号回程
          send({
            type: 4, path: sessionPath, interface: "org.freedesktop.portal.GlobalShortcuts", member: "Activated",
            sig: "osta{sv}", body: [sessionPath, "toggle", 1730000000000000, {}],
          });
        } else if (m.member === "Close") { /* 会话关闭：忽略 */ }
      }
    });
  });
  return new Promise((resolve) => server.listen(path, () => resolve({ server, path })));
}

section("PortalShortcuts × mock 总线（v2 全流程）");
{
  const { server, path } = await startMockBus({ bindMode: "v2" });
  const statuses = [];
  const actions = [];
  const p = new PortalShortcuts({
    env: { DBUS_SESSION_BUS_ADDRESS: `unix:path=${path}` },
    onStatus: (st) => statuses.push(st),
    onAction: (id) => actions.push(id),
  });
  p.start([
    { id: "toggle", description: "暂停/播放", trigger: "CTRL+ALT+F5" },
    { id: "next", description: "下一曲", trigger: "CTRL+ALT+Right" },
  ]);
  const ready = await until(() => p.state === "ready");
  check("达到 ready", ready === true, `statuses=${JSON.stringify(statuses)}`);
  const got = await until(() => actions.includes("toggle"));
  check("Activated → onAction(toggle)", got === true, `actions=${JSON.stringify(actions)}`);
  p.destroy();
  await sleep(50);
  server.close();
}

section("PortalShortcuts × mock 总线（门户不支持 → unsupported）");
{
  const { server, path } = await startMockBus({ bindMode: "never" });
  const statuses = [];
  const p = new PortalShortcuts({
    env: { DBUS_SESSION_BUS_ADDRESS: `unix:path=${path}` },
    onStatus: (st) => statuses.push(st),
  });
  p.start([{ id: "toggle", description: "暂停/播放", trigger: "CTRL+ALT+F5" }]);
  const end = await until(() => p.state === "unsupported" || p.state === "failed");
  check("v2 被拒且 v1 也被拒 → unsupported", end === true, `statuses=${JSON.stringify(statuses)}`);
  p.destroy();
  await sleep(50);
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
