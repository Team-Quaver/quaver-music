## Development

Vite MPA（无框架）。启动 dev server 用后台模式：

```sh
pnpm run dev -- --port 5173 --strictPort --host 127.0.0.1
```

健康检查：`curl -s http://127.0.0.1:5173/index.html | head -5` 应返回 HTML；
`curl -s http://127.0.0.1:5173/api/login/status` 验证中继（需 sidecar :3200 在跑，
否则返回 502 JSON 也算中继活着）。

## TypeScript 与 Node 24（全仓无构建步骤）

`ui/` 下**没有裸 JS 源码**：`electron/**`、`scripts/**` 全是 `.ts`，`src/**` 本来就是。运行方式
靠 Node 24 的原生类型剥离（strip-only）——`node scripts/verify-x.ts`、`electron .` 直接跑源码，
**没有 tsc 产物、没有 outDir**。三条硬约束（写错就是启动时炸，不是类型报错）：

- **相对导入必须写全 `.ts` 扩展名**：Node 的剥离不做路径改写，`"./config.js"` 或裸 `"./config"`
  一律 `ERR_MODULE_NOT_FOUND`。`allowImportingTsExtensions` 让 tsc 也认这种写法。
- **只能用可擦除语法**：`enum` / `namespace` / 构造器参数属性 / 旧式装饰器在 strip-only 下抛
  `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`。`tsconfig.node.json` 的 `erasableSyntaxOnly` 让 tsc 提前拦。
  类字段**必须显式声明**（`lines: string[];`）——`.ts` 不会从构造器赋值推断属性，这是主要迁移成本。
- **preload 必须是 `.cts`**（不是 `.ts`）：Electron 按扩展名分流 preload（`lib/renderer/init.ts`：
  `path.extname(p) !== '.mjs'` → 走 Node 的 `Module._load`），且 **preload 忽略 `type: module`**，
  所以 `.ts` 在 `"type": "module"` 包里是 ESM 语义、顶层 `require` 不存在。`.cts` 强制 CJS-TS，
  正好落在 Electron 的 CJS 分支 + Node 的剥离器上。

两套 tsconfig：`tsconfig.json` = 渲染层（`src/**`，浏览器语义）；`tsconfig.node.json` = Node 侧
（`electron/**` + `scripts/**`，nodenext + 上述开关，`lib` 含 DOM 是给 puppeteer `page.evaluate` 回调用的）。

```sh
pnpm run typecheck       # 渲染层，必须 0 错（build 闸门）
pnpm run typecheck:node  # Node 侧，迁移中：尚未清零，不作闸门
```

**verify 脚本的自毁陷阱**：不少断言是**读源码文本做正则**（`readFileSync("electron/config.ts")`
再 `.test()`）。给被测源码加类型标注会静默打坏这类断言（真实踩过：`valid: (v) =>` 改成
`valid: (v: string) =>` 后 verify-sidebar 立刻红）。改类型时**顺手跑一遍 verify:static**。

## Conventions

- 页面 = 根目录 `<name>.html` + `src/entries/<name>.ts`；新页面要同时加进
  `vite.config.ts` 的 `PAGES`。
- 页面脚本第一行必须 `mountLayout("标题")`（注入顶栏/侧栏/播放条并搬运 `.page` 内容），
  之后才可查询页面 DOM。
- `/api/*` 由 `src/relay.ts`（vite 插件中间件，dev 与 preview 都挂）转发 sidecar :3200 —— 纯透传 +
  封面取色代理；凭证只在主进程与 sidecar 之间流转（**永不进渲染层、也永不落明文**，见下节）。

## 凭证存储（系统密钥管理器）

真相在 `electron/keyring.ts`（零依赖、不 import electron，可单测）。三条硬约束：

- **`--password-store` 必须在 `app ready` 之前钉死**（`main.ts` 顶层 `appendSwitch`）：Chromium
  只在初始化时读一次，ready 之后再改是空操作。自定义合成器（Hyprland/sway）不在 Chromium 的桌面
  白名单里 → 不显式钉就会静默退到 `basic_text`（硬编码口令的假加密，而 `isEncryptionAvailable()`
  仍然返回 true）。探测顺序：桌面名 → `/proc` 里的守护进程 → 钱包/keyrings 目录 → 保守试 Secret Service。
  探测只负责**选开关**，真正算数的是 ready 之后的 `getSelectedStorageBackend()` 校验。
