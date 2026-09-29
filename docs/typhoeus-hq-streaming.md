# Typhoeus — 高音质流传输（仅限会员）实现记录

> **口径更新（2026-09-29，Go sidecar）**：下文「加密档三重拦截、不解密」是
> Python 时代的策略。Go 版 Typhoeus（`vendor/Typhoeus-go`）已支持 **QMC 加密档
> 流式解密播放**：明文档优先、加密档兜底（取 ekey → `qmc.NewCipherFromEkey` →
> 按绝对偏移逐块解密），解密仅驻内存、不落盘（合规口径不变：不做下载/整曲缓存）。
> 实现见 `typhoeus/quality.go`（档位表）、`typhoeus/resolver.go`（协商+嗅探）、
> `typhoeus/stream.go`（Range 中继+解密）、`qmc/`（Map/RC4/TEA，unlock-music
> 官方向量 + `tools/qmc_ref.py` 跨语言对拍双锚点）。本文其余部分保留作历史记录。

日期：2026-09-14 · 分支：`feat/high-end-quality`（主仓 + vendor/Typhoeus submodule）

## 结论

高音质档位（无损 SQ、OGG 640、臻品音质/全景声/母带）在**会员登录态**下由腾讯
直接下发**明文流**（首块 magic `fLaC`/`OggS`，带 vkey 无 ekey）——播放它们不需要
解密。Typhoeus 因此实现为：档位协商 + 会员门控 + Range/206 明文中继；**QMC 加密
档位（mflac/mgg）三重拦截拒绝，全链路无解密代码**（可缓存不可被解密）。

## 实测矩阵（超级会员账号，2026-09-14，`scripts/probe_tiers.py`）

| 档位 | 前缀 | 结果 |
| --- | --- | --- |
| 128/320 mp3 | M500/M800 | 明文（会员回真实 M800 内容，size 差 2.5x） |
| FLAC（无损 SQ） | F000 | 明文 fLaC |
| OGG 640/320（SQ/HQ） | O801/O800 | 明文 OggS（个别曲 404=无此资源 → 触发降档回退） |
| 臻品音质/全景声 5.1 | Q000/Q001 | 明文 fLaC |
| 臻品母带 Hi-Res | AI00 | 明文 fLaC（164-184 MB/曲，result=104003=该曲无母带） |
| NAC 自研 codec | TL01 | 非白名单容器（`NAC_`）→ 嗅探拒绝（Web 解码器不可用） |
| 加密 FLAC | F0M0 | 带 ekey、首块乱码 —— **策略层拒绝，不请求、不解密** |

非会员/匿名：高档被降级或 104003（spike-1 已证）；故 UI 门控必须以后端
`/stream/tiers`（`user.get_vip_info` → svip/huge_vip/vip）为准，不能只信本地。

## 架构

```
ui (api.ts getPlayUrl → /api/stream/resolve → <audio> src=/api/stream/<token>)
 └ relay.ts / native-server.mjs：/api/stream/* 流式管道（Range 透传，不缓冲）
    └ sidecar (quaver_server/streaming.py 薄接线)
       └ vendor/Typhoeus (包：quality/provider/resolver/stream/adapters.qqmusic)
          └ vendor/QQMusicApi (SDK：GetVkey 明文档位；不碰 GetEVkey/ekey)
```

- 会员门控：显式选高档+会员不足 → 403（UI 保留选择、提示开会员，勿静默降档）；
  `auto=true` → 链裁剪到可及最高档。
- 曲目缺高档资源（104003/404）→ rank 回退链逐档取链（degraded=true 徽章 `→无损 SQ`）。
- vkey 不出后端：浏览器只见随机 token；token 滑动过期 2h；中继透传 CDN 的
  206/416/Content-Range（`<audio>` seek 全兼容，headless Chrome 实播验证）。

## 加密曲解密播放复现（Go 版，以 DECO*27《モニタリング/视奸》为例）

《视奸》（mid `001bRxNB2j59Ly`，VOCALOID 曲库典型 VIP 加密源）在客户端里的
播放路径 = 搜索 → resolve（flac 档）→ 若明文 F000 缺失/被拒则走 F0M0 加密档 →
ekey 解密流播。登录态下的 curl 复现序列（sidecar 由 Electron 主进程拉起 :3200，
或 dev 态 `go run ./cmd/quaver-server` + main 交接凭证）：

```bash
# 1. 搜索定位（匿名可用）
curl -s 'http://127.0.0.1:3200/search?keyword=视奸' | jq '.data.song[0] | {mid, name}'
#    → 001bRxNB2j59Ly モニタリング DECO*27

# 2. 档位表（会员门控数据源：locked / requires / encrypted）
curl -s http://127.0.0.1:3200/stream/tiers | jq '.data.all_tiers'

# 3. 协商 flac：明文 F000 优先，被拒自动试加密 F0M0（响应 encrypted=true 即解密流）
curl -s -X POST http://127.0.0.1:3200/stream/resolve \
  -H 'Content-Type: application/json' \
  -d '{"mid":"001bRxNB2j59Ly","tier":"flac","auto":true}' | jq .

# 4. Range 播放（token 中继透传 CDN；解密按绝对偏移，seek 任意位置无缝）
curl -s -r 0-15 "http://127.0.0.1:3200$(jq -r .data.path <(curl -s -X POST \
  http://127.0.0.1:3200/stream/resolve -H 'Content-Type: application/json' \
  -d '{"mid":"001bRxNB2j59Ly","tier":"flac","auto":true}'))" | xxd | head -1
#    → 首块应为 "fLaC…" 魔数（解密正确性由 SniffPlain 在协商时先行校验）

# 未登录冒烟边界（2026-09-29 实测）：匿名 resolve 返回上游 result=104003
# （QQ 音乐目录政策：取链需登录），门控语义与搜索/档位表链路不受影响。
```


## 顺手修复（Py 时代历史）

`POST /song/urls` 旧路径：per-item `file_type` 默认 MP3_128 会**静默覆盖**批量
档位（SDK `item.file_type or file_type` 优先级）→ 未显式指定时传 None。修复后
`file_type=7` 实测回 `F000….flac`（修复前回 M500）。

## 验证记录（全部真实执行）

- Typhoeus 单测 19 passed（假 provider，无网络）。
- curl：tiers/resolve/206/后缀 range/416/451(加密档拒绝)/422/降档 degraded。
- headless Chrome（scripts/typhoeus-smoke.mjs）：flac/640ogg/master/320/128/auto
  六档 currentTime 前进、duration 261s 对、src 走 `/api/stream/`；播放条徽章
  「无损 SQ」；设置页 9 张档位卡（会员全解锁）。
- 旧冒烟 scripts/smoke.mjs 全 PASS（唯一 400 为歌词端点上游 24001，改动前即存在）。
