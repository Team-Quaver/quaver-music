# Quaver 音频架构计划（2026-10-29）

> 状态：Draft。本文只记录方案、边界和验收条件，不改变现有许可证、播放链路或打包配置。
>
> 本文不是法律意见。涉及许可证变更、第三方代码复用和发行合规时，应由版权持有人确认，
> 必要时咨询律师。
>
> **许可证决策（2026-10-29）：继续使用 AGPL-3.0-only。** 主应用与
> `quaver-audio-core` 统一采用 AGPL-3.0-only，不再拆分 LGPL 核心。

## 1. 结论

### 1.1 技术方向

保留现有 MPV 链路作为兼容后端，同时抽出独立的共享音频核心：

```text
Quaver / Astra
    └── quaver-audio-core
          ├── engine      载入、播放、暂停、停止、seek、载入结果
          ├── decode      MPV 现在；FFmpeg 后续
          ├── output      WASAPI / PulseAudio / ALSA / CoreAudio
          ├── timeline    位置、时长、缓冲、曲末、代次
          ├── cache       有界内存窗口，不落盘
          └── dsp         音量、EQ、淡入淡出、效果链
```

第一阶段不替换 Quaver 的默认播放路径。先把 Astra 的 `Engine`、PCM 输出和
`loadGen/startGen/loadedGen` 模型抽成稳定接口，再按平台接入输出后端。

### 1.2 许可证方向

**决定：继续使用 AGPL-3.0-only。**

- 主应用、`quaver-audio-core`、Astra 音频模型和后续音频适配层统一采用
  AGPL-3.0-only。
- 不再为“让音频核心单独使用 LGPL”拆分双许可证。
- Astra 的 AGPL 代码可以在本 AGPL 项目内复用，但必须保留版权、许可证和来源说明。
- `ffmpeg-audio` 仍是 GPL-3.0-only；在本 AGPL 项目内组合时按 AGPL/GPL 的发行义务
  处理，保留第三方清单、许可证和源码获取方式。
- MPV/FFmpeg 随包二进制仍按其实际构建选项确认是 LGPL 还是 GPL，并随发行包提供
  对应声明。

如果未来要把音频核心单独提供给非 AGPL 项目，应另立 RFC 和许可证方案；不在本次
音频迁移中处理。

## 2. 当前实现盘点

### 2.1 Quaver 现有链路

Quaver 渲染层只依赖 `Transport` 接口：

- `ui/src/lib/transport.ts`
  - `WebTransport`：浏览器 `<audio>` 兜底。
  - `EngineTransport`：主进程 MPV 引擎。
  - `PcmEngineTransport`：MPV 解码 + renderer AudioWorklet 输出。

主进程音频引擎：

- `ui/electron/audio/engine.ts`
  - `native`：MPV 自己打开音频设备。
  - `pcm`：MPV `--ao=pcm` 写入命名管道/FIFO，renderer 消费 PCM。
  - `epoch`、`pcmReady`、`pcmClientReady`、`endGate` 等状态机已经存在。
- `ui/electron/audio/mpv-ipc.ts`
  - MPV JSON IPC、命名管道、`loadfile/pause/seek/volume/audio-device`。
  - 当前原生模式使用 `--audio-exclusive=no`，即 WASAPI 共享模式方向。
- `ui/electron/audio/pcm-pipe.ts`
  - Windows 命名管道、POSIX FIFO、背压和看门狗。
- `ui/src/lib/pcm-sink.ts`
  - AudioWorklet 环形缓冲、音量、EQ、频谱、跨曲淡出和代次校验。
- `ui/electron/audio/eq-config.ts`
- `ui/electron/audio/eq-core.ts`
  - Quark EQ 的共享模型、滤镜串和 APO 解析。

现有测试和护栏：

- `ui/scripts/verify-mpv.ts`
- `ui/scripts/verify-eq.ts`
- `ui/scripts/verify-playback-end.ts`
- `ui/scripts/verify-bundle.ts`

这些测试的价值很高，迁移时不能只保留“能出声”的冒烟测试。

### 2.2 Astra 现有音频模型

Astra 的播放器只依赖 `Engine` 接口：

- `internal/player/player.go`
  - `OpenURL`、`Play`、`Pause`、`Stop`、`SeekTo`、`Position`、`Duration`、
    `Loaded`、`LoadError`、`LoadErrorFatal`、`OnObserve`。

Astra 的音频实现：

- `internal/audio/mpv.go`
  - MPV 常驻进程、JSON IPC、原生直出/兼容模式。
  - `loadGen`、`startGen`、`loadedGen`、`loadErrGen` 处理异步载入和旧事件回灌。
  - `start-file`、`file-loaded`、`end-file` 的代次归属清楚。
  - MPV 0.38 `loadfile` 参数布局差异有自愈逻辑。
