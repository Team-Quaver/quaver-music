// Quaver — XDG 桌面门户「全局快捷键」客户端（Linux 专用）。
//
// 为什么自己讲 D-Bus：门户只用到整个协议的一小片（EXTERNAL 认证 → Hello → 两个方法 +
// 两个信号），为此引一个完整的 D-Bus 运行时不划算 —— 本模块零依赖、不 import electron，
// 纯 Node socket，可以脱离 Electron 用 mock 总线做线级单测（scripts/verify-hotkeys.ts）。
//
// 协议口径（对齐规范 v2，本机 /usr/share/dbus-1/interfaces/…GlobalShortcuts.xml 同款）：
//   CreateSession(a{sv}) → o request；随后 Request::Response(u, a{sv}) 的 results.session_handle
//   是会话句柄（规范注明「本该是 o 却按 s 发」的历史遗留，按字符串收）。
//   BindShortcuts(o session, a(sa{sv}) shortcuts, s parent_window, a{sv}) → o request；
//   Response 的 results.shortcuts 是实际绑上的表（含 trigger_description，展示用）。
//   Activated / Deactivated(o session, s shortcut_id, t timestamp, a{sv}) → 按会话过滤后
//   把 shortcut_id 回调给调用方。
//   规范 v1（2023 年前 GNOME 43 等上古实现）的 BindShortcuts 收 a{sv}、键名即 id；
//   服务端回 UnknownMethod/InvalidArgs 时降级重试一次（同一套编解码原语）。
//
// 失败面（只降级、不炸进程，全部走 onStatus）：会话总线连不上、门户方法不存在（桌面
// 环境不支持）→ unsupported；授权弹窗被拒 → failed；socket 断开 → closed。
// 重绑（热键配置变更）= 关旧会话 → 全新 CreateSession → Bind —— 门户语义里一个会话只能
// Bind 一次，桌面端可能为此再弹一次授权框（GNOME 会，Hyprland/WLR 系不弹）。
import { createConnection, type Socket } from "node:net";

// —— 线级类型 ——
// 值形状由签名串决定，TS 看不到这层对应关系：编码入口收 unknown，按 sig 分支处显式收窄。

/** 'B' 大端（规范默认）/ 'l' 小端。 */
type Endian = "B" | "l";

/** 会话总线地址：abstract 走 \0 前缀，path 走文件系统。 */
export interface BusAddress {
  kind: "unix" | "abstract";
  path: string;
}

/** variant：值本身要连内层签名一起送。 */
export interface WireVariant {
  sig: string;
  value: WireValue;
}

/** 线上取值：签名串决定形状，`(…)` 是定长元组、`a{…}` 是键值对数组。 */
export type WireValue =
  | string
  | number
  | bigint
  | boolean
  | WireVariant
  | readonly WireValue[]
  | { readonly [key: string]: WireValue | undefined };

/** 解出来的头字段：按字段码分开，省得调用侧对一张 `Record<number, unknown>` 逐项断言。 */
interface MessageFields {
  path?: string;
  interface?: string;
  member?: string;
  errorName?: string;
  replySerial?: number;
  sig?: string;
}

/** a{sv} 解出来的一条键值对。 */
type DictEntry = readonly [string, WireValue];

function isVariant(value: WireValue): value is WireVariant {
  return value instanceof Object && !Array.isArray(value) && "sig" in value && "value" in value;
}

function isWireList(value: WireValue): value is readonly WireValue[] {
  return Array.isArray(value);
}

function isWireEntry(value: WireValue): value is DictEntry {
  return Array.isArray(value) && value.length === 2;
}

/** `a{…}` 允许直接给对象（编码端按条目展开）；数组形态原样返回。 */
function dictionaryEntries(value: WireValue): readonly WireValue[] {
  if (isWireList(value)) return value;

  if (!(value instanceof Object)) throw new Error("dictionary value must be an object or entry list");

  return Object.entries(value).flatMap(([key, entry]) => (entry === undefined ? [] : [[key, entry] as const]));
}

/** 标量取文本：容器（变体/数组/字典）走调用点各自的形状，不进这里。 */
function wireText(value: WireValue): string {
  if (value instanceof Object) throw new Error("expected scalar text, got container");

  return String(value);
}

/** 标量取数字：同上。 */
function wireNumber(value: WireValue): number {
  if (value instanceof Object) throw new Error("expected scalar number, got container");

  return Number(value);
}

/** 收一条 `a{sv}` 的键值对数组；`Object.fromEntries` 之前先确认元素形状。 */
function wireDict(entries: readonly WireValue[] | undefined): Map<string, WireValue> {
  const out = new Map<string, WireValue>();

  for (const entry of entries ?? []) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const [key, value] = entry;

    if (key === undefined || value === undefined) continue;
    out.set(wireText(key), value);
  }

  return out;
}

/** reserve32 的回填句柄。 */
interface Marker {
  buf: Buffer[];
  idx: number;
}

