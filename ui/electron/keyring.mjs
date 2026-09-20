// Quaver — 凭证存储：系统密钥管理器（Electron safeStorage）接入层。零依赖、可脱离 Electron 单测。
//
// **明文凭证一个字节都不落盘。** 这个模块里没有任何「写出明文 credential.json」的路径：
// 唯二涉及明文的操作是 ① `migrateLegacy()`（升级遗留的明文读一次 → 加密存进密钥环 → 回读校验 → 删）
// 与 ② 读取它做校验。想再加明文写出，请先想清楚为什么值得破这条线。
//
// 为什么密文还是有个文件：safeStorage **不提供存储**，它只负责「用 OS 里的密钥做对称加解密」
// （Linux = libsecret/KWallet 里的密钥，macOS = 钥匙串，Windows = DPAPI）。密文仍要我们落盘 ——
// 但单看 credential.enc 是没用的：解密的钥匙在密钥环里，换机器/换用户/重装系统都解不开。
//
// 拿不到真密钥环时**退到内存**，不退明文：本次登录照常可用，关掉应用即需重新登录。
// 这是刻意的取舍 —— 账户安全优先于「每次都要重新扫码」的那点不便。
//
// 三个必须显式处理的坑：
//   1) Linux「桌面认不出来」时 Chromium 静默退到 basic_text —— 用硬编码口令做对称加密，
//      isEncryptionAvailable() 照样返回 true。看着像加密，其实等于明文，还搬到了更难排查的位置。
//      → ready 之前显式钉 --password-store；ready 之后用 getSelectedStorageBackend() 校验；
//        落在 basic_text 一律当「密钥环不可用」，绝不启用。
//   2) 同一个桌面可能既有 KWallet 又有 gnome-keyring（Hyprland 这类自定义合成器尤其如此）。
//      探测结果只用来**选开关**，真正算数的是校验 —— 探错不致命，落到 basic_text 就退内存模式。
//   3) 存档解不开 ≠ 存档坏了（可能只是这次没拿到钥匙）。此时**绝不删存档**，按未登录处理即可；
//      这与「明文解析失败即 unlink」的老 Python 口径刻意不同（那边坏的是明文，这边可能只是没钥匙）。
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
// 文件名从 config.mjs 取（那是「路径与文件名」的单一真相），别在这里再写一遍字面量
import { CREDENTIAL_NAME, CREDENTIAL_STORE_NAME } from "./config.mjs";

/** 加密存档文件名（明文 credential.json 只作为升级遗留，迁完即删）。 */
export const STORE_NAME = CREDENTIAL_STORE_NAME;
/** 升级遗留的明文档名：唯一的明文来源，迁完删除。 */
export const LEGACY_NAME = CREDENTIAL_NAME;
/** sidecar stdout 上的凭证信封前缀。前缀之外的行一律当普通日志。 */
export const HANDOFF_PREFIX = "QCRED1 ";
/** [Security] CredentialStore 的取值。没有 file —— 明文不在选项里。 */
export const STORE_MODES = ["auto", "keyring", "memory"];
/** [Security] KeyringBackend 的取值（basic = 显式要求 Chromium 那套假加密，会被校验环节否决）。 */
export const BACKENDS = ["auto", "gnome-libsecret", "kwallet6", "kwallet5", "kwallet", "basic"];

export const normalizeStoreMode = (v) => (STORE_MODES.includes(v) ? v : "auto");
export const normalizeBackend = (v) => (BACKENDS.includes(v) ? v : "auto");

// —— 一、钉开关：ready 之前决定 Chromium 用哪个密钥后端 ——

/**
 * 从进程表 / 用户数据目录做**保守探测**：有没有在跑的密钥环守护进程、有没有用过钱包。
 * 读不到 /proc 的平台（Windows/macOS）或权限不足时全部返回 false，不抛。
 */
