# Quaver UI（Vite + 原生 TS，SPA 壳层）

Vite 多页入口，运行时为 SPA 壳：`index.html` 是唯一真页面（hash 路由），
其余 `*.html` 是深链兼容的跳转层。无框架，原生 TS + DOM。
浏览器不直接碰 QQ 音乐接口：所有请求走同源 `/api/*`，由 `src/relay.ts` 中继到本地 sidecar（:3200，`vendor/Typhoeus/`）。

```sh
npm install
npm run dev        # 开发服务 http://localhost:5173（含 /api 中继）
npm run build      # tsc 检查 + 产物到 dist/
npm run preview    # 预览构建产物（同样挂 /api 中继）
```

## 结构

```text
/
├── index.html          # 唯一 SPA 入口 -> src/main.ts -> shell.ts
├── <其余>.html         # 深链跳转层（重定向到 #/路由）
├── public/
├── vite.config.ts
└── src/
    ├── main.ts         # bootShell()
    ├── shell.ts        # 常驻壳层：标题栏/侧栏/内容区 + hash 路由渲染
    ├── views.ts        # 路由视图表（仅内容区：首页/猜你/每日/我喜欢/歌单/设置/我的/登录）
    ├── player.ts       # 全局播放器状态机（队列/模式/歌词/收藏，订阅式 notify）
    ├── lyric.ts        # LRC 解析（含翻译行）
    ├── relay.ts        # /api -> sidecar:3200 中继（透传 + 封面取色代理）
    ├── style.css       # 全局样式
    ├── lib/{api,config,prefs,songs,session,playlists,icons,transport,vip}.ts
    │                     # config=quaver.conf 门面，prefs=偏好映射，songs=歌曲行渲染（含右键菜单挂载），
    │                     # session=会话存档（队列/进度），playlists=自建歌单读写，transport=播放传输抽象（见下），
    │                     # vip=/user/vip 的展示口径（到期时间/档位明细，见 verify-user-vip）
    └── components/
        ├── PlayerBar.ts    # 底部播放条（进度线/控制/收藏/队列；封面点击展开 np）
        ├── NowPlaying.ts   # 正在播放全屏覆盖层（模糊封面背景+滚动歌词+大封面）
        ├── QueuePanel.ts   # 播放队列面板（停靠/浮窗双形态；形态与开合解耦，见 verify-queue-panel-anim）
        ├── SongMenu.ts     # 歌曲行右键菜单（插队播放/加入歌单/从歌单删除/跳转至/更多操作）
        ├── ListTools.ts    # 歌曲列表工具条（本地搜索 + 排序；歌单页/我喜欢共用）
        └── SearchBox.ts    # 顶带常驻搜索框（联想 + 搜索历史）
```

`electron/`（桌面壳，不属于 vite 构建）：`main.mjs` 主进程（窗口/托盘/MPRIS daemon 拉起/音频引擎接线/配置 IPC）、
`config.mjs` 配置文件引擎（跨平台目录、INI 保注释读写、schema 与原子落盘）、
`preload.cjs` 桥（窗口控制 + MPRIS + `quaverAudio` + `quaverConfig`）、`native-server.mjs` 打包态静态+/api 服务、
`audio/` 原生音频引擎（`bins.mjs` 二进制解析、`mpv-ipc.mjs` libmpv JSON IPC、`engine.mjs` 状态机与 IPC 命令面）。

## 配置持久化（quaver.conf）

所有用户设置都在系统标准配置目录的 `quaver.conf`（INI）里，换 AppImage 版本、重装都不丢：

| 平台 | 目录 |
| --- | --- |
| Linux | `$XDG_CONFIG_HOME/quaver-music`（默认 `~/.config/quaver-music`） |
| Windows | `%AppData%\Quaver Music` |
| macOS | `~/Library/Application Support/Quaver Music` |

同目录还有：`credential.json`（登录凭证，0600）、`device.json`（设备指纹）、`electron-dev.log`。
`QUAVER_CONFIG_DIR` 可整体顶掉这个目录（主进程同时用它下发给 sidecar，两边规则必须一致）。