- `internal/audio/engine_pcm.go`
  - `pcmOutput`、PCM 管道、代次、音量、EOF、设备侧消费位置。
- `internal/audio/pcm_speaker.go`
  - 应用侧 PCM 输出抽象：`Start/Play/Close`。
- `internal/audio/pcm_speaker_windows.go`
  - 纯 syscall WASAPI 共享模式输出。
  - `AUDCLNT_STREAMFLAGS_EVENTCALLBACK`
  - `AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM`
  - `AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY`
- `internal/audio/pcm_speaker_pulse.go`
  - 纯 Go PulseAudio native 协议输出。
  - `REQUEST` 许可做背压。
- `internal/audio/pcm_speaker_alsa.go`
  - PulseAudio 不可用时的 Linux ALSA 兜底。

Astra 的 `internal/audio` 目前**没有 `pcm_speaker_darwin.go`**。macOS 上仍然是 MPV
自己打开音频设备，或者由外部播放路径决定输出；没有可复用的 CoreAudio PCM 输出后端。

### 2.3 macOS 当前状态

Quaver 目前已经有 macOS 的 MPV 运行时和打包配置：

- `ui/electron/audio/bins.ts`
  - 解析 `mpv.app/Contents/MacOS/mpv`。
- `ui/scripts/stage-mpv-official.ts`
  - 只处理 macOS arm64。
  - 校验 Mach-O 最低系统版本，避免低版本 macOS 被 dyld 拒绝。
- `ui/electron/audio/macho.ts`
  - 读取 `LC_BUILD_VERSION.minos` / `LC_VERSION_MIN_MACOSX`。
- `ui/scripts/mpv-assets.ts`
  - macOS 地板是 14.0，资产选择 macos-14 arm 包。
- `packages/macos/arm64.yml`
  - 配置了 DMG，但 `identity: null`，签名/公证尚未接。

但 macOS 的音频核心仍然是缺口：

- 没有 CoreAudio / AudioUnit / AudioQueue / AVAudioEngine 输出后端。
- 没有 macOS 设备枚举和默认设备变化监听。
- `pcm` 兼容模式实际把 PCM 交给 renderer AudioWorklet，输出由 Electron/Chromium 的
  CoreAudio 路径完成，不是共享核心自己的输出层。
- 没有 macOS 的进程级/系统级捕获验证。macOS 没有 WASAPI，不能把 Windows 的
  “应用音频捕获”语义直接照搬。
- `ui/README.md` 仍说明 Windows/macOS 打包未接；Astra 已有 Windows/macOS 构建，
  但 Quaver 自身的打包链路仍需补齐。

### 2.4 Windows 当前状态

- Astra 的 WASAPI 后端是共享模式，方向正确。
- 当前只打开默认输出设备，没有指定设备。
- 没有默认设备变化监听和设备失效重建。
- 队列满时丢最旧数据，异常时会造成跳音。
- 没有 Windows 真机 CI；CI 只在 Linux 上跑测试，Windows 只交叉编译。
- OBS、Discord、Kook、Oopz、黑盒语音的捕获行为必须分别实测：
  - 设备 loopback 与应用音频捕获不是同一种能力。
  - WASAPI 独占模式不能 loopback；共享模式才是捕获前提。

### 2.5 Linux 当前状态

- Astra 的 PulseAudio native 实现比 WASAPI 实现更完整。
- 有 fake server 测试，覆盖协议版本、建流字段、背压和错误应答。
- 仍然只连默认 sink，不能选择设备。
- Flatpak 已声明 `--socket=pulseaudio`，见
  `packages/flatpak/red.0w0.quaver.yml`。
- ALSA 只应作为 PulseAudio/PipeWire 不可用时的兜底，不能默认强占 `/dev/snd`。

## 3. 许可证决策

### 3.1 事实

| 项目 | 当前许可证 | 对当前 AGPL 项目的影响 |
| --- | --- | --- |
| Quaver 主仓库 | AGPL-3.0-only | 继续作为主许可证 |
| `vendor/Typhoeus-go` | AGPL-3.0 | 与主项目同向，保留许可证和版权 |
| `vendor/Sparkle` | AGPL-3.0 | 与主项目同向，保留许可证和版权 |
| AMLL / lyric-kit 相关代码 | AGPL-3.0 | 与主项目同向，保留来源说明 |
| Astra `internal/audio` | AGPL-3.0 | 可在本 AGPL 项目内复用，需保留来源 |
| `apoint123/ffmpeg-audio` | GPL-3.0-only | 可在 AGPL 项目内组合，但需保留 GPL 声明和源码义务 |
| FFmpeg 本体 | LGPL-2.1+ 或 GPL-2+，取决于构建选项 | 只有不含 GPL 组件的构建才是 LGPL |
| MPV | 默认 GPL-2+；可构建 LGPL-2.1+ | 作为外部进程使用，仍需按发行方式合规 |