/** 一条出站消息的可选项；serial/sig/body 由 _send 补。 */
export interface MessageOptions {
  type: number;
  flags?: number;
  serial: number;
  path?: string;
  interface?: string;
  member?: string;
  destination?: string;
  errorName?: string;
  replySerial?: number;
  sig?: string;
  body?: WireValue | readonly WireValue[];
}

/** 解出来的一条消息。header 字段缺省即 undefined；`body` 按签名串逐项解出。 */
export interface Message {
  type: number;
  serial: number;
  fields: MessageFields;
  replySerial: number;
  interface: string;
  member: string;
  path: string;
  errorName: string;
  sig: string;
  body: WireValue[];
  consumed: number;
}

// —— 会话总线地址 ——

/** DBUS_SESSION_BUS_ADDRESS（取第一个 unix 段）→ {path} | {abstract}；缺省再看 XDG 兜底。 */
export function parseBusAddress(addr: string | null | undefined, env: NodeJS.ProcessEnv = process.env): BusAddress | null {
  for (const part of String(addr ?? "").split(";")) {
    if (!part.startsWith("unix:")) continue;

    // 地址形态 "unix:path=/x,guid=1"：key 紧跟 "unix:" 或逗号
    for (const kv of part.slice(5).split(",")) {
      const eq = kv.indexOf("=");

      if (eq <= 0) continue;
      const k = kv.slice(0, eq), v = kv.slice(eq + 1);

      if (!v) continue;

      if (k === "path") return { kind: "unix", path: v };

      if (k === "abstract") return { kind: "abstract", path: v };
    }
  }

  const dir = String(env.XDG_RUNTIME_DIR ?? "").trim();

  return dir ? { kind: "unix", path: `${dir}/bus` } : null;
}

/** 注入 connect 时地址必来自同一份解析：拿不到就按「会话总线不可用」处理。 */
function requireBusAddress(addr: BusAddress | null): BusAddress {
  if (addr === null) throw new Error("no session bus address");

  return addr;
}

// —— 线级类型对齐表（b 布尔线上是 u32；v 变体自身对齐 1，内部的值按各自类型对齐）——
const ALIGN = new Map<string, number>([
  ["y", 1], ["b", 4], ["n", 2], ["q", 2], ["i", 4], ["u", 4], ["x", 8], ["t", 8],
  ["d", 8], ["s", 4], ["o", 4], ["g", 1], ["v", 1], ["a", 4], ["(", 8], ["{", 8],
]);

/** 完整类型在签名串里的结束下标（a/( /{ 需要配对扫描，单字符类型即自身）。 */
export function sigEnd(sig: string, i: number): number {
  const c = sig[i];

  if (c === "a") return sigEnd(sig, i + 1);

  if (c === "(" || c === "{") {
    const close = c === "(" ? ")" : "}";
    let depth = 0;

    for (let j = i; j < sig.length; j++) {
      if (sig[j] === "(" || sig[j] === "{") depth++;
      else if (sig[j] === ")" || sig[j] === "}" || sig[j] === close) { depth--; if (depth === 0) return j; }
    }
  }

  if (!c || !ALIGN.has(c)) throw new Error(`bad signature: ${sig}@${i}`);

  return i;
}

// —— 编码：单缓冲 + 绝对偏移对齐（消息头恒补到 8 的倍数，body 对齐因此与按消息对齐一致）——
export class Writer {
  // declare：类型只活在编译期。裸声明会被 Node 的类型剥离变成 `endian;`，
  // 等于给实例凭空加一批 own property，这里刻意避免。
  declare endian: Endian;
  declare buf: Buffer[];
  declare len: number;
  constructor(endian: Endian) { this.endian = endian; this.buf = []; this.len = 0; }
  put(align: number, chunk: Buffer) {
    const p = (align - (this.len % align)) % align;

    if (p) { this.buf.push(Buffer.alloc(p)); this.len += p; }

    this.buf.push(chunk);
    this.len += chunk.length;
  }
  u8(v: number) { this.put(1, Buffer.from([v & 0xff])); }
  u32(v: number) {
    const b = Buffer.alloc(4);

    if (this.endian === "B") b.writeUInt32BE(v >>> 0); else b.writeUInt32LE(v >>> 0);
    this.put(4, b);
  }
  u64(v: number) {
    const b = Buffer.alloc(8);
    const big = BigInt(v);

    if (this.endian === "B") b.writeBigUInt64BE(big); else b.writeBigUInt64LE(big);
    this.put(8, b);
  }
  string(s: string) {
    const raw = Buffer.from(String(s ?? ""), "utf8");
    this.u32(raw.length);
    this.put(1, Buffer.concat([raw, Buffer.from([0])]));
  }
  sigStr(s: string) {
    const raw = Buffer.from(String(s ?? ""), "utf8");

    if (raw.length > 254) throw new Error("signature too long");
    this.u8(raw.length);
    this.put(1, Buffer.concat([raw, Buffer.from([0])]));
  }
  /** 定长 u32 占位（数组长度 / body 长度），返回回填句柄。 */
  reserve32() {
    const p = (4 - (this.len % 4)) % 4;

    if (p) { this.buf.push(Buffer.alloc(p)); this.len += p; }

    const marker = { buf: this.buf, idx: this.buf.length };
    this.buf.push(Buffer.alloc(4));
    this.len += 4;

    return marker;
  }
  patch32(marker: Marker, value: number) {
    const b = marker.buf[marker.idx];

    if (this.endian === "B") b.writeUInt32BE(value >>> 0); else b.writeUInt32LE(value >>> 0);
  }
  buffer() { return Buffer.concat(this.buf); }
}

