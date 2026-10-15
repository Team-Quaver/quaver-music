// Quaver — 桌面歌词窗口（主进程侧生命周期 + IPC 中转）
//
// 形态：一个独立、无边框、透明背景、置顶、不进任务栏的覆盖层，加载同源页 desktop-lyrics.html。
// 数据面**单向镜像**：主窗渲染层的 player 是唯一事实源，经 src/lib/desktop-lyrics.ts 把
//   • 曲目/歌词快照（换曲或歌词状态变化时整包推一次），
//   • 播放钟快照（随 notify ~4Hz 推，本窗不做节流——活跃时 4 IPC/s 是白菜价），
// 发到本模块；本模块转发进桌面歌词窗（并在其页面加载完成时补发缓存的最新一帧）。
// 控制面**反向回传**：桌面歌词窗的按钮/行点击发 "quaver:dl-cmd"，本模块原样转回主窗执行
// （播放/歌词延迟都改在主窗 player + localStorage，桌面歌词窗自己不持有任何播放状态）。
//
// 为什么中转走主进程而不是窗对窗：两渲染窗之间没有直连通道，主进程本来就必须在场
// （窗口本身是原生对象，开/关/缩放只有主进程能做）；顺带让「主窗没开/重建间隙」的语义
// 退化成「消息自然丢弃」，与热键/托盘同一套容错。
//
// 窗体形态：**纯 CSD** —— 无边框 + 页面自己划拖拽区（-webkit-app-region: drag）。
// 没有「点击穿透」这一档：需要它不挡桌面时把窗口拖到空闲处；理由见 desktop-lyrics-core.ts 头。
// 也没有「最大化/全屏」这一档：歌词是贴桌面的横带，铺满整屏读不了也拖不回来 —— 构造参数只是
// 「不给按钮」，拦不住窗口管理器的手势，所以另有一道「被最大化就立刻退回」的反应式守卫。
// 初始尺寸由「字号倍率 × 行数档位」贴合内容算出（defaultSizeFor，记忆里有能用的尺寸就用记忆的），
// 不再是一律 150px 的大空带；同时带上 min/max 尺寸提示 = **「申请浮窗」**（高度那条轴 min == max，
// 平铺合成器据此放它出布局，见 desktop-lyrics-core.ts:sizeHintsFor）—— 提示必须在构造参数里就给，
// 别等 show 之后再补：窗口映射那一刻合成器就会按它判一次浮窗与否。拖把手 = 把提示重钉到新值
// （拖动中两条轴都钉、松手只把宽度放回区间，见 pinSize / releaseWidth）—— 浮窗不掉，
// Wayland 下靠合成器夹取，而 setSize 只改我们这边的视口、改不动盒子。
// 配置解析/边界兜底在 desktop-lyrics-core.ts，窗口生命周期全在本文件。
import { BrowserWindow, ipcMain, screen } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readValues, writeValues } from "./config.ts";
import {
  boundsToPatch, clampSize, defaultSizeFor, parseSettings, pickBounds, pinnedHintsFor, sizeHintsFor,
  type DlSettings, type Rect,
} from "./desktop-lyrics-core.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));


/** 主进程注入的依赖：拿主窗引用 / 应用 URL / 日志 / 托盘刷新 / 退出标志（窗口生命周期归本模块）。 */
export interface DlDeps {
  log: (msg: string, ...rest: unknown[]) => void;
  /** 应用页面的绝对基地址（如 http://127.0.0.1:4174/）；未就绪时 null（延后到 boot/控制再开） */
  getUrl: () => string | null;
  getMainWindow: () => BrowserWindow | null;
  isQuitting: () => boolean;
  /** 托盘菜单里挂了桌面歌词的勾选态，状态一变就得重建菜单 */
  refreshTrayMenu: () => void;
  /** 配置增量广播（quaver:config-changed）——**本控制器自发写盘必须走它**，见 persistConf 注释 */
  broadcastConfig: (values: Record<string, string>) => void;
  /** Crotchet 调试模式（QUAVER_CROTCHET=1）：歌词窗渲染层 console 并入主日志流水线（同主窗口径） */
  crotchet: boolean;
}