export function probeKeyrings(io = {}) {
  const {
    procDir = "/proc",
    exists = existsSync,
    readDir = readdirSync,
    readFile = (p) => readFileSync(p, "utf8"),
    home = homedir(),
  } = io;
  const names = new Set();
  try {
    for (const entry of readDir(procDir)) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        names.add(readFile(join(procDir, entry, "comm")).trim());
      } catch {}
    }
  } catch {}
  // KWallet 的钱包库（~/.local/share/kwalletd/*.kwl）/ gnome-keyring 的 keyring 目录：
  // 有目录 = 这台机器真用过这套，比「有没有装包」更接近事实。
  const has = (p) => { try { return exists(p); } catch { return false; } };
  return {
    kwallet6: names.has("kwalletd6"),
    kwallet5: names.has("kwalletd5"),
    kwallet: names.has("kwalletd") || names.has("walletd"),
    gnomeKeyring: names.has("gnome-keyring-daemon"),
    wallets: has(join(home, ".local", "share", "kwalletd")),
    secretsDir: has(join(home, ".local", "share", "keyrings")),
  };
}

/** 桌面标识 → 已知的 libsecret 桌面（Chromium 认得出的那一批）。 */
const LIBSECRET_DESKTOPS = [
  "gnome", "unity", "x-cinnamon", "cinnamon", "pantheon", "xfce", "mate",
  "budgie", "deepin", "ukui", "lxqt", "elementary", "pop",
];

/**
 * 决定 --password-store 的取值（拿不定注意就返回 null 交给 Chromium 自己认）。
 * 注意：**只在 Linux 有意义**；Windows（DPAPI）/macOS（钥匙串）没有这个开关。
 */
export function pickPasswordStore({ platform = process.platform, env = process.env, backend = "auto", probe } = {}) {
  const want = normalizeBackend(backend);
  if (platform !== "linux") {
    return { switchValue: null, backend: want === "auto" ? platform : want, why: "非 Linux：由系统原生机制（DPAPI / 钥匙串）提供密钥" };
  }
  if (want !== "auto") return { switchValue: want, backend: want, why: "配置显式指定" };

  const desktop = String(env.XDG_CURRENT_DESKTOP ?? env.DESKTOP_SESSION ?? "").toLowerCase();
  const version = String(env.KDE_SESSION_VERSION ?? "").trim();
  const isKde = desktop.includes("kde") || desktop.includes("plasma");
  const isLibsecret = LIBSECRET_DESKTOPS.some((d) => desktop.includes(d));
  if (isKde) {
    const b = version === "5" ? "kwallet5" : version === "4" ? "kwallet" : "kwallet6";
    return { switchValue: b, backend: b, why: `KDE 会话（KDE_SESSION_VERSION=${version || "未设"}）` };
  }
  if (isLibsecret) return { switchValue: "gnome-libsecret", backend: "gnome-libsecret", why: `已知走 libsecret 的桌面（${desktop}）` };

  // 认不出的桌面（Hyprland / sway / i3 / 自建会话…）：Chromium 会直接退 basic_text，必须我们自己挑。
  const p = probe ?? probeKeyrings();
  const where = `桌面未知（${desktop || "空"}）`;
  if (p.kwallet6) return { switchValue: "kwallet6", backend: "kwallet6", why: `${where}，探测到 kwalletd6 在跑` };
  if (p.kwallet5) return { switchValue: "kwallet5", backend: "kwallet5", why: `${where}，探测到 kwalletd5 在跑` };
  if (p.gnomeKeyring) return { switchValue: "gnome-libsecret", backend: "gnome-libsecret", why: `${where}，探测到 gnome-keyring-daemon 在跑` };
  if (p.wallets) return { switchValue: "kwallet6", backend: "kwallet6", why: `${where}，但存在 KWallet 钱包库（按 KWallet6 拉起，D-Bus 激活）` };
  // 兜底仍给一个真后端而不是 basic：校验环节会把 basic_text 判成不可用，最差也只是退回文件模式。
  return {
    switchValue: "gnome-libsecret",
    backend: "gnome-libsecret",
    why: p.secretsDir ? `${where}，存在 keyrings 目录（按 libsecret 拉起）` : `${where}且无密钥环线索：保守尝试 Secret Service（KWallet6 亦提供该接口）`,
  };
}