- **凭证归属在 Electron 主进程**（打包态）。main 把已存凭证写进 sidecar 的 stdin（`QCRED1 {json}` /
  `QCRED1 null` 一行），sidecar 登录/刷新/登出时从 stdout 交回同一格式 → main 加密落盘。
  前缀常量两侧必须逐字一致：`ui/electron/keyring.ts:HANDOFF_PREFIX` ↔
  `vendor/Typhoeus/quaver_server/session.py:HANDOFF_PREFIX`（含末尾空格，verify:keyring 会比对）。
  sidecar 侧只在 `QUAVER_CREDENTIAL_MODE=external` 下启用（stdin 阻塞读、save/clear 改交接）；
  不设该变量（手工单跑）= memory 模式，什么都不落盘。
- **日志卫生**：sidecar 的 stdout 是混着的 —— 必须**先按行切**（`drainLines`）**再判前缀**，
  凭证行走 `applySidecarCredential`，其余才 `log()`。日志文件里凭证一个字符都不许出现
  （`credentialSummary` 只报 musicid 与字段长度）。同理绝不用 stderr 传凭证。

三级降级与边界：`keyring` → **`memory`（只驻内存，绝不退明文）**。`CredentialStore` 值域里没有
`file`，源码里也没有任何写出明文的路径（`verify:keyring` 有源码级护栏）。解不开的 `credential.enc`
**不删**（可能只是这次没拿到钥匙）；遗留明文**回读校验通过才删**，且只在明文比存档新时才导入
（更旧的残留不许顶掉新登录态）。设备指纹 `device.json` 不是密钥，保持明文。

**开发态也走同一条交接通道**（踩过一次）：`pnpm run app` 时主进程自己拉起
`vendor/Typhoeus/run.py`（优先 `.venv/bin/python`，退回 `uv run`），必须在 vite 加载**之前**拉
（`relay.ts` 在模块加载时读一次 `QUAVER_API`）。手工起的 sidecar 拿不到交接管道 → 只能 memory 模式，
所以**不要再手工起 sidecar 并期望登录被持久化** —— 环境里已有 `QUAVER_API` 时主进程不抢，并在日志里说明。
打包态与开发态的启动方式只在 `sidecarCommand()` 一处分叉，凭证通道完全一致。

## 配置持久化（quaver.conf）

真相在 `electron/config.ts`：平台路径规则、INI 解析（保注释）、schema 默认值与值域、原子落盘。
渲染层经 `src/lib/config.ts` 读写（桌面端过 preload 的 `quaverConfig` 桥，浏览器 dev 回落 localStorage）。

- 目录：Linux `~/.config/quaver-music`｜Windows `%AppData%\Quaver Music`｜macOS `Application Support/Quaver Music`；
  `QUAVER_CONFIG_DIR` 可整体顶掉（主进程也用它下发给 sidecar，两边规则必须一致：
  `ui/electron/config.ts:configDir` ↔ `vendor/Typhoeus/quaver_server/session.py:_config_dir`）。
- 加新设置项：改 `electron/config.ts` 的 `SCHEMA` + `src/lib/config.ts` 的 `FALLBACK`
  + `src/lib/prefs.ts` 的类型化 getter/setter（三处都要动）。**例外**：只有主进程消费的项
  （`[Security]` 三项）只需前两处，渲染层不加 getter。
- 字体两项是 **CSS font-family 列表**（空串 = 不覆盖，合法）。写入统一走 `setUiFontList` /
  `setLyricFontList`（逐字符输入 → `cfgSetSoon` 合并 400ms）。设置页 = 预设下拉 + 可直编输入框，
  两边靠 `fontKeyOf` 反向匹配同步；`fontCssOf` 负责把 `sans` 这类预设名简写展开成族列表
  （直接塞进 CSS 变量是无效声明）。`normalizeFontList` 是前端清洗（allowlist，比后端更严）。
- 打包态页面跑在**固定端口**（`main.ts:STABLE_PORT`）：origin 稳定，Chromium 的
  localStorage/IndexedDB/Cache 才能跨启动延续；端口被占时 native-server 自动回落随机端口。
- `app.setPath("userData")` 钉在配置目录，必须在任何 `app.getPath("userData")` 之前执行。
- 跨页导航一律 `.html` 后缀绝对路径（Vite dev 对 `/foo.html` 与 `/foo` 都可解析；
  壳层直接加载 dist 文件时只有 `.html` 形式可用）。
- 播放全局对象 `window.QuaverPlayer` 由 `PlayerBar()` 挂载。

## 默认主题的背景（关闭 / 封面 / 自定义图 + 模糊强度）

