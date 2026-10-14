// Quaver — 内置歌词引擎的接线
//
// 「内置」指的是**能力归属**（宿主的歌词实现，不是 vendor/Sparkle 里的插件），
// 不等于「必须挤进首屏 bundle」：AMLL core 约 400KB，仍然按需用动态 import 拉，
// vite 给它单独切 chunk —— 和它作为官方插件时的加载形状一致，正在播放页要歌词时它才到。
//
// 到位顺序不要紧：注册表里插件提供器排在内置之前（sparkleKaraokeProvider 先查插件），
// 而注册/换人都会 emitChange → player 对当前曲补拉一次歌词，所以先后只会多一次重解析，
// 不会漏解析。
import { setBuiltinKaraokeProvider } from "../sparkle/registry";

/** 把内置 AMLL 登记为歌词提供器的兜底实现（失败 = 回退宿主行级歌词 DOM，不拦启动）。 */
export async function registerBuiltinLyrics(): Promise<void> {
  const { builtinKaraokeProvider } = await import("./amll");
  setBuiltinKaraokeProvider(builtinKaraokeProvider);
}