### 3.2 决策记录

已确认：

- `Jhennan Li` 与 `Ne0W0r1d` 为同一自然人。
- `LMFuture` 已同意项目继续使用 AGPL-3.0-only；建议把沟通记录归档，便于后续审计。
- 本轮不更换许可证，因此不触发 `CONTRIBUTING.md` 中“更换开源许可协议”的 RFC。
- 后续所有音频模块继续按 AGPL-3.0-only 发布，不再设计 LGPL 分支。

仓库历史显示：

- `Ne0W0r1d` / `Jhennan Li`：同一自然人。
- `LMFuture`：29 个提交。
- `github-actions[bot]`：20 个提交。

继续 AGPL 后仍需完成：

1. 保留历史版本的 AGPL 授权，不删除旧的 `LICENSE` 和版权声明。
2. 确认所有第三方依赖、随包二进制和字体/图标资源的许可证。
3. 对复用 Astra/第三方代码的文件保留来源、版权和许可证说明。
4. 若未来改许可证，再按 `CONTRIBUTING.md` 发起 RFC。

### 3.3 代码来源审计

“AI 生成”不等于“没有版权”或“可以任意改变来源”：

- AI 生成代码的版权归属取决于司法辖区、生成工具的服务条款和人类编辑程度。
- 继续使用 AGPL 不要求追溯代码是否由 AI 生成，但复用第三方代码时仍要保留来源。
- 如果生成时参考、复制、改写 AGPL/GPL 代码，输出仍可能受原许可证约束。
- 建议保存生成记录、来源链接和人工修改记录，至少能证明代码来源。

### 3.4 推荐的许可证边界

采用单一许可证边界：

```text
Quaver 主应用（AGPL-3.0-only）
  └── quaver-audio-core（AGPL-3.0-only）
        ├── Astra AGPL 代码可在本 AGPL 项目内复用
        ├── ffmpeg-audio（GPL-3.0-only）组合时保留 GPL 声明和源码义务
        ├── MPV/FFmpeg 随包二进制按其实际构建许可证声明
        └── 随发行包提供 AGPL 源码、许可证和第三方清单
```

如果未来要把 `quaver-audio-core` 单独发布给非 AGPL 项目，必须另立项目、另做许可证
审计和 RFC；本次音频架构不承担这个目标。

### 3.5 许可证待办

- [x] 确认 `Jhennan Li` 与 `Ne0W0r1d` 为同一自然人。
- [x] 记录 `LMFuture` 同意继续 AGPL-3.0-only。
- [x] 决定主应用与音频核心统一继续 AGPL-3.0-only。
- [ ] 建立 `LICENSES/` 或 `THIRD_PARTY.md` 的完整清单。
- [ ] 对复用 Astra 代码做来源和版权标注。
- [ ] 对 `ffmpeg-audio` 保留 GPL-3.0-only 声明，并明确源码获取方式。
- [ ] 确认 MPV/FFmpeg 随包二进制是 LGPL 还是 GPL 构建。
- [ ] 确认 DMG/NSIS/AppImage 的许可证和源码提供方式。
- [ ] 将本次许可证决策记录到项目文档或 Issue，便于后续追溯。

## 4. 目标音频核心

### 4.1 对外接口

建议共享核心暴露最小接口，并保留可选能力接口：

```go
type Engine interface {
    Open(url string, opts LoadOptions) error
    Play()
    Pause()
    Stop()
    Seek(sec float64)
    Close()

    Snapshot() Snapshot
    Events() <-chan Event

    SetVolume(v float64)
    SetMute(muted bool)

    ListDevices() ([]Device, error)
    SetDevice(id string) error

    SetEffects(chain EffectChain) error
}
```

可选接口：

```go
type GaplessEngine interface {
    Preload(next Track) error
    CancelPreload()
}

type CaptureAwareEngine interface {
    CaptureCapabilities() CaptureCapabilities
}
```

事件至少包括：

- `loaded`
- `load-error`
- `ended`
- `buffering`
- `playing`
- `paused`
- `device-lost`
- `device-changed`
- `timeline`

### 4.2 代次规则

必须统一以下代次，不能只靠时间戳猜：