```ini
[Style]    Style / DefaultUIFonts / DefaultLyricsFonts / ShowTranslation
[Window]   Decor / CloseAction / SidebarCollapsed
[Playing]  Backend / AudioDevice / Fade / Volume / Muted
[Quality]  DefaultQuality / FallbackToQMAtmos
```

- 键名与可选值以 `electron/config.mjs` 的 `SCHEMA` 为唯一真相；改新项要同时改
  `src/lib/config.ts` 的 `FALLBACK` 与 `src/lib/prefs.ts` 的类型化 getter/setter（三处）。
- **保注释**：程序只改写对应键的那一行，注释、顺序、你自己加的键都原样保留；行内 `# 注释` 也认。
- 字体两项存的就是 **CSS font-family 列表**（如 `Source Han Sans, "Microsoft YaHei", sans-serif`）。
  设置页里下拉给预设、右侧输入框可直接编辑，两边互相同步（选预设 → 填进输入框；输入非预设值 →
  下拉自动切「自定义」），逐字符即时生效、落盘合并 400ms；留空 = 不覆盖，走内置默认栈。
- 值不合法时回落默认值并写日志，不阻断启动。设置页「配置文件」一区可一键定位与恢复默认。
- 读盘时机：preload 用 `sendSync` 同步取一次（渲染层模块在 ESM import 阶段就实例化，
  异步装载会让启动期全落在默认值上）；之后每次改动整键写回。音量这类拖拽高频项合并 250ms 落盘。
- 浏览器直接开 dev server 时没有桥，自动回落 localStorage（键 `quaver.conf.v1`），同一套页面脚本两处都能跑。
- 打包态页面跑在**固定端口**（`main.mjs:STABLE_PORT`）：origin 稳定，Chromium 的 localStorage/IndexedDB/Cache
  才能跨启动延续；端口被占时 `native-server.mjs` 自动回落系统分配端口（设置本就在 conf 里，不受影响）。

自检：`npm run verify:config`（INI 引擎 + 渲染层映射，纯 Node，不用起浏览器）。

## 播放管线（双后端）

`player.ts` 只依赖 `lib/transport.ts` 的 `Transport` 接口，两条实现热切换：

- **MPV（默认，`EngineTransport`）**：主进程 spawn `mpv --input-ipc-server=<unix socket> --idle=yes`，
  经 JSON IPC 收发 `loadfile/pause/seek/volume/audio-device`；位置/时长/播放态/缓冲由引擎广播（约 4Hz），
  渲染层用单调时钟外推插值（单帧上限 0.35s、连续两帧不动即冻结），歌词/进度条/MPRIS 位置同源。
  缓存 = mpv demuxer cache（纯内存有界滑动窗口，`--cache-on-disk=no`，不落盘）。
  播放流仍走本机 `/api/stream/<token>` 中继（URL 只在 socket 里传，vkey/token 不进命令行与日志）。
  **淡入淡出**：不用 `afade`（要掐流时间位置，切歌/暂停场景不好用），而是用 mpv `volume` 属性做振幅包络 ——
  挂流时压到 0，`file-loaded` 起播瞬间升到目标；暂停/停止先降下来再落 `pause`/`stop`。
  「淡出后要执行的动作」是单一 pending 槽：任何更新的意图（播放/切歌 load）都会作废它 ——
  否则切歌时那个延迟的 `stop` 会把刚 loadfile 的新歌掐掉。淡出途中 `seek`（MPRIS Stop = pause+seek(0)）
  会把淡出提前收尾再跳，避免先听见 250ms 歌头。时长档位见设置页（关闭/0.15s/0.4s/0.8s，配置 `[Playing] Fade`）。
- **浏览器 `<audio>`（`WebTransport`）**：渲染层直挂流，dev/无原生引擎时的兜底；行为与历史管线一致（无淡入淡出）。