设置→外观→背景。三档模式 = `Style.Background`（`off` / `cover` / `custom`），自定义图的路径 =
`Style.BackgroundImage`（原生选图写入的绝对路径），模糊强度 = `Style.BackgroundBlur`（px，0..120，
默认 70）。**默认 `off`**（只有主题底色，不铺环境色层）—— 注意这条只在「键缺失 / 全新配置 / 恢复默认」
时生效：conf 是首启按模板**物化**出来的，跑过的机器上那行已经写死了，不会被改默认值搬动。

- **渲染层分工**：`src/lib/prefs.ts` 只管「枚举 ⇄ 配置取值」；DOM 归 `src/lib/ambient.ts`
  （建 `.ambient` 层、按 `data-mode` + `--ambient-blur` / `--ambient-scale` 应用、监听换曲）。
  改完偏好要自己调 `applyBackground()`。**界面染色不在这一节**（见下节「界面高亮色」）：
  那条与背景同源（都可能取同一张封面）但彼此独立 —— 关掉背景不该把界面高亮色一起关掉。
- **图片怎么到界面**：走同源 `/api/bg`，与 `/api/sparkle/plugin/<id>/<file>` 同一套路
  （dev/preview = `src/relay.ts`，打包态 = `electron/native-server.ts`，两个服务端共用
  `electron/background.ts:backgroundResponse`）。**不走 data: URL**（4K 壁纸的 base64 是几 MB 的字符串
  常驻内存）、**不过 IPC 传 buffer**、**不用 file://**（页面 Origin 是 http，Chromium 不许跨 scheme 取本地文件）。
- **安全边界**（三条一起才成立，`verify-background` 逐条反向锁定）：
  ① 路径只来自 `quaver.conf` —— 请求里的任何参数都不参与拼路径，渲染层无法指定读哪个文件；
  ② 扩展名白名单 `BG_IMAGE_EXTS`；③ 只读**普通文件**且有 40MB 上限（否则 `/dev/zero` 一次请求读爆主进程）。
- **两种图两种观感**（`style.css` 的 `.ambient[data-mode=…]`）：`cover` 是「环境色」，强模糊 +
  提饱和/提亮只取色彩倾向 → 压到 55% 不透明；`custom` 是用户自己挑的图，满不透明且**不额外调色**。
  扩边系数（`--ambient-scale`）随模糊一起收放 —— 扩边只为盖住 `blur()` 边缘发白，不模糊时白裁一圈图。
- 选图是 Electron 专属（原生对话框）：浏览器 dev 下没有 `window.quaverBackground`，设置页给提示、
  不给假按钮；`/api/bg` 在纯浏览器下读的是磁盘 conf（localStorage 里那份不参与），故也不出图。
- 验证：`node scripts/verify-background.ts`（读盘侧真文件真 HTTP + 源码接线护栏，已进 `verify:static`）。

## 界面高亮色（tint）：固定青色 / 跟随封面 / 自定义

设置→外观→高亮颜色。三档 = `Style.Tint`（`default` / `cover` / `custom`），自定义色的取值 =
`Style.TintColor`（`#rrggbb`，默认 `#19c2d8`）。**默认 `default` = 固定青色，不跟封面跑。**

- **染色只有一个来源**：`src/lib/tint.ts`（`shell.ts` 在 `bootShell` 里调 `bootTint()`）。一次写
  5 个变量，全部由同一个源色派生：`--cvg-accent` / `--cvg-glow`（`toUiColors`，UI 高亮：选中态、
  激活描边、条目洗底…）；`--cvg-bar-fill` / `--cvg-bar-line`（`toBarColors`，播放条已播区与拖拽 seek
  的边线 —— 「亮度另调过」的那一版）；`--np-hl`（播放页歌词当前句，CSS 侧目前是注释掉的预留钩子）。
  清空时按 `TINT_VARS` 清单一起 `removeProperty`（别漏一个，否则留下「半套颜色」）。
- **别让任何组件自己从封面取色**：播放条原先就是这么干的（`PlayerBar` 里写 `--tint` / `--tint-line`，
  `.pb-fill` 读 `var(--tint)`），于是「高亮颜色」选固定色后界面变了、进度条还在跟封面跑。
  这类旁路不读 `--cvg-*`，只 grep `--cvg-` 的消费点是查不出来的 —— 动视觉令牌时一并 `grep --tint`。
