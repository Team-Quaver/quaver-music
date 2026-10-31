## Development

Vite MPA（无框架）。启动 dev server 用后台模式：

```sh
pnpm run dev -- --port 5173 --strictPort --host 127.0.0.1
```

健康检查：`curl -s http://127.0.0.1:5173/index.html | head -5` 应返回 HTML；
`curl -s http://127.0.0.1:5173/api/login/status` 验证中继（需 sidecar :3200 在跑，
否则返回 502 JSON 也算中继活着）。

## TypeScript 与 Node 24.22.1（全仓无构建步骤）

`ui/` 下**没有裸 JS 源码**：`electron/**`、`scripts/**` 全是 `.ts`，`src/**` 本来就是。运行方式
靠 Node 24.22.1 的原生类型剥离（strip-only）——`node scripts/verify-x.ts`、`electron .` 直接跑源码，
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
pnpm run lint            # anti-slop（vendored Oxlint 插件，配置在 .oxlintrc.json）
```

**anti-slop 代码口味闸门**：`tools/oxlint/anti-slop/` 是 vendored 规则仓（上游快照与本地定制见其
`UPSTREAM.md`）。`pnpm run lint:fix` 只做空行补白（require-readable-spacing 有同物理行豁免，紧凑单行
`if (c) { a; return; }` 不会被劈开）；其余规则（`SAFETY:` 断言注释、unknown 收口、flatMap 合并两趟遍历等）
要**真改**：不许用新断言/抑制注释洗过 lint。改被 `verify-*` 正则盯住的源码前后各跑一遍 `verify:static`（陷阱见下）。

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

## 播放流版权闸门（DevTools 保留，下载路径封死）

用户报告：设置 → 通用 → 调试 → 「开发者模式」开 DevTools 后，网络面板复制
`/api/stream/<token>`（新标签页 / Copy as cURL / 控制台 fetch）即可整曲拖走——加密档在后端
已解密成明文再出流，这直接击穿「只流媒体、不下载」立场。修法两层，**开发者的 Console/
Elements 不受影响**：

- 第一层 `ui/electron/stream-guard.ts`（主进程 webRequest，CSP 同层同法）：按 `resourceType`
  白名单收口——`media`（`<audio>` 元素）放行；`xmlhttprequest` 只放行**单段闭合 ≤64KiB 的
  Range 探测**（正在播放页音质浮窗取容器头）；地址栏/新标签页/另存为一律 cancel。
  `/api/song/urls`、`/api/song/<id>/url`（返回带 vkey 裸链的旧端点，渲染层零使用）对整页拉黑。
- 第二层 `vendor/Typhoeus-go/server/stream_guard.go`（后端兜底，本机 curl/直连 sidecar 端口
  伪造头也绕不开）：`Sec-Fetch-Dest` 分类同上，且 **mid 粒度令牌桶限速 ≈3× 实时码率**
  （resolve 带 `duration_ms` 提示；16MiB 突发覆盖起播预缓冲与 seek）。「下完一首 ≈ 听完
  一首」，一键批量抓曲失去意义；重复 resolve 换 token 刷不出额度（桶按 mid 跨 token 共享）。
- token 生命周期同步收紧：滑动空闲 30min + 绝对 3h（旧值 2h 滑动让复制走的地址长期有效）。
- 中继（`native-server.ts` / `relay.ts`）负责透传 `Sec-Fetch-Dest/Mode`，dev 与打包态同权。
- 诚实边界：本地播放的字节终归交给本地播放器，逐帧录制不在客户端威胁模型内；闸门针对的是
  「顺手整曲下载」的形态。验证：`node scripts/verify-stream-guard.ts`（已进 `verify:static`）
  与 `go test ./server/`（stream_guard_test.go）。

## 启动闪屏（splash）

主窗**先建、后等后端**：`createWindow` 一建窗就装载闪屏页（`data:` URL，零依赖、秒出画面），
sidecar 健康检查（最长 15s）与服务端就绪在后台进行；闪屏至少演完一遍全程（`SPLASH_MIN_MS`，
含底部署名）后淡出，随即导航到应用。**闪屏盖的是主程序自己的窗口**——同窗、同尺寸、同底色，
不是居中独立小窗。重建窗口（cachedUrl）与集成测试（QUAVER_URL）走 warmBoot，不放闪屏。

- 真相分三处：`electron/splash.ts`（loadSplash/dismissSplash；零 electron 值导入，裸 node 可载）、
  `electron/splash-page.ts`（模板拼装 / 图标 C2PA 元数据剥离 / 时序常量，纯逻辑）、
  `electron/splash.html`（模板，`__ICON__`/`__THEME__` 两枚占位）。
- 动画四段全在 CSS（居中淡入 → 左移 → 字标 → 底部「Built by Team Quaver」）；左移量 `--shift`
  由页内脚本用 `offsetWidth` 实测（布局量、不吃 transform），图标从画面正中出发、落回布局位不跳；
  `prefers-reduced-motion` 降级为纯淡入。
- **底色四方同源**：`SPLASH_BG_DARK/LIGHT` ⇄ `splash.html --bg` ⇄ 主窗 `backgroundColor` ⇄
  `style.css --bg`——交接是同一个窗口亮起内容，改任何一处都要对齐其余（verify-splash 逐字核对）。
- **闪屏绝不阻断启动**：模板/素材/拼装任一失败 = 记日志跳过；图标缺失 = 仅字标降级。
  `did-finish-load` 按 `data:` 分流（闪屏不算应用加载完成）；`did-fail-load` 忽略 `-3`
  （闪屏→应用的导航掐掉上一帧在途加载属正常时序）。
- 验证：`node scripts/verify-splash.ts`（已进 `verify:static`）。

## 歌词引擎（AMLL 内置）· 辅助行 · QRCKana 振假名

**AMLL 是宿主内置功能，不是插件**：`src/lyrics/amll.ts`（解析 + 渲染）、`src/lyrics/builtin.ts`
（把它交给注册表）、`src/lyrics/qrc-kana.ts`（振假名）。它曾经是「内置且不可停用的官方插件」，
为此攒了三层补丁（`OFFICIAL_META.required` + 启动强启 + `disableSparklePlugin` 中央闸口 + 设置页
锁开关），现在整体撤掉：歌词是能力，不该伪装成一个「摘不掉的插件」。

- 在位规则只有一条：`registry.ts:sparkleKaraokeProvider()` = **插件注册的提供器优先**，
  没有插件提供器时落到内置 AMLL（`?? builtinKaraoke`）。所以第三方仍能用
  `registerKaraokeProvider` 完整接管歌词（未来移植别的播放器逐字效果就走这条路），
  内置引擎本身没有开关、也不出现在设置页的插件列表里。
- 内置 ≠ 挤进首屏 bundle：AMLL core 约 400KB，`builtin.ts` 仍用动态 `import()`，vite 单独切
  chunk（和它当插件时的加载形状一致）。注册到位会 `emitChange` → player 对当前曲补拉一次歌词，
  这条既有链路负责「provider 晚到」的补齐，别改成静态 import 图省事。
- 已撤下的官方 id 记在 `loader.ts:RETIRED_OFFICIAL_IDS`，`init.ts:pruneRetiredOfficial()` 启动
  时把 `amll` 从启用集合 / 见过名单 / 显式停用名单里洗掉 —— 不洗，将来同名 id 的插件会莫名
  「已停用」或「不再默认启用」。
- **AMLL 的歌词是「自发光」的**：`.amll-lyric-player` 自带 `mix-blend-mode: plus-lighter`（文字给
  底色**加光**），未唱那半句与辅助行的「变淡」也是减 alpha 而不是换灰。这套口径的前提是背景恒为深色
  （本页原本就是模糊封面 + 深色遮罩）。谁把这一页换成**浅色**表面（Sparkle 主题接管，例：Lumen 的
  「随主题设置」档），往近白底色上加光 = 整层歌词洗白 —— 墨色、混合模式、`--dark-mask-alpha`、子行
  opacity 四处必须成套翻面，只改一项读不回来。桌面歌词窗早就摘掉了 plus-lighter（`desktop-lyrics.css`）。
  验证在 `scripts/verify-lumen-np.ts`（`pnpm verify:lumen-np`，先打包 marketplace）：真浏览器里把宿主
  style.css + AMLL style.css + 真实打包的主题 CSS 叠一起量像素，连「播放有影 / 暂停无影」的封面投影
  一起量（该特效的颜色必须由主题的 Tint 派生，纯黑投影压在深色表面上等于没画）。

### 歌词设置（[Lyrics] 段）· 繁简转换 · TTML 逐字库（本地目录 + 在线数据库）

设置页「歌词」tab 四件套（schema 键见 electron/config.ts，值域注释即口径）：

- `ChineseConvert`（off/simplified/traditional）→ `src/lib/cjk-convert.ts`：opencc-js 词典按方向
  动态 import（t2cn ~107KB、cn2t ~1.1MB 各一个懒 chunk —— **简→繁必须带短语级歧义**，
  纯字符表会把「头发」写成「头發」，别为省体积换成手写映射表）。
  **转换只发生在「文本进播放器」的口子**（player 的 QRC/LRC/TTML/本地合成各路解析前），
  磁盘缓存、手动导入原文一律不动；音译（roma）不转。档位变化必须 `resetCjkConverter()` +
  `player.reloadLyric()`（管线在拉歌词时才判档，不重拉 = 假即时生效）。
- `OnlineTtml`（默认开）+ `TtmlDatabase`（地址模板，默认 https://amlldb.bikonoo.com/%p/%s.ttml =
  AMLL TTML 数据库 amll-dev/amll-ttml-db 的实时镜像）→ 展开规则在 `src/lib/ttml.ts`：
  `%p` 展开平台目录（qq-lyrics / ncm-lyrics / am-lyrics / spotify-lyrics），`%s` = 该平台歌曲 id。
  **TTML 是「逐字补刀」不是抢答器**：只有当当前曲拿不到逐字内容（无 QRC、或只有行级）才查询；
  手动导入件恒跳过（导入 = 显式意图）。在线查询渲染层直连 fetch（公共静态库无凭证，CSP connect-src
  与镜像回显 Origin 的 CORS 都放行），**未命中记会话级负缓存**（TTL 10min），别改成每次都打。
- `TtmlLibrary`（本地库目录，非空即启用，无独立开关）→ 主进程路由 `GET /api/local/ttml`
  （electron/local/library.ts，dev/preview 与打包态两处同构挂载自动覆盖）：目录**只**吃 quaver.conf
  （同 /api/bg 红线，请求参数只产候选文件名，消毒 + 库内包含校验）；候选序 = 仓库布局
  `qq-lyrics/<songmid>.ttml` → id 平铺 → 「歌名-歌手/歌手-歌名/歌名.ttml」。优先级链：
  手动导入 > 本地 TTML 库 > 在线逐字（QRC/TTML）> 侧车 LRC/内嵌 —— 逐字优先是既有口径。
- 判据两侧同步：`isTtmlDatabaseUrl`（渲染层 src/lib/ttml.ts，输入框即时反馈）与
  `isTtmlDatabaseUrlTemplate`（electron/config.ts，写盘拦截）**同规**，改一处要改两处
  （先例：isHexColor/parseHex）。FALLBACK 表同样双写（verify-lyrics 有源码断言钉住）。
- 验证：`node scripts/verify-lyrics.ts`（模板展开/在线桩/负缓存/本地库路由真目录真配置/
  繁简真词典含歧义对拍/接线正则，已进 verify:static）。

### 辅助行（翻译 / 音译）

正在播放页歌词下方**只有一行**辅助行。两路数据（上游 `trans` 翻译、`roma` 音译=romaji/拼音）
都保留在解析结果里，**上屏哪一路**由「翻译选项」三档决定，规则只有一条：

- `off` 不显示；`translation` 优先翻译、本行没翻译则回落音译；`romanization` 优先音译、
  本行没音译则回落翻译。**按行**回落（不是整首二选一），所以只有翻译的歌与只有音译的歌都有的
  专辑不会开天窗。
- 音译**不是**词上方的 Ruby。Ruby 是日文振假名那种逐词注音，位置在词上；romaji/拼音属翻译区域
  （AMLL 的 `lyricSubLine`）。以前把音译挂词上，读逐字歌词时会在字上方刷一层拉丁字母，
  且和扫色高亮抢版面 —— 别再改回去。
- 上游辅助源里的 `//` 是「本行没有译文/音译」的占位，不是歌词，但**匹配时必须保留**：它和
  主歌词行一对一绑定，用来阻断邻行文本被就近借走。每条辅助源最多匹配一行、每行最多收一条；
  两路都没有时辅助子行整行收起，不能出现 `//`。辅助文本与主行原文完全相同也视为无效，不上屏。