export class DesktopLyricsController {
  deps: DlDeps;
  win: BrowserWindow | null;
  /** 覆盖层页首帧是否已经拿到（晚到的快照补发要在页面就绪后才发得出去） */
  pageReady: boolean;
  settings: DlSettings;
  /** 最新一帧曲目/歌词与控制面快照：DL 窗晚到（先建窗、页面后加载）时靠它补发 */
  latestTrack: unknown;
  latestSync: unknown;
  persistTimer: ReturnType<typeof setTimeout> | null;
  /** 当前钉住的尺寸（尺寸提示里那对 min/max 的值）：拖动的**基准**，见 pinSize。
   *  为什么不拿 win.getSize() 当基准：Wayland 下那份尺寸要等合成器 configure 回来才更新，
   *  逐帧增量撞上一个滞后的基准会被吃掉（快速拖会缩水）；高度那条轴 WM 改不动（提示钉着），
   *  宽度在拖动那几帧也被我们钉着 —— 两条都以这里为准。0 = 还没开窗/未知。 */
  pinnedWidth: number;
  pinnedHeight: number;

  constructor(deps: DlDeps) {
    this.deps = deps;
    this.win = null;
    this.pageReady = false;
    this.settings = parseSettings(this.readConf());
    this.latestTrack = null;
    this.latestSync = null;
    this.persistTimer = null;
    this.pinnedWidth = 0;
    this.pinnedHeight = 0;
    this.registerIpc();
  }

  // ——— IPC 接线 ———

  private registerIpc(): void {
    // 主窗 → 主进程：曲目/歌词整包快照（结构化克隆可序列化的纯数据）
    ipcMain.on("quaver:dl-track", (e, payload) => {
      if (!this.fromMainWin(e.sender)) return;
      this.latestTrack = payload;
      this.toDl("quaver:dl-track", payload);
    });
    // 主窗 → 主进程：播放钟/延迟/可用性快照（~4Hz）
    ipcMain.on("quaver:dl-sync", (e, payload) => {
      if (!this.fromMainWin(e.sender)) return;
      this.latestSync = payload;
      this.toDl("quaver:dl-sync", payload);
    });
    // DL 窗 → 主进程 → 主窗：控制命令原样回传（执行永远在主窗 player）
    ipcMain.on("quaver:dl-cmd", (e, msg) => {
      if (!this.fromDlWin(e.sender)) return;
      const main = this.deps.getMainWindow();
      if (main && !main.isDestroyed()) main.webContents.send("quaver:dl-cmd", msg);
    });
    // DL 窗 → 主进程：窗口级动作（边缘改大小 / 关窗）——挪窗走 CSD 拖拽区，不经这里
    ipcMain.on("quaver:dl-window", (e, msg) => {
      if (!this.fromDlWin(e.sender)) return;
      this.handleWindowOp(msg);
    });
    // 主窗桥启动时的同步问路（sendSync：与 config-sync 同理，早于任何异步都要拿到确定值）
    ipcMain.on("quaver:dl-active", (e) => {
      e.returnValue = this.state();
    });
    // 控制入口：设置页开关 / 托盘菜单（任何窗都可调用；写配置 + 开窗/关窗 + 全窗广播）
    ipcMain.handle("quaver:dl-control", (_e, msg) => {
      const op = String(msg?.op ?? "");
      if (op === "get-state") return { ok: true, ...this.state() };
      // 控制指令只认主窗（设置页/播放页）；DL 页的合法出路是 quaver:dl-window，浏览器 dev 页一律拒
      if (!this.fromMainWin(_e.sender)) return { ok: false, error: "控制入口仅主窗可用" };
      if (op === "set-enabled") {
        this.setEnabled(!!msg?.on);
        return { ok: true, ...this.state() };
      }
      return { ok: false, error: `unknown op: ${op}` };
    });
  }

