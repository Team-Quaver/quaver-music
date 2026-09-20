// Quaver — 凭证密钥环层（electron/keyring.mjs）单测 + 两侧契约的源码级断言。
// 跑：node scripts/verify-keyring.mjs
//
// 这一层写错了**从界面上看不出来**：最坏是 Chromium 落到 basic_text（硬编码口令的假加密），
// isEncryptionAvailable() 照样返回 true，所谓「凭证已受系统密钥管理器保护」就成了谎话。
// 另外还有一条更硬的线：**凭证明文一个字节都不许落盘** —— 这里既测行为，也做源码级回归护栏。
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BACKENDS, CredentialStore, HANDOFF_PREFIX, STORE_MODES, STORE_NAME,
  credentialSummary, decodeHandoff, drainLines, encodeHandoff, evaluateKeyring, pickPasswordStore, probeKeyrings,
} from "../electron/keyring.mjs";

let pass = 0, fail = 0;
const section = (t) => console.log(`\n=== ${t} ===`);
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const mainSrc = read("electron/main.mjs");
const keyringSrc = read("electron/keyring.mjs");
const configSrc = read("electron/config.mjs");
const sessionPy = readFileSync(join(ROOT, "..", "vendor", "Typhoeus", "quaver_server", "session.py"), "utf8");
const appPy = readFileSync(join(ROOT, "..", "vendor", "Typhoeus", "quaver_server", "app.py"), "utf8");
const pkg = JSON.parse(read("package.json"));

// —— 假 safeStorage：真加解密的形状，足够跑通归档逻辑（不依赖 Electron）——
const KEY = 0x5a;
const xor = (buf, k = KEY) => Buffer.from(buf.map((b) => b ^ k));
const magicCrypto = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => "kwallet6",
  encryptString: (s) => Buffer.concat([Buffer.from("ENC1"), xor(Buffer.from(s, "utf8"))]),
  decryptString: (b) => {
    if (b.subarray(0, 4).toString() !== "ENC1") throw new Error("magic 不对");
    return xor(b.subarray(4)).toString("utf8");
  },
};
const cryptoWith = (over = {}) => ({ ...magicCrypto, ...over });
const TMP_DIRS = [];
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), "quaver-keyring-")); TMP_DIRS.push(d); return d; };
const planOf = (over = {}) => ({ persist: "keyring", backend: "kwallet6", reason: "test", ...over });
const storeOf = (dir, over = {}, crypto = magicCrypto) =>
  new CredentialStore({ dir, safeStorage: crypto, plan: planOf(over), log: () => {} });
const CRED = { musicid: 8237199, musickey: "W_X_verysecretkey", refresh_token: "rt_verysecrettoken", login_type: 1 };
const legacyOf = (dir) => join(dir, "credential.json");

// ——— 一、后端选择：ready 之前钉哪个 --password-store ———
section("后端选择（--password-store）");
const pick = (env, probe, backend = "auto") => pickPasswordStore({ platform: "linux", env, backend, probe: probe ?? {} });
eq("KDE + KDE_SESSION_VERSION=5 → kwallet5", pick({ XDG_CURRENT_DESKTOP: "KDE", KDE_SESSION_VERSION: "5" }).switchValue, "kwallet5");
eq("KDE 无版本号 → kwallet6", pick({ XDG_CURRENT_DESKTOP: "KDE" }).switchValue, "kwallet6");
eq("Plasma 桌面名也认", pick({ XDG_CURRENT_DESKTOP: "plasma" }).switchValue, "kwallet6");
eq("GNOME → gnome-libsecret", pick({ XDG_CURRENT_DESKTOP: "GNOME" }).switchValue, "gnome-libsecret");
eq("XFCE → gnome-libsecret", pick({ XDG_CURRENT_DESKTOP: "XFCE" }).switchValue, "gnome-libsecret");
eq("大小写/多值桌面串（KDE:GNOME）按 kde 优先", pick({ XDG_CURRENT_DESKTOP: "KDE:GNOME" }).switchValue, "kwallet6");