/**
 * 按单个完整类型编码一个值。JS 取值约定：
 *   s/o/g → string ｜ u/t → number ｜ b → boolean ｜ y → number
 *   v → { sig, value } ｜ a<X> → 数组（a{…} 也可传对象）｜ (…) → 数组
 */
export function encodeValue(w: Writer, sig: string, v: WireValue) {
  const c = sig[0];

  if (c === "s" || c === "o") { w.put(4, Buffer.alloc(0)); w.string(wireText(v)); return; }

  if (c === "u") { w.u32(wireNumber(v)); return; }

  if (c === "t" || c === "x") { w.u64(wireNumber(v)); return; }

  if (c === "b") { w.u32(v ? 1 : 0); return; }

  if (c === "y") { w.u8(wireNumber(v)); return; }

  if (c === "g") { w.sigStr(wireText(v)); return; }

  if (c === "v") {
    if (!isVariant(v)) throw new Error("variant value must be { sig, value }");
    const inner = v.sig;

    if (inner.length !== sigEnd(inner, 0) + 1) throw new Error(`variant sig must be one complete type: ${inner}`);
    w.sigStr(inner);
    encodeValue(w, inner, v.value);

    return;
  }

  if (c === "a") {
    const elSig = sig.slice(1, sigEnd(sig, 0) + 1);
    const elAlign = ALIGN.get(elSig[0]) ?? 1;

    const items: readonly WireValue[] = elSig[0] === "{" ? dictionaryEntries(v) : isWireList(v) ? v : [];

    const marker = w.reserve32();
    // 规范：数组长度 n 不含 length 字段后的首元素对齐垫片，但含元素之间的垫片
    // （worked example：单个 8 字节元素 + 4 字节垫片时 n=8）。算错会被 dbus-broker
    // 以 invalid body 踢线（c-dvar 按「首元素起点→内容终点」严格复核）。
    let contentAt: number | null = null;

    for (const item of items) {
      w.put(elAlign, Buffer.alloc(0));

      if (contentAt === null) contentAt = w.len;

      if (elSig[0] === "{") {
        if (!isWireEntry(item)) throw new Error("dictionary entry must be a [key, value] pair");
        encodeValue(w, elSig[1], item[0]);
        encodeValue(w, elSig.slice(2, -1), item[1]);
      }
      else encodeValue(w, elSig, item);
    }

    w.patch32(marker, contentAt === null ? 0 : w.len - contentAt);

    return;
  }

  if (c === "(") {
    w.put(8, Buffer.alloc(0));
    const inner = sig.slice(1, sigEnd(sig, 0));
    const list: readonly WireValue[] = isWireList(v) ? v : [v];
    let i = 0;

    for (let p = 0; p < inner.length; p = sigEnd(inner, p) + 1) encodeValue(w, inner.slice(p, sigEnd(inner, p) + 1), list[i++]);

    return;
  }

  if (c === "{") { // dict entry（只作为数组元素出现，见上；这里兜独立用法）
    w.put(8, Buffer.alloc(0));
    const inner = sig.slice(1, sigEnd(sig, 0));

    if (!isWireEntry(v)) throw new Error("dictionary entry must be a [key, value] pair");
    encodeValue(w, inner[0], v[0]);
    encodeValue(w, inner.slice(1), v[1]);

    return;
  }

  throw new Error(`unsupported type: ${c}`);
}

