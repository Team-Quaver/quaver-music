// Quaver — 本地音乐缓存的渲染层半密钥与状态口。
//
// 约束：这不是下载功能。缓存数据与索引由 Typhoeus-Go 落盘加密；前端 seed 是解密钥匙的
// 另一半，只存 localStorage，并且与账号绑定 —— 换账号自动换 seed，旧缓存自然解不开。
import { api } from "./api";
import { cfg } from "./config";

const SEED_KEY = "quaver.musicCache.seed.v1";
const SEED_OWNER_KEY = "quaver.musicCache.seed.owner.v1";

function randomSeed(): string {
	const b = new Uint8Array(32);
	crypto.getRandomValues(b);

	return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function musicCacheSeed(accountKey?: string): string {
	let seed = localStorage.getItem(SEED_KEY) ?? "";
	const storedOwner = localStorage.getItem(SEED_OWNER_KEY) ?? "";
	// resolveStreamUrl 不带账号键（歌曲上下文不持有账号），此时沿用当前已绑定
	// 的 owner；只有调用方显式换了账号才触发半种轮换。
	const owner = accountKey ?? storedOwner;

	if (seed.length >= 32 && (accountKey === undefined || owner === accountKey)) return seed;
	// 已绑定过别的账号时必须换半种：后端会随 seed 变化作废旧账号的缓存。
	if (seed.length < 32 || (owner !== "" && owner !== accountKey)) seed = randomSeed();
	localStorage.setItem(SEED_KEY, seed);
	localStorage.setItem(SEED_OWNER_KEY, owner);

	return seed;
}

export async function syncMusicCacheSeed(accountKey = ""): Promise<void> {
	const seed = musicCacheSeed(accountKey);
	const limitMB = Number(cfg("Playing.MusicCacheLimitMB", "2048")) || 2048;

	try {
		await api("/cache/seed", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ seed }) });
		await api("/cache/music/limit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bytes: limitMB * 1024 * 1024 }) });
	}
	catch { /* sidecar 未起/未登录：下次 resolve 再试 */ }
}

export interface MusicCacheStatus { items: number; bytes: number; limit_bytes?: number }

export const musicCacheStatus = (): Promise<MusicCacheStatus> => api<MusicCacheStatus>("/cache/music/status");

export const clearMusicCache = (): Promise<MusicCacheStatus> =>
	api<MusicCacheStatus>("/cache/music/clear", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ seed: musicCacheSeed() }),
	});

export const setMusicCacheLimit = (bytes: number): Promise<MusicCacheStatus> =>
	api<MusicCacheStatus>("/cache/music/limit", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ bytes }),
	});