- 同一条规则的实现收敛到**两处**（AMLL 进了宿主，直接 import `pickAux`，不再各抄一份）：
  `ui/src/lyric.ts:pickAux`（行级视图与内置 AMLL 共用）、
  `vendor/Sparkle/marketplace/flowscape/index.ts:auxText`（整页接管主题的逐字路径，在 vendor 里
  import 不到宿主）。`ui/src/sparkle/np-view.ts` 交出去的行级 `lyrics().trans` **已经**按档位挑好，
  视图不必判两路；`karaoke()` 给的是原始两路，渲染方自取。档位是宿主状态（`player.lyricAux`，
  持久化 `Style.LyricAux`），切档后行级靠 NowPlaying 重建 DOM（`lastAuxMode` 进重建条件），
  逐字靠内置引擎 rAF 里比 `shownMode`。

### 歌词延迟（按歌曲的歌词同步微调）

正在播放页 ⋮ 菜单的「歌词延迟」行：−/+ 步进（0.1s 一档，±10s），点数值归零。**按歌曲**区分，
是「本地数据」不是「设置」——与红心收藏 / 会话存档同路走 localStorage（键 `quaver.lyricDelay.v1`，
表 = mid → 毫秒；本地/NAS 曲的 mid 本身是 `local:<trackId>`，同为稳定身份键），不进 quaver.conf：
那是一歌一项的无界键集，INI schema 装它是错的形状。实现收在 `src/lib/lyric-delay.ts`
（惰性内存缓存 + 写穿，取值钳到 0.1s 粒度；0 删条目）。

- **符号约定**：正数 = 歌词更晚出现（滞后），负数 = 提前。调的是「歌词渲染器看到的时钟」，
  播放头/音频永远不动。
- **宿主不直接消费，一律透传**：`time()` 只含固定的 +0.2s 传输补偿，**不含**延迟；渲染方驱动
  时钟取 `time() − lyricDelay()`，「点击歌词行跳转」再加回真实播放位（`行时间 + lyricDelay`），
  点哪行屏幕才停在哪行。三条消费路同一个口径：内置 AMLL 与插件提供器经
  `SparkleKaraokeRenderCtx.lyricDelay()`（SDK 注释是契约文本）、整页接管视图经
  `SparkleNpViewCtx.lyricDelay()`（宿主端工厂在 `src/sparkle/np-view.ts`）、行级兜底视图由
  NowPlaying 在 notify 的当前行比对里扣减。