- 颜色数学在 `src/lib/color.ts`（纯函数、无 DOM，可直接单测）：`parseHex` / `toHex` / `rgb2hsl` /
  `hsl2rgb` / `rgb2cmyk` / `cmyk2rgb`。**真相只有一个 RGB**，HSL/CMYK/HEX 都只是它的表示，落盘只存 HEX。
  两侧判据**故意不同**：`electron/config.ts:isHexColor` 严格（必须带 `#`），渲染层 `parseHex` 宽松
  （可省 `#`、认 3 位简写 —— 它判的是「输入框里正在敲的东西」）。只认十六进制，是因为这个值会进 CSS 变量。
- 选择器 = 自绘浮窗 `.tint-pop`（`absolute` 挂在 `.tint-slot`，即「自定义颜色」卡旁边）：HSL / CMYK / RGB
  三个模式（number 通道，两列 grid）+ 常驻 HEX 输入 + 一条彩虹色相条。展开/收起 = 点色块或点「自定义颜色」
  卡，「收起」缩回；非自定义档不给开（面板编的就是自定义色）。输入时**只刷显示位、不重建字段**（否则丢
  焦点），越界值在 blur 时校正。卡片 `hidden` 靠 `.opt-card[hidden]`，浮窗靠 `.tint-pop[hidden]`。
- 验证：`node scripts/verify-tint.ts`（纯逻辑往返 + 源码接线 + 反向自证，已进 `verify:static`）。
  加配置键时 `scripts/verify-config.ts` 的 `Object.keys(defaults()).length` 硬断言要一起改。

## 「跟随系统」深浅色（Linux 特有的坑）

渲染层只认 `matchMedia("(prefers-color-scheme: dark)")`（`src/lib/prefs.ts`），但**这个值由谁决定
是平台相关的**：Linux 上 Chromium 只按 GTK 设置判（`gtk-theme-name` 含 dark /
`gtk-application-prefer-dark-theme=true`），而 KDE 下那份 GTK 设置是 kde-gtk-config 写的
**静态快照**，不跟 KDE 配色方案联动 —— 实测 `kdeglobals` 的配色在 `noctalia` ⇄ `BreezeLight`
之间来回切，`~/.config/gtk-{3,4}.0/settings.ini` 里始终是 `adw-gtk3`（浅），于是「跟随系统」
永远是浅色。

所以这件事由**主进程**兜（`electron/systheme.ts`）：

- 探测真相：KDE 会话读 `kdeglobals` 的 `[Colors:Window] BackgroundNormal` 按亮度判（不猜方案名，
  「BreezeLight」「noctalia」这类名字没法可靠分类）；其他桌面读 GTK settings.ini 兜底；
  都拿不到返回 `null`，交回 Electron 自己判。
- `nativeTheme.themeSource` 只有 system/light/dark 三档，跟随系统时写成**探测到的** dark/light ——
  Electron 会把它同步给渲染进程的 `prefers-color-scheme`，**渲染层零改动**。
- 变化监听用 `fs.watchFile`（stat 轮询，1.5s）而不是 `fs.watch`：KDE 走 KConfig 重写文件，
  inode 会换，`fs.watch` 会跟丢。也别用 `nativeTheme` 的 `updated` 事件 —— themeSource 写死之后
  它不会再来，盯文件才是真来源。
- 主题偏好经 `quaver:config` 的 `set` 落盘时同步进主进程（`themePref`），`reset` 也要同步，
  否则切回明/暗固定档后还挂着探测值。
- 单测：`node scripts/verify-systheme.ts`（INI 解析 / 亮度判据 / 来源优先级 / 变化监听，真文件真解析）。

## 应用身份与图标（Linux 桌面集成）

窗口身份 app_id / WM_CLASS = `red.0w0.quaver`，**唯一真相是 package.json 顶层的 `desktopName`**：
Electron init 在任何用户代码之前读它并写进 `CHROME_DESKTOP`，X11 WM_CLASS 与 Wayland app_id 都取
它去掉 `.desktop` 后缀的值。主进程**不得**再手工 `app.setDesktopName()`（两处赋值迟早写岔，
`verify:icon` 有护栏）。`linux.executableName` 必须与 appId 一致——AppImage 内的二进制名、
desktop 文件名、`Icon=`、hicolor 图标文件名全部取自它，四方只能同源。

图标链：桌面环境按 app_id 反查 `<ID>.desktop` → `Icon=` → 图标主题。AppImage 裸跑与开发态没人
代装桌面文件/图标，`electron/linux-desktop.ts` 每次启动自装（幂等、失败只记账）：

