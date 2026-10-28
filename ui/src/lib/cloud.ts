// Quaver — 微云音乐条目的本地化元数据操作（刮削信息 / 封面 / 歌词）。
//
// key 是 sidecar 按账号 + file_id 生成的稳定哈希；这里只操作该条目的展示元数据，
// 不暴露微云目录、上传、删除等通用文件管理能力。
import { api, bumpCloudCover } from "./api";
import { fileToBase64, pickFile } from "./local";

export interface CloudSongFingerprint {
  key: string;
  hasCover: boolean;
  lyricImport: boolean;
  importFormat: string;
}

export interface CloudMetaEdit {
  title: string;
  artist: string;
  album: string;
}

const notifyCloudChanged = (key: string) => {
  window.dispatchEvent(new CustomEvent("quaver:cloud-changed", { detail: { key } }));
};

export async function importCloudLyric(key: string, file: File): Promise<{ format: string; chars: number }> {
  const r = await api<{ format: string; chars: number }>("/cloud/lyric/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key, name: file.name, data: await fileToBase64(file) }),
  });

  notifyCloudChanged(key);

  return r;
}

export async function revertCloudLyric(key: string): Promise<void> {
  await api(`/cloud/lyric/import/${encodeURIComponent(key)}`, { method: "DELETE" });
  notifyCloudChanged(key);
}

export async function importCloudCover(key: string, file: File): Promise<void> {
  await api("/cloud/cover/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key, name: file.name, data: await fileToBase64(file) }),
  });
  bumpCloudCover(key);
  notifyCloudChanged(key);
}

export async function setCloudMeta(key: string, meta: CloudMetaEdit): Promise<void> {
  await api("/cloud/meta/set", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key, ...meta }),
  });
  notifyCloudChanged(key);
}

export async function triggerCloudScrape(opts: { keys?: string[]; all?: boolean; force?: boolean } = {}) {
  const r = await api<{ started: boolean; busy?: boolean; total: number }>("/cloud/scrape", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(opts),
  });

  notifyCloudChanged(opts.keys?.[0] ?? "");

  return r;
}

export const chooseCloudLyricFile = () => pickFile(".lrc,.qrc,.ttml,.xml,.txt");
export const chooseCloudCoverFile = () => pickFile(".jpg,.jpeg,.png,.gif,.webp");