/** 编一条 D-Bus 消息。opts: {type, flags, serial, path, interface, member, destination, errorName, replySerial, sig, body}。 */
export function buildMessage(opts: MessageOptions, endian: Endian = "B") {
  const w = new Writer(endian);
  w.u8(endian === "B" ? 0x42 : 0x6c); // 'B' | 'l'
  w.u8(opts.type); // 1=method_call 2=method_return 3=error 4=signal
  w.u8(opts.flags ?? 0);
  w.u8(1); // protocol version
  const bodyMarker = w.reserve32();
  w.u32(opts.serial);
  // header fields：array of (byte, variant)
  const fields: [number, WireVariant][] = [];

  if (opts.path) fields.push([1, { sig: "o", value: opts.path }]);

  if (opts.interface) fields.push([2, { sig: "s", value: opts.interface }]);

  if (opts.member) fields.push([3, { sig: "s", value: opts.member }]);

  if (opts.errorName) fields.push([4, { sig: "s", value: opts.errorName }]);

  if (opts.replySerial !== undefined) fields.push([5, { sig: "u", value: opts.replySerial }]);

  if (opts.destination) fields.push([6, { sig: "s", value: opts.destination }]);

  // 规范：SIGNATURE 头字段（8）的值类型是 g（SIGNATURE），不是 s —— 编错会被 dbus-broker
  // 以 invalid header 踢线（且自家回环解析发现不了：s/g 都按字符串读）
  if (opts.sig) fields.push([8, { sig: "g", value: opts.sig }]);
  const fMarker = w.reserve32();
  const fAt = w.len;

  for (const [code, val] of fields) {
    w.put(8, Buffer.alloc(0)); // 结构对齐 8
    w.u8(code);
    encodeValue(w, "v", val);
  }

  w.patch32(fMarker, w.len - fAt);

  while (w.len % 8) w.u8(0); // body 从 8 的倍数开始
  const bodyAt = w.len;

  if (opts.sig && opts.body !== undefined) {
    const values: readonly WireValue[] = Array.isArray(opts.body) ? opts.body : [opts.body];
    let i = 0;

    for (let at = 0; at < opts.sig.length; at = sigEnd(opts.sig, at) + 1) {
      const value = values[i++];

      if (value === undefined) throw new Error(`missing value for signature ${opts.sig}@${at}`);
      encodeValue(w, opts.sig.slice(at, sigEnd(opts.sig, at) + 1), value);
    }
  }

  w.patch32(bodyMarker, w.len - bodyAt);

  return w.buffer();
}

// —— 解码 ——

class Reader {
  declare buf: Buffer;
  declare little: boolean;
  declare off: number;
  constructor(buf: Buffer, little: boolean) { this.buf = buf; this.little = little; this.off = 0; }
  align(a: number) { this.off += (a - (this.off % a)) % a; }
  need(n: number) {
    if (this.off + n > this.buf.length) throw new Error(`truncated @${this.off}+${n}/${this.buf.length}`);
  }
  u8() { this.need(1); return this.buf[this.off++]; }
  u32() { this.align(4); this.need(4); const v = this.little ? this.buf.readUInt32LE(this.off) : this.buf.readUInt32BE(this.off); this.off += 4; return v; }
  u64() { this.align(8); this.need(8); const v = this.little ? this.buf.readBigUInt64LE(this.off) : this.buf.readBigUInt64BE(this.off); this.off += 8; return Number(v); }
  string(a = 4): string {
    this.align(a);
    const n = this.u32();
    this.need(n + 1);
    const s = this.buf.toString("utf8", this.off, this.off + n);
    this.off += n + 1;

    return s;
  }
  sig(): string {
    this.align(1);
    const n = this.u8();
    this.need(n + 1);
    const s = this.buf.toString("utf8", this.off, this.off + n);
    this.off += n + 1;

    return s;
  }
  /** 按单个完整类型读一个值。a{…} → [[k,v],…] ｜ (…) → 数组 ｜ v → 展开后的内值。 */
  value(sig: string): WireValue {
    const c = sig[0];

    if (c === "s" || c === "o") return this.string(4);

    if (c === "g") return this.sig();

    if (c === "u" || c === "i") return this.u32();

    if (c === "y") return this.u8();

    if (c === "b") return this.u32() !== 0;

    if (c === "t" || c === "x" || c === "d") return this.u64();

    if (c === "v") return this.value(this.sig());

    if (c === "a") {
      const elSig = sig.slice(1, sigEnd(sig, 0) + 1);
      const byteLen = this.u32();
      this.align(ALIGN.get(elSig[0]) ?? 1); // 首元素垫片不计入 n（与编码端同一口径）
      const end = this.off + byteLen;
      const elAlign = ALIGN.get(elSig[0]) ?? 1;
      const out: WireValue[] = [];

      if (elSig[0] === "{") {
        while (this.off < end) {
          this.align(elAlign);
          const k = this.value(elSig[1]);
          const v = this.value(elSig.slice(2, -1));
          out.push([k, v]);
        }
      } else {
        while (this.off < end) {
          this.align(elAlign);
          out.push(this.value(elSig));
        }
      }

      this.off = end;

      return out;
    }

    if (c === "(") {
      this.align(8);
      const inner = sig.slice(1, sigEnd(sig, 0));
      const out: WireValue[] = [];

      for (let p = 0; p < inner.length; p = sigEnd(inner, p) + 1) out.push(this.value(inner.slice(p, sigEnd(inner, p) + 1)));

      return out;
    }

    throw new Error(`unsupported type: ${c}`);
  }
}

