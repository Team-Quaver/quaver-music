# Spike #3 — 用 Node 版 qq-music-api 实现 SQ（无损 FLAC）播放

日期：2026-09-14 · 环境：Node v22.23.2 / @yakult-green-tea/qq-music-api 3.1.2 · 实验目录 `~/qq-node-spike`

## 背景与问题

当前后端为 Python sidecar（L-1124/QQMusicApi + FastAPI 适配层，:3200），打包引入 uv 工程 +
submodule，体积和维护面偏重。想验证：换回 Node 版 API（npm 包）能否做到

1. SQ 级别（FLAC 无损）音频播放；
2. 复用现有登录态（不重新扫码）。

## 结论速览（全部实测，非推测）

| 检查项 | 结果 |
| --- | --- |
| npm 安装 3.1.2 + 起服务 :3201 | ✅ 正常 |
| 复用 Python `credential.json`（musicid/musickey/refresh_key/encrypt_uin）种入注入式会话仓库 | ✅ `restoredCount: 1`，`/login/status` 返回真实 profile（Ne0W0r1d新界） |
| 账号会员态 | ✅ 超级会员（huge_vip，2026-07-25 ~ 09-25），`svip:1` |
| `GET /getMusicPlay/<mid>?quality=flac&mediaId=<media_mid>` | ✅ 免费曲与付费曲均返回 `F000….flac` 带 vkey URL |
| 流媒体内容 | ✅ **明文 FLAC**（首块 magic=`fLaC`），HTTP 与 HTTPS 双通、206 Range、`Content-Range` 正确 |
| 全文件下载解码（未来的主人翁 53,556,336 B = size_flac） | ✅ ffprobe 450.4s / 951kbps；ffmpeg 仅尾部 sync 警告（已知良性，见 spike-1） |
| quality 表 | m4a=C400 / 128=M500 / 320=M800 / ape=A000 / flac=F000（登录态与匿名路径同一张表） |
| 320mp3 档位 | ✅ 会员态下返回真实 M800 内容（与 spike-1 非会员降级行为一致地可对照） |
| OGG_640/O320（SQ ogg，F000 之外的另一无损形态） | ✅ Node 侧未暴露（无 `O801` 前缀映射），**Python SDK 支持**（`file_type=8/9` result=0，明文 OggS） |

## 关键实现细节（会话嫁接）

- `configureAuthSessionRepository({ kind, load, save })` 在 require 包后立刻注入；
  seed 记录形状 = `{token, credential, device, expiresAt}`（见 `types/root.d.ts`）。
- credential 字段必须用 **camelCase**：`musicid`、`musickey`、`refresh_key`、`loginType`、
  `encryptUin`（Python 的 `encrypt_uin` 直接抄会报 `Login credential is missing encryptUin`）。
- device 必须映射到 AndroidDevice 形状（`procVersion`←`proc_version`、`androidId`←`android_id`、
  `openUdid`←`open_udid`、`osRelease`/`sdk` 等）；`isAndroidDevice` 严格校验必填文本字段。
- `loginType` 取 6（Android QQ 通道）实测可用。
- 会话仓库会随 refresh 被调用 `save()`——宿主可落盘实现续期持久化。
- 复现脚本：`~/qq-node-spike/boot-with-python-credential.js`（PORT=3201 避开现有 sidecar）。

> 更新（2026-09-20）：**seed 的来源没有了** —— Python 侧已不落明文 `credential.json`（凭证改为
> Electron 主进程用系统密钥管理器加密保存，见 `ui/electron/keyring.mjs`）。要重跑这个 spike，
> 得改成从主进程拿凭证：要么走 `QCRED1` 交接管道（由主进程 spawn 时注入），
> 要么在 Electron 里 `safeStorage.decryptString(credential.enc)` 后按下面的 camelCase 形状种进仓库。

## 与现 Python 后端对比（能力/缺口）

Node fork 缺失、但 Quaver UI 现在依赖的端点（UI 调用点已盘点）：

| UI 依赖 | Python 后端 | Node fork |
| --- | --- | --- |
| `/search` 新 CGI | ✅ | ❌ 只有废弃的 `/getSearchByKey`（实测空）与 `/getSmartbox`（可用，可当联想/兜底搜索） |
| `/user/vip` 会员徽章 | ✅ | ❌ 无 VIP 端点 |
| `/song/like` 收藏写 | ✅ | ❌ |
| `/recommend/guess` 猜你喜欢 | ✅ | ❌ |
| `/song/{v}/lyric?trans=1` 翻译歌词 | ✅ | ⚠️ `/getLyric` 实测**能用**（返回 lyric 正文；翻译字段未验证） |
| `/songlist/{id}/like` | ✅ | ❌ |
| 登录续期（refresh_token） | ✅ 自动 | ⚠️ 有内部 refresh，但需宿主注入仓库才持久化 |

Node fork 独有优点：3.1.1 起自带 CDN 测速选节点（sjy6 优先 + GetCdnDispatch 兜底），
播放 URL 质量比裸 `dl.stream` 稳；包本身零外部运行时依赖（serverless 入口 0 npm 依赖），
且明确面向 Electron 嵌入（root 导出 = Electron lifeline）。

## 判断与建议

- **SQ 播放本身：Node 方案完全成立**（登录态 + flac 明文流 + `<audio>` 直出，无需 QMC）。
- **但整体回迁 Node = 倒退**：搜索/VIP/收藏/推荐都是现 UI 在用的能力，Python SDK 全覆盖。
- 更优路径是 spike-1 就预留的方向：**Electron 主进程直接 require 嵌入 API 进程内跑**
  （省掉 sidecar 子进程 = 用户感知的"重"），而不是在两种上游 API 之间二选一。
  - 若嵌入 Node fork：得到轻量 + SQ + 选路，但要自补搜索/VIP/收藏端点。
  - 若嵌入 Python：做不到进程内（语言不同），仍要子进程 → 除非后端换成 Node 重写调用层。
  - 折中（推荐）：保留现架构，仅把"播放取链 + CDN 选路"抽成 UI 侧薄逻辑；
    或等 Typhoeus 统一后端时一并做轻量化。
- mflac/QMC 加密档位（臻品母带/黑胶等）两版都不解密，与 SQ 无关，维持二期结论。

## 复现步骤

```bash
cd ~/qq-node-spike && npm i @yakult-green-tea/qq-music-api
PORT=3201 node boot-with-python-credential.js        # 嫁接 Python 登录态
curl -H 'x-qq-session: spike-<str_musicid>' \
  'localhost:3201/getMusicPlay/002yOAU6197RAE?quality=flac&mediaId=001S6Gwm2gM9BP'
curl -sL '<purl>' -o t.flac && ffprobe t.flac       # fLaC 明文, 450s
```