  /**
   * 控制器自发写盘的唯一出口：落盘 + 增量广播（quaver:config-changed）。
   *
   * 为什么不广播就会坏（真机踩过的回归）：渲染层的配置是**启动时一次性装载的内存快照**
   * （src/lib/config.ts），cfgSet 的「值没变就不写盘」优化拿这份内存比对。✕ 关窗 / 托盘切换
   * 走的是主进程直写（不经 quaver:config IPC），文件已经 False 而渲染层内存还停在 True ——
   * 再点开启：cfgSet(True) 比对内存(True) === 新值(True)，整个写盘被短路跳过，
   * syncFromConf 永远不触发，「关了再也打不开」。广播合并让所有窗口的内存恒追文件真相。
   *
   * 例外：X/Y/W/H 记忆坐标是本模块私事（渲染层不读），persistBoundsNow 保持静默直写，
   * 免得每次拖窗都全窗广播一遍噪音。
   */
  private persistConf(values: Record<string, string>): void {
    writeValues(values);
    this.deps.broadcastConfig(values);
  }

  private readConf(): Record<string, string> {
    try {
      return readValues().values;
    } catch (e) {
      this.deps.log("[quaver] desktop-lyrics: 配置读取失败，走默认值:", String(e));
      return {};
    }
  }

  private fromMainWin(sender: Electron.WebContents): boolean {
    const main = this.deps.getMainWindow();
    return !!main && !main.isDestroyed() && main.webContents === sender;
  }

  private fromDlWin(sender: Electron.WebContents): boolean {
    return !!this.win && !this.win.isDestroyed() && this.win.webContents === sender;
  }

  private toDl(channel: string, payload: unknown): void {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(channel, payload);
  }

  private broadcastActive(): void {
    const main = this.deps.getMainWindow();
    if (main && !main.isDestroyed()) main.webContents.send("quaver:dl-active", this.state());
  }

  // ——— 对外状态 ———

  state(): { open: boolean; enabled: boolean; scale: number } {
    return {
      open: !!this.win && !this.win.isDestroyed(),
      enabled: this.settings.enabled,
      scale: this.settings.scale,
    };
  }

  // ——— 开关 ———

  /** 应用启动尾调用：磁盘上开着桌面歌词 → 主窗就绪后把覆盖层也拉起来（位置/大小按记忆恢复）。 */
  boot(): void {
    this.settings = parseSettings(this.readConf());
    if (this.settings.enabled) this.open();
  }

  /** 外部改了 [DesktopLyrics] 配置（设置页 cfgSet 走 quaver:config set）后按磁盘现值对齐：
   *  开→没开则开，关→开着则关（幂等，无回流循环 —— 本方法不写盘，写盘恒在 setEnabled
   *  或渲染层 config 通道里各只发生一次）。字号/行数/颜色/透明度由覆盖层自己读配置、
   *  听 quaver:config-changed 广播即时跟随；只有**窗体**不透明度要原生那一刀（win/mac）。 */
  syncFromConf(): void {
    const next = parseSettings(this.readConf());
    const open = !!this.win && !this.win.isDestroyed();
    // 字号/行数/辅助行变了 = 内容容量变了：窗还开着就把高度重新贴合（见 refitHeight）
    const capacityChanged = this.settings.scale !== next.scale
      || this.settings.mode !== next.mode || this.settings.aux !== next.aux;
    this.settings = next;
    if (next.enabled && !open) this.open();
    else if (!next.enabled && open) this.closeWindow();
    else if (capacityChanged) this.refitHeight();
    this.broadcastActive();
    this.deps.refreshTrayMenu();
  }

  setEnabled(on: boolean): void {
    this.settings = { ...this.settings, enabled: on };
    this.persistConf({ "DesktopLyrics.Enabled": on ? "True" : "False" });
    if (on) this.open();
    else this.closeWindow();
    this.broadcastActive();
    this.deps.refreshTrayMenu();
  }

  // ——— 窗口生命周期 ———