/** 解一条完整消息（buf 须含全包；字节不够返回 null）。偏移基准 = 消息首字节，与线上一致。 */
export function parseMessage(buf: Buffer): Message | null {
  if (buf.length < 16) return null;
  const endian = String.fromCharCode(buf[0]);

  if (endian !== "B" && endian !== "l") throw new Error(`bad endianness: 0x${buf[0].toString(16)}`);
  const little = endian === "l";
  const type = buf[1];
  const bodyLen = little ? buf.readUInt32LE(4) : buf.readUInt32BE(4);
  const serial = little ? buf.readUInt32LE(8) : buf.readUInt32BE(8);
  const fLen = little ? buf.readUInt32LE(12) : buf.readUInt32BE(12);
  const fieldsEnd = 16 + fLen;

  if (buf.length < fieldsEnd) return null;
  const bodyStart = fieldsEnd + ((8 - (fieldsEnd % 8)) % 8);

  if (buf.length < bodyStart + bodyLen) return null;
  const r = new Reader(buf, little);
  r.off = 16; // fields 数组内容起点（12..15 是长度）
  const fields: MessageFields = {};

  while (r.off < fieldsEnd) {
    r.align(8);
    const code = r.u8();
    const sig = r.sig();
    const value = r.value(sig);

    if (code === 1) fields.path = wireText(value);
    else if (code === 2) fields.interface = wireText(value);
    else if (code === 3) fields.member = wireText(value);
    else if (code === 4) fields.errorName = wireText(value);
    else if (code === 5) fields.replySerial = wireNumber(value);
    else if (code === 8) fields.sig = wireText(value);
  }

  r.off = bodyStart;
  const bodySig = fields.sig ?? "";
  const body: WireValue[] = [];

  for (let p = 0; p < bodySig.length; p = sigEnd(bodySig, p) + 1) body.push(r.value(bodySig.slice(p, sigEnd(bodySig, p) + 1)));

  return {
    type, serial, fields,
    // 头字段缺省时线上就是 undefined；只有 reply/error 分支会读它，这里按字段码解出后再兜空串。
    replySerial: fields.replySerial ?? 0,
    interface: fields.interface ?? "", member: fields.member ?? "", path: fields.path ?? "",
    errorName: fields.errorName ?? "", sig: bodySig,
    body,
    consumed: bodyStart + bodyLen,
  };
}

// —— SASL / socket ——

const hexUid = () => {
  const uid = process.getuid?.() ?? 1000;

  return Buffer.from(String(uid), "utf8").toString("hex");
};

function defaultConnect(addr: BusAddress) {
  return new Promise<Socket>((resolve, reject) => {
    const opts = addr.kind === "abstract" ? { path: `\0${addr.path}` } : { path: addr.path };
    const s = createConnection(opts);
    s.once("connect", () => resolve(s));
    s.once("error", (e) => reject(e));
  });
}

/** 建连函数：注入用（mock 总线跑线级单测），缺省走 defaultConnect。 */
export type ConnectFn = (addr: BusAddress) => Promise<Socket>;

/** 连接会话总线并完成 SASL EXTERNAL（注入 connect 便于 mock 测试）。 */
export async function connectSessionBus({ connect = defaultConnect, env = process.env }: { connect?: ConnectFn; env?: NodeJS.ProcessEnv } = {}): Promise<Socket> {
  const addr = parseBusAddress(env.DBUS_SESSION_BUS_ADDRESS, env);

  if (!addr) throw new Error("no session bus address");
  const socket = await connect(addr);
  socket.setNoDelay(true);
  await new Promise<void>((resolve, reject) => {
    socket.write(`\0AUTH EXTERNAL ${hexUid()}\r\n`, "utf8");
    const to = setTimeout(() => finish(new Error("sasl timeout")), 5000);
    let acc = "";

    const onData = (chunk: Buffer) => {
      acc += chunk.toString("utf8");
      let i;

      while ((i = acc.indexOf("\r\n")) >= 0) {
        const line = acc.slice(0, i);
        acc = acc.slice(i + 2);

        if (!line) continue; // 空行：等下一行

        if (line.startsWith("OK")) { socket.write("BEGIN\r\n"); finish(null); return; }

        finish(new Error(`sasl rejected: ${line.slice(0, 60)}`));

        return;
      }
    };

    const onError = (e: Error) => finish(e);

    const finish = (err: Error | null) => {
      clearTimeout(to);
      socket.off("data", onData);
      socket.off("error", onError);

      if (err) reject(err); else resolve();
    };

    socket.on("data", onData);
    socket.on("error", onError);
  });

  return socket;
}

// —— 门户会话 ——

const DESKTOP = "org.freedesktop.portal.Desktop";
const OBJ = "/org/freedesktop/portal/desktop";
const IFACE = "org.freedesktop.portal.GlobalShortcuts";

/**
 * GlobalShortcuts 门户会话。用法：
 *   const p = new PortalShortcuts({ log, onAction, onStatus });
 *   p.start([{ id, description, trigger }]);   // trigger = XDG 串（如 CTRL+ALT+F5）
 *   p.setShortcuts(nextList);                  // 重绑 = 关旧会话再建（授权框可能重弹）
 *   p.destroy();
 * onStatus({state, reason})：connecting / ready / failed / unsupported。
 */
/** BindShortcuts 的属性表：只放该快捷键**真有**的键（D-Bus 变体字典，多余键/undefined 会打坏编码） */
type ShortcutProps = { description: WireVariant; preferred_trigger?: WireVariant };