/**
 * ready 之后校验：这次到底拿到了什么后端，能不能用。
 * 返回 { persist, backend, reason }：
 *   persist = keyring（真密钥环）/ memory（拿不到就只在内存里，绝不退明文）
 * sidecar 永远走「父进程交接、自己不落盘」那套 —— 与 persist 无关，所以这里不用再说一遍。
 */
export function evaluateKeyring({ platform = process.platform, safeStorage, requested = "auto", mode = "auto" } = {}) {
  const want = normalizeStoreMode(mode);
  const ask = normalizeBackend(requested);
  const memory = (reason, backend = "none") => ({ persist: "memory", backend, reason });

  if (want === "memory") return memory("配置指定 CredentialStore=memory（凭证只驻内存，不落盘）");
  if (!safeStorage) return memory("safeStorage 不可用");

  let usable = false;
  let backend = "none";
  let reason = "";
  try {
    usable = !!safeStorage.isEncryptionAvailable();
    backend = platform === "linux" ? String(safeStorage.getSelectedStorageBackend?.() ?? "unknown") : (platform === "win32" ? "dpapi" : "keychain");
  } catch (e) {
    reason = `探测异常：${String(e)}`;
  }
  if (!usable) reason = reason || "isEncryptionAvailable() 为 false（密钥不可得）";
  else if (platform === "linux" && backend === "basic_text") {
    usable = false;
    reason = "Chromium 落到 basic_text（硬编码口令的假加密）—— 桌面未被识别或所选后端不可用";
  } else if (platform === "linux" && backend === "unknown") {
    usable = false;
    reason = "app ready 前调用 / 后端未知";
  }
  if (usable) {
    const tail = ask !== "auto" ? `（配置要求 ${ask}）` : "";
    return { persist: "keyring", backend, reason: `已启用系统密钥管理器（${backend}）${tail}` };
  }
  return memory(`${want === "keyring" ? "CredentialStore=keyring 但不可用：" : ""}${reason}`);
}

// —— 二、密文存档 ——

/** 凭证必须是普通对象（数组/字符串/null 都不算）。 */
const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

function writeAtomic(file, data) {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${basename(file)}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, data, { mode: 0o600 });
    renameSync(tmp, file);
  } catch (e) {
    try { unlinkSync(tmp); } catch {}
    throw e;
  }
}

/**
 * 加密封档。只有 persist === "keyring" 时才真正落盘/读盘；memory 模式读永远返回 null、写永远返回 false
 * （凭证只在进程内存里活着，关掉即丢）。
 */
export class CredentialStore {
  constructor({ dir, safeStorage, plan, log = () => {} }) {
    this.dir = dir;
    this.safeStorage = safeStorage;
    this.plan = plan;
    this.log = log;
    this.file = join(dir, STORE_NAME);
    this.legacy = join(dir, LEGACY_NAME);
  }

  get usable() { return this.plan.persist === "keyring"; }
  get exists() { try { return existsSync(this.file); } catch { return false; } }

  status() {
    return {
      persist: this.plan.persist,
      backend: this.plan.backend,
      reason: this.plan.reason,
      store: this.usable ? this.file : null,
      legacy: existsSync(this.legacy),
      hasStored: this.exists,
    };
  }

  /** 读回凭证。解不开/解析失败都返回 null（**不删存档**：可能只是这次没拿到钥匙）。 */
  read() {
    if (!this.usable) return null;
    let blob;
    try {
      blob = readFileSync(this.file);
    } catch {
      return null; // 没有存档 = 未登录，不是错误
    }
    try {
      const json = this.safeStorage.decryptString(blob);
      const cred = JSON.parse(json);
      if (!isPlainObject(cred)) throw new Error("存档不是对象");
      return cred;
    } catch (e) {
      this.log("[quaver] 凭证存档解不开（保留文件，按未登录处理）:", String(e));
      return null;
    }
  }

  /** 写凭证（原子写 + 0600）。失败返回 false 并记账，不抛。 */
  write(cred) {
    if (!this.usable) return false;
    if (!isPlainObject(cred)) return false;
    try {
      writeAtomic(this.file, this.safeStorage.encryptString(JSON.stringify(cred)));
      return true;
    } catch (e) {
      this.log("[quaver] 凭证写入失败:", String(e));
      return false;
    }
  }

