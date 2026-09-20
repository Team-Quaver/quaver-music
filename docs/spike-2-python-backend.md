# Spike #2 — 后端切换到 L-1124/QQMusicApi（Python）

日期：2026-09-13 · 环境：Fedora 44 / Python 3.12 (uv) / qqmusic-api-python 0.7.2（vendor submodule @3740170）

## 为什么换

- 旧 Node fork（@yakult-green-tea）搜索端点已废、歌词无翻译、无 VIP 协议、
  歌单详情 `check privacy error`。
- L-1124/QQMusicApi（GPLv3+）覆盖搜索（新 CGI）、歌词带翻译/逐字解密、
  `user.get_vip_info` 会员协议、歌单读写、排行榜、歌手主页等，且自带完整 Web 层参考实现。
- 与 README 协议声明一致：项目 AGPLv3+，上游 GPLv3+ 兼容。

## 形态

- `vendor/QQMusicApi` = git submodule（pin commit）；
  `vendor/Typhoeus/`（uv 工程，原 `api-server/`，2026-09 并入 Typhoeus）以 path
  依赖安装 `qqmusic-api-python`。
- `vendor/Typhoeus/quaver_server/`：薄 FastAPI 适配层（不做上游那套限流/缓存/多账号池——
  单机 sidecar 用不上），监听 :3200（与旧口一致，relay 无感）。
  - `run.py` 启动；`session.py` 管 Client 生命周期。
  - 登录凭证 = SDK `Credential`（musicid+musickey…），QR `DONE` 时由 sidecar
    写 `~/.config/quaver/credential.json`(0600)，浏览器全程拿不到 token。
  - 设备指纹 `~/.local/state/quaver/device.json`（SDK device_path）。
  - `CredentialInvalidError` → 自动 `login.refresh_credential()` 重试一次

> 更新：这两个文件后来统一挪进了系统配置目录（Linux `~/.config/quaver-music/`，与 `quaver.conf` 同目录），
> 旧的 `~/.config/quaver`、`~/.local/state/quaver` 在首次运行时自动搬迁。见 `ui/electron/config.mjs`。

> 更新（2026-09-20，凭证归属）：**凭证明文不再落盘**。`session.py` 已不读写 `credential.json`，
> 改由 Electron 主进程独占保存：磁盘上只有密文 `credential.enc`，钥匙在系统密钥管理器里
> （KWallet / GNOME Keyring / 钥匙串 / DPAPI，见 `ui/electron/keyring.mjs`）。启动时主进程通过
> stdin 注入一行 `QCRED1 {json}`，sidecar 登录/刷新/登出时从 stdout 交回；不设
> `QUAVER_CREDENTIAL_MODE=external` 时（手工单跑）为 memory 模式 —— 只驻内存、关掉即需重登。
> 上面的「QR DONE 时由 sidecar 写 credential.json」是当时的实况，保留作历史记录。
    （refresh_token 续期是 Python 库的硬优势）。
- 响应信封 `{code:0,msg:"ok",data}`；UI `api()` 统一解包，错误抛 `ApiError(msg)`。

## 端点映射（旧 Node → 新）

| 旧 (yakult) | 新 | 说明 |
| --- | --- | --- |
| /login/qr/key+/create+/check | /login/qrcode/{qq\|wx\|mobile} + /status | event: 0 DONE,1 SCAN,2 CONF,3 TIMEOUT,4 REFUSE；mobile 走 MQTT 由 sidecar 后台消费 |
| /user/detail | /user/me（get_homepage） | |
| 无 vip 数据 | /user/vip | 豪华绿钻/绿钻/超级会员徽章自此有源 |
| /user/liked-songs | /user/liked?page&num | 走 user.get_fav_song(dirid=201) |
| /getMusicPlay | POST /song/urls {file_info,file_type} | file_type 整数表（13=128mp3,12=320mp3,7=FLAC…）；响应 items[].url 已拼 CDN（含 get_cdn_dispatch 调度）|
| /getLyric（fork 无翻译） | /song/{value}/lyric?trans=1 | SDK 带 qrc 解密 |
| /getSongListDetail（privacy error） | /songlist/{id}/detail?page&num | 实测 170 首分页全出 |
| /getSearchByKey（废） | /search?keyword&type / /search/general / /search/hotkey / /search/complete | 新搜索 CGI |
| /getSingerHotsong | /singer/{mid}/songs | |
| /getAlbumInfo | /album/{mid}/detail + /songs | |
| 无 | /recommend/guess /recommend/songlist /top/… /song/like|unlike | 个性化推荐、榜单、真实收藏写 |
| /logout | POST /login/logout | 上游登出 + 清本地凭证 |

## 实测结论（headless Chrome + 真实网络）

- 匿名可播免费曲（paytype=0）：`/song/urls` result=0 → `<audio>` 实播
  currentTime 前进、时长对（In the Dark 184s）✅。
- VIP 曲匿名 result=104003（无权限）— UI 明示"取链接失败"，属预期降级。
- 搜索偶发 429「触发风控, 需登录或者安全验证」= 上游对匿名高频的指纹要求，
  登录态调用即恢复；UI 按错误显示。
- 播放跨视图不中断（hash 路由切换 7.7s→8.9s 连续）✅。
- QR：qq/wx/mobile 三通道出码正常；status 轮询/锁/过期事件全通。

## 遗留 / 下一步

- 加密档位（mflac/mflac24/OGG 加密 = QMC）：SDK `EncryptedSongFileType` 能拿到
  ekey/url，但解密要外挂（二期：本地解密代理流）。档位选择 UI 已就绪（设置页）。
- 会员权益探测（sa/vip 位 → 可用档位）目前只在 UI 显示徽章，播放降级未做逐曲预判。
- `ui/AGENTS.md` 的 sidecar 约定条目需人工更新（保护文件，未自动改）。

## 复现步骤

```bash
git submodule update --init
cd vendor/Typhoeus && uv sync && uv run run.py        # :3200
./scripts/qq-login.sh mobile                     # 终端扫码（或应用内登录页）
curl -s localhost:3200/login/status | jq
curl -s "localhost:3200/search?keyword=%E5%91%8A%E7%99%BD&num=3" | jq '.data.song[0].name'
cd ../ui && npm run dev -- --port 5173 --strictPort --host 127.0.0.1
node scripts/smoke.mjs                           # headless 全链路冒烟
```