/** 调用方交进来的一条快捷键绑定意图。 */
export interface ShortcutSpec {
  id: string;
  description?: string;
  trigger?: string;
}

/** 门户状态机：partial = 部分触发串被桌面端丢弃。 */
export type PortalState = "connecting" | "ready" | "partial" | "failed" | "unsupported";

/** onStatus 回调负载。 */
export interface PortalStatus {
  state: PortalState;
  reason?: string;
  missing?: string[];
}

/** PortalShortcuts 构造参数。 */
export interface PortalOptions {
  log?: (...args: unknown[]) => void;
  onAction?: (id: string) => void;
  onStatus?: (status: PortalStatus) => void;
  connect?: ConnectFn;
  env?: NodeJS.ProcessEnv;
}

/** 等一条信号时的匹配条件（缺省项 = 不比对该维）。 */
interface SignalMatch {
  path?: string;
  interface?: string;
  member?: string;
}

/** Request::Response 的解码结果。 */
interface RequestResponse {
  code: number;
  results: PortalResults;
  msg: Message;
}

/** `Response.results` 只消费两键，其余原样留在 `raw` 里备查。 */
interface PortalResults {
  sessionHandle: string;
  shortcuts: readonly DictEntry[];
  raw: ReadonlyMap<string, WireValue>;
}