  private open(): void {
    if (this.win && !this.win.isDestroyed()) return;
    const base = this.deps.getUrl();
    if (!base) {
      this.deps.log("[quaver] desktop-lyrics: 应用服务地址未就绪，稍后再开（启用状态已记录）");
      return;
    }
    let url: URL;
    try {
      url = new URL("desktop-lyrics.html", base);
    } catch (e) {
      this.deps.log("[quaver] desktop-lyrics: URL 拼装失败:", String(e), base);
      return;
    }
    const displays: Rect[] = screen.getAllDisplays().map((d) => d.workArea);
    // 初始尺寸跟着「字号 × 行数」贴内容；记忆里若是用户拖过且合理的尺寸，照旧恢复
    const hint = defaultSizeFor(this.settings);
    const bounds = pickBounds(this.settings.bounds, displays, hint);
    // 「申请浮窗」：min/max 尺寸提示必须在**构造参数**里给 —— 窗口映射那一刻合成器就按它判浮窗
    // （高度 min == max = 有一条不可变的轴），之后 show 再补就晚了那一帧。机制见 sizeHintsFor。
    const hints = sizeHintsFor(bounds?.height ?? hint.height);
    const win = new BrowserWindow({
      width: bounds?.width ?? hint.width,
      height: bounds?.height ?? hint.height,
      x: bounds?.x,
      y: bounds?.y,
      minWidth: hints.minWidth,
      maxWidth: hints.maxWidth,
      minHeight: hints.minHeight,
      maxHeight: hints.maxHeight,
      show: false,
      frame: false,
      transparent: true,                 // 背景全透明：只留歌词与控制条
      backgroundColor: "#00000000",
      hasShadow: false,                  // 透明窗的投影会画成一圈脏边
      resizable: true,
      // CSD 的拖拽区（-webkit-app-region: drag，见 src/desktop-lyrics.css）要靠「窗口可移动」；
      // 关掉就只剩缩放能用了。Wayland 下这是唯一真能挪窗的路（setPosition 被合成器无视）。
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      title: "Quaver 桌面歌词",
      webPreferences: {
        preload: join(__dirname, "preload.cts"), // 与主窗同一座桥：quaverDesktopLyrics 双面入口
        contextIsolation: true,
        sandbox: false,
      },
    });
    // 屏幕最前（macOS 用 screen-saver 层，能盖全屏应用；X11 落 _NET_WM_STATE_ABOVE；
    // Wayland 无通用「置顶」协议——尽力而为，这也是桌面类应用在所有 Wayland 桌上的共同现状）
    win.setAlwaysOnTop(true, "screen-saver");
    try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch { /* 平台不支持则跳过 */ }
    win.on("ready-to-show", () => win.showInactive()); // 不抢焦点：桌面歌词只是「贴」在屏幕上
    win.webContents.on("did-finish-load", () => {
      // Electron 44 把本事件收进「参数对象」形态且不带 sender —— 守卫改比 this.win 更直接：
      // 事件源就是手里这个 win；窗已被关替（重建竞态）时旧监听自然作废
      if (this.win !== win || win.isDestroyed()) return;
      // 晚到的窗补发最新缓存：曲目歌词，最后时钟
      this.pageReady = true;
      if (this.latestTrack) this.toDl("quaver:dl-track", this.latestTrack);
      if (this.latestSync) this.toDl("quaver:dl-sync", this.latestSync);
    });
    if (this.deps.crotchet) {
      // 调试模式：歌词窗渲染层日志（含未捕获异常）并入同一份文件 —— 与主窗 console-message 同一口径
      win.webContents.on("console-message", (details) => {
        this.deps.log(`[dl-renderer:${details?.level ?? "info"}]`, details?.message ?? "", details?.sourceId ? `(${details.sourceId}:${details.lineNumber})` : "");
      });
      win.webContents.on("render-process-gone", (_e, gone) => this.deps.log("[dl-renderer:gone]", JSON.stringify(gone)));
    }
    // ——— 「不支持最大化」的兜底 ———
    // maximizable/fullscreenable=false 只拿掉了按钮，挡不住窗口管理器：Windows 拖到顶边的 Aero Snap、
    // KDE/GNOME 的平铺手势与 Super+Up、无边框窗双击拖拽区都能把它整屏化。整屏的覆盖层既读不了歌词
    // 又会把记忆坐标写歪（resized 会落盘，见下面），所以两道一起上：
    //   ① 尺寸上限在构造参数里（maxWidth = DL_SIZE_MAX.width；高度那条轴被 min == max 钉死，长不了）——
    //      「申请浮窗」用的就是这一对提示（见 sizeHintsFor），别在这里再 setMaximumSize 覆盖它：
    //      一旦把 maxHeight 改成别的值，轴就不等了，合成器会重新把窗平铺回布局里；
    //   ② 真的被最大化/全屏/最小化了，当场退回（unmaximize 还原到 maximize 前的 bounds；500ms 的
    //      落盘去抖会把这中间的抖动合成一次，最终写下去的就是还原后的尺寸）。
    //      最小化这一档更该拦：本窗 skipTaskbar，缩进任务栏外就再也点不回来了（只能靠托盘开关）。
    const rejectState = (what: string): void => {
      if (this.win !== win || win.isDestroyed()) return;
      if (!win.isMaximized() && !win.isMinimized() && !win.isFullScreen()) return; // 事件抢跑：已经好了
      try {
        if (win.isFullScreen()) win.setFullScreen(false);
        if (win.isMaximized()) win.unmaximize();
        if (win.isMinimized()) win.restore();
      } catch (e) {
        this.deps.log("[quaver] desktop-lyrics: 还原窗体失败:", String(e));
        return;
      }
      this.deps.log(`[quaver] desktop-lyrics: 覆盖层不支持${what}，已还原`);
    };
    win.on("maximize", () => rejectState("最大化"));
    win.on("enter-full-screen", () => rejectState("全屏"));
    win.on("minimize", () => rejectState("最小化"));
    win.on("moved", () => this.schedulePersist());
    win.on("resized", () => this.schedulePersist());
    win.on("closed", () => {
      this.win = null;
      this.pageReady = false;
      this.persistBoundsNow();
      // 用户主动关掉覆盖层 = 「这次不想看」：启用状态落 False，下次启动不再自动弹回。
      // 随应用退出被连带销毁时**不**写（quitting），否则「带着桌面歌词退出」会被误记成关闭。
      if (!this.deps.isQuitting()) {
        this.settings = { ...this.settings, enabled: false };
        this.persistConf({ "DesktopLyrics.Enabled": "False" });
      }
      this.broadcastActive();
      this.deps.refreshTrayMenu();
    });
    this.win = win;
    // 构造参数里的 min/max 就是第一次「钉」（见 sizeHintsFor）：基准跟着一起记
    this.pinnedWidth = bounds?.width ?? hint.width;
    this.pinnedHeight = hints.minHeight;
    win.loadURL(url.toString());
    this.deps.log("[quaver] desktop-lyrics: 已开", url.toString(), bounds ? `@${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}` : "(无屏幕坐标)");
    this.deps.refreshTrayMenu();
  }