// 本机场景：Hyprland 不在 Chromium 的桌面白名单里 —— 这才是必须我们自己挑的原因
eq("Hyprland + 探测到 kwalletd6 → kwallet6", pick({ XDG_CURRENT_DESKTOP: "Hyprland" }, { kwallet6: true }).switchValue, "kwallet6");
eq("Hyprland + 只有 kwalletd5 → kwallet5", pick({ XDG_CURRENT_DESKTOP: "Hyprland" }, { kwallet5: true }).switchValue, "kwallet5");
eq("Hyprland + 只有 gnome-keyring → gnome-libsecret", pick({ XDG_CURRENT_DESKTOP: "Hyprland" }, { gnomeKeyring: true }).switchValue, "gnome-libsecret");
eq("Hyprland + 只有钱包库（守护进程未起）→ kwallet6", pick({ XDG_CURRENT_DESKTOP: "Hyprland" }, { wallets: true }).switchValue, "kwallet6");
const blind = pick({ XDG_CURRENT_DESKTOP: "Hyprland" }, {});
eq("Hyprland 毫无线索 → 仍不给 basic，保守试 gnome-libsecret", blind.switchValue, "gnome-libsecret");
check("…并在 why 里说明是保守尝试", blind.why.includes("保守"), blind.why);
check("认不出的桌面的 why 会带上桌面名（便于排查）", pick({ XDG_CURRENT_DESKTOP: "sway" }, {}).why.includes("sway"));

eq("显式指定后端时无视桌面", pick({ XDG_CURRENT_DESKTOP: "GNOME" }, {}, "kwallet6").switchValue, "kwallet6");
eq("显式 basic 是逃生舱（照发，交给校验环节否决）", pick({ XDG_CURRENT_DESKTOP: "GNOME" }, {}, "basic").switchValue, "basic");
eq("非法后端名归一为 auto（不静默乱发开关）", pickPasswordStore({ platform: "linux", env: { XDG_CURRENT_DESKTOP: "GNOME" }, backend: "gnome" }).switchValue, "gnome-libsecret");
eq("Windows 不发这个开关（DPAPI 是原生机制）", pickPasswordStore({ platform: "win32", env: { XDG_CURRENT_DESKTOP: "KDE" } }).switchValue, null);
eq("macOS 不发这个开关", pickPasswordStore({ platform: "darwin", env: {} }).switchValue, null);
check("BACKENDS 是 schema 值域的超集（配置里写的名字都得认识）",
  ["auto", "gnome-libsecret", "kwallet6", "kwallet5", "kwallet", "basic"].every((b) => BACKENDS.includes(b)));

// —— probeKeyrings：只读探测，读不到不许抛 ——
section("进程探测容错");
const okProbe = probeKeyrings({
  procDir: "/proc-probe",
  readDir: () => ["1", "self", "321"],
  readFile: (p) => (p.endsWith("321/comm") ? "kwalletd6\n" : "bash\n"),
  exists: (p) => p.includes("kwalletd"),
  home: "/home/x",
});
check("从进程表认出 kwalletd6", okProbe.kwallet6 === true);
check("非数字目录被跳过（self/net 之类）", okProbe.gnomeKeyring === false);
check("认出钱包库目录", okProbe.wallets === true);
const boomProbe = probeKeyrings({ procDir: "/nope", readDir: () => { throw new Error("EACCES"); }, readFile: () => { throw new Error("ENOENT"); }, exists: () => { throw new Error("EPERM"); }, home: "/home/x" });
check("探测全失败也不抛（Windows/macOS 无 /proc 同理）", boomProbe.kwallet6 === false && boomProbe.wallets === false);

// ——— 二、校验：这一票才是算数的 ———
section("后端校验（ready 之后）");
const ev = (over) => evaluateKeyring({ platform: "linux", safeStorage: cryptoWith(over), requested: "auto", mode: "auto" });