解析顺序：`QUAVER_MPV`（显式路径）> 随包运行时 > 宿主 `PATH`。排障追加参数走 `QUAVER_MPV_ARGS`（空白分隔，如 `--ao=null`），
显式顶掉随包目录走 `QUAVER_AUDIO_DIR`（指向解好的声源根，内含 `mpv/`）。
引擎不可用（三处都没有 / 浏览器 dev）时自动落 `<audio>` 并在设置页提示，不阻断播放。
解码后端偏好 `[Playing] Backend`：`MPV`（默认）/`Chromium`（渲染层内部标识仍是 Blink）；
音频设备偏好 `[Playing] AudioDevice`（mpv `audio-device` 名）。

### 随包音频运行时（mpv）

上游 mpv 不发布 Linux 二进制，CI 在打包前用 `scripts/stage-mpv.sh` 取 pkgforge 的 mpv AppImage
（钉版本 + sha256，x86_64 / aarch64），**构建期** `--appimage-extract` 展开到 `build-res/audio/mpv/`
（gitignored，~90MB），再由 `extraResources` 落到包内 `<resources>/audio`。本地想要同样效果：

```sh
cd ui && ./scripts/stage-mpv.sh            # 默认按 uname -m；产物在 build-res/audio/mpv
node electron/audio/bins.mjs --check build-res/audio   # 自检（验的就是生产解析路径）
```

`build-res/audio` 在仓库里只留一个 `.gitkeep`（`extraResources` 的 `from` 路径不存在会让 electron-builder 直接失败）；
没暂存也能正常构建，运行期回落系统 mpv —— 随包是优化不是前提。

运行期的三条硬约束（改之前先看 `electron/audio/bins.mjs` 头部注释）：

- 载荷是 `mpv/shared/bin/mpv`，**不能裸跑**（缺包内 so）；
- 必须用**包内自带 loader + `lib/lib.path`** 声明的库路径启动，**绝不能改用宿主 `LD_LIBRARY_PATH`**
  （宿主导入包内 libc → `undefined symbol: __pointer_chk_guard` 直接崩）；
- 不要走它的 `AppRun`：sharun 启动器会跑包内钩子（自更新下载 appimageupdatetool、弹「要不要装 yt-dlp」），
  对 spawn 出来的子进程是灾难。loader 直启载荷 = 同一套运行时、零钩子。

CI 两道断言：暂存后 `bins.mjs --check build-res/audio`；AppImage 产出后再解包，
`bins.mjs --check squashfs-root/resources/audio` —— 跨架构/缺库不会报错、只会跑不起来（exec 126），
且 AppImage 只读挂载没法运行时 chmod 补救，必须在 CI 就验过。

## 约定

- 切视图只重建 `.content` 内容区；播放条/歌词页/侧栏常驻，音频不中断。
- `player.on(fn)` 订阅状态广播，组件在回调里拉平 DOM；UI 反向改状态后调 `player.notifyPublic()`。
- 视图函数 `async (root, query) => cleanup?`：返回的 cleanup 在路由切换前执行（登录页轮询靠它停）。
- 红心收藏存 localStorage（`quaver.loved.v1`）——它是本地数据不是设置，且本 fork 上游不提供收藏写接口，勿伪造。
- 歌词翻译：fork 的老歌词 CGI 恒返回空 trans；`relay.ts` 的 `enrichLyric()` 在 `/api/getLyric`
  命中空 trans 时改走免 cookie 的 `musicu.fcg GetPlayLyricInfo`（trans=1）补齐并解码成明文 LRC。
  前端 `parseLrc` 同时兼容 base64/明文（player.b64utf8 有探测逻辑），显示开关 = player.showTrans。
- 列表交互（对齐设计稿）：歌曲行 = 序号+封面+歌名/歌手/专辑三行+♥+时长；双击行播放整队列
  （单击封面兜底播放）；歌手/专辑名为可点链接 → `#/singer?mid=` / `#/album?mid=` 视图
  （getSingerHotsong / getAlbumInfo，后者 list 项是 songmid/songname 异形需归一）。