  private closeWindow(): void {
    const win = this.win;
    // 先断引用防重入（'closed' 回调里的再清一次是幂等）
    this.win = null;
    this.pageReady = false;
    if (win && !win.isDestroyed()) win.close();
  }

  // ——— DL 窗的窗口级动作 ———

  /** 档位（字号 / 行数 / 辅助行）变了把窗高重新贴合内容：**只长不缩** —— 用户自己拖出来的高度
   *  不该被一次配置改动抹掉，而「字被条带切掉」是实打实的坏画面。宽度与左上角都不动（高度向下长；
   *  Wayland 下 setPosition 本来就被合成器无视，挪顶边这条路不可靠）。
   *  高度是 min == max 那条「钉死的轴」（见 sizeHintsFor）：钉的不是「不许改」而是值的唯一性，
   *  所以这里把**提示与窗体一起**重钉到新值（合成器随后按提示夹取，Wayland 下这才是真生效的那一步）。
   *  setSize 触发 'resized' → 去抖落盘 W/H。 */
  private refitHeight(): void {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    const [w, h] = win.getSize(); // 档位变化时没有拖动，读窗体即可（拖动中另说，见 pinSize）
    const from = this.pinnedHeight || h;
    const want = Math.max(defaultSizeFor(this.settings).height, from);
    if (from >= want) return;
    this.pinHeight(w, want);
    this.deps.log(`[quaver] desktop-lyrics: 档位变化，窗高贴合 ${from} -> ${want}`);
  }