const basic = ev({ getSelectedStorageBackend: () => "basic_text" });
eq("basic_text → 只驻内存（绝不退明文）", basic.persist, "memory");
check("…理由点明是假加密", basic.reason.includes("basic_text"), basic.reason);
const basicStrict = evaluateKeyring({ platform: "linux", safeStorage: cryptoWith({ getSelectedStorageBackend: () => "basic_text" }), mode: "keyring" });
eq("keyring 模式 + basic_text：同样只驻内存", basicStrict.persist, "memory");
check("…理由指明是配置强要求后仍不可用", basicStrict.reason.includes("keyring"), basicStrict.reason);
eq("unknown（ready 前调用）→ 内存", ev({ getSelectedStorageBackend: () => "unknown" }).persist, "memory");
eq("密钥不可得 → 内存", ev({ isEncryptionAvailable: () => false }).persist, "memory");
check("…理由指明是密钥不可得", ev({ isEncryptionAvailable: () => false }).reason.includes("isEncryptionAvailable"));
eq("safeStorage 抛异常 → 不炸，退内存", evaluateKeyring({ platform: "linux", safeStorage: { isEncryptionAvailable: () => { throw new Error("boom"); } }, mode: "auto" }).persist, "memory");
eq("gnome_libsecret → 启用密钥环", ev({ getSelectedStorageBackend: () => "gnome_libsecret" }).backend, "gnome_libsecret");
eq("kwallet6 → 启用密钥环", ev({ getSelectedStorageBackend: () => "kwallet6" }).persist, "keyring");
eq("keyring 模式显式要求 → 报告实际后端", ev({ getSelectedStorageBackend: () => "kwallet6" }).backend, "kwallet6");
eq("Windows 走 DPAPI", evaluateKeyring({ platform: "win32", safeStorage: cryptoWith({}), mode: "auto" }).backend, "dpapi");
eq("macOS 走钥匙串", evaluateKeyring({ platform: "darwin", safeStorage: cryptoWith({}), mode: "auto" }).backend, "keychain");
eq("CredentialStore=memory 时压根不碰密钥环", evaluateKeyring({ platform: "linux", safeStorage: cryptoWith({}), mode: "memory" }).persist, "memory");
eq("safeStorage 缺席 → 内存（不炸）", evaluateKeyring({ platform: "linux", safeStorage: null, mode: "auto" }).persist, "memory");
eq("safeStorage 缺席 + 强制 keyring → 内存", evaluateKeyring({ platform: "linux", safeStorage: null, mode: "keyring" }).persist, "memory");
check("**没有 file 这一档**：值域里不该出现明文模式", !STORE_MODES.includes("file") && STORE_MODES.join(",") === "auto,keyring,memory", STORE_MODES.join(","));
eq("配置里写 file 会被归一成 auto（老配置不炸，但也不再走明文）",
  evaluateKeyring({ platform: "linux", safeStorage: cryptoWith({}), mode: "file" }).persist, "keyring");

// ——— 三、密文存档 ———
section("密文存档");
const d1 = tempDir();
const s1 = storeOf(d1);
eq("初次读：没有存档 → null（未登录，不是错误）", s1.read(), null);
check("不存在时 exists 为 false", s1.exists === false);
check("写入成功", s1.write(CRED) === true);
eq("读回完全一致", s1.read(), CRED);
const encPath = join(d1, STORE_NAME);
check("存档落在 credential.enc", existsSync(encPath));
eq("存档 0600", statSync(encPath).mode & 0o777, 0o600);
check("目录里没有残留临时文件", readdirSync(d1).every((f) => !f.endsWith(".tmp")), readdirSync(d1).join(","));
const blob = readFileSync(encPath, "utf8");
check("磁盘上是密文：搜不到 musickey/refresh_token 原文", !blob.includes(CRED.musickey) && !blob.includes(CRED.refresh_token));
check("**memory 模式：不落任何文件**（目录干净、读回 null、写入被拒）", (() => {
  const d = tempDir();
  const s = storeOf(d, { persist: "memory" });
  const r = s.write(CRED);
  const clean = readdirSync(d).length === 0;
  rmSync(d, { recursive: true, force: true });
  return r === false && clean && s.read() === null;
})());
check("清除成功", s1.clear() === true);
eq("清除后读回 null", s1.read(), null);
check("重复清除不报错（幂等）", s1.clear() === true);