- `load_id`：每次 `Open` 递增。
- `start_id`：解码器确认开始后盖章。
- `loaded_id`：载入成功时盖章。
- `pcm_epoch`：PCM 输出会话代次。
- `seek_id`：每次 seek 递增。

只有带当前代次的 `loaded`、`error`、`ended` 才能影响当前 UI。旧代次的迟到事件必须丢弃。

### 4.3 缓存和流式

- 只保留有界内存窗口，不落盘。
- 前向窗口和回看窗口分开配置。
- 上游断流、Range 重试、首包超时和欠载状态要有明确事件。
- seek 不能依赖“排空多久”的时序猜测，必须通过代次隔离。
- 若未来要做离线缓存，放到独立的曲库/下载模块，不混进播放缓存。

### 4.4 效果链

- 音量、EQ、淡入淡出、limiter 放在输出前。
- EQ 参数变更不能重启解码器。
- 继续复用 Quaver 的 `eq-config.ts` / `eq-core.ts` 模型和 APO 导入。
- 效果链的 bypass 必须是真正 bypass，不能留下旧滤镜。
- 输出后提供只读 tap，供频谱和电平显示；tap 不能阻塞实时线程。

## 5. 平台计划

### 5.1 Windows

目标：

- WASAPI 共享模式。
- 默认设备和指定设备都支持。
- 设备变化时自动重建流。
- 事件驱动 + `GetCurrentPadding` 背压。
- 48kHz / stereo / float32 作为内部格式，设备格式不同则用 `AUTOCONVERTPCM` 或
  `AudioConverter` 转换。

验收：

- 耳机插拔后能恢复。
- 默认设备切换后能跟随。
- OBS 设备捕获可用。
- OBS 应用音频捕获、Discord/Kook/Oopz/黑盒语音分别实测并记录。
- 多实例不会抢同一命名管道或同一设备会话。

### 5.2 Linux

目标：

- PulseAudio / PipeWire native 默认路径。
- ALSA 仅作兜底。
- 支持默认 sink 和指定 sink。
- 服务重启、sink 消失、Flatpak 权限场景可恢复。

验收：

- PulseAudio fake server 测试继续保留。
- PipeWire 真机 smoke test。
- Flatpak `--socket=pulseaudio` 下可播。
- 不使用 `/dev/snd` 独占作为默认路径。

### 5.3 macOS

目标：

- 新增 `output/coreaudio_darwin.go`。
- 首选 CoreAudio `AudioUnit` 或 `AudioQueue` 输出。
- 设备枚举和默认输出设备变化监听。
- 48kHz / stereo / float32 内部格式；设备格式不同时用 `AudioConverter`。
- 位置使用 CoreAudio 时间戳或实际消费帧数，不用纯墙钟。
- 捕获能力按 macOS 版本单独测试：
  - ScreenCaptureKit 系统/应用音频捕获。
  - Core Audio process tap（新系统，需按实际版本验证）。
  - OBS 桌面音频捕获。
  - Discord 等应用的实际捕获行为。

实现选择：

- 若 `purego` 能安全承载 CoreAudio 实时回调，优先纯 Go + purego。
- 若实时 render callback 在 purego 下不稳定，允许把 CoreAudio 适配放在独立
  Rust/C sidecar 中，但要在计划中明确“该后端不满足无 CGO”的例外。
- 在 CoreAudio 后端成熟前，macOS 继续使用 MPV 原生输出作为兼容路径。

打包验收：

- `packages/macos/arm64.yml` 的 DMG 能产出。
- 签名、公证、Hardened Runtime 和 `identity` 配置明确。
- 随包 `mpv.app` 的 Mach-O 地板仍为 macOS 14.0。
- 低版本 macOS 不会被 dyld 拒绝。
- Apple Silicon 真机播放、暂停、seek、切歌、EQ、设备切换通过。

## 6. 分阶段迁移

### Phase 0：来源与第三方审计

- 确认贡献者和版权归属。
- 确认 Astra/FFmpeg-Audio/MPV/FFmpeg 的许可证边界。
- 建立第三方清单。
- 记录“继续 AGPL-3.0-only”的决策。

### Phase 1：抽共享核心，保留 MPV

- 把 Astra 的 `Engine` 接口、`loadGen/startGen/loadedGen`、`pcmSpeaker` 抽象抽成
  独立模块。
- 保留 MPV 作为参考后端。
- 给 Quaver 增加适配层，不替换现有 `Transport`。
- 保留 Quaver 的 `epoch`、`endGate`、`PcmSink` 行为测试。

### Phase 2：macOS CoreAudio

