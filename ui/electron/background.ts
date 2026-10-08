// Quaver — 自定义背景图（默认主题）的读盘侧：把 quaver.conf 里记的那张图交给界面。
//
// 为什么走 HTTP 路由（/api/bg）而不是 file:// 或自定义协议：页面 Origin 是 http://127.0.0.1，
// Chromium 不许 http 页面跨 scheme 取本地文件；而「渲染层要拿本地文件」在本仓库已有既定通路 ——
// /api/sparkle/plugin/<id>/<file>（dev/preview 见 src/relay.ts，打包态见 electron/native-server.ts，
// 两处同构）。同源、不走 IPC 传大 buffer、不把图片塞进 data: URL（一张 4K 壁纸的 base64 是几 MB 的
// 字符串常驻内存，还会随配置一起写盘）。
//
// 安全边界（三条一起才成立，缺一条就是「开放文件读取」）：
//   ① 路径**只**来自 quaver.conf 的 Style.BackgroundImage —— 请求里的任何参数都不参与拼路径，
//      所以渲染层（含万一被 XSS 的页面）没法指定读哪个文件；
//   ② 扩展名白名单（BG_IMAGE_EXTS）：手改配置文件也读不到 /etc/shadow 这类没有图片后缀的东西；
//   ③ 只读**普通文件**且有体积上限：否则拿 /dev/zero 或一个几 GB 的视频文件当路径，一次请求
//      就能把主进程读爆。
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import { BG_IMAGE_EXTS, configFile, readValues, type Env } from "./config.ts";

/** 单张背景图上限 40MB：4K 壁纸绰绰有余，再大基本是误选了。 */
export const BACKGROUND_MAX_BYTES = 40 * 1024 * 1024;

const MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
};

/** 扩展名（小写、带点）→ mime；不在白名单里返回 null（= 这个文件不许走背景图通路）。 */
export function backgroundMime(file: string): string | null {
  return MIME[extname(String(file ?? "")).toLowerCase()] ?? null;
}

/** 原生「选择图片」对话框的扩展名过滤器：与 schema 的白名单同源，别各写一份。 */
export const BG_DIALOG_EXTENSIONS: string[] = [...BG_IMAGE_EXTS];

export interface BackgroundInfo {
  /** 配置里的路径（原样，可能为空） */
  path: string;
  /** 现在能不能真的拿出来用 */
  exists: boolean;
  /** 不能用的原因（给人看的一句话） */
  error?: string;
}

/** 当前配置里的背景图路径。配置文件还不存在时不落盘（读值会顺手写模板 —— 一条 GET 不该改磁盘）。 */
export function backgroundPath(env: Env = process.env): string {
  if (!existsSync(configFile(env))) return "";
  return String(readValues(env).values["Style.BackgroundImage"] ?? "").trim();
}

/** 设置页「图片」一行要显示的现状：路径 + 文件在不在（不在就提示重选）。 */
export function backgroundInfo(env: Env = process.env): BackgroundInfo {
  const path = backgroundPath(env);
  if (!path) return { path: "", exists: false };
  if (!backgroundMime(path)) {
    return { path, exists: false, error: `不是支持的图片格式（只认 ${BG_IMAGE_EXTS.join(" / ")}）` };
  }
  try {
    const st = statSync(path);
    if (!st.isFile()) return { path, exists: false, error: "不是一个普通文件" };
    if (st.size > BACKGROUND_MAX_BYTES) {
      return { path, exists: false, error: `图片超过 ${Math.round(BACKGROUND_MAX_BYTES / 1024 / 1024)}MB` };
    }
    return { path, exists: true };
  } catch {
    return { path, exists: false, error: "文件不存在或读不了" };
  }
}

/** /api/bg 的完整应答（两个服务端各写各的 res，逻辑只有这一份）。 */
export interface BackgroundResponse {
  status: number;
  type: string;
  body: Buffer;
}

const jsonBody = (status: number, msg: string): BackgroundResponse => ({
  status,
  type: "application/json",
  body: Buffer.from(JSON.stringify({ code: -1, msg: `bg: ${msg}` })),
});

/** 读出背景图本体。任何一步不成立都给一个明确的 status —— 界面侧只看「加载成功/失败」。 */
export function backgroundResponse(env: Env = process.env): BackgroundResponse {
  const info = backgroundInfo(env);
  if (!info.path) return jsonBody(404, "未设置自定义背景");
  if (!info.exists) return jsonBody(404, info.error ?? "不可用");
  try {
    return { status: 200, type: backgroundMime(info.path) as string, body: readFileSync(info.path) };
  } catch (e) {
    return jsonBody(500, String(e));
  }
}