- **曲名展示一律走 `lib/api.ts:songTitle()`**：上游 `name` 只是主名，版本后缀（Studio Live /
  (Half-acoustic Ver.) / Live On MTV…）挂在 `title` 上 —— 直接用 name，「半梦」与「半梦 (Studio Live)」
  在界面上长得一模一样。`subtitle` 是另一回事（「《小时代》电影主题曲」这类一句话说明），
  在行内作为 `.rt-sub` 次级文本追加。播放条/队列/正在播放页/MPRIS 同样走 songTitle。
- **右键菜单（SongMenu）**：插队播放（= 排到下一首，见下）/ 加入歌单（我创建的歌单）/
  从歌单删除（仅自有歌单页）/ 跳转至（歌手·专辑·同名搜索）/ 更多操作（复制歌曲链接·复制歌曲名称）。
  面板是 body 下的 fixed 层
  （`.ctx-layer` z-index 80：盖住队列浮窗 70 与正在播放页 50，但让开窗口按钮簇 90），
  子菜单悬停展开、**同层换项先收深层再展开**（早期写法会锁死第二个子菜单）；
  指针移进子菜单时不得作废在飞的异步子菜单（不然会永远停在「载入中…」）。
- **列表工具条（本地搜索 + 排序，歌单页与「我喜欢」共用，都不回源）**：组件 = `components/ListTools.ts`
  的 `songListTools({ source, paint, hint })`，控件**靠右**（命中计数在左，中间空档由 `.lt-count` 的
  auto margin 吃掉）。搜索匹配曲名（含版本后缀）/主名/副标题/歌手/专辑，输入按 120ms 合并重画
  （大列表上千行，逐字符重建会卡）；排序三键 = 默认 / 歌曲名 / 歌手，同一个键再点 = 正倒对调（箭头 ↑/↓）。
  **服务端原序不许动**：歌单的 orderlist 就是「加入时间」、我喜欢的是收藏顺序，所以「默认」原样返回，
  过滤/排序只作用在 `all.slice()/filter()` 的副本上（就地 sort 会把「加入时间」永久弄丢）。
  中文用 `Intl.Collator("zh-Hans-CN")` 按拼音排。双击播的是**当前可见的那一列**（跟着眼睛走）；
  删除一行时两页都会把它从原序里摘掉（否则重排/筛选会把它放回来）。
  选中态是「软洗底 + accent 系前景 + accent 描边」，已在 `verify-highlight-contrast.mjs` 里登记
  （新加 accent 掺色的高亮态都得跑它）。
- **插队播放 = 排队，不是切歌**（`player.enqueueNext`）：把歌插到**当前曲之后**，当前曲继续放，
  下一首轮到它 —— 不打断、不跳转；只有队列还空着（没播过）时才直接起播。
  **搜索页双击就是这个语义**（不再整队列替换），其余列表双击仍是 `playList`（整队列替换）。
  菜单项与搜索页双击共用 `SongMenu.ts:enqueueNextWithToast`（同一处语义 + 同一处 toast 回执）。
- **会话存档**（`lib/session.ts` + `player.restoreSession`）：退出时把队列/指针/位置/循环模式写进
  localStorage（`quaver.session.v1`，本地会话数据不是设置，与收藏同类），下次启动**挂流但不自动播**，
  按播放键从原处继续。两条硬约束：还原完成前不写盘（闸门 `sessionReady`，否则启动瞬间的空队列
  会覆盖存档）；用户先点了歌就放弃还原（用户意图优先）。
- **歌单写入**（加入歌单 / 从歌单删除）走 vendored submodule `vendor/QQMusicApi` 的
  `SonglistApi.add_songs` / `del_songs` —— **别拿 `SonglistApi.delete` 干这事**：那个删的是整个歌单
  （dirid 传错会删错单），移出一首歌只能是 `del_songs`。三条实测/文档约定：
  ①写接口要 **dirid**、读详情要 **disstid**（歌单详情里 `info.dirid` 与 `info.id` 各取所需）；
  ②`song_type` 必须发**写侧**枚举（读侧 type - 1，见 `api.ts:writeSongType`），发原值时上游回 retCode=0
  却什么都不发生；③`add_songs`/`del_songs` 返回的 True 很宽容（歌已存在、歌本就不在都算 True），
  只有异常码 **80092** 压成 False = 确凿失败 → `lib/playlists.ts:assertAccepted` 必须把它抛出来，
  否则「其实没写进去」会静默显示成「已加入」。
  后端 = `quaver_server/app.py` 的 `POST/DELETE /songlist/{dirid}/songs`（body: song_id/song_type/tid）。