- **实时生效、不重建 DOM**：逐字渲染每帧现读 ctx；AMLL 的去抖钳平（防重同步回跳）对延迟变化
  要**重锚**放行 —— 0.1s 一档的倒退落进 250ms 钳平带里会被吞掉，调了等于没调（见 amll.ts
  feedTime 的 lastDelay 分支）。行级靠 applyLyricDelay 补一刀 `notifyPublic()`（暂停中 4Hz
  广播不在，行号得靠这次事件挪动）。
- **换曲即换值**：菜单每次打开现建读数；ctx 读的是 `player.current` 的当时值，没有「上一首的
  延迟粘到下一首」的可能。

验证：`node scripts/verify-sparkle.ts`（三方接线断言：SDK 契约 ↔ 宿主 ctx 工厂 ↔ AMLL/行级/
Flowscape 消费口径；已进 `verify:static`）；`pnpm run verify:lyric-delay`（活体：菜单步进/归零、
localStorage 按曲持久化与钳位、行级挪行与点击补偿、AMLL active 行随 ctx 重锚——需 dev server）。

### QRCKana（QRC 振假名注音）

日文逐字歌词的汉字上方假名**不在正文里**，而在 QRC 单独一行 `[kana: ...]` 标签里
（形如 `[kana:2きさ2ぶんがく]`：数字 = 这段读音覆盖几个可注音字符，`(起始,时长)` = 假名自己的
时间轴）。系统移植自 [SPlayer-Dev/lyric-kit](https://github.com/SPlayer-Dev/lyric-kit)
（AGPL-3.0，对齐口径 v0.6.1）的 `src/utils/kana.ts` + `src/parse/qrc.ts` 里对 `[kana:]` 的处理
—— **只取 QRCKana 这一套**，它的 KRC/YRC/LyS/SRT/ASS 解析、序列化、语言推断一概不要，
所以是手写移植而不是加依赖（加 `lyric-kit` 会把一堆用不上的解析器打进包）。移植要点：

- **可注音字符只有汉字**（CJK 统一表意 + 扩展 A + 々〆）：平/片假名自己不算（它们是注音素材、
  不是被注音对象），拉丁与空格也不算。所以「貴下の」的可注音流是 `貴 下`，`の` 不占配额。
- **数字按 token 计一位**（上游 v0.6.1 的修正，半角全角都算）：连续数字串「22」吃掉一个配额，
  「22/7」是两个 token 而不是三个字符 —— 逐字符数会让「27 組」这类读法的注音整体后移串位。
- 数字序列是**跨行的全局游标**：整首扫一遍字符流按序消费，写错一个 off-by-one 不报错，
  只是注音集体串位。空读音单元也照样吃掉字符位（那是「这几个字没注音」≠「这里无事发生」）。
- 标签必须**先摘再喂** `parseQrc`（`stripKanaTag`），它不是歌词行；落点写进 `words[].ruby`
  （SDK 的 `SparkleKaraokeWord.ruby`），AMLL core 原生渲染词上方注音并跟着时间轴扫色。
- 时间不换算：ruby 的时间永远取自「它挂的那个词」或标签里的音节时间轴。QRC 正文的词时间与
  标签 `(start,dur)` 都是**绝对毫秒**，原样透传（上游同款口径），别在中间加行首偏移。
- 只有 QRC 本体带这个标签；TTML/LRC 没有，别去那儿找。

验证：`node scripts/verify-kana.ts`（移植层纯单测：上游 `tests/kana.spec.ts` 同款黄金样例
+ 与本地 lyric-kit 的逐字节差分 + 接线断言；已进 `verify:static`）、`node scripts/verify-amll-parse.ts`
（解析层活体：词级 QRC / XML 信封 / 普通 LRC 的音译形状都归一成行级 `romanLyric`，`[kana:]`
在正文前后与信封里都挂对 ruby，并用 QQ《怪物》真实样本对齐上游期望，需 dev server）、`node scripts/verify-np-gallery.ts`
（渲染层：三档辅助行行为 + 「辅助行只有一条」+ ruby 真画在词上方）、`verify:sparkle`（源码接线）。
整页接管视图也必须消费同一份 ruby（参考 Flowscape：词上注音、按 ruby 自己的时间轴扫色），
不能只把 `words[].word` 拼成一行；无限电台经 `radioActive/radioLoading/radioError` 透传给插件，
左侧历史卡与 `songAt(-1)` 在电台态都必须为空。

## 播放控制条（底部停靠 / 内容区悬浮）· 音量浮窗与滚轮

- 形态只有一条 DOM 状态：`body[data-control-bar]`（外加 `.control-bar-floating`），由
  `lib/prefs.ts:applyControlBarMode()` 写、`lib/control-bar.ts` 与 Sparkle 主题策略合流；布局全在
  style.css 的 `--control-bar-*` 令牌（悬浮态 = fixed + 在内容区居中，不 JS 量高度）。
- **条上缘不画描边、拖拽 seek 不画整条 outline**：`border-top-color: transparent` 摘掉条顶那条
  1px 冷白线（它悬在内容与条之间的空隙里，重绘后像凭空多出来的一层高光）；拖进度只靠
  `.pb-fill` 染色块 + 前沿线反馈，`outline` 一律不加（带 offset 的描边会画到条外一圈）。
  `verify:volume-bar` 对两处都有正反断言。
- **挂在条上方的浮窗，锚点必须跟着它自己的按钮走**，不贴 Bar 右缘、也不写死 `right: calc(...)`。
  两个原因：① 悬浮态条只有 `--control-bar-width`（默认 720px）且在内容区居中，贴右缘会把整块浮窗
  甩到收藏/画廊/队列那一排上面（音量浮窗实测差 55px+，就是用户报的「悬浮模式错位」）；② 右侧按钮
  会增删（画廊/桌面歌词/收藏按宽度隐藏、画质胶囊随档名变宽），写死的偏移改版即过期
  （`.pb-lpop` 如今就是这么过期的，尚未修）。音量浮窗的形状：`<div class="pb-volhost">` 把音量钮
  与浮窗装进同一个定位锚，`left: -13px`（= 浮窗自己的 1px 描边 + 12px 内边距）让浮窗里的喇叭压在
  条上那颗的正上方；竖向余量按 `--control-bar-height` 算 —— 锚点换成钮之后 `100%` 不再是条高，
  漏掉这项浮窗会骑在条顶（实测压住 5px）。窄条（`minWidth: 760` / 半屏吸附）放不下整块浮窗，
  于是 `showPop()` 前 `clampVolPop()` 量一次余量，只往左退、不退过条的左内缘（与 SongMenu 的
  视口夹取同一套路：锚点交给 CSS，越界修正交给一次测量）。
- **滚轮在整条上 = 微调音量**（音质/播放模式浮窗内、以及那颗胶囊与循环钮例外 —— 浮窗里那点是
  菜单自己的滚动，preventDefault 会把它杀掉）。滑杆「谁在改音量」只认**指针态**：`volEditing`
  由 `pointerdown` 起、`pointerup` / `lostpointercapture` / `blur` 收。**别拿
  `document.activeElement` 当判据**：range 一被点/拖就拿到焦点、而且焦点一直留着（移开鼠标、
  收起浮窗都不掉），拿焦点当「正在编辑」= 此后所有外部改的音量（滚轮 / 全局热键 / MPRIS / 设置页）
  全都回不到滑杆上 —— 条与读数冻在聚焦那一刻的值，声音明明在变。松手立刻回写播放器真值，
  别留「拖中滚过轮」的那一截差（94 vs 98 那种假读数）。
- 验证：`pnpm run verify:volume-bar`（源码接线 + 反向自证 + 活体：两种形态 × 六档尺寸的锚点与
  越界退位、滚轮四态四值一致、拖动跟手与松手回写；活体段需 dev server，`QBASE` 可指别处）。

## Quark EQ（图形均衡器 · MPV 原生 / 兼容）

设置 → 播放的「图形均衡器」与音量浮窗右侧的快捷入口打开同一个 body 常驻模态窗
（`.eq-overlay` 黑遮罩 + `.eq-dialog` 玻璃窗体；`src/components/EqualizerDialog.ts` +
`equalizer.css`，均按需动态 import）。与更新/调试等模态窗同一套 `--menu-*` 玻璃语言：
窗体居中、不可拖动、点击标题不触发缩放缓动，避免玻璃整层重采样发闪；点遮罩空白处 / Esc 关闭。
遮罩必须自己消费 `--shell-filter`，否则会变成 backdrop root、窗体只采到纯色遮罩，设置里的
毛玻璃像被关掉。布局是「上工具条（预设 / 前级 / 导入）→ 全宽曲线 → 下频段检查器」，
不要改回曲线与控件左右分栏。红线：

- **只有 MPV 后端可编辑**：`mpv` 原生直出与 `mpv-compat` PCM 兼容都算；浏览器 / Blink 能让窗
  打开看结构，但控件锁定并写明「当前不是原生播放模式」；不要偷偷对 `<audio>` 做另一套实现。
- 模型分两层：`electron/audio/eq-config.ts` 是首屏共享的轻量层（0 点默认 / 10 点上限、normalize、
  `af` 串生成）；`electron/audio/eq-core.ts` 才放曲线计算与 APO 解析（懒加载块）。
  整窗 CSS 也必须留在 `src/components/equalizer.css` —— 塞回 `style.css` 会顶爆首屏预算。
- 声音真相：渲染层把节点曲线以约 40ms 节流经 `EngineTransport.setEqualizer` 下发；主进程
  `AudioEngine` 存状态并原子替换 mpv `af`。`af` 运行时可换，不重挂流；mpv 重拉后
  `ensureStarted` 必须重新套用。bypass = `af=""`，不能留旧滤镜。
- 节点交互：点空白新建、拖动同时改频率/增益、双击/右键/Delete 删除、滚轮调 Q；默认 **0 点**，
  最多 10 点，不是预铺 10 段。频率 20..20000、增益/前级 ±24dB、Q 0.1..18。
  类型含 Bell、Low/High Shelf、High-Pass/Low-Pass；LP/HP 的 gain 固定 0，只沿频率轴拖。
- 频谱：`audioSpectrum` 的 MPV 静音镜像 / PCM `AnalyserNode` FFT 驱动 canvas，画 Peak（峰值
  保持线）+ Loudness（平滑能量填充），SVG 折线 EQ 与节点叠在上层。兼容模式的 EQ 重建
  `PcmSink` 滤波链时必须复位 `analyserHint` 并重新接回分析旁路，否则首次调 EQ / 切预置后
  频谱会永久消失。显示口径是 **Post-Fader**：
  每个频点叠加当前音量推子（含 mute）与 EQ 响应后再进入 Loudness/Peak，图头直接标
  `POST-FADER`，不要再退回成只看原始流的 pre-fader 图。只有 MPV 打开浮窗时才订阅，
  关闭/切回 Blink 要退订，别留镜像音频在后台跑。
- 内置预设：`electron/audio/eq-presets.ts` 保存 13 组固定的 10 Band 曲线（32Hz..16kHz）。
  应用预设会替换节点、启用 EQ，但保留 preamp；手动改任一节点后下拉回落「自定义」。
- APO 导入：支持 `Preamp`、`PK/PEAK`、`LS/LSC`、`HS/HSC`、`LP`、`HP` 与 `GraphicEQ:` 行；
  未支持类型（Notch/AllPass…）必须进 warnings，不许静默冒充。超过 10 点的 GraphicEQ
  要在对数频率轴上重采样成 10 点，**不许只截前 10 点**（那样会丢掉整段高频）。导入后会启用 EQ。
- 浮窗右下角固定 `Powered By Quark EQ`。验证：`node scripts/verify-eq.ts`
  （模型/滤镜串/APO/接线，已进 `verify:static`；`verify:volume-bar` 继续守音量入口）。

## 桌面歌词（透明覆盖层窗）

一个**独立的 Electron 窗**（`electron/desktop-lyrics.ts` + 页 `desktop-lyrics.html` / `src/desktop-lyrics.ts`），
与主窗单向上镜像数据（主窗 player 是唯一事实源，见 `src/lib/desktop-lyrics.ts`）。几条别踩的：

- **未锁定时是纯 CSD；macOS / Windows / X11 有「固定 + 鼠标透穿」档**。拖拽区由页面自己划
  （`#dl-root{-webkit-app-region:drag}` + 控制条/进度条/缩放手把 `no-drag`），挪窗交给窗口管理器 ——
  Wayland 下 `setPosition()` 会被合成器无视，拖拽区是唯一真能挪窗的路（旧版 move-by IPC 已删）。
  锁定时主进程走 `setIgnoreMouseEvents(true)` + `setMovable(false)`，页面同步加 `.dl-locked` 收起控件；
  解除入口只留托盘与设置页（锁住的窗收不到点击）。Wayland 不开放该档，平台闸门在
  `desktop-lyrics-core.ts:supportsDlLock`。`no-drag` 的豁免**只在同一子树内**成立（主窗顶带踩过：
  兄弟子树里的 no-drag 挡不住铺过来的 drag 矩形）——本窗三个控件都是 `#dl-root` 的直接子元素才挖得动洞。
- **两层不透明度，别混成一个**：`Opacity` = **歌词层**（挂在**内容**两处：`#dl-clip` 与 `#dl-empty`
  的 `opacity: var(--dl-opacity)`）；`Backdrop` = **窗体不透明度**（`#dl-board`，`inset:0` **铺满客户端表面**、
  画在歌词下面，默认 0 = 整扇窗全透明、只有字）。背板刻意是 `#dl-root` 的**兄弟**、变量挂在 `<html>` 上 ——
  放进 root 里就会被歌词层的 opacity 连坐乘一遍（两个滑条就不独立了）。
  想要「窗体」有可调的面就调背板，**不要**去碰字。
  为什么不做原生 `win.setOpacity()`：Linux 上 Electron 不实现（文档原话「On Linux, does nothing」），
  按平台分叉两条路只会让三平台口径不一致 —— 一律用「背板」这一层表达窗体，三平台同一套。
  真机踩过「背板只盖了上面一截、下面露出桌面」：**不是页面的锅** —— 被平铺时合成器给的窗体盒由
  布局决定，而客户端表面被自己的 max 尺寸提示夹住，盒子里多出来的那一截不归页面画，`inset:0`
  只能盖到客户端表面。病根是尺寸提示缺一条「不变的轴」，见下面「申请浮窗」那条。
- **悬停地板：歌词层的透明度挂在「内容」而不是整层 `#dl-root`**。指针停在覆盖层上（= 可拖动那个状态）
  时内容至少要到 0.3（`prefs` 的 `DL_HOVER_OPACITY_FLOOR` → `applyStyle` 算成 `--dl-hover-opacity`，
  CSS 只在 `#dl-root:hover` 里消费），设置高于 0.3 就完全照设置来 —— 复用同一条透明度链，**不新增设置项**。
  为什么不整层压住再给控件乘补偿系数：CSS `opacity` 被浏览器夹回 `[0,1]`，`1/0.3` 这种补偿直接作废
  （真机踩过：补偿值算出来是 3.33，读回来还是 1）。控件本来就只在悬停时才出现，让它恒满值才按得着。
- **尺寸：高度是一条「钉死的轴」，但值能拖；宽度是区间**（`desktop-lyrics-core.ts:sizeHintsFor`）。
  默认窗高 = 主行/辅助行/呼吸位的容量 × 留量 + 落位余量（`defaultHeightFor`），系数是 headless 量
  `__dl.stripDiag().applied` **实测标定**的（12 种档位组合逐一核过，最紧的一档 字号2+双行+辅助 = 258
  vs 实测条带 253）；默认宽度 560（`DL_DEFAULT_WIDTH`）。四条配套：
  ① 高度以 **`minHeight == maxHeight` 的提示**钉死（既是「这条轴由我定」也是「申请浮窗」的判据，见下条）；
  ② **改尺寸 = 重钉提示**，钉的是「值的唯一性」不是「不许改」：拖动中 `pinSize` 把**两条轴**一起钉
  （`pinnedHintsFor`），松手 `releaseWidth` 只把宽度放回区间。为什么宽度也得推提示：Wayland 下客户端
  定不了自己的尺寸，`setSize` 只改**我们这边**的视口 —— 真机量过 `setSize(900)` 之后 renderer 的
  innerWidth 是 900 而合成器盒子仍是 560，两个值一脱钩歌词就在那半张看不见的宽里居中；推提示
  （min == max）才是让盒子跟上的唯一路。实测：拖动期间合成器盒子逐帧跟上、浮窗不掉，松手把宽度放回
  区间后盒子与浮窗都保持；③ 字号/行数/辅助行变了 → `refitHeight` **只长不缩**（用户拖出来的高度不该被
  一次配置改动抹掉）；④ 辅助行容量取自全局 `[Style] LyricAux`（覆盖层真的会多渲染那一行）。
- **记忆尺寸要过筛**：`isLegacyDefaultSize`（旧版一律 720×150 的那条大空带）与 `isSaneSavedSize`
  （越界值只可能来自合成器把窗拉爆后的静默落盘，真机踩过 H=1224）都不算用户偏好 —— 位置照旧恢复、
  尺寸回落当前贴合值；合格的记忆高度照旧恢复（那是用户拖出来的，`pickBounds` 两条轴一起用）。
- **「申请浮窗」= xdg 的 min/max 尺寸提示**（`sizeHintsFor` → BrowserWindow 的 `minWidth/maxWidth/
  minHeight/maxHeight`）。链路：`NativeWindow::InitFromOptions` → `views::Widget::OnSizeConstraintsChanged`
  → `DesktopWindowTreeHostPlatform` → `WaylandToplevelWindow::SetSizeConstraints` →
  `xdg_toplevel.set_min_size/set_max_size`。平铺合成器就是按「有没有一条不可变的轴」判浮窗的，
  Hyprland 0.56 `CHyprXWaylandManager::shouldBeFloated`（Wayland 分支）：
  `minSize.x != 0 && minSize.y != 0 && (minSize.x == maxSize.x || minSize.y == maxSize.y)` → 浮窗；
  浮窗后再用同一对提示把窗夹到该尺寸（`Window.cpp:clampWindowSize`），于是「合成器给的窗体盒」与
  「客户端表面」永远一样大 —— 背板盖不满的病根一并解决。**别把高度改成区间**（提示里一旦没有相等的轴，
  窗会被重新平铺回布局格子，错位就回来了），也**别在 show 之后再补提示**（构造参数里就给：窗口映射
  那一刻合成器就判一次）。改尺寸的入口只有三个方法：`pinSize`（拖动中两条轴）/`pinHeight`（只钉高度）/
  `releaseWidth`（放回宽度，内部复用 `pinHeight`），而 `setMinimumSize/setMaximumSize` 只在这**两**处成对
  出现 —— 单独改一条会把轴打散。
- **没有「最大化/全屏」这一档**：`maximizable:false` + `fullscreenable:false` 只是「不给按钮」，拦不住
  窗口管理器的手势（Windows 顶边 Aero Snap、KDE/GNOME 平铺与 Super+Up、无边框窗双击拖拽区）——
  所以另有一道反应式兜底：`maximize` / `enter-full-screen` 一到就 `unmaximize()` / `setFullScreen(false)`。
  尺寸上限就在那对提示里（宽度 `DL_SIZE_MAX.width`，高度由 `min == max` 钉死），而**改高度只能走
  `pinSize` 的成对重钉** —— 单独 `setMaximumSize` 会只改一条，把那条轴打散。也别改成 `resizable:false`：
  那正是 Electron 在 Linux 上实现「不可缩放」的路子（min = max = 当前尺寸），它会连我们的把手一起废掉。
- **垂直居中：钉的是整块文字的实测中心**（主行 + 翻译/音译；条带高 = 块高 + 上下 0.25em 呼吸位，
  条带恒居中于视口）。量尺走 `textBox()`（文本节点 Range）而不是元素矩形 —— core 给行/词盒铺了
  ±1em 的 margin/padding，量盒子会虚增近一倍。纯公式在 `src/lib/desktop-lyrics-layout.ts`
  （有真单测），DOM 量测在 `src/desktop-lyrics.ts:tightenStrip`。
- **换锚位必须补一刀 `player.calcLayout(LayoutReason.ConfigChange)`**：AMLL 的 `calcLayout` 只在
  *时间线状态**真的**变了*时才跑（换行/间奏/seek/重建…），光写 `setAlignPosition()` 不会立刻重排 ——
  实测不补这刀，新锚位要等下一行才生效，当前行整块吊在旧位置（就是「歌词整体偏下」）。
- **超长行横向滚动**：`updateMarquee` 只给「真的超宽」的那一行挂 `.dl-scrolling`（摘掉 core 行元素的
  paint containment，否则字被行盒裁掉）并写**该行自己**的 `translate` —— 主行滚的时候翻译/音译不动，
  它们自己太长才自己滚。滚法是**来回滚（三角波）**：停顿→走到末尾→停顿→退回开头，两头都连续
  （回卷/一次性停死都会被当成故障）。相位按行元素记（`marqueeStart`），4Hz 重测不重锚。
- 位置/大小/开关/锁定写 `[DesktopLyrics]`（主进程写 X/Y/W/H 记忆坐标；渲染层碰开关/锁定/字号/透明度）。

验证：`node scripts/verify-desktop-lyrics.ts`（纯逻辑 + 几何真单测 + 尺寸贴合/尺寸提示（浮窗轴，高度 min==max）/
悬停地板 + 固定/鼠标透穿的平台闸门与原生接线 + 「无最大化档」红线 + 源码接线；已进 `verify:static`）。

## 本地音乐 / NAS（扫描 · 播放 · 刮削 · QRC 逐字）

读盘侧真相在 `electron/local/library.ts`（零 electron、纯 Node）：**两处同构挂载** ——
dev/preview 由 `src/relay.ts` 挂 `/api/local/*`，打包态由 `electron/native-server.ts` 同样接
`handleLocalApi`（与 bg/accent/sparkle 一个套路，verify-local 逐条点名 + 顺序红线：
local 必须早于 sidecar 兜底转发）。标签解析纯函数在 `electron/local/tags.ts`
（ID3v2.2/2.3/2.4 + USLT/APIC、ID3v1、Vorbis/FLAC/OGG、MP4 ilst/mvhd、WAV/AIFF、文件名兜底），
WebDAV 客户端在 `electron/local/webdav.ts`（PROPFIND + Range；NAS 走挂载目录时按 folder 源处理）。

- **数据落点**：配置目录下 `local-library/`（library.json 0600、covers/、lyrics/）。
  库文件里有 WebDAV 口令 → 一切响应经 maskSource 剔除 `password`，日志不打印；渲染层永不接触。
- **曲目 id** = `t_` + sha1(sourceId␀relPath) 前 12 hex：**relPath 永远相对源根**
  （嵌套目录曾被递归拍平成 basename → 同名文件撞 id，walkFolder 必须带 base 根走）。
  软链不跟；所有 GET 只认 id，路径只从库来 —— 与 `/api/bg` 同一条「请求参数不参与拼路径」红线。
- **流**：folder = createReadStream + Range/206/416/HEAD；webdav = 上游 Range 代理
  （上游无视 Range 回全量时本地掐头去尾，保住 206 语义）。`<audio>` 与 mpv 引擎共用同一同源 URL。
- **播放整合**（`src/player.ts`）：`Song.local` 指纹 = {id, kind, hasCover, path, sourceName, qqMid}，
  随会话存档走（session.ts 的 slim 透传 `local`）。本地曲目：取流不过 Sparkle/QQ resolve、
  无档位回退链（流失败=跳下一曲）、红心/换音质/预取全短路；音质胶囊显示「本地文件/NAS 流」。
  封面走 `coverUrl` 本地分支（hasCover=false 回空串，别产死链）；MPRIS 的 artUrl 必须
  `absArt` 绝对化（相对 /api/local/cover 给外部播放器就是画不出图）。
- **选目录/文件定位是 Electron 专属**（`quaverLocal` 桥：pick-folder / reveal(id)；
  reveal 只传 id，主进程现读库反查路径）。浏览器 dev 没有桥 → 页面给手输路径输入框，
  「打开位置」按钮直接藏掉。
- **刮削（scrape）**：串行 + 250ms 间隔打 sidecar：`/search` → 打分（歌名吻合是硬门槛，
  宁缺毋滥绝不错配）→ `/song/<qqMid>/lyric?trans&roma` 落缓存 → 无内嵌封面时下载专辑封面。
  **扫描发现新歌 → 收尾自动补一轮未匹配刮削**（found>0 才跑，免每次扫描白打网络）。
- **歌词优先级**（用户明确要求）：官方曲目恒走在线 QRC 管线；**本地曲目仅在刮削命中
  （local.qqMid 非空）时优先复用同一条在线管线**（`pullQqLyric`：qrc=1 → 在位的逐字提供器（内置 AMLL，或被插件顶掉的版本）→
  无 provider 或 QRC 解析失败自动回退行级 LRC）；在线拿不到内容（未命中/sidecar 掉线/上游无词）
  才落回本地通路 —— 服务端 `/local/lyric` 按「**手动导入 > sidecar .lrc > 在线刮削缓存 > 内嵌**」
  合成，响应带 format（lrc/qrc/ttml）。刮削后落地 qqMid 时，正在播的本地曲经
  `onLocalLibraryChange → refreshLocalCurrent` 原地升级指纹并补拉一次歌词（撤销导入同理翻转）。
- **手动覆盖三件套（右键「更多操作」，SongMenu 本地分支）**：
  ① 导入歌词（QRC/TTML/LRC）：`pickFile` + base64 POST `/local/lyric/import`（≤512KB，
  服务端 `sniffLyricFormat` 嗅格式，原文落 `lyrics/<id>.import`）；**导入恒胜** —— 指纹
  `lyricImport` 让 fetchLyric 跳过在线管线，materializeTrack 重扫保导入件；「撤销导入」
  （DELETE）按现存资产回退一档、指纹翻转自动触发重拉（订阅链负责，菜单不再手动补刀防双拉）。
  宿主兜底：`src/lyric.ts:ttmlToLrc/qrcToLrc/coerceLyricToLrc` 在无逐字插件时把 QRC/TTML
  拍平成行级 LRC（内置 AMLL 在场则本就吃词级 —— 它恒在，这条兜底只在它注册失败时生效）。
  ② 导入封面：POST `/local/cover/import`（≤8MB，`imageFormat` 魔数验 jpg/png/gif/webp）；
  `coverManual` 让重扫抽到内嵌图也不换。**同 id 原地换图 URL 恒定** —— 重导成功经
  `api.ts:bumpLocalCover` 给封面路径加 `?v=`（穿透 <img>/背景/tint 的按-URL 缓存；服务端
  no-store 只救网络层），且 `refreshLocalCurrent` 因此**恒 notify**、不按指纹相等早退。
  ③ 重新设置刮削信息（曲名/歌手/专辑）：`LocalImportDialog` 模态 → POST `/local/meta/set`
  置 `editedMeta` —— scrapeTrack 的回填恒被跳过（「借匹配拿词/封面/qqMid，不改写用户校正」），
  保存即对该曲 force 重刮；正在播的曲目经 `player.patchCurrentMeta` 就地换展示字段。
- 验证：`node scripts/verify-local.ts`（解析纯单测 + 真 HTTP 端到端：folder/WebDAV 扫描、
  Range/416/HEAD、封面抽出、sidecar 歌词、自动刮削落库、口令掩码、移除源清库 + 源码接线
  含反向断言；已进 verify:static）。

## 页面 CSP（Content-Security-Policy）

真相在 `electron/csp.ts`：策略文本 + `installAppCsp()`。主进程在 `createWindow` 里、
`loadURL` **之前**给会话挂钩子（`session.defaultSession.webRequest.onHeadersReceived`），
只给应用自己 origin 的响应贴头。

- 症状与判据：非打包态只要「页面没有 CSP」或「策略里有 unsafe-eval」，Electron 就往控制台刷
  `Electron Security Warning (Insecure Content-Security-Policy)`（`pnpm run app` 终端里那条
  `[renderer:warning]`）。**修法是真给一条策略**，不是 `ELECTRON_DISABLE_SECURITY_WARNINGS`
  静音 —— 那是拔烟雾报警器的线。
- 姿态是「网络放开、脚本收紧」：这是个插件宿主，第三方音源直链、封面外链、插件自己的请求都发生在
  同一张页面上，所以 `img/media/connect` 允许远端；但 `script-src` 只有 `'self' blob:` ——
  不开 `unsafe-inline`、绝不开 `unsafe-eval`（`blob:` 只服务于装本地插件前先执行一遍读元数据）。
  于是 innerHTML 里混进来的 `<script>` / `onclick=` / `eval()` 一律失效。
- **因为 script-src 不开内联，页面里不许有内联 `<script>`**：八个入口的薄跳转层已挪成
  `public/redirect.js`（路由名走标签上的 `data-route`）。往 html 里加内联脚本 = 那段代码静默失效。
- `app.session` 在 Electron 44 已经不存在（实测是 undefined，钩子被守卫静默吞掉、警告照旧），
  必须用 `session.defaultSession`。
- 验证：`verify:csp`（策略文本 + 贴头逻辑 + 接线，纯 Node）与 `verify:csp-live`
  （拿 dist 真跑 Chromium：首屏与插件 chunk 都过得去、内联脚本**确实**被拦、跳转层仍然工作）。
  后者存在的全部理由就是那次「静态全绿、警告照旧」。

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
  `vendor/Typhoeus-go/server/session.go:HandoffPrefix`（含末尾空格，verify:keyring 会比对）。
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
`vendor/Typhoeus-go`（优先用已编译的 `quaver-server`，没有就 `go run ./cmd/quaver-server`），必须在 vite 加载**之前**拉
（`relay.ts` 在模块加载时读一次 `QUAVER_API`）。手工起的 sidecar 拿不到交接管道 → 只能 memory 模式，
所以**不要再手工起 sidecar 并期望登录被持久化** —— 环境里已有 `QUAVER_API` 时主进程不抢，并在日志里说明。
打包态与开发态的启动方式只在 `sidecarCommand()` 一处分叉，凭证通道完全一致。

## 配置持久化（quaver.conf）

真相在 `electron/config.ts`：平台路径规则、INI 解析（保注释）、schema 默认值与值域、原子落盘。
渲染层经 `src/lib/config.ts` 读写（桌面端过 preload 的 `quaverConfig` 桥，浏览器 dev 回落 localStorage）。

- 目录：Linux `~/.config/quaver-music`｜Windows `%AppData%\Quaver Music`｜macOS `Application Support/Quaver Music`；
  `QUAVER_CONFIG_DIR` 可整体顶掉（主进程也用它下发给 sidecar，两边规则必须一致：
  `ui/electron/config.ts:configDir` ↔ `vendor/Typhoeus-go/server/session.go:ConfigDir`）。
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
- **Sparkle 主题可以接管这一层**（契约 `SparkleTheme.background`，策略 `src/sparkle/theme-background.ts`）：
  **不声明 = 主题自带背景**，宿主让位 —— `ambient.ts` 把层设成 `data-mode="theme"`（CSS 与 off 一样
  藏掉）并作废图源指纹，设置页「背景」整组禁用 + 写明由谁接管；声明 `{ mode: "host" }` = 用户那三档
  照常。判定口径与 tint 那一节**必须一致**（让位是安全侧：不成形的声明也算主题接管）。
  激活主题的解析只有一份：`sparkle/registry.ts:sparkleActiveTheme()`（读 host 维护的
  `<html data-sparkle-theme>`，不 import host 免得成环），tint / 背景 / 设置页三处共用。
- 验证：`node scripts/verify-background.ts`（读盘侧真文件真 HTTP + 主题交接纯逻辑 + 源码接线护栏，
  已进 `verify:static`）。

## 界面高亮色（tint）：固定青色 / 跟随封面 / 自定义

设置→外观→高亮颜色。三档 = `Style.Tint`（`default` / `cover` / `custom`），自定义色的取值 =
`Style.TintColor`（`#rrggbb`，默认 `#19c2d8`）。**默认 `default` = 固定青色，不跟封面跑。**

- **染色只有一个来源**：`src/lib/tint.ts`（`shell.ts` 在 `bootShell` 里调 `bootTint()`）。一次写
  5 个变量，全部由同一个源色派生：`--cvg-accent` / `--cvg-glow`（`toUiColors`，UI 高亮：选中态、
  激活描边、条目洗底…）；`--cvg-bar-fill` / `--cvg-bar-line`（`toBarColors`，播放条已播区与拖拽 seek
  的边线 —— 「亮度另调过」的那一版）；`--np-hl`（播放页歌词当前句，CSS 侧目前是注释掉的预留钩子）。
  清空时按 `TINT_VARS` 清单一起 `removeProperty`（别漏一个，否则留下「半套颜色」）。
- **取色源选择只有一个**：`lib/color.ts:toPixelSrc` —— 跨源 http(s) 封面必须过 `/api/img` 白名单中继
  （QQ CDN 无 CORS），**同源相对路径（本地/NAS 曲封面 `/api/local/cover/<id>`）必须直连** ——
  中继只认外链主机，相对路径会被 400 拒掉、tint 恒失败像「跟丢了封面」（2026-10 本地曲上线时踩过；
  verify-tint 有 toPixelSrc 三态单测钉死）。同源图进 canvas 不 taint，getImageData 合法。
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
- **Sparkle 主题可以接管高亮色**（SDK 的 `SparkleTheme.tint`，策略解析在 `src/sparkle/theme-tint.ts`）。
  主题**不声明** `tint` = 它自带强调色 → **宿主让位**：`lib/tint.ts` 清掉那几个内联变量，
  `--cvg-accent` 回落 `:root { --cvg-accent: var(--acc) }` —— 于是主题只要覆盖 `--acc`/`--cyan`
  就等于自带高亮色；设置页的「高亮颜色」整组**禁用**并注明由谁接管。`tint: { mode: "host" }` 让用户
  继续用那三档；`tint: { mode: "presets", presets: [...] }` 则换成主题给的方案卡（选择按主题 id 存在
  localStorage，切主题来回不丢）。
  **让位是必须的**：那几个变量是行内样式，主题在 CSS 里写 `--cvg-accent` 抢不赢 —— 所以「主题自带
  高亮色」只能是宿主主动不写，不能靠主题去覆盖。`theme-tint.ts` 是纯策略（护栏要在 node 里直接
  import 做单测），因此它的**值导入必须带 `.ts` 扩展名**（`from "../lib/color.ts"`）。
  换/停主题后 host 要重算（`host.ts:applySparkleTheme` 末尾调 `applyTint()`，背景那一层同理调
  `applyBackground()`）。激活主题的解析走 `sparkle/registry.ts:sparkleActiveTheme()`（读 host 维护的
  `<html data-sparkle-theme>`）—— 别在消费方各写一份（tint / 背景 / 设置页共用同一份）。
- 验证：`node scripts/verify-tint.ts`（纯逻辑往返 + 主题交接策略 + 源码接线 + 反向自证，已进
  `verify:static`）。加配置键时 `scripts/verify-config.ts` 的 `Object.keys(defaults()).length`
  硬断言要一起改。

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

图标链：桌面环境按 app_id 反查 `<ID>.desktop` → `Icon=` → 图标主题。AppImage 裸跑没人代装桌面
文件/图标，`electron/linux-desktop.ts` 每次启动**在打包态**自装（幂等、失败只记账）。开发态
（`pnpm app` → `electron .`，即 `!app.isPackaged` 且无 `$APPIMAGE`）**什么都不写**：开发态条目的
Exec 写死「当前 electron + 仓库 ui/」，落进 `applications/` 就是启动器里常驻的、跟着仓库状态漂移
的开发实例——污染启动器而非修身份（开发态 X11 窗口图标走 BrowserWindow 的 `_NET_WM_ICON`，
不依赖这份文件）。开发态只跑 `removeDevManagedDesktopEntry`：仅当条目带 `X-Quaver-Managed`
**且** `Exec=` 含仓库 `ui/` 路径才删（打包态/集成工具/用户的条目一律不碰）。打包态自装规则：

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
- **MPRIS 在 Electron 主进程内**（`electron/mpris.ts` + `mpris-service` 生产依赖）：渲染层只推
  状态快照，D-Bus 命令原样回推；没有 daemon、没有 `mpris:build`、没有额外子进程。别再把它搬回
  Typhoeus submodule 或 sidecar —— 前者制造漏构建静默失效，后者把系统媒体控件绑死后端生命周期。

## 打包与首屏（Rolldown · 动态加载 · 内存）

Vite 8 的打包内核就是 **Rolldown**（`node_modules/rolldown` 1.2.x），配置写在 `build.rolldownOptions`
（`build.rollupOptions` 是别名，已 deprecated，别再往里塞东西）。一次构建 ~0.3s，产物形状由两份
机器可读文件描述：`dist/.vite/manifest.json`（谁静态引谁）与 `dist/.vite/chunk-graph.json`
（每块装了哪些模块、各占多少字节，由 vite.config.ts 里的 `quaver-chunk-graph` 插件写）。

- **判据是「入口的静态闭包」，不是 bundle 总量。** 总量会随依赖漂移；决定启动要解析多少字节的
  只有静态闭包。预算与理由在 `scripts/verify-bundle.ts`（`pnpm run verify:bundle`，CI 在
  `pnpm run build` 之后直接跑它）：SPA 壳首屏 JS ≤ 200KB、覆盖层 ≤ 520KB，AMLL / 繁简词典 /
  更新链路必须留在懒加载侧，视图不许回退成静态导入。
- **视图按路由懒加载**：`src/views.ts` 已拆成 `src/views/<页面>.ts` + `src/views/_shared.ts`
  （共用件：页头/粘顶/小工具/响应类型），路由→模块的表在 `src/views/index.ts`。
  三条口径：① 优先级与拆分前逐字一致（宿主路由 > 插件自定义路由 > 回落首页）；② 只在**首次访问**
  解析，解析到的函数留在表里；③ 预取只由交互意图触发（导航项/卡片 `pointerover`、`pointerdown`），
  **不做 idle 全量预热** —— 那是把刚省下的解析与内存再吃回去，还顺带污染首屏。
  shell 的 `renderRoute` 里 `await loadView(path)` **必须**在 await 之后再验一次 `gen !== renderGen`
  （快速连点导航时晚到的旧一轮只能写进已脱离 DOM 的死容器）；这条与 `.entering` 动画同属竞态护栏。
- **桌面歌词覆盖层的契约与实现分家**：类型/常量/`Window` 声明在 `src/lib/desktop-lyrics-protocol.ts`
  （零依赖），主窗侧的镜像实现留在 `src/lib/desktop-lyrics.ts`。覆盖层从前只 import 一个
  `CLOCK_COMP_MS`，却把整条 player 依赖链（player/api/color/accent/vip/local …）拖进自己的首屏 ——
  一个「绝不持有播放器」的镜像窗，启动时却 new 了一个播放器。分家后覆盖层静态闭包 486.7KB → 437.0KB。
  加字段改协议那份，别把重依赖带回契约里。
- 更新链路（`lib/updater` + `lib/update-core` + `UpdateDialog` ≈ 22KB）不在首屏：`main.ts` 把
  「启动 3s 后检查」的延时留在调用侧，到点才 `import()`。延时口径没变，只是把加载缝隙钉在了那里。
- MPV 兼容模式（pcm 出声）整条渲染侧状态机住在 `src/lib/pcm-sink.ts`：`PcmController`
  （进度上报 / 暂停淡出 / EQ / 跨曲淡出 / 世代校验）+ `PcmEngineTransport` 子类，由
  `createEngineTransport` 按 mode **动态 import**；native 版 `EngineTransport` 里只有空钩子
  （`PcmHooks`），hook 挂上之前引擎已推流的 PCM 帧进 `pcmBacklog`，子类构造完按序回放。
  别把 `PcmSink` 改回静态 import —— 那会把兼容模式的 ~7KB 塞回每个人的首屏。
- `output.codeSplitting.groups` 只给**第三方重量级懒加载依赖**命名（`amll-*`、`cjk-cn2t`、`cjk-t2cn`），
  为的是预算断言能钉住名字（自动分块的名字会随内容漂）。**Sparkle 预装插件不分组**：本来一个插件
  一条动态 import，写组反而会把所有插件并进一块，装一个就把全部字节拉走。
- `build.modulePreload.polyfill: false`：产物只跑在 Electron 的 Chromium 里，那段
  `relList` 探测 + MutationObserver 补挂永远是死码（verify-bundle 有一条专门的守卫）。
- `build.target: "esnext"`：Chromium 与 Electron 一起升，写死 `chromeNN` 只会在 Electron 升级后
  悄悄过时，还白付一层语法税。渲染层该不该用某语法由 `tsconfig.json` 的 target/lib 说话。
- `chunkSizeWarningLimit: 1100` **只**是为了放过那份 1.05MB 的简→繁词典（懒加载纯数据，
  见「歌词设置」）。不要拿它当预算：真红线在 verify-bundle。

### 内存：先归因，再动手（`scripts/probe-bundle.ts` 是量尺，不是闸门）

界面里也能直接问出答案：**设置 → 通用 → 调试 → 「进程与内存自检」**（`src/components/DebugDialog.ts`，
沿用模态弹窗那套壳 `.upd-overlay/.upd-dialog`）。逐进程列 RSS / Pss / 峰值 / CPU，外加首屏实际解析量与
DOM 规模；数据源在主进程（`app.getAppMetrics` + Linux `/proc`，IPC 走 `quaver:metrics`）—— 渲染层看不见
主进程、GPU 进程、zygote 池和外部子进程（sidecar / mpv / 看门狗），这三类必须在那边拍平再送过来。
CPU 列是「自上次采样以来的均值」，所以第一次采样必是 0（外部子进程没有这个数，显示 `—`）。

弹窗里的**「开发者模式」按钮是 DevTools 的唯一入口，F12 不绑定**：本应用是插件宿主，DevTools 等于把
渲染层控制台与网络面板交给任何能碰到键盘的人 —— 宁可多两次点击，也不要一个顺手就能按开的口子。
因此这里**没有** `[Debug]` 配置段：入口不持久化，每次都要显式点。


```sh
pnpm run build && node scripts/probe-bundle.ts --static   # 首屏闭包 / chunk 明细（带模块归属）
node scripts/probe-bundle.ts --label after                # 另起隔离实例（QUAVER_CONFIG_DIR + CDP）按里程碑采样
node scripts/probe-bundle.ts --live-only --label xxx      # 已开着带 Crotchet 调试端口的应用时只采样
```

实测（Wayland / Electron 44 / 本机）一个实例的进程树 ~2.6GB，**JS 堆只占其中约 10MB**：大头是
Chromium 侧的 `/dev/shm` 合成器缓冲（主进程 ~620MB）与**字体映射**（思源黑体一份 .ttc 就映射
~450MB RSS、思源宋体 ~155MB —— 这些是 clean file-backed 页，内存紧张时可回收，别当成泄漏），
再加 renderer / gpu-process / mpv / sidecar。所以这里定的规矩是：

- **改内存前先跑 `--static` 与 `--live-only` 拿到归因**，别拿「总内存好大」当依据动 GPU 或字体。
- 应用侧真正能省的是：不进首屏的代码（解析与常驻都不付）、有上限的缓存、以及用完就丢的对象。
  已落地的上限：`src/lib/songlist-detail.ts` 详情缓存 8 张（一条 = 整单歌曲数组），订阅中/在途的
  歌单不淘汰；`lib/color.ts` 256 条 LRU、`lib/streaminfo.ts` 32 条、`lib/ttml.ts` 未命中表 TTL 10min。
- 反复进出重页面**不留残留**是硬指标：探针里那 8 轮「首页 ⇄ 设置页」后的堆读数应当回到首轮水位
  （涨 = 有东西没解绑）。AMLL 播放器随视图销毁走 `player.dispose()`（`lyrics/amll.ts`），
  覆盖层换曲走 `disposeRender`。
- 已知没动的（写清楚，别让人以为已经修好）：① `registerBuiltinLyrics()` 在启动就拉起 399KB 的
  AMLL 块（改成「首次播放再注册」要重看插件提供器优先那条链）；② AMLL 的 400KB 里约 80KB 是
  `@pixi/utils → url → qs/object-inspect` 这条依赖链；③ `src/style.css` 仍有约 69KB 常驻首屏
  （壳层 + 播放条 + 正在播放页；设置/本地音乐/模态弹窗已各自拆成随模块加载的
  `views/settings.css`、`views/local.css`、`components/dialog.css`，继续拆要新做 CSS 层视觉对拍）；
  ④ mpv 的 `--demuxer-max-bytes=32MiB`
  `--demuxer-max-back-bytes=24MiB`（≈56MB 缓冲）没调，动它等于动播放稳定性，要单独灰度。

## Documentation

Vite guide: https://vite.dev/guide/
- Static sites / MPA: https://vite.dev/guide/static-deploy
- Backend for /api middleware: https://vite.dev/guide/backend-integration
- Proxy & server options: https://vite.dev/config/server-options