/** serial → 同步回包等待者。 */
interface Pending {
  resolve: (body: WireValue[]) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** 信号等待者；timer 只有限时等待才有。 */
interface Waiter {
  match: SignalMatch;
  resolve: (res: RequestResponse) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export class PortalShortcuts {
  declare log: (...args: unknown[]) => void;
  declare onAction: (id: string) => void;
  declare onStatus: (status: PortalStatus) => void;
  declare connect: ConnectFn | undefined;
  declare env: NodeJS.ProcessEnv;
  declare socket: Socket | null;
  declare serial: number;
  declare pendings: Map<number, Pending>;
  declare waiters: Waiter[];
  declare stashed: Map<string, RequestResponse>;
  declare sessionPath: string;
  declare applying: boolean;
  declare wantShortcuts: ShortcutSpec[] | null;
  declare dead: boolean;
  declare acc: Buffer;
  declare state: PortalState;
  constructor({ log = () => {}, onAction = () => {}, onStatus = () => {}, connect, env = process.env }: PortalOptions = {}) {
    this.log = log;
    this.onAction = onAction;
    this.onStatus = onStatus;
    this.connect = connect;
    this.env = env;
    this.socket = null;
    this.serial = Math.floor(Math.random() * 1000) + 1;
    this.pendings = new Map<number, Pending>(); // serial → {resolve, reject, timer}
    this.waiters = [];         // Request::Response 等待者
    this.stashed = new Map<string, RequestResponse>();  // path → Response 结果：waiter 尚未挂上就到的信号先存着
                               // （method_return 与 Response 同段抵达时，await 续延要等微任务，
                               //  不 stash 的话先到的信号会被空表丢弃 → 干等超时）
    this.sessionPath = "";
    this.applying = false;
    this.wantShortcuts = null; // applying 期间到达的重绑请求（最后一次为准）
    this.dead = false;
    this.acc = Buffer.alloc(0);
  }

  _status(state: PortalState, reason = "", missing: string[] = []) {
    this.state = state;

    try { this.onStatus({ state, reason, missing }); } catch { /* 回调不许炸连接 */ }
  }

  destroy() {
    this.dead = true;

    if (this.sessionPath && this.socket && !this.socket.destroyed) {
      try {
        this.socket.write(buildMessage({
          type: 1, serial: ++this.serial, destination: DESKTOP, path: this.sessionPath,
          interface: "org.freedesktop.portal.Session", member: "Close", flags: 1, // NO_REPLY_EXPECTED
        }));
      } catch { /* socket 已死就算了 */ }
    }

    this._teardown("destroyed");
  }

  _teardown(_reason: string) {
    const pend = [...this.pendings.values()];
    this.pendings.clear();

    for (const p of pend) { clearTimeout(p.timer); p.reject(new Error("teardown")); }

    for (const w of this.waiters) if (w.timer) clearTimeout(w.timer);
    this.waiters = [];
    this.stashed.clear();

    if (this.socket) { try { this.socket.destroy(); } catch { /* noop */ } this.socket = null; }

    this.sessionPath = "";
  }

  _send(opts: Omit<MessageOptions, "serial" | "sig" | "body">, sig: string, body: WireValue | readonly WireValue[]) {
    this.socket!.write(buildMessage({ ...opts, serial: ++this.serial, sig, body }));

    return this.serial;
  }

  /** 发方法调用并等 method_return / error（portal 的 request 句柄就是同步返回的）。 */
  _call(dest: string, path: string, iface: string, member: string, sig: string, body: WireValue | readonly WireValue[], timeoutMs = 10000) {
    return new Promise<WireValue[]>((resolve, reject) => {
      const serial = this._send({ type: 1, destination: dest, path, interface: iface, member }, sig, body);

      const timer = setTimeout(() => {
        this.pendings.delete(serial);
        reject(new Error(`${member} timeout`));
      }, timeoutMs);

      this.pendings.set(serial, { resolve, reject, timer });
    });
  }

  /** 等一条匹配的信号（Request::Response）。timeoutMs=0 = 不限时（授权弹窗可能悬很久）。 */
  _waitSignal(match: SignalMatch, timeoutMs = 0) {
    const path = match.path;
    const stashed = path === undefined ? null : this.stashed.get(path);

    if (stashed && path !== undefined) {
      this.stashed.delete(path);

      return Promise.resolve(stashed);
    }

    return new Promise<RequestResponse>((resolve, reject) => {
      const w: Waiter = { match, resolve };
      this.waiters.push(w);

      if (timeoutMs) {
        w.timer = setTimeout(() => {
          this.waiters = this.waiters.filter((x) => x !== w);
          reject(new Error("signal timeout"));
        }, timeoutMs);
      }
    });
  }

  start(shortcuts: ShortcutSpec[]) {
    this.wantShortcuts = shortcuts;

    if (this.applying || this.dead) return; // 跑完这轮后按 wantShortcuts 重来
    this.applying = true;
    this._run(shortcuts).finally(() => {
      this.applying = false;

      if (this.dead) return;

      const next = this.wantShortcuts;

      if (next === null || next === shortcuts) return;
      this._teardown("rebind");
      void this.start(next);
    });
  }

  setShortcuts(shortcuts: ShortcutSpec[]) { this.start(shortcuts); }

  async _run(shortcuts: ShortcutSpec[]) {
    this._teardown("restart"); // 干掉上一次的连接/会话
    this._status("connecting");

    let socket: Socket;

    try {
      socket = await (this.connect
        ? this.connect(requireBusAddress(parseBusAddress(this.env.DBUS_SESSION_BUS_ADDRESS, this.env)))
        : connectSessionBus({ env: this.env }));
    } catch (e) {
      this._status("unsupported", `会话总线不可用：${e instanceof Error ? e.message : e}`);

      return;
    }

    this.socket = socket;
    const sock = socket;
    sock.setNoDelay(true);
    sock.on("data", (chunk: Buffer) => this._onData(chunk));
    // 闭包捕获 sock：重绑路径会先 _teardown 换新 socket，老事件迟到时不许殃及新连接
    sock.on("error", (e: Error) => {
      if (this.socket !== sock || this.dead) return;
      this.log("[hotkeys] portal socket error:", String(e?.message ?? e));
      this._teardown("error");
      this._status("failed", `门户连接断开：${e?.message ?? e}`);
    });
    sock.on("close", () => {
      if (this.socket !== sock || this.dead) return;
      this._teardown("closed");

      if (this.state === "ready") this._status("failed", "门户连接已断开（会话关闭）");
    });

    try {
      await this._call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "Hello", "", [], 8000);
      this._send({ type: 1, destination: "org.freedesktop.DBus", path: "/org/freedesktop/DBus", interface: "org.freedesktop.DBus", member: "AddMatch" },
        "s", ["type='signal',interface='org.freedesktop.portal.Request',member='Response'"]);
      this._send({ type: 1, destination: "org.freedesktop.DBus", path: "/org/freedesktop/DBus", interface: "org.freedesktop.DBus", member: "AddMatch" },
        "s", [`type='signal',sender='${DESKTOP}',interface='${IFACE}'`]);

      // CreateSession：同步拿 request 句柄，再等 Response 里的 session_handle
      const token = `quaver${Date.now().toString(36)}`;

      const [requestPath] = await this._call(DESKTOP, OBJ, IFACE, "CreateSession", "a{sv}", [
        { handle_token: { sig: "s", value: token }, session_handle_token: { sig: "s", value: "quaver" } },
      ]);

      const resp = await this._waitSignal({ interface: "org.freedesktop.portal.Request", member: "Response", path: wireText(requestPath ?? "") }, 15000);

      if (resp.code !== 0) throw new Error(`CreateSession 被拒（code ${resp.code}）`);
      this.sessionPath = resp.results.sessionHandle;

      if (!this.sessionPath) throw new Error("CreateSession 未返回 session_handle");

      // BindShortcuts：规范 v2 形态 a(sa{sv})；上古 v1 门户不认就降级 a{sv}（键名即 id）重试一次
      const shortcutsV2 = shortcuts.map((s) => {
        const props: ShortcutProps = { description: { sig: "s", value: s.description ?? "" } };

        if (s.trigger) props.preferred_trigger = { sig: "s", value: s.trigger };

        return [s.id, props] as const satisfies readonly [string, ShortcutProps];
      });

      let bindRequest: WireValue | undefined;

      try {
        [bindRequest] = await this._call(DESKTOP, OBJ, IFACE, "BindShortcuts", "oa(sa{sv})sa{sv}", [
          this.sessionPath, shortcutsV2, "",
          { handle_token: { sig: "s", value: `${token}b` } },
        ], 15000);
      } catch (e) {
        if (!/UnknownMethod|UnknownInterface|InvalidArgs/i.test(String(e instanceof Error ? e.message : e))) throw e;
        this.log("[hotkeys] portal v2 BindShortcuts rejected, trying legacy v1 a{sv}");
        [bindRequest] = await this._call(DESKTOP, OBJ, IFACE, "BindShortcuts", "oa{sv}sa{sv}", [
          this.sessionPath,
          // v1：键名即 shortcut id，值是 variant 包着的属性表（a{sv}），同样只有 description / preferred_trigger
          Object.fromEntries(shortcuts.map((s) => {
            const value: ShortcutProps = { description: { sig: "s", value: s.description ?? "" } };

            if (s.trigger) value.preferred_trigger = { sig: "s", value: s.trigger };

            return [s.id, { sig: "a{sv}", value }] as const satisfies readonly [string, WireVariant];
          })),
          "",
          { handle_token: { sig: "s", value: `${token}b` } },
        ], 15000);
      }

      const bindResp = await this._waitSignal({ interface: "org.freedesktop.portal.Request", member: "Response", path: wireText(bindRequest ?? "") }, 0);

      if (bindResp.code !== 0) throw new Error(`快捷键绑定被取消（code ${bindResp.code}）`);
      // Response.results.shortcuts 是**实际绑上**的子集 —— 桌面端会把与系统占用冲突的
      // 首选触发串静默丢弃（如 Hyprland 的 Ctrl+Alt+←/→ 切工作区）。差集回传给调用方提示。
      const boundIds = new Set(bindResp.results.shortcuts.map(([id]) => wireText(id)));
      const missing = shortcuts.flatMap((s) => (boundIds.has(s.id) ? [] : [s.id]));
      this._status(missing.length ? "partial" : "ready", missing.length ? `未绑上（可能被其他应用占用）：${missing.join("、")}` : "", missing);
      this.log(`[hotkeys] portal ready: ${boundIds.size}/${shortcuts.length} shortcuts${missing.length ? `（未绑上：${missing.join(", ")}）` : ""}, session ${this.sessionPath}`);
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e);

      const unsupported = /UnknownMethod|UnknownInterface|InvalidArgs|AccessDenied/i.test(msg)
        || /CreateSession timeout/.test(msg);

      this._teardown("error");
      this._status(unsupported ? "unsupported" : "failed", msg);
    }
  }