- 播放条悬浮：`.player` 绝对定位悬浮窗底（高 64 + 底距 10）；`.body` 底部 padding 84px
  把侧栏/内容卡整体收缩到条上方（条不再遮挡任何容器，列表尾行滚到卡片底部即完整可见）。
  进度 = 整个 Bar 可拖拽（pointerdown 于任意非控件处起拖，拖中预览线/圆点/时间跟手，
  松手才 seek；换算用 #pb-prog 矩形与可视线对齐），顶边青线只是视觉指示。
  音量 = 浮窗 #pb-volpop（悬停/点击 #pb-mute 弹出，玻璃底：静音钮+滑杆+百分比读数一体；
  Bar 上滚轮微调 ±4%；条外点击关闭）。无底边音量线。
  进度可视化 = 封面染色：`lib/color.ts` 经同源中继 `/api/img`（主机+路径白名单，CDN 无 CORS
  会 taint canvas）取 24x24 量化主色 → HSL 拉进可读区间（色相保留、饱和≥0.5、亮度锚 0.6，
  灰封面例外只微提饱和）→ `--tint` 填充 Bar 已播区（.pb-fill 宽=--pf，z-index 0，控件 z-index 1；
  .player 有 backdrop-filter，负 z-index 会被整层压没——勿改回）。深色文字对比 ~4.5:1 达 AA-large。
- 音量/静音/歌词翻译开关存 `quaver.conf`（`[Playing] Volume|Muted`、`[Style] ShowTranslation`）；
  静音保留原音量值，恢复即回。音量是拖拽高频项，落盘合并 250ms。
- **每日30首 = 系统虚拟歌单（dirid 202）**：与「我喜欢」（201）同一族的系统目录 —— 服务端**每天重生成**
  30 首个性化歌单，disstid 每天都变（`created-songlists` 里也不列它，首页 feed 的卡片虽带 id/dirid，
  但按 dirid 取才稳）。读法与普通歌单详情一致（`CgiGetDiss` 传 disstid = dirid = 202），
  后端 = `quaver_server/app.py` 的 `GET /recommend/daily`（`DAILY_DIRID = 202`），返回结构与
  `/songlist/{id}/detail` 相同。前端 `dailyView` 一把 `num=100` 拿全 30 首，说明文案直接用服务端那句
  编辑语（`info.desc`）。**这页以前是假的**（拿「我喜欢」按日期种子随机凑 30 首），别再改回去。
- **猜你喜欢（`/recommend/guess`）想多拿只能「多调几轮」**：上游 `get_radio_track` **一次只给 5 首** ——
  `num` 加大被忽略（实测 5/10/20/50 都回 5 首）、回灌 `song_ids` 续拿直接 22006；好在**每轮内容随机**。
  ⚠️ **必须串行**：并发同样的请求上游只放行一个，其余全回 700000（实测并发 2/3/4/6 轮只有 1 轮成功），
  所以后端老实 `for i in range(rounds)`，别改成 `asyncio.gather`（会静默退化成 1 轮 5 首）。
  单轮约 950ms，6 轮 ≈ 6s —— 前端 `guessView` 因此**分两段取**：先 `rounds=2`（10 首）立刻出画面，
  再 `rounds=4` 去重补齐到 ~30 首后重画；第二批失败不算失败（保住首批）。**「换一批」走同一条 `load()`**：
  上游池子很大（实测 6 轮 30 首零重复），两批基本撞不上，不必排除上一批（上游也不吃排除参数）；
  取新批次**先攒在临时数组里、成了才整体换上** —— 换批失败时手上这批还在，不会一片空白。
  按钮 `.guess-bar`（页头下方右对齐，`.ghost-btn--quiet`），取歌中禁用并改文案。断言见 `verify-guess.mjs`。