  /** 只钉高度（宽度留区间，WM 拖边改宽照旧）：档位变化与松手走这条。
   *  高度那条 min == max 的提示既是「申请浮窗」的判据，也是让合成器把窗夹到该高度的**唯一**手段 ——
   *  Wayland 下 setSize 改不动窗体盒（见 pinnedHintsFor）。setSize 在这里是给 X11/Windows/macOS 的
   *  那一刀，四个平台同一套口径。pinned* 两个镜像只在本方法与 pinSize 里写（开窗那一次在 open()
   *  里补记，构造里置 0）。 */
  private pinHeight(width: number, height: number): void {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    const hints = sizeHintsFor(height);
    win.setMinimumSize(hints.minWidth, hints.minHeight);
    win.setMaximumSize(hints.maxWidth, hints.maxHeight);
    win.setSize(width, hints.minHeight);
    this.pinnedWidth = width;
    this.pinnedHeight = hints.minHeight;
  }

  /** 拖动中：两条轴一起钉（min == max），合成器每帧都跟得上 —— 见 pinnedHintsFor 的实测记录。
   *  松手由 releaseWidth() 把宽度放回区间。 */
  private pinSize(width: number, height: number): void {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    const hints = pinnedHintsFor(width, height);
    win.setMinimumSize(hints.minWidth, hints.minHeight);
    win.setMaximumSize(hints.maxWidth, hints.maxHeight);
    win.setSize(hints.minWidth, hints.minHeight);
    this.pinnedWidth = hints.minWidth;
    this.pinnedHeight = hints.minHeight;
  }

  /** 拖完松手：宽度放回区间（高度继续钉死）—— 常态下窗口的宽度还是交给 WM 拖边。 */
  private releaseWidth(): void {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    const [w, h] = win.getSize();
    this.pinHeight(this.pinnedWidth || w, this.pinnedHeight || h);
  }

  private handleWindowOp(msg: { op?: string; dx?: number; dy?: number; on?: boolean }): void {
    // 挪窗不在这里：整层是 CSD 拖拽区（-webkit-app-region: drag，见 src/desktop-lyrics.css），
    // 由合成器/窗口管理器做交互移动（Wayland 下 setPosition 本就无效，只有这条路是真的）。
    // 这里只剩边缘缩放与关窗 —— 都只有原生侧做得了。
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    switch (String(msg?.op ?? "")) {
      case "resize-by": {
        const dx = Number(msg?.dx) || 0;
        const dy = Number(msg?.dy) || 0;
        if (!dx && !dy) return;
        const [w, h] = win.getSize();
        // 两条轴都以我们自己钉的值为基准（见 pinnedWidth/pinnedHeight）：读 win.getSize() 在
        // Wayland 上会滞后，逐帧增量会被吃掉（快速拖会缩水）。还没钉过就退回读窗体。
        const fromW = this.pinnedWidth || w;
        const fromH = this.pinnedHeight || h;
        const size = clampSize(fromW + dx, fromH + dy);
        if (size.width === fromW && size.height === fromH) return;
        this.pinSize(size.width, size.height); // 两条轴都推提示：Wayland 下 setSize 跟不上盒子
        this.schedulePersist();
        break;
      }
      case "resize-end":
        // 松手：宽度放回区间（见 releaseWidth），高度继续钉死
        this.releaseWidth();
        this.schedulePersist();
        break;
      case "close":
        this.setEnabled(false);
        break;
      default:
        break;
    }
  }

  /** 位置/尺寸落盘去抖：拖拽逐帧发 'moved'，别一帧写一次 INI。 */
  private schedulePersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => this.persistBoundsNow(), 500);
    this.persistTimer.unref?.();
  }

  private persistBoundsNow(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    try {
      const b = win.getBounds();
      this.settings = { ...this.settings, bounds: b };
      writeValues(boundsToPatch(b));
    } catch (e) {
      this.deps.log("[quaver] desktop-lyrics: 位置落盘失败:", String(e));
    }
  }
}