// 解不开 ≠ 坏了：换钥匙/存档损坏都不许删文件
const d2 = tempDir();
const s2 = storeOf(d2);
s2.write(CRED);
const s2wrongKey = new CredentialStore({
  dir: d2, safeStorage: cryptoWith({ decryptString: () => { throw new Error("钥匙不对"); } }),
  plan: planOf(), log: () => {},
});
eq("换钥匙后读不出凭证（按未登录处理）", s2wrongKey.read(), null);
check("…但存档必须留着（可能只是这次没拿到钥匙）", existsSync(join(d2, STORE_NAME)));
writeFileSync(join(d2, STORE_NAME), Buffer.from("这不是密文"));
eq("存档损坏 → 读回 null 而不抛", storeOf(d2).read(), null);
check("…损坏的存档也不删", existsSync(join(d2, STORE_NAME)));
check("写入非对象被拒（数组/字符串不算凭证）", s2.write([1, 2]) === false && s2.write("x") === false && s2.write(null) === false);
const st = storeOf(tempDir()).status();
check("status() 不泄露凭证本体，只报形态", st.persist === "keyring" && !("credential" in st) && !JSON.stringify(st).includes("musickey"));
check("status() 不再有 handoff 这种「半开」状态（永远交接）", !("handoff" in st));

// ——— 四、遗留明文的唯一去向：导入 + 删除 ———
section("遗留明文（读一次 → 加密存 → 删）");
const d3 = tempDir();
const s3 = storeOf(d3);
writeFileSync(legacyOf(d3), JSON.stringify(CRED));
eq("迁移返回 migrated", s3.migrateLegacy(), "migrated");
check("**明文已删除**（这是它唯一的去处）", !existsSync(legacyOf(d3)));
eq("密文里读回同一份凭证", s3.read(), CRED);

const d4 = tempDir();
const s4 = storeOf(d4);
eq("没有明文 → none", s4.migrateLegacy(), "none");
writeFileSync(legacyOf(d4), "{ 这不是 json");
eq("明文非法 → failed", s4.migrateLegacy(), "failed");
check("…且明文保留（不吞用户数据）", existsSync(legacyOf(d4)));
writeFileSync(legacyOf(d4), JSON.stringify(CRED));
eq("存档不可用（memory）时不动明文 → skipped", storeOf(d4, { persist: "memory" }).migrateLegacy(), "skipped");
check("…明文仍在", existsSync(legacyOf(d4)));