- 新增 CoreAudio 输出后端。
- 补设备枚举、默认设备变化、时间戳位置。
- 用 MPV PCM 模式验证应用侧输出。
- 做 OBS 和系统音频捕获实测。

### Phase 3：Windows/Linux 输出硬化

- WASAPI 指定设备、设备失效重建、真背压。
- PulseAudio sink 选择、服务重启。
- 统一设备接口和错误模型。

### Phase 4：FFmpeg 解码

- 先做 FFmpeg CLI + 独立 PCM 输出 spike。
- 验证 MP3/FLAC/OGG/128/320、Range、seek、切歌、换音质。
- 再评估 FFmpeg-Audio。
- 若使用 `ffmpeg-audio`，优先独立 sidecar；如选择进程内组合，必须按
  GPL-3.0-only 与 AGPL-3.0-only 的双重发行义务处理。

### Phase 5：Quaver/Astra 双适配

- Quaver 通过 Electron sidecar 或本地 IPC 接共享核心。
- Astra 直接依赖 Go 核心。
- 两端共用协议版本、代次语义和测试向量。

### Phase 6：灰度与回退

- 按平台灰度默认后端。
- 保留 MPV 原生和浏览器 `<audio>` 回退。
- 监控启动失败、设备失败、缓冲欠载和曲末重复。
- 达到验收条件后再考虑移除默认 MPV。

## 7. 验收条件

### 功能

- 播放、暂停、停止、seek、切歌、换音质、窗口重建接管。
- 单曲循环、列表循环、随机、无限电台。
- 跨曲淡入淡出和无缝切换。
- EQ、preamp、APO 导入、bypass。
- 设备枚举、指定设备、默认设备变化。
- 流式缓存、断流恢复、Range seek。

### 捕获

- Windows：OBS 设备捕获、OBS 应用捕获、Discord/Kook/Oopz/黑盒语音分别记录。
- Linux：PulseAudio/PipeWire 普通 client 捕获。
- macOS：ScreenCaptureKit / Core Audio tap / OBS 桌面音频分别记录。
- 任何“能捕获”的结论都必须注明捕获方式、系统版本和应用版本。

### 稳定性

- 连续切歌 100 次无旧代次回灌。
- 快速连续 seek 不产生旧音频尾巴。
- 设备插拔、默认设备切换、服务重启可恢复。
- 暂停/恢复不产生长时间静音或时间轴漂移。
- 退出后没有残留 MPV、PCM helper 或音频设备会话。

### 许可证

- 每个发行包都包含 `LICENSE`、`THIRD_PARTY.md` 和对应源码/获取方式。
- 音频核心继续标注 AGPL-3.0-only。
- `ffmpeg-audio` 的 GPL-3.0-only 声明和源码义务随发行包保留。
- 历史 AGPL 版本的授权不被撤销。

## 8. 非目标

- 不在本计划中直接修改当前 `LICENSE`。
- 不拆分 LGPL 音频核心；若未来需要，另立 RFC 和项目。
- 不承诺所有捕获软件都支持“按应用捕获”。
- 不把整曲持久化缓存混进播放缓存。
- 不在 macOS CoreAudio 后端未验证前删除 MPV 兼容路径。

## 9. 待确认问题

1. `ffmpeg-audio` 作为独立 sidecar，还是重写解码适配层？
2. macOS 最低支持版本是否继续是 14.0？
3. macOS CoreAudio 是否允许使用 purego；若不允许，是否接受独立 sidecar？
4. Windows 首批要支持哪些捕获软件和哪些系统版本？

## 10. 参考

- Quaver：
  - `ui/src/lib/transport.ts`
  - `ui/electron/audio/engine.ts`
  - `ui/electron/audio/mpv-ipc.ts`
  - `ui/electron/audio/pcm-pipe.ts`
  - `ui/src/lib/pcm-sink.ts`
  - `ui/electron/audio/eq-config.ts`
  - `ui/electron/audio/eq-core.ts`
  - `ui/scripts/verify-mpv.ts`
  - `ui/scripts/verify-eq.ts`
  - `ui/scripts/verify-playback-end.ts`
- Astra：
  - `internal/player/player.go`
  - `internal/audio/mpv.go`
  - `internal/audio/engine_pcm.go`
  - `internal/audio/pcm_speaker.go`
  - `internal/audio/pcm_speaker_windows.go`
  - `internal/audio/pcm_speaker_pulse.go`
  - `internal/audio/pcm_speaker_alsa.go`
- 外部项目：
  - `apoint123/ffmpeg-audio`
  - `mpv-player/mpv`
  - `FFmpeg/FFmpeg`
  - `go-musicfox/go-musicfox`（仅作多引擎架构参考）