- **登录页**：扫码通道用标签（`.tag-tabs` / `.tag`，与搜索页分类、歌手页标签同一组件）而不是下拉 ——
  三档一眼看全，也与全站标签语言一致。`data-ch` 的取值必须落在 sidecar 的 `QR_TYPES`（qq/wx/mobile）里，
  写错是 422 而不是静默失败（脚本交叉核对）。选中态**不复用** `.tag.sel` 的「白字 + 裸 accent 实心」：
  登录页是关卡，浅色 accent（暗色主题的 `--acc` 就是浅绿）或亮色相封面染色下白字只有 ~1-2:1；
  改用与 `.lt-sg.on` 同一套「软洗底 + accent 系前景（亮度锚 `--ink`）+ accent 描边」。
- **动效与挂载顺序**：给一个元素「换父节点」和加动画类**不能同一帧做** —— 浏览器会把「插入新节点 +
  类变更」合并成一次样式重算，`transition` 压根不启动，表现就是**「第一次没有动画，第二次正常」**
  （第二次不再换父节点了）。队列面板因此把「形态（dock/float，只看内容区宽度，**关闭时也定好**）」与
  「开合（`.open`）」解耦，并在构造后补一帧 `requestAnimationFrame(syncMount)`（壳层是构造完才把它
  append 进 DOM 的）；万一仍然换了父节点，就把 `.open` 推到下一帧再补。断言见 `verify-queue-panel-anim.mjs`。
- **程序化滚动只许动自己的滚动容器**：`scrollIntoView()` 会把**所有**可滚祖先的 scrollport 一起滚，
  而 `overflow: hidden` 的盒子程序化照样能滚（`scrollLeft` 能设）—— `.content` 正是 `.route` 的祖先。
  队列面板停靠后是「0 宽 + overflow:hidden 裁切 + translateX(20px)」，当前曲那行落在内容区右缘之外，
  于是**切一次歌**就给 `.content` 设上 scrollLeft，整个路由视图横移（「切歌后 ContentView 错位」）。
  改法：`.qp-list` 按 rect 差值自己设 `scrollTop`（见 `QueuePanel.revealCurrent`）；关闭态的面板再打
  `inert`（面板必须常驻 DOM，不能 `display:none`，否则 Tab 能聚焦进隐藏面板、浏览器又把它滚进视野）。
  脚本扫全 `src/` 禁止再出现 `scrollIntoView`。
- **「滚动就收起」这类判据必须分辨是谁在滚**：右键菜单原本监听捕获阶段的 `scroll` 就一律收起，
  结果**菜单刚开就闪没**。真因是 `.np`（正在播放）**不是 `display:none`** —— 它是
  `opacity:0 + translateY(100%)` 常驻布局，歌词每换一行就 `lyrics.scrollTo({behavior:"smooth"})`，
  smooth 滚动会连发几百毫秒 `scroll` 事件；队列面板切歌时 `revealCurrent()` 改 `.qp-list.scrollTop`、
  关于页日志框自动滚到底，都是同源误伤。菜单是 fixed 定位、坐标来自打开时的指针，**只有两类滚动
  会让它跟锚点脱节**：① 文档/窗口自己滚；② 锚点所在的可滚祖先滚（`.route`）。别的一概不收
  （见 `SongMenu.onScroll`；锚点由 `bindSongMenu` 把行传进去）。
- **玻璃效果**：侧栏/标题栏/播放条 = 半透明底 + backdrop-filter；色彩来源 = `.ambient` 环境色层
  （当前封面 blur 铺底，z-index:-1 画在 body 背景上、内容下，白卡不受污染）。无播放时退回纯色。
- dev/自动化：`import.meta.env.DEV` 下 `window.__quaverPlayer` 暴露单例。
- 新 hash 路由 = `views.ts` 注册 + `nav`（如需侧栏入口）+ 可选同名跳转层 html（记得进 `vite.config.ts` 的 `PAGES`）。