  clear() {
    if (!this.usable) return false;
    try {
      unlinkSync(this.file);
      return true;
    } catch (e) {
      if (e?.code === "ENOENT") return true;
      this.log("[quaver] 凭证存档删除失败:", String(e));
      return false;
    }
  }

  /** 明文 mtime / 存档 mtime（都不存在则 0）。 */
  _mtimes() {
    const at = (p) => { try { return statSync(p).mtimeMs; } catch { return 0; } };
    return { legacyAt: at(this.legacy), storeAt: at(this.file) };
  }

  /**
   * 升级遗留的明文 credential.json → 加密封档，**迁完全程就删掉明文**。
   *
   * 这是明文唯一的合法去向，也是本模块唯一会碰明文的写操作（而且是 unlink，不是写出）。
   * 只有当明文比存档**新**（或存档还不存在）时才迁：更旧的遗留文件不许顶掉更新的登录态。
   * 顺序要紧 —— **回读校验通过之后**才删明文：反了会在密钥环抽风时把登录态弄丢。
   * 返回 migrated | none（无明文）| stale（明文更旧，忽略）| failed | skipped（存档不可用）。
   */
  migrateLegacy() {
    if (!this.usable) return "skipped";
    let raw;
    try {
      raw = readFileSync(this.legacy, "utf8");
    } catch {
      return "none";
    }
    const { legacyAt, storeAt } = this._mtimes();
    if (storeAt && legacyAt <= storeAt) return "stale";
    let cred;
    try {
      cred = JSON.parse(raw.trim() || "null");
      if (!isPlainObject(cred)) return "failed";
    } catch {
      this.log("[quaver] credential.json 不是合法 JSON，保留原文件不迁移:", this.legacy);
      return "failed";
    }
    if (!this.write(cred)) return "failed";
    const back = this.read();
    if (!back || JSON.stringify(back) !== JSON.stringify(cred)) {
      this.log("[quaver] 迁移回读校验失败，保留 credential.json（存档已写入，下次再校验）");
      return "failed";
    }
    try {
      unlinkSync(this.legacy);
    } catch (e) {
      this.log("[quaver] 明文删除失败（下次启动会重迁，幂等）:", String(e));
    }
    this.log("[quaver] 已把明文 credential.json 迁入密钥环存档并删除明文");
    return "migrated";
  }
}

// —— 三、与 sidecar 的交接信封 ——

/** 主进程 → sidecar stdin 的一行。credential 为 null 表示「本次没有已存凭证」。 */
export function encodeHandoff(credential) {
  return HANDOFF_PREFIX + (isPlainObject(credential) ? JSON.stringify(credential) : "null") + "\n";
}

/** sidecar stdout 的一行 → { credential } 或 null（不是交接行的就当普通日志）。 */
export function decodeHandoff(line) {
  const text = String(line ?? "");
  if (!text.startsWith(HANDOFF_PREFIX)) return null;
  const body = text.slice(HANDOFF_PREFIX.length).trim();
  if (body === "null") return { credential: null };
  try {
    const cred = JSON.parse(body);
    return isPlainObject(cred) ? { credential: cred } : null;
  } catch {
    return null;
  }
}

/** 记账用的凭证摘要 —— 日志里只允许出现这个：**一个字符都不暴露**，只报长度。 */
export function credentialSummary(cred) {
  if (!isPlainObject(cred)) return "无凭证";
  const len = (v) => (v ? String(v).length : 0);
  return `musicid=${cred.musicid || "-"} musickey(${len(cred.musickey)}字符) refresh_token(${len(cred.refresh_token)}字符)`;
}

/** 按行切分 stdout 缓冲：返回 { lines, rest }。sidecar 输出可能被任意切断，必须自己攒行。 */
export function drainLines(buf, chunk) {
  const text = buf + String(chunk ?? "");
  const parts = text.split("\n");
  const rest = parts.pop() ?? "";
  return { lines: parts.map((l) => l.trim()).filter(Boolean), rest };
}