- hicolor `<size>x<size>/apps/<ID>.png`（素材 `build-res/icons`，随 extraResources 进包）：
  内容一致就跳过；有实际写入后 best-effort 刷 `gtk-update-icon-cache`——有 icon-theme.cache 的
  系统不会自动重扫新文件（实测新装图标 GtkIconTheme 查不到，刷完立刻能查到）。
- `applications/<ID>.desktop` 三分策略：带 `X-Quaver-Managed` 标记 → 整份强制对齐；别人写的且
  Icon 已指向我们**且条目可见** → 让位不碰（集成工具的可见条目以它为准，避免启动器重复）；其余
  （含 `Icon=audio-x-generic` 这类通配名——Tela 下渲染成音符图标，Plasma 上看起来就是「图标坏了」）
  → 收编成我们托管的条目。
- **条目必须可见（禁用 NoDisplay/Hidden）**：Noctalia 解析 desktop 时整条丢弃隐藏条目
  （noctalia-dev/noctalia#4626），app_id 反查不到自己就会退到 id 尾段模糊匹配、撞上集成工具的
  旧条目，Dock/任务栏/切换器全丢图标。GNOME 的 `g_app_info_get_all` 连隐藏条目也索引且按精确 id
  优先，所以同一份文件在 GNOME 上看不出问题——别据此认为 NoDisplay 无害。想从启动器藏应用，
  用启动器自己的隐藏功能。
- `quaver` 是词典词（八分音符）：**图标名绝不能用裸 `quaver`**，会撞图标主题里的音符图标。

三平台打包图标：win/mac 的 `build.icon` 指向 build-res/icon.png（electron-builder 首次打包自动
转 ico/icns）；linux 用 build-res/icons 多尺寸集（16–512）。验证：`pnpm run verify:icon`。

## 托盘（图标 + 菜单）

托盘挂在**外壳**上（Linux 面板 / macOS 菜单栏 / Windows 通知区），不是挂在应用窗口里——两件事都
按这个前提判：

- **图标明暗**（`electron/tray-icon.ts` + `main.ts:trayAppearance`）：判据必须是「系统给外壳的
  颜色」，Linux 探测桌面配色、macOS 读 `AppleInterfaceStyle`、Windows 读注册表
  `HKCU\...\Themes\Personalize\SystemUsesLightTheme`（`systheme.ts:readWindowsShellTheme`）。
  两个**别用**的写法：
  - `nativeTheme.shouldUseDarkColors` —— 它跟着应用自己的 `themeSource` 走，而本应用默认主题是
    dark → 永远判成深色外壳，系统切浅色后菜单栏变浅、图标还是浅色那份，直接看不见。
  - Windows 上 `shouldUseDarkColorsForSystemIntegratedUI` —— 名义上正是「系统集成 UI 的深浅」，
    但 Electron 只在 native theme 通知到达时才去读注册表，其余时间**退回 `shouldUseDarkColors`
    （= 应用主题）**；`Personalize` 键 Open 失败时更是永远吃应用主题。表现就是托盘图跟着用户选的
    深浅色档位走（实测：浅色配浅色图标、深色配深色图标）—— 外壳判据最忌这个，所以 Windows 自己读
    注册表。刷新触发同理：注册表没有 mtime 可盯，`watchWindowsShellTheme` 定时轮询（2s），
    不能只等 `nativeTheme` 的 `updated`。
  尺寸统一 16pt 出图（mac 按点画 NSImage，直塞 512² 就是「托盘图标巨大」）。
- **菜单标题行**（`electron/tray-title.ts`）：`electron/tray-title.ts:trayTitleLine` 拼「歌名 -
  歌手」并按**显示列宽**截断（40 列，汉字记 2 列）。原因：Win32 HMENU 与 macOS NSMenu **都不折
  行**，菜单宽度 = 最宽那一项，一首长中文歌名 + 多位歌手就能把托盘菜单撑成横贯屏幕的一条；Linux
  面板宿主自己会打省略号，所以这个症状只在 win/mac 看得见——但**三平台同一份口径**，别为 win/mac
  另开分支（否则同一首歌在三个系统上显示成三样）。上限别调大来「修好」截断。
- 曲目行是 `enabled:false` 的纯展示项；命令一律回发渲染层（`quaver:mpris-cmd`），播放器仍是唯一
  事实源。

## Documentation

Vite guide: https://vite.dev/guide/
- Static sites / MPA: https://vite.dev/guide/static-deploy
- Backend for /api middleware: https://vite.dev/guide/backend-integration
- Proxy & server options: https://vite.dev/config/server-options