  _onData(chunk: Buffer) {
    this.acc = this.acc.length ? Buffer.concat([this.acc, chunk]) : chunk;

    while (true) {
      let msg: Message | null;

      try { msg = parseMessage(this.acc); } catch (e) {
        this.log("[hotkeys] portal bad message:", String(e instanceof Error ? e.message : e));
        this.acc = Buffer.alloc(0);

        return;
      }

      if (!msg) return;
      this.acc = this.acc.subarray(msg.consumed);
      this._dispatch(msg);
    }
  }

  _dispatch(msg: Message) {
    if (msg.type === 2 || msg.type === 3) { // method_return / error
      const p = this.pendings.get(msg.replySerial);

      if (!p) return;
      this.pendings.delete(msg.replySerial);
      clearTimeout(p.timer);

      if (msg.type === 3) p.reject(new Error(msg.errorName || "dbus error"));
      else p.resolve(msg.body);

      return;
    }

    if (msg.type !== 4) return;

    if (msg.interface === "org.freedesktop.portal.Request" && msg.member === "Response") {
      const code = wireNumber(msg.body[0] ?? 1);
      const pairs = msg.body[1];
      const raw = wireDict(Array.isArray(pairs) ? pairs : undefined);
      const shortcuts = raw.get("shortcuts");

      const results: PortalResults = {
        sessionHandle: wireText(raw.get("session_handle") ?? ""),
        shortcuts: Array.isArray(shortcuts) ? shortcuts.filter(isWireEntry) : [],
        raw,
      };

      for (const w of [...this.waiters]) {
        const m = w.match;

        if (m.path && m.path !== msg.path) continue;

        if (m.interface && m.interface !== msg.interface) continue;

        if (m.member && m.member !== msg.member) continue;

        if (w.timer) clearTimeout(w.timer);
        this.waiters = this.waiters.filter((x) => x !== w);
        w.resolve({ code, results, msg });

        return;
      }

      // 没有等待者：method_return 的 await 续延还在微任务队列里 —— 先 stash，_waitSignal 来领
      if (msg.path && this.stashed.size < 8) this.stashed.set(msg.path, { code, results, msg });

      return;
    }

    if (msg.interface === IFACE && msg.member === "Activated" && this.sessionPath) {
      const [session, shortcutId] = msg.body;

      if (session !== undefined && wireText(session) === this.sessionPath) {
        try { this.onAction(shortcutId === undefined ? "" : wireText(shortcutId)); } catch (e) { this.log("[hotkeys] onAction failed:", String(e)); }
      }
    }
    // Deactivated / ShortcutsChanged / NameAcquired 等：暂无消费方，忽略
  }
}