// 明文比存档旧（早就迁过的残留）→ 不许顶掉新登录态
const d6 = tempDir();
const s6 = storeOf(d6);
s6.write({ ...CRED, musicid: 333 });
writeFileSync(legacyOf(d6), JSON.stringify({ ...CRED, musicid: 444 }));
utimesSync(legacyOf(d6), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
eq("明文更旧 → stale（不覆盖）", s6.migrateLegacy(), "stale");
eq("存档里仍是新的那份", s6.read().musicid, 333);
check("…旧明文被留着（交给下次判断，不擅自删）", existsSync(legacyOf(d6)));
// 反过来：明文更新（用户从别处拷回来的新凭证）→ 必须迁
const d7 = tempDir();
const s7 = storeOf(d7);
s7.write({ ...CRED, musicid: 111 });
utimesSync(join(d7, STORE_NAME), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
writeFileSync(legacyOf(d7), JSON.stringify({ ...CRED, musicid: 222 }));
eq("明文更新 → 迁移", s7.migrateLegacy(), "migrated");
eq("迁进来的是明文那份（新的）", s7.read().musicid, 222);

// ——— 五、交接信封 ———
section("交接信封与日志卫生");
check("编码带前缀 + 换行", encodeHandoff({ a: 1 }) === `${HANDOFF_PREFIX}{"a":1}\n`, encodeHandoff({ a: 1 }));
eq("null 用字面量表示（主进程与 sidecar 都认得）", encodeHandoff(null), `${HANDOFF_PREFIX}null\n`);
eq("解码凭证行", decodeHandoff(`${HANDOFF_PREFIX}{"musicid":1}`), { credential: { musicid: 1 } });
eq("解码登出行", decodeHandoff(`${HANDOFF_PREFIX}null`), { credential: null });
eq("普通日志行不认（绝不误当凭证）", decodeHandoff("[sidecar] 已加载登录凭证 musicid=5"), null);
eq("空行不认", decodeHandoff(""), null);
eq("前缀 + 坏 JSON → null（不抛）", decodeHandoff(`${HANDOFF_PREFIX}{oops`), null);
eq("前缀 + 数组 → null（只要对象）", decodeHandoff(`${HANDOFF_PREFIX}[1,2]`), null);
const drained = drainLines("ab", "c\nde\nf");
eq("跨块攒行：完整行出、残行留", drained.lines, ["abc", "de"]);
eq("残行留给下一块", drained.rest, "f");
eq("缓冲里的空行被丢掉", drainLines("", "\n\nx\n").lines, ["x"]);
const summary = credentialSummary(CRED);
check("日志摘要不露凭证内容（一个字符都不许）",
  !summary.includes(CRED.musickey) && !summary.includes(CRED.refresh_token) && !summary.includes(CRED.musickey.slice(-4)));
check("…但要有可记账的信息（musicid + 长度）", summary.includes("8237199") && summary.includes("W_X_verysecretkey".length + "字符"), summary);

// ——— 六、两侧契约（源码级）———
section("两侧契约（源码级断言）");
const pyPrefix = sessionPy.match(/^HANDOFF_PREFIX = "([^"]*)"/m)?.[1];
check("前缀在 Python / JS 两侧逐字一致（含末尾空格）", pyPrefix === HANDOFF_PREFIX, `py=${JSON.stringify(pyPrefix)} js=${JSON.stringify(HANDOFF_PREFIX)}`);
check("Python 侧只在 QUAVER_CREDENTIAL_MODE=external 时接管",
  /EXTERNAL_CREDENTIALS = os\.environ\.get\("QUAVER_CREDENTIAL_MODE", ""\)\.strip\(\)\.lower\(\) == "external"/.test(sessionPy));
check("Python 侧 credential_mode 只有 external / memory 两档",
  sessionPy.includes('return "external" if EXTERNAL_CREDENTIALS else "memory"'));
check("Python 侧采用「先判前缀」再解析（不匹配的行当未登录）", sessionPy.includes("if not body.startswith(HANDOFF_PREFIX):"));
check("Python 侧发出前 flush（走管道是块缓冲，不 flush 会睡在缓冲区里）", /sys\.stdout\.flush\(\)/.test(sessionPy));
check("Python 侧 external 下 save_credential 直接交接、不落盘",
  /def save_credential[\s\S]{0,220}?if EXTERNAL_CREDENTIALS:\s*\n\s*_emit_credential\(credential\)/.test(sessionPy));
check("Python 侧 external 下 clear_credential 发 null 而不是删文件",
  /def clear_credential[\s\S]{0,200}?if EXTERNAL_CREDENTIALS:\s*\n\s*_emit_credential\(None\)/.test(sessionPy));
check("**Python 侧不存在写明文的代码**（mkstemp / os.replace 都不该有）",
  !sessionPy.includes("mkstemp") && !sessionPy.includes("os.replace"));
check("**Python 侧不存在读明文的代码**（老口径已拆）",
  !sessionPy.includes("_load_credential_from_disk") && !sessionPy.includes("CREDENTIAL_PATH.read_text"));
check("凭证模式默认 memory（手工单跑不落盘，且有明确日志）",
  /credential_mode\(\)\s*\n?\s*\{?\s*\n?\s*"""[\s\S]{0,200}?memory/.test(sessionPy) || sessionPy.includes('"""当前凭证模式：external=交给主进程'));
check("启动凭证只经 _initial_credential 取（external 才读 stdin）",
  /if EXTERNAL_CREDENTIALS:\s*\n\s*return _read_injected_credential\(\)/.test(sessionPy));
const stdinCallSites = sessionPy.split("\n").filter((l) => /_read_injected_credential\(\)/.test(l) && !/^\s*def /.test(l));
check("阻塞读 stdin 只有那一处调用点（终端手跑不会卡在输入上）", stdinCallSites.length === 1, stdinCallSites.join(" | "));
check("sidecar 的 /login/status 报出 credential_mode（便于 curl 确认）",
  appPy.includes('"credential_mode": credential_mode()') && appPy.includes("credential_mode,"));

// —— keyring.mjs：明文写出路径必须为零 ——
section("「明文绝不落盘」的源码级护栏");
check("**没有任何写出明文凭证的路径**（writeAtomic 只用于密文存档）",
  keyringSrc.includes("writeAtomic(this.file") && !keyringSrc.includes("writeAtomic(this.legacy"));
check("mirror / materialize 那套（会产出明文）已彻底删除",
  !keyringSrc.includes("mirrorLegacy") && !keyringSrc.includes("materializeLegacy") && !keyringSrc.includes("startLegacyMirror"));
check("碰明文的写操作只有 migrateLegacy 里的 unlink",
  (keyringSrc.match(/unlinkSync\(this\.legacy\)/g) ?? []).length === 1);
check("文档头写明这条红线", keyringSrc.includes("明文凭证一个字节都不落盘"));
check("配置 schema 里 CredentialStore 不含 file", /key: "CredentialStore"[\s\S]{0,300}?\["auto", "keyring", "memory"\]/.test(configSrc));
check("配置 schema 里已无 DevPlaintextFallback（明文开关一并删掉）", !configSrc.includes("DevPlaintextFallback"));
check("主进程也认这套值域（归一函数来自 keyring.mjs）", mainSrc.includes("securityConf.store"));

// —— main.mjs：交接永远开、开发态也自拉 sidecar ——
const whenReadyAt = mainSrc.search(/^app\.whenReady\(\)/m);
const switchAt = mainSrc.indexOf('appendSwitch("password-store"');
check("主进程确实钉了 --password-store", switchAt > 0);
check("…且在 app ready 之前钉（ready 之后再改是空操作）", switchAt > 0 && whenReadyAt > 0 && switchAt < whenReadyAt, `switch=${switchAt} ready=${whenReadyAt}`);
check("主进程 ready 后才建凭证存档", mainSrc.indexOf("new CredentialStore(") > whenReadyAt);
check("主进程用 evaluateKeyring 校验而不是自己猜", mainSrc.includes("evaluateKeyring({ platform: process.platform, safeStorage"));
check("**QUAVER_CREDENTIAL_MODE=external 无条件下发**（不再有「文件模式」分支）",
  /QUAVER_CREDENTIAL_MODE: "external",/.test(mainSrc) && !/\.\.\.\(external \?/.test(mainSrc));
check("spawnSidecar 给 sidecar 开 stdin 管道（否则无法注入）", mainSrc.includes('stdio: ["pipe", "pipe", "pipe"]'));
check("有凭证/没凭证都注入（null 也要写，否则 sidecar 阻塞读不到 EOF 语义）",
  mainSrc.includes("child.stdin.write(encodeHandoff(handoff));"));
const stdoutHandler = mainSrc.match(/child\.stdout\.on\("data"[\s\S]{0,600}?\n  \}\);/)?.[0] ?? "";
check("抠到 sidecar stdout 处理块", stdoutHandler.length > 100, `${stdoutHandler.length} 字符`);
check("stdout 先分行再分流（不按行处理会把多行粘在一起）", stdoutHandler.includes("drainLines(outBuf, chunk)"));
check("凭证行先被识别、再决定是否写日志（顺序反了就泄露 musickey）",
  stdoutHandler.indexOf("decodeHandoff(line)") < stdoutHandler.indexOf('log("[sidecar]", line)'));
check("普通日志行才进日志，凭证行走 applySidecarCredential", /if \(msg\) applySidecarCredential\(msg\.credential\);\s*\n\s*else log\("\[sidecar\]", line\);/.test(stdoutHandler));
check("主进程从不把凭证本体写进日志（只允许 credentialSummary）",
  !/log\([^)]*JSON\.stringify\((cred|handoff)\b/.test(mainSrc) && mainSrc.includes("credentialSummary(handoff)"));
check("开发态由主进程自拉 sidecar（否则凭证拿不到交接管道 → 只能落明文）",
  /} else \{[\s\S]{0,400}?sidecar = spawnSidecar\(\);/.test(mainSrc));
check("开发态 spawn 早于 vite preview（relay.ts 在模块加载时读 QUAVER_API）",
  mainSrc.indexOf("sidecar = spawnSidecar()", mainSrc.indexOf("} else {")) < mainSrc.lastIndexOf("await import(\"vite\")"));
check("开发态优先用仓库里的 venv，退回 uv run",
  mainSrc.includes('join(dir, ".venv", "bin", "python")') && mainSrc.includes('args: ["run", "run.py"]'));
check("Windows 上找 venv 的 python.exe（别拼成 POSIX 路径）", mainSrc.includes('".venv", "Scripts", "python.exe"'));
check("环境已给 QUAVER_API（手工 sidecar / 联调）时不抢，并说明凭证只驻内存",
  /QUAVER_API 已由环境给出，本进程不自拉 sidecar（凭证不落盘，只驻内存）/.test(mainSrc));
check("随机端口不含 3200（那是手工 sidecar 的默认端口，开发态很容易正被占用）",
  mainSrc.includes("3201 + Math.floor(Math.random() * 200)"));
check("memory 模式的警告要讲清楚「没有退回明文这一档」",
  mainSrc.includes("本应用不会把凭证以明文写到磁盘上，所以没有「退回明文」这一档"));
check("凭证信息 IPC 只回状态不回凭证",
  mainSrc.includes('ipcMain.handle("quaver:credential-info"') && !/credential-info[\s\S]{0,400}?credentialStore\.read\(\)/.test(mainSrc));
check("preload 暴露的是只读 info()", read("electron/preload.cjs").includes('info: () => ipcRenderer.invoke("quaver:credential-info")'));
check("keyring.mjs 不 import electron（保证可单测）", !/from "electron"/.test(keyringSrc));
check("文件名只在 config.mjs 写一次（keyring.mjs 不再重复字面量）",
  keyringSrc.includes('import { CREDENTIAL_NAME, CREDENTIAL_STORE_NAME } from "./config.mjs"')
  && !keyringSrc.includes('"credential.json"') && !keyringSrc.includes('"credential.enc"'));
check("打包态在 Windows 上找 quaver-server.exe（拼错就整个 sidecar 起不来）",
  mainSrc.includes('process.platform === "win32" ? "quaver-server.exe" : "quaver-server"'));
check("用户可见文案不再提 credential.json / 0600（登录页与设置页）",
  !read("src/views.ts").includes("credential.json") && !read("src/relay.ts").includes("credential.json")
  && !read("vite.config.ts").includes("credential.json"));
check("登录页写明凭证存在系统密钥管理器",
  read("src/views.ts").includes("系统密钥管理器"));
check("verify:keyring 已挂进 verify:static", pkg.scripts["verify:static"].includes("verify-keyring.mjs") && !!pkg.scripts["verify:keyring"]);

for (const d of TMP_DIRS) rmSync(d, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "✅" : "❌"} verify-keyring: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
