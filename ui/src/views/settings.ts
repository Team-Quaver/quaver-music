// Quaver — 路由视图：settings（由 src/views/index.ts 按需动态 import，不在首屏解析）
import "./settings.css";
import { mountHotkeysPanel } from "../components/HotkeySettings";
import { showCreditsDialog } from "../components/CreditsDialog";
import { showDebugDialog } from "../components/DebugDialog";
import { toast } from "../components/SongMenu";
import { currentAccent, refreshAccent } from "../lib/accent";
import { applyBackground } from "../lib/ambient";
import { api, escHtml, getQuality, getStreamTiers, setQuality, setSessionQuality } from "../lib/api";
import type { Quality } from "../lib/api";
import { resetCjkConverter } from "../lib/cjk-convert";
import { cmyk2rgb, hsl2rgb, parseHex, rgb2cmyk, rgb2hsl, toHex } from "../lib/color";
import type { RGB } from "../lib/color";
import { configInfo, resetConfig, revealConfig } from "../lib/config";
import { clearMusicCache, musicCacheStatus, setMusicCacheLimit } from "../lib/music-cache";
import { desktopLyricsStateSync } from "../lib/desktop-lyrics";
import { syncInhibit } from "../lib/inhibit";
import { applyMenuGlass } from "../lib/menu-glass";
import { BG_FLOW_MAX, BG_FLOW_MIN, FONT_CUSTOM, FONT_LABELS, FONT_PRESETS, TINT_DEFAULT_COLOR, fontKeyOf, getAutoCheck, getBackgroundFlow, getBackgroundImage, getBackgroundMode, getBackgroundRenderer, getNpBackgroundRenderer, getChineseConvert, getCloseAction, getControlBarMode, getDecode, getPlaylistMode,
  getDecor, getDesktopLyrics, getDesktopLyricsBackdrop, getDesktopLyricsBorder, getDesktopLyricsColor, getDesktopLyricsColorMode, getDesktopLyricsFontList, getDesktopLyricsLocked, getDesktopLyricsShadow, getDesktopLyricsShadowBlur, getDesktopLyricsShadowOpacity, getDesktopLyricsShadowX, getDesktopLyricsShadowY, getDesktopLyricsMode, getDesktopLyricsOpacity, getDesktopLyricsScale, getDesktopLyricsSingleCenter, getDesktopLyricsWeight, getFade, getFallbackSort, getInhibitSleep, getLyricFontList, getMusicCacheLimitMB, getMenuBlur, getNpLyricLayout, getOnlineTtml, getPrevBehavior, getReportListenTime, getTheme, getTintColor, getTintMode, getTtmlDatabase, getTtmlLibrary, getUiFontList, getUpdateChannel, normalizeFontList, setAutoCheck, setBackgroundFlow, setBackgroundImage, setBackgroundMode, setBackgroundRenderer, setNpBackgroundRenderer, setChineseConvert, setCloseAction, setControlBarMode, setDecor, setMusicCacheLimitMB, setPlaylistMode, setDesktopLyrics, setDesktopLyricsBackdrop, setDesktopLyricsBorder, setDesktopLyricsColor, setDesktopLyricsColorMode, setDesktopLyricsFontList, setDesktopLyricsFontPreset, setDesktopLyricsLocked, setDesktopLyricsShadow, setDesktopLyricsShadowBlur, setDesktopLyricsShadowOpacity, setDesktopLyricsShadowX, setDesktopLyricsShadowY, setDesktopLyricsMode, setDesktopLyricsOpacity, setDesktopLyricsScale, setDesktopLyricsSingleCenter, setDesktopLyricsWeight, setFallbackSort, setInhibitSleep, setLyricFontList, setLyricFontPreset, setMenuBlur, setNpLyricLayout, setOnlineTtml, setPrevBehavior, setReportListenTime, setTheme, setTintColor, setTintMode, setTtmlDatabase, setTtmlLibrary, setUiFontList, setUiFontPreset, setUpdateChannel, MUSIC_CACHE_MAX_MB } from "../lib/prefs";
import type { BackgroundMode, BackgroundRenderer, ChineseConvert, CloseAction, ControlBarMode, DecorMode, PlaylistMode, DlColorMode, DlMode, FadePreset, FallbackSort, NpLyricLayout, PrevBehavior, ThemeMode, TintMode, UpdateChannel } from "../lib/prefs";
import { applyTint } from "../lib/tint";
import { TTML_DB_DEFAULT_URL, isTtmlDatabaseUrl } from "../lib/ttml";
import { buildChannel, channelLabel, describeBuild, parseVersion } from "../lib/update-core";
import { checkAndPrompt, getPlatformInfo } from "../lib/updater";
import { player } from "../player";
import { sparkActivateTheme, sparkActiveThemeId } from "../sparkle/host";
import { onSparkleChange, sparkleActiveTheme, sparkleThemes } from "../sparkle/registry";
import { mountSparklePanel } from "../sparkle/settings";
import { backgroundPolicyOf, backgroundRendererOf } from "../sparkle/theme-background";
import { menuGlassPolicyOf } from "../sparkle/theme-menus";
import { controlBarPolicyOf } from "../sparkle/theme-control-bar";
import { playlistModePolicyOf } from "../sparkle/theme-playlist-mode";
import {
  TINT_PRESET_CUSTOM,
  TINT_PRESET_COVER, TINT_PRESET_SYSTEM, resolvePresetColor,
  sparkCustomTint, sparkSetCustomTint, sparkSetTintChoice, sparkTintChoice, tintPolicyOf,
  pickPreset,
} from "../sparkle/theme-tint";
import type { SparkleTintPreset } from "@quaver/sparkle";
import { errText, h, watchBackendChange } from "./_shared";

// —— 设置页（对齐设计稿：外观设置 / 播放设置 / 调试 三区；不触碰侧栏与播放条） ——
export default async function settingsView(root: HTMLElement) {
  const isMac = /Mac|iPhone|iPad/.test(navigator.userAgent);

  const fontOptions = Object.entries(FONT_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")
    + `<option value="${FONT_CUSTOM}">个性化</option>`;

  const decodeRow = (name: string, label: string, disabled = false) =>
    `<label><input type="radio" name="decode" value="${name}"${disabled ? " disabled" : ""}/>${label}${disabled ? ` <span class="muted soon">敬请期待</span>` : ""}</label>`;

  root.classList.add("settings-page"); // 让设置页内部自己滚动（见 style.css 的 .settings-page）
  root.append(h("h1", "page-title", "设置"));

  // 分区标签：只切显隐，不重渲染（各面板绑定一次常驻有效）
  const tabs = h("div", "set-tabs", `
    <button class="set-tab is-active" data-tab="appearance" type="button">外观</button>
    <button class="set-tab" data-tab="playback" type="button">播放</button>
    <button class="set-tab" data-tab="lyrics" type="button">歌词</button>
    <button class="set-tab" data-tab="hotkeys" type="button">热键</button>
    <button class="set-tab" data-tab="general" type="button">通用</button>
    <button class="set-tab" data-tab="plugins" type="button">花火插件</button>`);

  root.append(tabs);
  const wrap = h("div", "set-view");
  wrap.innerHTML = `
    <section class="set-panel" data-panel="appearance">
      <div class="set-group">
        <div class="set-label">外观模式</div>
        <div class="opt-cards" id="theme-cards">
          <button class="opt-card" data-opt="system" type="button"><span class="sw sw-system"></span>跟随系统</button>
          <button class="opt-card" data-opt="light" type="button"><span class="sw sw-light"></span>明镜白</button>
          <button class="opt-card" data-opt="dark" type="button"><span class="sw sw-dark"></span>玄幻黑</button>
        </div>
      </div>

      <!-- 背景（默认主题的环境色层）：三档 + 自定义图片 + 模糊强度，绑定见下方 paintBg* -->
      <div class="set-group">
        <div class="set-label">背景</div>
        <div class="opt-cards" id="bg-cards">
          <button class="opt-card" data-opt="off" type="button">关闭背景</button>
          <button class="opt-card" data-opt="cover" type="button">专辑封面</button>
          <button class="opt-card" data-opt="custom" type="button">自定义图片</button>
          <!-- 「选择图片…」紧挨着「自定义图片」：只在选中它时才出现（paintBgMode 控 hidden），
               虚边框 + 次级文字色 = 它是动作不是第四个档位 -->
          <button class="opt-card action" id="bg-pick" type="button" hidden>选择图片…</button>
          <span class="bg-file" id="bg-file" hidden></span>
        </div>
        <div class="set-row" id="bg-flow-row">
          <span class="set-row__label">流动速度</span>
          <div class="set-row__ctrl">
            <input class="set-blur" id="bg-flow" type="range" min="${BG_FLOW_MIN}" max="${BG_FLOW_MAX}" step="0.05"
              aria-label="背景流动速度" />
            <span class="bg-blur-val" id="bg-flow-val"></span>
          </div>
        </div>
        <div class="set-row">
          <span class="set-row__label">首页风格</span>
          <div class="opt-cards" id="bg-renderer-cards">
            <button class="opt-card" data-opt="mesh" type="button">网格渐变</button>
            <button class="opt-card" data-opt="quaver" type="button">Quaver Design</button>
          </div>
        </div>
        <div class="set-row">
          <span class="set-row__label">歌词页风格</span>
          <div class="opt-cards" id="np-bg-renderer-cards">
            <button class="opt-card" data-opt="mesh" type="button">网格渐变</button>
            <button class="opt-card" data-opt="quaver" type="button">Quaver Design</button>
          </div>
        </div>
        <p class="muted set-hint" id="bg-hint" hidden></p>
      </div>

      <!-- 高亮颜色（tint）：三档来源 + 自定义色的颜色选择器（HSL / CMYK / RGB + HEX），
           绑定见下方 paintTint* 那一段 -->
      <div class="set-group">
        <div class="set-label">高亮颜色</div>
        <div class="opt-cards" id="tint-cards">
          <button class="opt-card" data-opt="default" type="button">青色（默认）</button>
          <button class="opt-card" data-opt="cover" type="button">跟随封面</button>
          <button class="opt-card" data-opt="system" type="button"><span class="sw sw-accent"></span>系统强调色</button>
          <div class="tint-slot" id="tint-slot">
            <button class="opt-card" data-opt="custom" type="button">自定义颜色</button>
            <!-- 当前自定义色的色块：动作按钮样式（虚边框）+ 点它展开/收起旁边的选择器；只在自定义档出现 -->
            <button class="opt-card action tint-chip" id="tint-chip" type="button" hidden
              aria-label="展开或收起颜色选择器" aria-expanded="false"></button>
            <div class="tint-pop" id="tint-pop" hidden>
              <div class="tint-pop__head">
                <span class="tint-pop__title">颜色选择器</span>
                <button class="tint-pop__fold" id="tint-fold" type="button">收起</button>
              </div>
              <div class="tint-preview">
                <span class="tint-preview__sw" id="tint-swatch"></span>
                <code class="tint-preview__hex" id="tint-code"></code>
              </div>
              <input class="tint-hue" id="tint-hue" type="range" min="0" max="359" step="1" aria-label="色相" />
              <div class="tint-modes" id="tint-modes" role="tablist">
                <button class="tint-mode" data-mode="hsl" type="button" role="tab">HSL</button>
                <button class="tint-mode" data-mode="cmyk" type="button" role="tab">CMYK</button>
                <button class="tint-mode" data-mode="rgb" type="button" role="tab">RGB</button>
              </div>
              <div class="tint-fields" id="tint-fields"></div>
              <div class="tint-hex-row">
                <span class="tint-field__label">HEX</span>
                <input id="tint-hex" type="text" spellcheck="false" autocomplete="off" maxlength="7"
                  placeholder="#19c2d8" aria-label="颜色十六进制值" />
              </div>
            </div>
          </div>
        </div>
        <!-- 主题自带的高亮方案（SDK: SparkleTheme.tint.mode="presets"）动态填充；
             主题接管高亮色（tint 缺省）时这组与上面的三档都不出现，只留一行说明 -->
        <div class="opt-cards" id="tint-spark-cards" hidden></div>
        <p class="muted set-hint" id="tint-hint" hidden></p>
      </div>

      <!-- 浮层菜单的毛玻璃：一棵总开关（右键菜单 / 音质·播放模式·音量浮窗 / 正在播放页 ⋮ /
           音频流信息浮窗），绑定见下方 paintMenuGlass*。令牌与七处消费点全在 style.css 顶部。 -->
      <div class="set-group">
        <div class="set-label">模糊效果</div>
        <div class="opt-cards" id="menu-glass-cards">
          <button class="opt-card" data-opt="on" type="button">开启</button>
          <button class="opt-card" data-opt="off" type="button">关闭</button>
        </div>
        <p class="muted set-hint" id="menu-glass-hint" hidden></p>
      </div>

      <!-- 播放控制条：底部停靠 / Content View 内悬浮。悬浮态的让位动画与安全区全在
           style.css 的 --control-bar-*；Sparkle 主题/样式层可覆盖同一组令牌或重画形态。 -->
      <div class="set-group">
        <div class="set-label">播放控制</div>
        <div class="opt-cards" id="control-bar-cards">
          <button class="opt-card" data-opt="bottom" type="button">底部停靠</button>
          <button class="opt-card" data-opt="floating" type="button">内容区悬浮</button>
        </div>
        <p class="muted set-hint" id="control-bar-hint" hidden></p>
      </div>

      <!-- 歌单显示模式：菜单栏（侧栏列歌单，默认）/ 歌单集合页（侧栏不列歌单、导航垂直居中，
           歌单改到 #/playlists 以 grid 分区）。主题声明 theme.playlistMode 时整组禁用，
           呈现形态与让位一律由 style.css 按 body[data-playlist-mode] 接管。 -->
      <div class="set-group">
        <div class="set-label">菜单栏模式</div>
        <div class="opt-cards" id="playlist-mode-cards">
          <button class="opt-card" data-opt="menu" type="button">高效模式</button>
          <button class="opt-card" data-opt="collection" type="button">简洁模式</button>
        </div>
        <p class="muted set-hint" id="playlist-mode-hint" hidden></p>
      </div>

      <!-- 花火面具：卡片由下方 renderSparkleThemes 动态填充（无插件主题时整组隐藏） -->
      <div class="set-group" id="sparkle-theme-group" hidden>
        <div class="set-label">花火面具 <span class="set-note-inline">来自插件；覆盖在上方模式之上，未覆盖的变量跟随明暗</span></div>
        <div class="opt-cards" id="sparkle-theme-cards"></div>
      </div>

      <div class="set-group">
        <div class="set-label">窗口装饰模式 <span class="set-note-inline">点击切换后立即重启</span></div>
        <div class="opt-cards" id="decor-cards">
          <button class="opt-card" data-opt="csd" type="button">无边窗口模式</button>
          <button class="opt-card" data-opt="ssd" type="button">系统装饰模式</button>
        </div>
      </div>

      <div class="set-group">
        <div class="set-label">关闭按钮行为 <span class="set-note-inline"></span></div>
        <div class="opt-cards" id="close-cards">
          <button class="opt-card" data-opt="tray" type="button">缩回托盘</button>
          <button class="opt-card" data-opt="quit" type="button">退出</button>
        </div>
      </div>

      <div class="set-group">
        <div class="set-label">字体设置</div>
        <div class="set-row"><span class="set-row__label">界面字体</span>
          <div class="set-row__ctrl font-row">
            <select id="font-ui" aria-label="界面字体预设">${fontOptions}</select>
            <input id="font-ui-list" type="text" spellcheck="false" autocomplete="off"
              aria-label="字体家族列表"
              placeholder="留空代表使用默认字体" />
          </div>
        </div>
        <div class="set-row"><span class="set-row__label">正在播放页歌词字体</span>
          <div class="set-row__ctrl font-row">
            <select id="font-lyric" aria-label="正在播放页歌词字体预设">${fontOptions}</select>
            <input id="font-lyric-list" type="text" spellcheck="false" autocomplete="off"
              aria-label="正在播放页歌词字体家族列表"
              placeholder="留空代表使用默认字体" />
          </div>
        </div>
        <p class="muted set-hint">按优先级排序，使用半角逗号排序</p>
      </div>

    </section>

    <section class="set-panel" data-panel="playback" hidden>
      <div class="set-group" id="backend-device"${isMac ? " hidden" : ""}>
        <div class="set-label">音频设备</div>
        <div class="set-row"><span class="set-row__label">输出设备</span>
          <div class="set-row__ctrl"><select id="audio-backend" disabled><option>系统默认</option></select></div>
        </div>
        <p class="muted set-hint" id="audio-device-hint">原生播放引擎下，</p>
      </div>

      <div class="set-group">
        <div class="set-label">播放引擎 <span class="set-note-inline" id="engine-note">- 默认 MPV，可选原生兼容 / 浏览器</span></div>
        <div class="opt-radios" id="decode-radios">
          ${decodeRow("MPV", "原生直出（MPV）")}${decodeRow("MPVCompat", "原生兼容（MPV 仅解码模式，实验性支持）")}${decodeRow("Blink", "兼容模式（Blink）")}
        </div>
        <p class="muted set-hint" id="engine-hint" hidden></p>
      </div>

      <div class="set-group">
        <div class="set-label">图形均衡器 <span class="set-note-inline">原生 / 兼容 · 实时预览</span></div>
        <div class="set-row">
          <div class="set-row__ctrl">
            <button class="ghost-btn eq-open-btn" id="open-equalizer" type="button">打开 EQ 浮窗</button>
          </div>
        </div>
      </div>

      <div class="set-group">
        <div class="set-label">淡入淡出 <span class="set-note-inline">原生 / 兼容 · 兼容模式跨曲交叉</span></div>
        <div class="opt-cards" id="fade-cards">
          <button class="opt-card" data-opt="off" type="button">0s</button>
          <button class="opt-card" data-opt="short" type="button">0.15s</button>
          <button class="opt-card" data-opt="normal" type="button">0.4s</button>
          <button class="opt-card" data-opt="long" type="button">0.8s</button>
        </div>
        <!-- <p class="muted set-hint">起播从静音升到当前音量；暂停 / 切歌 / 停止时先降下来再停（切歌时淡出与下一首的淡入自然衔接）。浏览器 &lt;audio&gt; 后端不生效。</p> -->
      </div>

      <div class="set-group">
        <div class="set-label">上一首按钮行为</div>
        <div class="opt-cards" id="prev-behavior-cards">
          <button class="opt-card" data-opt="replay" type="button">重放当前曲</button>
          <button class="opt-card" data-opt="previous" type="button">跳到上一首</button>
        </div>
        <p class="muted set-hint">「重放当前曲」：单击把当前曲从头再放、双击跳到队列里的上一首（默认）；「跳到上一首」：单击直接切到队列里的上一首（连按逐首回退）。即时生效；媒体键/热键同逻辑，快速连按两次等同双击。</p>
      </div>

      <div class="set-group">
        <div class="set-label">播放音频时睡眠禁止 <span class="set-note-inline">默认开启</span></div>
        <div class="opt-cards" id="inhibit-sleep-cards">
          <button class="opt-card" data-opt="on" type="button">开启</button>
          <button class="opt-card" data-opt="off" type="button">关闭</button>
        </div>
        <p class="muted set-hint">播放音频期间阻止系统进入睡眠/待机；屏幕的熄灭与锁屏照常生效，暂停或停止即恢复原睡眠策略。</p>
      </div>

      <div class="set-group">
        <div class="set-label">听歌时长上报 <span class="set-note-inline">默认开启</span></div>
        <div class="opt-cards" id="listen-report-cards">
          <button class="opt-card" data-opt="on" type="button">开启</button>
          <button class="opt-card" data-opt="off" type="button">关闭</button>
        </div>
        <p class="muted set-hint">登录后每满 60 秒向 QQ 音乐上报一次真实播放时长；暂停、缓冲、系统休眠与本地曲目不计入。</p>
      </div>

      <div class="set-group">
        <div class="set-label">默认音质 <span class="set-note-inline" id="q-member-note"></span></div>
        <div class="opt-cards" id="quality-grid">
          <button class="opt-card q" data-q="auto" type="button">自动</button>
        </div>
      </div>

      <div class="set-group">
        <div class="set-label">是否启用回退臻品全景声<span class="set-note-inline">臻品全景声可能会影响部分歌曲视听体验，故默认关闭</span></div>
        <div class="opt-cards" id="atmos-fallback-cards">
          <button class="opt-card" data-opt="no-atmos" type="button">关闭</button>
          <button class="opt-card" data-opt="rank" type="button">开启</button>
        </div>
        <p class="muted set-hint">自动优先「臻品母带」，若音源无该音质则跳过「臻品全景声」；「开启」则保留全景声模式。</p>
        <p class="muted set-hint">仅限 QQ 音乐超级会员生效。</p>
      </div>
    </section>
    <!-- 歌词面板：繁简转换 / 在线 TTML 逐字库 / 本地 TTML 歌词库目录（[Lyrics] 段，见 electron/config.ts） -->
    <section class="set-panel" data-panel="lyrics" hidden>
      <div class="set-group">
        <div class="set-label">歌词列模式</div>
        <div class="opt-cards" id="np-lyric-layout-cards">
          <button class="opt-card" data-opt="default" type="button">默认</button>
          <button class="opt-card" data-opt="full" type="button">全高</button>
          <button class="opt-card" data-opt="hide-played" type="button">已播放行隐藏</button>
          <button class="opt-card" data-opt="full-hide-played" type="button">全高已播放行隐藏</button>
        </div>
      </div>

      <div class="set-group">
        <div class="set-label">繁简转换 <span class="set-note-inline">Powered by OpenCC</span></div>
        <div class="opt-cards" id="cjk-cards">
          <button class="opt-card" data-opt="off" type="button">不转换</button>
          <button class="opt-card" data-opt="simplified" type="button">转为简体</button>
          <button class="opt-card" data-opt="traditional" type="button">转为繁体</button>
        </div>
      </div>

      <div class="set-group">
        <div class="set-label">在线 TTML 歌词</div>
        <div class="opt-cards" id="ttml-online-cards">
          <button class="opt-card" data-opt="on" type="button">开启</button>
          <button class="opt-card" data-opt="off" type="button">关闭</button>
        </div>
        <div class="set-row"><span class="set-row__label">数据库地址</span>
          <div class="set-row__ctrl font-row">
            <input id="ttml-db-url" type="text" spellcheck="false" autocomplete="off"
              aria-label="TTML 数据库地址模板" placeholder="https://amlldb.bikonoo.com/%p/%s.ttml" />
            <button class="ghost-btn" id="ttml-db-default" type="button">恢复默认</button>
          </div>
        </div>
        <p class="muted set-hint">地址模板：<code>%p</code> = 平台目录（QQ→qq-lyrics、网易云→ncm-lyrics、Apple→am-lyrics、Spotify→spotify-lyrics），
          <code>%s</code> = 该平台歌曲 ID（QQ 为 songmid），必须包含 <code>%s</code>。</p>
        <p class="muted set-hint" id="ttml-db-note" hidden></p>
      </div>

      <div class="set-group">
        <div class="set-label">本地 TTML 歌词库</div>
        <div class="set-row"><span class="set-row__label">歌词库目录</span>
          <div class="set-row__ctrl">
            <input id="ttml-lib-path" readonly placeholder="未设置（只用在线库）" />
            <button class="ghost-btn" id="ttml-lib-pick" type="button">选择目录…</button>
            <button class="ghost-btn" id="ttml-lib-clear" type="button">清除</button>
          </div>
        </div>
        <p class="muted set-hint">放入 .ttml 文件即可启用，支持歌曲 ID、歌名-歌手或歌名命名；本地库优先于在线库。</p>
      </div>

      <div class="set-group">
        <div class="set-label">桌面歌词</div>
        <div class="set-row"><span class="set-row__label">启用</span>
          <div class="opt-cards" id="dl-enable-cards">
            <button class="opt-card" data-opt="on" type="button">开启</button>
            <button class="opt-card" data-opt="off" type="button">关闭</button>
          </div>
        </div>
        <div class="set-row" id="dl-lock-row"><span class="set-row__label">固定（鼠标透穿）</span>
          <div class="opt-cards" id="dl-lock-cards">
            <button class="opt-card" data-opt="on" type="button">开启</button>
            <button class="opt-card" data-opt="off" type="button">关闭</button>
          </div>
        </div>
        <div class="set-row"><span class="set-row__label">字体</span>
          <div class="set-row__ctrl font-row">
            <select id="dl-font" aria-label="桌面歌词字体预设">${fontOptions}</select>
            <input id="dl-font-list" type="text" spellcheck="false" autocomplete="off"
              aria-label="桌面歌词字体家族列表"
              placeholder="留空代表使用默认字体" />
          </div>
        </div>
        <div class="set-row"><span class="set-row__label">字重</span>
          <div class="set-row__ctrl">
            <input class="set-blur set-blur--flat" id="dl-weight" type="range" min="100" max="900" step="10" aria-label="桌面歌词字重" />
            <span class="bg-blur-val" id="dl-weight-val"></span>
          </div>
        </div>
        <div class="set-row"><span class="set-row__label">字号</span>
          <div class="set-row__ctrl">
            <input class="set-blur set-blur--flat" id="dl-scale" type="range" min="50" max="200" step="5" aria-label="桌面歌词字号" />
            <span class="bg-blur-val" id="dl-scale-val"></span>
          </div>
        </div>
        <div class="set-row"><span class="set-row__label">描边宽度</span>
          <div class="set-row__ctrl">
            <input class="set-blur set-blur--flat" id="dl-border" type="range" min="0" max="4" step="0.5" aria-label="桌面歌词文字描边宽度" />
            <span class="bg-blur-val" id="dl-border-val"></span>
          </div>
        </div>
        <div class="set-row"><span class="set-row__label">阴影</span>
          <div class="opt-cards" id="dl-shadow-cards">
            <button class="opt-card" data-opt="on" type="button">开启</button>
            <button class="opt-card" data-opt="off" type="button">关闭</button>
          </div>
        </div>
        <div class="set-row"><span class="set-row__label">阴影模糊</span>
          <div class="set-row__ctrl">
            <input class="set-blur set-blur--flat" id="dl-shadow-blur" type="range" min="0" max="32" step="1" aria-label="桌面歌词阴影模糊半径" />
            <span class="bg-blur-val" id="dl-shadow-blur-val"></span>
          </div>
        </div>
        <div class="set-row"><span class="set-row__label">阴影不透明度</span>
          <div class="set-row__ctrl">
            <input class="set-blur set-blur--flat" id="dl-shadow-opacity" type="range" min="0" max="100" step="5" aria-label="桌面歌词阴影不透明度" />
            <span class="bg-blur-val" id="dl-shadow-opacity-val"></span>
          </div>
        </div>
        <div class="set-row"><span class="set-row__label">阴影水平偏移</span>
          <div class="set-row__ctrl">
            <input class="set-blur set-blur--flat" id="dl-shadow-x" type="range" min="-12" max="12" step="1" aria-label="桌面歌词阴影水平偏移" />
            <span class="bg-blur-val" id="dl-shadow-x-val"></span>
          </div>
        </div>
        <div class="set-row"><span class="set-row__label">阴影垂直偏移</span>
          <div class="set-row__ctrl">
            <input class="set-blur set-blur--flat" id="dl-shadow-y" type="range" min="-12" max="12" step="1" aria-label="桌面歌词阴影垂直偏移" />
            <span class="bg-blur-val" id="dl-shadow-y-val"></span>
          </div>
        </div>
        <div class="set-row"><span class="set-row__label">歌词不透明度</span>
          <div class="set-row__ctrl">
            <input class="set-blur set-blur--flat" id="dl-opacity" type="range" min="10" max="100" step="5" aria-label="桌面歌词歌词不透明度" />
            <span class="bg-blur-val" id="dl-opacity-val"></span>
          </div>
        </div>
        <div class="set-row"><span class="set-row__label">窗体不透明度</span>
          <div class="set-row__ctrl">
            <input class="set-blur set-blur--flat" id="dl-backdrop" type="range" min="0" max="100" step="5" aria-label="桌面歌词窗体不透明度（整扇窗的背板）" />
            <span class="bg-blur-val" id="dl-backdrop-val"></span>
          </div>
        </div>
        <div class="set-row"><span class="set-row__label">行数</span>
          <div class="opt-cards" id="dl-mode-cards">
            <button class="opt-card" data-opt="single" type="button">单行</button>
            <button class="opt-card" data-opt="dual" type="button">双行</button>
          </div>
        </div>
        <div class="set-row" id="dl-center-row"><span class="set-row__label">单行居中</span>
          <div class="opt-cards" id="dl-center-cards">
            <button class="opt-card" data-opt="on" type="button">开启</button>
            <button class="opt-card" data-opt="off" type="button">关闭</button>
          </div>
        </div>
        <div class="set-row"><span class="set-row__label">颜色</span>
          <div class="opt-cards" id="dl-color-cards">
            <button class="opt-card" data-opt="default" type="button">默认</button>
            <button class="opt-card" data-opt="cover" type="button">封面染色</button>
            <button class="opt-card" data-opt="system" type="button">系统染色</button>
            <button class="opt-card" data-opt="custom" type="button">自定义颜色</button>
          </div>
        </div>
        <div class="set-row" id="dl-color-row" hidden><span class="set-row__label">自定义颜色</span>
          <div class="set-row__ctrl">
            <input class="dl-color" id="dl-color" type="color" aria-label="桌面歌词颜色" />
            <input id="dl-color-hex" type="text" spellcheck="false" autocomplete="off" size="9" maxlength="7" aria-label="桌面歌词颜色 HEX" />
          </div>
        </div>
        <p class="muted set-hint">「固定（鼠标透穿）」仅在 macOS / Windows / X11 会话开放。</p>
      </div>
    </section>

    <!-- 热键面板：内容由 ui/src/components/HotkeySettings.ts 填充（全局/焦点内两组绑定） -->
    <section class="set-panel" data-panel="hotkeys" hidden></section>
    <section class="set-panel" data-panel="general" hidden>
      <div class="set-group">
        <div class="set-label">应用更新 <span class="set-note-inline">更新前会先提醒并展示更新日志</span></div>
        <div class="opt-cards" id="upd-auto-cards">
          <button class="opt-card" data-opt="on" type="button">自动检查</button>
          <button class="opt-card" data-opt="off" type="button">关闭</button>
        </div>
        <p class="muted set-hint">启动后自动检查新版本（默认开启）；发现更新先弹窗展示 GitHub 更新日志，经你确认才开始下载安装，绝不静默更新。关闭后仍可在此手动检查。</p>
      </div>

      <div class="set-group">
        <div class="set-label">更新渠道</div>
        <div class="opt-cards" id="upd-channel-cards">
          <button class="opt-card" data-opt="stable" type="button">Stable</button>
          <button class="opt-card" data-opt="beta" type="button">Beta</button>
          <button class="opt-card" data-opt="nightly" type="button">Nightly</button>
        </div>
        <p class="muted set-hint">Stable：正式发布版；Beta：打了 beta 标记的预发布版；Nightly：main 分支的每夜滚动构建，功能更新但可能不稳定。三个渠道可以互相切换：选完会自动检查一次，即使版本号相同也会提示换上对应渠道的构建。</p>
        <p class="muted set-hint" id="upd-channel-note"></p>
        <div class="set-debug">
          <button class="ghost-btn" id="check-update" type="button">检查更新</button>
          <span class="muted set-hint" id="upd-status"></span>
        </div>
      </div>

      <div class="set-group">
        <div class="set-label">音乐缓存</div>
        <div class="set-row"><span class="set-row__label">缓存上限</span>
          <div class="set-row__ctrl">
            <input class="set-blur" id="cache-limit" type="range" min="256" max="32768" step="256" aria-label="音乐缓存上限（MiB）" />
            <span class="bg-blur-val" id="cache-limit-val"></span>
          </div>
        </div>
        <div class="set-debug">
          <button class="ghost-btn" id="clear-cache" type="button">清理音乐缓存</button>
          <span class="muted set-hint" id="cache-status"></span>
        </div>
      </div>

      <div class="set-group">
        <div class="set-label">配置文件</div>
        <p class="muted set-hint">以下设置全部持久化在系统标准配置目录的 <code>quaver.conf</code>里，可自定义</p>
        <div class="set-row"><span class="set-row__label">路径</span>
          <div class="set-row__ctrl"><input id="conf-path" readonly /></div>
        </div>
        <div class="set-debug">
          <button class="ghost-btn" id="open-conf" type="button">在文件管理器中显示</button>
          <button class="ghost-btn" id="reset-conf" type="button">恢复默认设置</button>
        </div>
        <p class="muted set-hint" id="conf-hint"></p>
      </div>

      <div class="set-group">
        <div class="set-label">调试</div>
        <div class="set-debug">
          <button class="ghost-btn" id="open-log" type="button">打开日志页面</button>
          <button class="ghost-btn" id="open-dbg" type="button">进程与内存自检</button>
        </div>
      </div>

      <div class="set-group set-about">
        <div class="about-img"><img class="ic-dark" src="/quaver-icon-dark.svg" width=60 alt="Quaver Icon"><img class="ic-light" src="/quaver-icon.svg" width=60 alt="Quaver Icon"></div>
        <h3> Quaver Music </h3>
        <h4> 现代、流畅、百变的第三方 QQ 音乐客户端，基于 Electron + Vite + Golang </h4>
        <small> Version: ${__APP_VERSION__} </small>
        <button class="ghost-btn credits-btn" id="open-credits" type="button">开源软件与第三方库（Credits）</button>
      </div>
    </section>
    
    <!-- Sparkle 面板：内容由 ui/src/sparkle/settings.ts 填充（插件列表/插件设置区/Marketplace） -->
    <section class="set-panel" data-panel="plugins" hidden></section>`;

  root.append(wrap);

  // 与歌手页同一套切换动画（.set-view.tab-anim > .set-panel，见 style.css）：门闩首次点击才挂，
  // 首屏交给 .route.entering；重复点当前标签直接返回，避免重播。
  tabs.querySelectorAll<HTMLButtonElement>(".set-tab").forEach((t) => {
    t.onclick = () => {
      if (t.classList.contains("is-active")) return;
      wrap.classList.add("tab-anim");
      tabs.querySelectorAll(".set-tab").forEach((x) => x.classList.toggle("is-active", x === t));
      wrap.querySelectorAll<HTMLElement>(".set-panel").forEach((p) => { p.hidden = p.dataset.panel !== t.dataset.tab; });
    };
  });

  // preset 是「Sparkle 主题自带的高亮方案」那组（见 #tint-spark-cards）
  const syncSel = (box: HTMLElement, attr: "opt" | "q" | "preset", active: string) =>
    box.querySelectorAll<HTMLElement>("[data-" + attr + "]").forEach((b) => b.classList.toggle("sel", b.dataset[attr] === active));

  /** 说明行只承载当前状态 / 主题接管备注：没有内容时整行收起。 */
  const setHint = (el: HTMLElement, text: string) => {
    el.textContent = text;
    el.hidden = !text;
  };

  /** 通用「卡片选项组」绑定：点击写偏好 + 原地同步选中态（外观/装饰/关闭行为/Fallback/淡入淡出共用） */
  function bindOptCards<K extends string>(box: HTMLElement, get: () => K, set: (v: K) => void) {
    const sync = () => syncSel(box, "opt", get());
    box.querySelectorAll<HTMLElement>("[data-opt]").forEach((b) => {
      b.onclick = () => { set(b.dataset.opt as K); sync(); };
    });
    sync();
  }

  // 外观模式：跟随系统 / 明镜白 / 玄幻黑（prefs 写 html[data-theme]，style.css 响应）
  bindOptCards<ThemeMode>(wrap.querySelector<HTMLElement>("#theme-cards")!, getTheme, setTheme);

  // —— 背景（默认主题的环境色层）：关闭背景 / 专辑封面 / 自定义图片 + 模糊强度 ——
  // 选图走主进程的原生对话框（路径落进 quaver.conf，图片本体由同源 /api/bg 端点交给界面，
  // 见 lib/ambient.ts）；浏览器 dev 下没有这个桥，只能看不能换。
  const bgCards = wrap.querySelector<HTMLElement>("#bg-cards")!;
  const bgFile = wrap.querySelector<HTMLElement>("#bg-file")!;
  const bgPick = wrap.querySelector<HTMLButtonElement>("#bg-pick")!;
  const bgFlow = wrap.querySelector<HTMLInputElement>("#bg-flow")!;
  const bgFlowVal = wrap.querySelector<HTMLElement>("#bg-flow-val")!;
  const bgHint = wrap.querySelector<HTMLElement>("#bg-hint")!;
  const bgBridge = window.quaverBackground;
  /** 当前激活的 Sparkle 主题（含它的 background 声明）；没启用主题 / 主题已消失 = null。 */
  const bgPolicy = () => backgroundPolicyOf(sparkleActiveTheme());

  const paintFlow = () => {
    const v = getBackgroundFlow();
    bgFlow.value = String(v);
    // 已滑过的一段染色：值换算成百分比写 --v（与播放条音量滑块同一口径）
    bgFlow.style.setProperty("--v", `${Math.round(((v - BG_FLOW_MIN) / (BG_FLOW_MAX - BG_FLOW_MIN)) * 100)}%`);
    bgFlowVal.textContent = v === 0 ? "静止" : `${v.toFixed(2)}×`;
  };

  /** 图片一行：文件名 + 文件还在不在（被挪走/删掉要提示重选，不静默当没事）。 */
  const paintBgFile = (info?: { path?: string; exists?: boolean; error?: string }) => {
    const path = info?.path ?? getBackgroundImage();

    if (!path) { bgFile.textContent = "尚未选择图片"; bgFile.title = ""; bgFile.classList.remove("bad"); return; }

    const name = path.split(/[\\/]/).pop() || path;
    const bad = info?.exists === false;
    bgFile.textContent = bad ? `${name}（${info?.error ?? "不可用"}）` : name;
    bgFile.title = path; // 完整路径挂 title：行内只放文件名，长路径不撑破布局
    bgFile.classList.toggle("bad", bad);
  };

  const paintBgMode = () => {
    const mode = getBackgroundMode();
    const locked = bgPolicy().mode === "off"; // 主题接管背景：这一组整体不可调（见 paintBgPolicy）
    syncSel(bgCards, "opt", mode);
    // 「选择图片…」与文件名只在自定义档出现（就在那张卡片旁边）：不占别的档位的版面；
    // 主题接管时也不给换图/换文件
    const isCustom = mode === "custom" && !locked;
    bgPick.hidden = !isCustom;
    bgFile.hidden = !isCustom;
    bgFlow.disabled = locked || mode === "off"; // 背景都关了（或不由宿主管），流动速度无从谈起
  };

  /** 原生选图：成功（路径已落盘 + 界面重画）返回 true；取消/失败返回 false。 */
  const pickBgImage = async (): Promise<boolean> => {
    if (!bgBridge?.pick) return false;
    bgPick.disabled = true;

    try {
      const r = await bgBridge.pick();

      if (!r?.ok) { paintBgFile({ path: getBackgroundImage(), exists: false, error: r?.error ?? "选择失败" }); return false; }

      if (r.canceled) return false;
      // 主进程已经写盘；这里同步渲染层的内存快照（值相同，落盘侧是一次幂等重写）
      setBackgroundImage(r.path ?? "");
      applyBackground();
      paintBgFile({ path: getBackgroundImage(), exists: true });

      return true;
    } catch (e) {
      paintBgFile({ path: getBackgroundImage(), exists: false, error: errText(e) });

      return false;
    } finally {
      bgPick.disabled = false;
    }
  };

  bgCards.querySelectorAll<HTMLElement>("[data-opt]").forEach((b) => {
    b.onclick = async () => {
      const next = b.dataset.opt as BackgroundMode;

      // 选「自定义」但还没有图：这一档点下去的意图就是去选图，直接弹对话框；
      // 取消就停在原来的档位（不切到一个「自定义但没有图」的空状态）
      if (next === "custom" && !getBackgroundImage() && !(await pickBgImage())) { paintBgMode(); return; }

      setBackgroundMode(next);
      applyBackground();
      paintBgMode();
    };
  });
  bgPick.onclick = async () => {
    if (!(await pickBgImage())) return;
    setBackgroundMode("custom"); // 「选择图片」本身就意味着要用这张图 → 顺手切到自定义档
    applyBackground();
    paintBgMode();
  };

  bgFlow.addEventListener("input", () => {
    setBackgroundFlow(Number(bgFlow.value));
    paintFlow();
    applyBackground();
  });

  // 首页 / 歌词页的背景风格各自独立；主题声明 background.renderer 时整组禁用并显示生效值
  const bgRendererCards = wrap.querySelector<HTMLElement>("#bg-renderer-cards")!;
  const npBgRendererCards = wrap.querySelector<HTMLElement>("#np-bg-renderer-cards")!;

  const paintRendererCards = (cards: HTMLElement, get: () => BackgroundRenderer) => {
    const locked = backgroundRendererOf(sparkleActiveTheme());
    cards.querySelectorAll<HTMLButtonElement>("[data-opt]").forEach((b) => { b.disabled = locked !== null; });
    syncSel(cards, "opt", locked ?? get());
  };

  const paintBgRenderers = () => {
    paintRendererCards(bgRendererCards, getBackgroundRenderer);
    paintRendererCards(npBgRendererCards, getNpBackgroundRenderer);
  };

  bgRendererCards.querySelectorAll<HTMLElement>("[data-opt]").forEach((b) => {
    b.onclick = () => { setBackgroundRenderer(b.dataset.opt as BackgroundRenderer); applyBackground(); paintBgRenderers(); };
  });
  npBgRendererCards.querySelectorAll<HTMLElement>("[data-opt]").forEach((b) => {
    b.onclick = () => { setNpBackgroundRenderer(b.dataset.opt as BackgroundRenderer); paintBgRenderers(); };
  });

  /** 浏览器 dev 没有选图桥时只保留一句功能提示；桌面端不显示通用描述。 */
  const bgHintBase = bgBridge?.pick ? "" : "浏览器里无法选择本地图片，请在桌面端设置。";

  /** 整组的主刷新：主题接管背景时三档留在原位但禁用并写明原因（整组消失会让人找不到）。
   *  面板初次挂载 / 切换主题 / 插件启停都要重跑一遍。 */
  const paintBgPolicy = () => {
    const locked = bgPolicy().mode === "off";
    bgCards.querySelectorAll<HTMLButtonElement>("[data-opt]").forEach((b) => { b.disabled = locked; });
    setHint(bgHint, locked
      ? `由花火面具「${sparkleActiveTheme()?.name ?? ""}」接管背景。`
      : bgHintBase);
    paintBgMode(); // 顺带把按钮显隐与滑块可用性收口（那里也要叠加 locked）
    paintBgRenderers();
  };

  paintFlow();
  paintBgPolicy();
  paintBgFile();

  // 文件还在不在要问主进程（渲染层看不到磁盘）：不在就提示重选
  if (bgBridge?.info) void bgBridge.info().then((r) => { if (r?.ok) paintBgFile(r); }).catch(() => {});

  // —— 高亮颜色（tint）：三档来源 + 自定义色的颜色选择器（HSL / CMYK / RGB + HEX） ——
  // 颜色真相只有一个 RGB：三个模式与 HEX 都只是它的不同表示，表示之间的换算走 lib/color.ts 的
  // 纯函数。落盘的永远是 HEX（prefs.setTintColor），样式侧由 lib/tint.ts 写 --cvg-accent/--cvg-glow。
  const tintCards = wrap.querySelector<HTMLElement>("#tint-cards")!;
  const tintChip = wrap.querySelector<HTMLButtonElement>("#tint-chip")!;
  const tintPop = wrap.querySelector<HTMLElement>("#tint-pop")!;
  const tintFold = wrap.querySelector<HTMLButtonElement>("#tint-fold")!;
  const tintSwatch = wrap.querySelector<HTMLElement>("#tint-swatch")!;
  const tintCode = wrap.querySelector<HTMLElement>("#tint-code")!;
  const tintHue = wrap.querySelector<HTMLInputElement>("#tint-hue")!;
  const tintModes = wrap.querySelector<HTMLElement>("#tint-modes")!;
  const tintFields = wrap.querySelector<HTMLElement>("#tint-fields")!;
  const tintHex = wrap.querySelector<HTMLInputElement>("#tint-hex")!;
  const tintHint = wrap.querySelector<HTMLElement>("#tint-hint")!;
  const chipSw = h("span", "tint-chip__sw");
  tintChip.append(chipSw);

  type ColorMode = "hsl" | "cmyk" | "rgb";

  /** 每个模式的通道定义：k 用于读写输入框，label + suffix 只影响显示。 */
  const CHANNELS: Record<ColorMode, { k: string; label: string; min: number; max: number; suffix: string }[]> = {
    hsl: [
      { k: "h", label: "H", min: 0, max: 359, suffix: "°" },
      { k: "s", label: "S", min: 0, max: 100, suffix: "%" },
      { k: "l", label: "L", min: 0, max: 100, suffix: "%" },
    ],
    cmyk: [
      { k: "c", label: "C", min: 0, max: 100, suffix: "%" },
      { k: "m", label: "M", min: 0, max: 100, suffix: "%" },
      { k: "y", label: "Y", min: 0, max: 100, suffix: "%" },
      { k: "k", label: "K", min: 0, max: 100, suffix: "%" },
    ],
    rgb: [
      { k: "r", label: "R", min: 0, max: 255, suffix: "" },
      { k: "g", label: "G", min: 0, max: 255, suffix: "" },
      { k: "b", label: "B", min: 0, max: 255, suffix: "" },
    ],
  };

  let colorMode: ColorMode = "hsl";
  let popOpen = false; // 选择器是否展开（只对自定义档有意义）
  // 选择器编辑的永远是自定义色的值；进来时以配置为准（配置里的才是真相）
  let tintRgb: RGB = parseHex(getTintColor()) ?? parseHex(TINT_DEFAULT_COLOR) ?? { r: 25, g: 194, b: 216 };

  const unit01 = (n: number) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
  const pctInt = (n: number) => Math.round(unit01(n) * 100);

  /** 当前色在某个模式下的通道取值（整数，直接进输入框）。 */
  const channelValues = (m: ColorMode): number[] => {
    if (m === "rgb") return [tintRgb.r, tintRgb.g, tintRgb.b];

    if (m === "hsl") {
      const { h, s, l } = rgb2hsl(tintRgb);

      return [Math.round(h), pctInt(s), pctInt(l)];
    }

    const { c, m: mg, y, k } = rgb2cmyk(tintRgb);

    return [pctInt(c), pctInt(mg), pctInt(y), pctInt(k)];
  };

  /** 把某模式的通道值组装回 RGB。 */
  const rgbFromChannels = (m: ColorMode, v: number[]): RGB => {
    if (m === "rgb") return { r: v[0], g: v[1], b: v[2] };

    if (m === "hsl") return hsl2rgb(v[0], unit01(v[1] / 100), unit01(v[2] / 100));

    return cmyk2rgb({ c: unit01(v[0] / 100), m: unit01(v[1] / 100), y: unit01(v[2] / 100), k: unit01(v[3] / 100) });
  };

  const fieldOf = (k: string) => tintFields.querySelector<HTMLInputElement>(`[data-k="${k}"]`);

  /** 各显示位（色块 / HEX 码 / 色相条 / HEX 框）跟着真相走。 */
  const paintColor = (hueOverride?: number) => {
    const hex = toHex(tintRgb);
    tintSwatch.style.background = hex;
    chipSw.style.background = hex;
    tintCode.textContent = hex;
    tintHue.value = String(Math.round(hueOverride ?? rgb2hsl(tintRgb).h));

    if (document.activeElement !== tintHex) tintHex.value = hex;
  };

  /** 通道输入框回填：正在编辑的那个不动（否则会打断输入 / 把半截值抹掉）。 */
  const refreshFields = () => {
    const vals = channelValues(colorMode);
    CHANNELS[colorMode].forEach((ch, i) => {
      const el = fieldOf(ch.k);

      if (el && document.activeElement !== el) el.value = String(vals[i]);
    });
  };

  /** 写色：真相 → 落盘 + 即时生效（写 CSS 变量）→ 刷新显示位。 */
  const commitColor = (next: RGB) => {
    tintRgb = { r: Math.round(next.r), g: Math.round(next.g), b: Math.round(next.b) };
    setTintColor(toHex(tintRgb));
    applyTint();
    paintColor();
    refreshFields();
  };

  /** 重建当前模式的通道输入行（只在切模式时调；输入过程中不重建，免得丢焦点）。 */
  const renderFields = () => {
    const vals = channelValues(colorMode);
    tintFields.innerHTML = CHANNELS[colorMode].map((ch, i) =>
      `<label class="tint-field"><span class="tint-field__label">${ch.label}${ch.suffix}</span>`
      + `<input type="number" inputmode="numeric" data-k="${ch.k}" min="${ch.min}" max="${ch.max}" step="1"`
      + ` value="${vals[i]}" aria-label="${ch.label}" /></label>`,
    ).join("");
    tintModes.querySelectorAll<HTMLElement>("[data-mode]")
      .forEach((b) => b.classList.toggle("sel", b.dataset.mode === colorMode));
  };

  tintModes.querySelectorAll<HTMLElement>("[data-mode]").forEach((b) => {
    b.onclick = () => { colorMode = b.dataset.mode as ColorMode; renderFields(); };
  });
  tintFields.addEventListener("input", () => {
    const cur = channelValues(colorMode);

    const vals = CHANNELS[colorMode].map((ch, i) => {
      const raw = (fieldOf(ch.k)?.value ?? "").trim();

      if (raw === "") return cur[i]; // 清空中的框按原值算，不瞬间掉到下限
      const n = Number(raw);

      return Number.isFinite(n) ? Math.max(ch.min, Math.min(ch.max, Math.round(n))) : cur[i];
    });

    commitColor(rgbFromChannels(colorMode, vals));
  });
  // 离开输入框时校正越界值（R 里敲 300 会被夹到 255，但框里还显示着 300）
  tintFields.addEventListener("blur", refreshFields, true);
  tintHue.addEventListener("input", () => {
    const hue = Number(tintHue.value);
    const { s, l } = rgb2hsl(tintRgb);
    // 无彩度（灰/黑白）时给一个看得出颜色的 S/L，否则拖色相条毫无反馈
    const base = s < 0.02 ? { s: 0.75, l: 0.5 } : { s, l };
    commitColor(hsl2rgb(hue, base.s, base.l));
    paintColor(hue); // 用拖动值回填滑块，免得 hsl→rgb→hsl 往返把圆点抖回去
  });
  tintHex.addEventListener("input", () => {
    const c = parseHex(tintHex.value);

    if (c) commitColor(c); // 半截输入（如 "#19"）不是合法字面量，先不改色
  });

  // —— 与 Sparkle 主题的交接（SDK 的 SparkleTheme.tint；策略解析见 sparkle/theme-tint.ts）——
  // 主题不声明 tint = 它自带强调色：宿主让位（lib/tint.ts 清掉内联变量、回落 --acc/--cyan），
  // 这里把整组禁用并写明原因。主题声明 presets = 用它给的那几套方案，三档卡退场换方案卡。
  const tintSparkCards = wrap.querySelector<HTMLElement>("#tint-spark-cards")!;
  /** 当前激活的 Sparkle 主题（含它的 tint / background 声明）；没启用主题 / 主题已消失 = null。
   *  解析走 sparkle/registry（读 host 维护的 <html data-sparkle-theme>）—— 背景那一组也用它。 */
  const activeSparkTheme = sparkleActiveTheme;
  const tintPolicy = () => tintPolicyOf(activeSparkTheme());

  /** 系统强调色还没读到时补拉一次（回来后重画一次当前态）。
   *  accentProbed 防自旋：拉不到也只拉一次 —— 「重画 → 又拉 → 又重画」会把设置页变成请求风暴；
   *  后续的跟随由 lib/accent.ts 的轮询（哨兵方案/系统档激活时才开）负责。 */
  let accentProbed = false;

  const probeAccentOnce = () => {
    if (accentProbed || currentAccent()?.color) return;
    accentProbed = true;
    void refreshAccent().then(() => paintTintPolicy());
  };

  /** 主题给的高亮方案卡：一张卡 = 色块 + 名字。色值已过 validPresets 校验（十六进制字面量或
   *  "system" / "cover" 哨兵）。系统哨兵没读到前用斜纹占位；封面哨兵用另一道斜纹表示动态取色。 */
  const renderSparkTintCards = (presets: readonly SparkleTintPreset[], themeId: string) => {
    tintSparkCards.innerHTML = "";

    for (const p of presets) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "opt-card";
      b.dataset.preset = p.id;
      const hex = resolvePresetColor(p.color, currentAccent()?.color ?? null);

      const sw = p.color === TINT_PRESET_SYSTEM
        ? (hex ? `<span class="sw" style="background:${hex}"></span>` : `<span class="sw sw-accent"></span>`)
        : p.color === TINT_PRESET_COVER
          ? `<span class="sw sw-cover"></span>`
          : p.color === TINT_PRESET_CUSTOM
            ? `<span class="sw" style="background:${sparkCustomTint(themeId) ?? "#6750a4"}"></span>`
          : `<span class="sw" style="background:${p.color}"></span>`;

      b.innerHTML = `${sw}${escHtml(p.label)}`;
      b.onclick = () => {
        sparkSetTintChoice(themeId, p.id);
        if (p.color === TINT_PRESET_CUSTOM) openSparkCustomPicker(themeId);
        applyTint();       // 换了方案立刻重写 CSS 变量
        paintTintPolicy(); // 同步选中态
      };

      tintSparkCards.append(b);
    }
  };

  /** 主题方案里的「自定义颜色」档：就地弹宿主同款颜色选择器。
   *  色值落在 theme-tint 的主题级存储（不是宿主四档的 TintColor），换主题不串味。 */
  const sparkCustomBox = document.createElement("div");
  sparkCustomBox.className = "tint-pop tint-pop--inline";
  sparkCustomBox.hidden = true;
  sparkCustomBox.innerHTML = `
    <div class="tint-pop__head">
      <strong>主题自定义颜色</strong>
      <button class="tint-pop__fold" type="button">收起</button>
    </div>
    <div class="tint-preview">
      <span class="tint-preview__sw"></span>
      <code class="tint-preview__hex"></code>
    </div>
    <input class="tint-hue" type="range" min="0" max="359" step="1" aria-label="色相" />
    <div class="tint-hex-row">
      <span class="tint-field__label">HEX</span>
      <input type="text" spellcheck="false" autocomplete="off" maxlength="7" placeholder="#6750a4" aria-label="主题自定义颜色十六进制值" />
    </div>`;
  tintSparkCards.after(sparkCustomBox);
  const sparkCustomSw = sparkCustomBox.querySelector<HTMLElement>(".tint-preview__sw")!;
  const sparkCustomCode = sparkCustomBox.querySelector<HTMLElement>(".tint-preview__hex")!;
  const sparkCustomHue = sparkCustomBox.querySelector<HTMLInputElement>(".tint-hue")!;
  const sparkCustomHex = sparkCustomBox.querySelector<HTMLInputElement>(".tint-hex-row input")!;

  const paintSparkCustom = (themeId: string) => {
    const hex = sparkCustomTint(themeId) ?? "#6750a4";
    const rgb = parseHex(hex) ?? { r: 103, g: 80, b: 164 };
    sparkCustomSw.style.background = hex;
    sparkCustomCode.textContent = hex;
    if (document.activeElement !== sparkCustomHex) sparkCustomHex.value = hex;
    sparkCustomHue.value = String(Math.round(rgb2hsl(rgb).h));
  };

  const commitSparkCustom = (themeId: string, rgb: RGB) => {
    const hex = toHex({ r: Math.round(rgb.r), g: Math.round(rgb.g), b: Math.round(rgb.b) });
    sparkSetCustomTint(themeId, hex);
    paintSparkCustom(themeId);
    applyTint();
  };

  const openSparkCustomPicker = (themeId: string) => {
    sparkCustomBox.dataset.themeId = themeId;
    sparkCustomBox.hidden = false;
    paintSparkCustom(themeId);
  };

  sparkCustomBox.querySelector<HTMLButtonElement>(".tint-pop__fold")!.onclick = () => { sparkCustomBox.hidden = true; };
  sparkCustomHue.addEventListener("input", () => {
    const id = sparkCustomBox.dataset.themeId;

    if (!id) return;
    const cur = parseHex(sparkCustomTint(id) ?? "#6750a4") ?? { r: 103, g: 80, b: 164 };
    const { s, l } = rgb2hsl(cur);
    const base = s < 0.02 ? { s: 0.75, l: 0.5 } : { s, l };

    commitSparkCustom(id, hsl2rgb(Number(sparkCustomHue.value), base.s, base.l));
  });
  sparkCustomHex.addEventListener("input", () => {
    const id = sparkCustomBox.dataset.themeId;
    const c = parseHex(sparkCustomHex.value);

    if (id && c) commitSparkCustom(id, c);
  });

  /** 展开/收起选择器。非自定义档不给开，高亮色被主题接管时也不给开 —— 面板编的就是自定义色。 */
  const setPopOpen = (open: boolean) => {
    popOpen = open && tintPolicy().mode === "host" && getTintMode() === "custom";
    tintPop.hidden = !popOpen;
    tintChip.setAttribute("aria-expanded", String(popOpen));
  };

  const paintTintMode = () => {
    const mode = getTintMode();
    syncSel(tintCards, "opt", mode);
    // 色块只在「宿主管高亮色 + 自定义档」出现；离开该档时选择器一并收起
    tintChip.hidden = tintPolicy().mode !== "host" || mode !== "custom";
    setPopOpen(popOpen);

    // 「系统强调色」档：把读到的来源/色值直接说给用户听（读不到也说明白为什么 + 怎么办）。
    if (tintPolicy().mode !== "host") return;

    if (mode === "system") {
      const a = currentAccent();
      setHint(tintHint, a?.color
        ? `系统强调色：已读到${a.label ? ` ${a.label} 的` : ""} ${a.color}，换桌面配色后自动跟随。`
        : "系统强调色：暂时没读到（先用默认青色）。在 Noctalia / matugen 的模板里把颜色写到"
          + " <配置目录>/system-theme.json，或在系统设置里挑一个强调色。");
      probeAccentOnce(); // 值是异步来的：还没读到就先刷一次，回来重画（accentProbed 防自旋）
    } else {
      setHint(tintHint, "");
    }
  };

  /** 整组的主刷新：决定三档卡、主题方案卡、说明文案各自出现与否（主题切换 / 插件启停都要重跑）。 */
  const paintTintPolicy = () => {
    const policy = tintPolicy();
    const themeName = activeSparkTheme()?.name ?? "";
    const locked = policy.mode === "off";   // 主题自带配色：三档留在原位但禁用（整组消失会让人找不到）
    const presets = policy.mode === "presets";

    tintCards.hidden = presets;             // 有替代方案时三档直接退场
    tintSparkCards.hidden = !presets;
    tintCards.querySelectorAll<HTMLButtonElement>("[data-opt]").forEach((b) => { b.disabled = locked; });

    if (presets) {
      renderSparkTintCards(policy.presets, policy.themeId ?? "");
      syncSel(tintSparkCards, "preset", sparkTintChoice(policy.themeId) ?? policy.presets[0]?.id ?? "");
      const chosen = pickPreset(policy.presets, sparkTintChoice(policy.themeId));
      const isCustomPreset = chosen?.color === TINT_PRESET_CUSTOM;
      sparkCustomBox.hidden = !isCustomPreset || sparkCustomBox.dataset.themeId !== policy.themeId;

      if (isCustomPreset && !sparkCustomBox.hidden) paintSparkCustom(policy.themeId ?? "");

      // 方案里有哨兵（color:"system"）且系统强调色还没到：补拉一次，回来重画方案卡的色块
      if (policy.presets.some((p) => p.color === TINT_PRESET_SYSTEM)) probeAccentOnce();
    }

    setHint(tintHint, locked
      ? `由花火面具「${themeName}」接管高亮颜色。`
      : presets
        ? `高亮颜色由花火面具「${themeName}」提供。`
        : "");
    paintTintMode(); // 顺带把 chip / 选择器的可用性收口
  };

  tintCards.querySelectorAll<HTMLElement>("[data-opt]").forEach((b) => {
    b.onclick = () => {
      const next = b.dataset.opt as TintMode;
      setTintMode(next);
      applyTint(); // 档位换了要立刻重写 CSS 变量（封面档还会去取当前曲封面）

      if (next === "custom") popOpen = true; // 点「自定义颜色」→ 就地弹出选择器
      paintTintMode();
    };
  });
  tintChip.onclick = () => { setPopOpen(!popOpen); };

  tintFold.onclick = () => { setPopOpen(false); };

  renderFields();
  paintColor();
  paintTintPolicy();

  // —— 界面毛玻璃（[Style] MenuBlur）：侧栏 / Content View / 浮层与浮窗的模糊开不开 ——
  // 真相是 <html data-menu-glass>（由 lib/menu-glass.ts 写，on/off/theme 三态），CSS 侧一组
  // --menu-* 令牌据此取值；这里只管这棵开关的呈现。主题自带菜单外观时整组留在原位但禁用。
  const menuGlassCards = wrap.querySelector<HTMLElement>("#menu-glass-cards")!;
  const menuGlassHint = wrap.querySelector<HTMLElement>("#menu-glass-hint")!;
  const menuGlassPolicy = () => menuGlassPolicyOf(activeSparkTheme());

  const paintMenuGlass = () => {
    syncSel(menuGlassCards, "opt", getMenuBlur() ? "on" : "off");
    setHint(menuGlassHint, menuGlassPolicy().mode === "off"
      ? `由花火面具「${activeSparkTheme()?.name ?? ""}」接管模糊效果。`
      : "");
  };

  /** 整组的主刷新：主题接管时这组留在原位但禁用（整组消失会让人找不到）。 */
  const paintMenuGlassPolicy = () => {
    const locked = menuGlassPolicy().mode === "off";
    menuGlassCards.querySelectorAll<HTMLButtonElement>("[data-opt]").forEach((b) => { b.disabled = locked; });
    paintMenuGlass();
  };

  menuGlassCards.querySelectorAll<HTMLElement>("[data-opt]").forEach((b) => {
    b.onclick = () => {
      setMenuBlur(b.dataset.opt === "on");
      applyMenuGlass(); // 立刻生效：样式按属性取值，这里只换那个属性
      paintMenuGlass();
    };
  });
  paintMenuGlassPolicy();

  // Sparkle 主题：插件注册的自定义主题（覆盖在上方外观模式之上的变量层）。
  // 列表随注册表动态变化（插件异步启用/停用），onSparkleChange 重画整组；
  // 激活经 host 持久化并即时生效，停用激活主题所属插件时 host 自动回落默认。
  const sparkleThemeGroup = wrap.querySelector<HTMLElement>("#sparkle-theme-group")!;
  const sparkleThemeCards = wrap.querySelector<HTMLElement>("#sparkle-theme-cards")!;

  const syncSparkleThemeSel = () => {
    const activeId = sparkActiveThemeId();
    // 持久化的 id 可能指向已消失的主题（如插件被禁用后残留）：UI 只认仍注册着的
    const active = sparkleThemes().some((t) => t.id === activeId) ? (activeId ?? "") : "";
    syncSel(sparkleThemeCards, "opt", active);
  };

  // 播放控制条：底部停靠（默认）/ Content View 内悬浮。主题声明 controlBar 时是最终态，
  // 这里整组禁用并显示实际生效值；宿主态由 setControlBarMode + applyControlBar 即时同步。
  const controlBarCards = wrap.querySelector<HTMLElement>("#control-bar-cards")!;
  const controlBarHint = wrap.querySelector<HTMLElement>("#control-bar-hint")!;

  const paintControlBarPolicy = () => {
    const policy = controlBarPolicyOf(activeSparkTheme());
    const locked = policy.mode !== "host";
    controlBarCards.querySelectorAll<HTMLButtonElement>("[data-opt]").forEach((b) => { b.disabled = locked; });
    syncSel(controlBarCards, "opt", locked ? policy.mode : getControlBarMode());
    controlBarCards.querySelector<HTMLElement>('[data-opt="bottom"]')!.textContent = locked ? "底部停靠（主题接管）" : "底部停靠";
    setHint(controlBarHint, locked
      ? `由花火面具「${activeSparkTheme()?.name ?? ""}」接管播放控制。`
      : "");
  };

  controlBarCards.querySelectorAll<HTMLElement>("[data-opt]").forEach((b) => {
    b.onclick = () => {
      setControlBarMode(b.dataset.opt as ControlBarMode);
      paintControlBarPolicy();
    };
  });
  paintControlBarPolicy();
  // 菜单栏模式：高效模式（默认）/ 简洁模式。主题声明 playlistMode 时是最终态，这里整组禁用
  // 并显示实际生效值；宿主态由 setPlaylistMode + applyPlaylistModeKind 即时同步。
  const playlistModeCards = wrap.querySelector<HTMLElement>("#playlist-mode-cards")!;
  const playlistModeHint = wrap.querySelector<HTMLElement>("#playlist-mode-hint")!;

  const paintPlaylistModePolicy = () => {
    const policy = playlistModePolicyOf(activeSparkTheme());
    const locked = policy.mode !== "host";
    playlistModeCards.querySelectorAll<HTMLButtonElement>("[data-opt]").forEach((b) => { b.disabled = locked; });
    syncSel(playlistModeCards, "opt", locked ? policy.mode : getPlaylistMode());
    playlistModeCards.querySelector<HTMLElement>('[data-opt="collection"]')!.textContent = locked ? "简洁模式（主题接管）" : "简洁模式";
    setHint(playlistModeHint, locked
      ? `由花火面具「${activeSparkTheme()?.name ?? ""}」接管菜单栏模式。`
      : "");
  };

  playlistModeCards.querySelectorAll<HTMLElement>("[data-opt]").forEach((b) => {
    b.onclick = () => {
      setPlaylistMode(b.dataset.opt as PlaylistMode);
      paintPlaylistModePolicy();
    };
  });
  paintPlaylistModePolicy();

  const renderSparkleThemes = () => {
    const themes = sparkleThemes();
    sparkleThemeGroup.hidden = themes.length === 0;
    sparkleThemeCards.innerHTML = "";

    const mkCard = (id: string, label: string) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "opt-card";
      b.dataset.opt = id;
      b.textContent = label;
      b.onclick = () => {
        sparkActivateTheme(id || null);
        syncSparkleThemeSel();
        paintTintPolicy(); // 主题决定高亮色归谁：切完要把上面那组重新收口
        paintBgPolicy();   // 背景归谁同理
        paintMenuGlassPolicy(); // 浮层菜单的外观归谁同理
        paintControlBarPolicy(); // 控制条停靠形态归谁同理
        paintPlaylistModePolicy(); // 歌单显示模式归谁同理
      };

      return b;
    };

    sparkleThemeCards.append(mkCard("", "Quaver Design"));

    for (const t of themes) sparkleThemeCards.append(mkCard(t.id, t.name));
    syncSparkleThemeSel();
    paintTintPolicy(); // 主题列表变了（插件启停）→ 高亮色那组的可用性也要跟着重算
    paintBgPolicy();   // 背景那组同理
    paintMenuGlassPolicy(); // 菜单外观那组同理
    paintControlBarPolicy(); // 控制条停靠那组同理
    paintPlaylistModePolicy(); // 歌单显示模式那组同理
  };

  renderSparkleThemes();
  const offSparkleThemes = onSparkleChange(renderSparkleThemes);
  // 窗口装饰：CSD（右上角自绘按钮簇）/ SSD（系统标题栏）。Electron 桥重建窗口；浏览器仅隐藏按钮簇。
  bindOptCards<DecorMode>(wrap.querySelector<HTMLElement>("#decor-cards")!, getDecor, setDecor);
  // 关闭按钮行为：缩放到托盘 / 退出程序（Electron 桥同步主进程；浏览器 dev 无效果）
  bindOptCards<CloseAction>(wrap.querySelector<HTMLElement>("#close-cards")!, getCloseAction, setCloseAction);
  // Fallback 排序：默认「不优先全景声」（母带优先，atmos51 压链尾兜底）；改动自下一首协商起生效
  bindOptCards<FallbackSort>(wrap.querySelector<HTMLElement>("#atmos-fallback-cards")!, getFallbackSort, setFallbackSort);
  // 上一首按钮行为：重放当前曲（默认）/ 直接跳到队列里的上一首（播放条按钮与媒体键共用，即时生效）
  bindOptCards<PrevBehavior>(wrap.querySelector<HTMLElement>("#prev-behavior-cards")!, getPrevBehavior, setPrevBehavior);
  // 播放音频时睡眠禁止（[Playing] InhibitSleep，默认开）：开关即时对齐 sidecar 持有态
  bindOptCards<"on" | "off">(
    wrap.querySelector<HTMLElement>("#inhibit-sleep-cards")!,
    () => (getInhibitSleep() ? "on" : "off"),
    (v) => { setInhibitSleep(v === "on"); syncInhibit(); },
  );
  bindOptCards<"on" | "off">(
    wrap.querySelector<HTMLElement>("#listen-report-cards")!,
    () => (getReportListenTime() ? "on" : "off"),
    (v) => setReportListenTime(v === "on"),
  );

  // 音乐缓存上限 / 清理：上限写 quaver.conf 并同步 sidecar；清理只删缓存，不动配置。
  const cacheLimit = wrap.querySelector<HTMLInputElement>("#cache-limit")!;
  const cacheLimitVal = wrap.querySelector<HTMLElement>("#cache-limit-val")!;
  const cacheStatus = wrap.querySelector<HTMLElement>("#cache-status")!;
  const clearCacheBtn = wrap.querySelector<HTMLButtonElement>("#clear-cache")!;

  const fmtBytes = (n: number) => n >= (1 << 30) ? `${(n / (1 << 30)).toFixed(1)} GiB` : `${Math.round(n / (1 << 20))} MiB`;
  const paintCacheStatus = (r?: { items?: number; bytes?: number }) => {
    if (!r) return;
    cacheStatus.textContent = r.items ? `${r.items} 首 · ${fmtBytes(Number(r.bytes ?? 0))}` : "暂无缓存";
  };
  const paintCacheLimit = () => {
    const v = getMusicCacheLimitMB() || 2048;

    cacheLimit.max = String(MUSIC_CACHE_MAX_MB);
    cacheLimit.value = String(v);
    cacheLimit.style.setProperty("--v", `${Math.round(((v - 256) / (MUSIC_CACHE_MAX_MB - 256)) * 100)}%`);
    cacheLimitVal.textContent = v >= 1024 ? `${(v / 1024).toFixed(v % 1024 ? 1 : 0)} GiB` : `${v} MiB`;
  };

  paintCacheLimit();
  void musicCacheStatus().then(paintCacheStatus).catch(() => { cacheStatus.textContent = "缓存服务不可用"; });
  cacheLimit.addEventListener("input", () => {
    setMusicCacheLimitMB(Number(cacheLimit.value));
    void setMusicCacheLimit(Number(cacheLimit.value) * 1024 * 1024).catch(() => {});
    paintCacheLimit();
  });
  clearCacheBtn.onclick = async () => {
    clearCacheBtn.disabled = true;
    cacheStatus.textContent = "清理中…";

    try { paintCacheStatus(await clearMusicCache()); }
    catch (e) { cacheStatus.textContent = `清理失败：${errText(e)}`; }
    finally { clearCacheBtn.disabled = false; }
  };
  // 应用更新：自动检查开关（[Update] AutoCheck，默认开）
  bindOptCards<"on" | "off">(
    wrap.querySelector<HTMLElement>("#upd-auto-cards")!,
    () => (getAutoCheck() ? "on" : "off"),
    (v) => setAutoCheck(v === "on"),
  );
  // 更新渠道（[Update] Channel）：stable=latest release ｜ beta=tag 含 beta 的 prerelease ｜
  // nightly=滚动 Release「nightly」。三个渠道可以互相切换 —— 判定不靠「谁版本号更大」，而靠
  // 「设置里的渠道 ≠ 当前构建所属渠道」（buildChannel 认版本串里的短 sha / beta 段），所以同版号
  // 甚至回退都要能提示，否则切到 nightly/beta 就再也回不来（正式版不会为了一份预发布抬高版本号）。
  let buildVer = __APP_VERSION__;
  const channelCards = wrap.querySelector<HTMLElement>("#upd-channel-cards")!;
  const channelNote = wrap.querySelector<HTMLElement>("#upd-channel-note")!;

  const syncChannel = () => {
    const sel = getUpdateChannel();
    const built = buildChannel(buildVer);
    syncSel(channelCards, "opt", sel);
    channelNote.classList.toggle("is-switch", sel !== built);
    channelNote.textContent = sel === built
      ? `当前运行 ${describeBuild(buildVer)}`
      : `当前运行 ${describeBuild(buildVer)} · 已选 ${channelLabel(sel)}，点下方「检查更新」完成切换`;
  };

  channelCards.querySelectorAll<HTMLElement>("[data-opt]").forEach((b) => {
    b.onclick = () => {
      const next = b.dataset.opt as UpdateChannel;
      const was = getUpdateChannel();
      setUpdateChannel(next);
      syncChannel();

      // 明确点了「另一个渠道」= 要换一份构建：立刻查一次并按切换语义弹提醒
      // （失败也不打扰 —— 状态行与渠道说明都在，用户可再点「检查更新」）
      if (next !== was && next !== buildChannel(buildVer)) {
        void checkAndPrompt(next).catch(() => { /* 网络失败：状态行会显示检查失败 */ });
      }
    };
  });
  syncChannel();
  // 手动检查：状态行就地回报；发现更新 / 待切换（含已跳过、已暂不切换的）都弹提醒弹窗
  const checkBtn = wrap.querySelector<HTMLButtonElement>("#check-update")!;
  const updStatus = wrap.querySelector<HTMLElement>("#upd-status")!;
  updStatus.textContent = `当前 ${describeBuild(buildVer)}`;
  checkBtn.onclick = async () => {
    checkBtn.disabled = true;
    updStatus.textContent = "检查中…";

    try {
      const r = await checkAndPrompt(getUpdateChannel());

      if (r.status === "error") updStatus.textContent = `检查失败：${r.error}`;
      else if (r.status === "up-to-date") updStatus.textContent = `${channelLabel(r.channel)} 渠道已是最新`;
      else if (r.info.switching) updStatus.textContent = `可切换到 ${r.info.decision.targetLabel}${r.info.skipped ? "（你已暂不切换）" : ""}`;
      else if (r.info.channel === "nightly") updStatus.textContent = `发现新的 Nightly 构建${r.info.skipped ? "（你已跳过此构建）" : ""}`;
      else updStatus.textContent = `发现新版本 ${r.info.decision.latestDisplay}${r.info.skipped ? "（你已跳过此版本）" : ""}`;
    } catch (e) {
      updStatus.textContent = `检查失败：${errText(e)}`;
    } finally {
      checkBtn.disabled = false;
    }
  };

  // 当前构建版本以打包态的 app.getVersion() 为准（构建期注入的 __APP_VERSION__ 在 dev 下
  // 落在 git tag 上，不是「正在跑的这份」）。拿到后刷新渠道说明；状态行正忙就让位给检查结果。
  void getPlatformInfo().then((pf) => {
    if (!pf?.version || !parseVersion(pf.version)) return;
    buildVer = pf.version;
    syncChannel();

    if (!checkBtn.disabled) updStatus.textContent = `当前 ${describeBuild(buildVer)}`;
  });
  // 淡入淡出预设：持久化 + 立即下发时长（引擎侧做振幅包络；Blink 后端无此项）
  bindOptCards<FadePreset>(
    wrap.querySelector<HTMLElement>("#fade-cards")!,
    getFade,
    (p) => { void player.setFadePreset(p); },
  );

  // 字体：下拉给预设，右侧输入框可直接编辑 CSS font-family 列表（不必再去手改配置文件）。
  // 两边互相同步：选预设 → 填进输入框；输入框改成非预设值 → 下拉自动切到「自定义」。输入即时生效。
  const bindFont = (
    sel: HTMLSelectElement,
    input: HTMLInputElement,
    applyList: (css: string) => void,
    pickPreset: (key: string) => void,
    current: string,
  ) => {
    input.value = current;
    sel.value = fontKeyOf(current);
    sel.onchange = () => {
      if (sel.value === FONT_CUSTOM) return; // 「自定义」= 保持输入框现有内容，不动配置
      input.value = FONT_PRESETS[sel.value]?.css ?? "";
      pickPreset(sel.value);
    };

    input.oninput = () => { applyList(input.value); sel.value = fontKeyOf(input.value); };

    // 失焦时把输入框回写成规范化结果，跟落进配置的值保持一致（多余空格、半截分号都在这里清掉）
    input.onchange = () => {
      const norm = normalizeFontList(input.value);

      if (norm !== input.value) input.value = norm;
      applyList(norm);
      sel.value = fontKeyOf(norm);
    };
  };

  bindFont(
    wrap.querySelector<HTMLSelectElement>("#font-ui")!,
    wrap.querySelector<HTMLInputElement>("#font-ui-list")!,
    setUiFontList, setUiFontPreset, getUiFontList(),
  );
  bindFont(
    wrap.querySelector<HTMLSelectElement>("#font-lyric")!,
    wrap.querySelector<HTMLInputElement>("#font-lyric-list")!,
    setLyricFontList, setLyricFontPreset, getLyricFontList(),
  );

  // —— 歌词面板（[Lyrics]）：歌词列布局 / 繁简转换 / 在线 TTML 开关 / 数据库地址 / 本地 TTML 歌词库目录 ——
  // 歌词列布局只切正在播放页的 DOM class；notifyPublic 让已展开的页面立即读到新档。
  bindOptCards<NpLyricLayout>(
    wrap.querySelector<HTMLElement>("#np-lyric-layout-cards")!,
    getNpLyricLayout,
    (v) => { setNpLyricLayout(v); player.notifyPublic(); },
  );
  // 三项「取词计划」类开关共用一条收尾：写偏好 → resetCjkConverter（仅档位项需要）→ player.reloadLyric()。
  // 歌词管线默认只在换曲时重判顺序，而这些设置改的正是顺序 —— 不重拉当前曲就是假即时生效。
  bindOptCards<ChineseConvert>(
    wrap.querySelector<HTMLElement>("#cjk-cards")!,
    getChineseConvert,
    (v) => { setChineseConvert(v); resetCjkConverter(); player.reloadLyric(); },
  );
  bindOptCards<"on" | "off">(
    wrap.querySelector<HTMLElement>("#ttml-online-cards")!,
    () => (getOnlineTtml() ? "on" : "off"),
    (v) => { setOnlineTtml(v === "on"); player.reloadLyric(); },
  );
  const ttmlUrlInput = wrap.querySelector<HTMLInputElement>("#ttml-db-url")!;
  const ttmlUrlNote = wrap.querySelector<HTMLElement>("#ttml-db-note")!;

  /** 输入框永远显示「当前生效值」（getTtmlDatabase 已把坏值回落默认）；note 只放一次性反馈。 */
  const paintTtmlUrl = (note = "") => {
    ttmlUrlInput.value = getTtmlDatabase();
    setHint(ttmlUrlNote, note);
  };

  paintTtmlUrl();

  const commitTtmlUrl = () => {
    const v = ttmlUrlInput.value.trim();

    if (!v || v === getTtmlDatabase()) { paintTtmlUrl(); return; } // 留空 = 不改，回显当前生效值

    if (!isTtmlDatabaseUrl(v)) {
      paintTtmlUrl("地址模板要 http(s) 开头、含 %s 占位符，且不能有空格/引号——已回落到当前生效值。");

      return;
    }

    setTtmlDatabase(v);
    paintTtmlUrl();
    player.reloadLyric();
  };

  // 失焦提交（change）；回车 = 主动离开输入框，交给 blur 触发同一份提交口径（校验回落只留一处）
  ttmlUrlInput.onchange = commitTtmlUrl;
  ttmlUrlInput.onkeydown = (e) => { if (e.key === "Enter") ttmlUrlInput.blur(); };

  wrap.querySelector<HTMLButtonElement>("#ttml-db-default")!.onclick = () => {
    setTtmlDatabase(TTML_DB_DEFAULT_URL);
    paintTtmlUrl("已恢复默认模板。");
    player.reloadLyric();
  };

  // 本地 TTML 歌词库目录：原生选目录走「本地音乐」页同一座桥（quaver:local pick-folder），
  // 浏览器 dev 没有桥 → 按钮禁用并注明；清除 = 目录置空 = 功能整档关闭（非空即启用，不设独立开关）。
  const libInput = wrap.querySelector<HTMLInputElement>("#ttml-lib-path")!;
  const libPick = wrap.querySelector<HTMLButtonElement>("#ttml-lib-pick")!;
  const libClear = wrap.querySelector<HTMLButtonElement>("#ttml-lib-clear")!;

  const paintLib = () => {
    libInput.value = getTtmlLibrary();
    libClear.disabled = !getTtmlLibrary();
  };

  paintLib();

  if (!window.quaverLocal) {
    libPick.disabled = true;
    libPick.title = "浏览器 dev 没有原生选目录，请在桌面端设置";
  }

  libPick.onclick = async () => {
    const bridge = window.quaverLocal;

    if (!bridge) return;
    libPick.disabled = true;

    try {
      const r = await bridge.pickFolder();

      if (!r.ok) { toast(r.error ?? "选择目录失败", "err"); return; }

      if (r.canceled || !r.path) return;
      setTtmlLibrary(r.path);
      paintLib();
      player.reloadLyric();
    } finally {
      libPick.disabled = false;
    }
  };

  libClear.onclick = () => { setTtmlLibrary(""); paintLib(); player.reloadLyric(); };

  // —— 桌面歌词（[DesktopLyrics]）——
  // 开关只写配置：主进程 config set 处理器看到 DesktopLyrics.* 落盘即 syncFromConf()
  // 开/关覆盖层窗（electron/main.ts），本窗无需再经 control() 走第二条写盘路。
  bindOptCards<"on" | "off">(
    wrap.querySelector<HTMLElement>("#dl-enable-cards")!,
    () => (getDesktopLyrics() ? "on" : "off"),
    (v) => setDesktopLyrics(v === "on"),
  );
  // 固定/鼠标透穿：平台能力从主进程现读（macOS / Windows / X11 才有）。Wayland 隐藏整行，
  // 不在 UI 里给一个按下去也不会生效的开关。锁定后的解除入口同时留在托盘。
  const dlLockRow = wrap.querySelector<HTMLElement>("#dl-lock-row")!;
  dlLockRow.hidden = !desktopLyricsStateSync()?.canLock;
  const dlLockCards = wrap.querySelector<HTMLElement>("#dl-lock-cards")!;
  const syncDlLock = () => syncSel(dlLockCards, "opt", getDesktopLyricsLocked() ? "on" : "off");
  bindOptCards<"on" | "off">(
    dlLockCards,
    () => (getDesktopLyricsLocked() ? "on" : "off"),
    (v) => setDesktopLyricsLocked(v === "on"),
  );
  // 托盘改了锁定态 → 主进程广播配置增量；设置页跟着回填，别留一个过期勾选。
  (window as any).quaverConfig?.onChanged?.((p: { all?: boolean; values?: Record<string, string> } | null) => {
    if (p?.all || Object.prototype.hasOwnProperty.call(p?.values ?? {}, "DesktopLyrics.Locked")) syncDlLock();
  });
  // 桌面歌词字体：独立存 [DesktopLyrics] Font，不碰 [Style] DefaultLyricsFonts。
  bindFont(
    wrap.querySelector<HTMLSelectElement>("#dl-font")!,
    wrap.querySelector<HTMLInputElement>("#dl-font-list")!,
    setDesktopLyricsFontList, setDesktopLyricsFontPreset, getDesktopLyricsFontList(),
  );
  // 阴影总开关：关闭后仍保留描边，两个效果互不绑定。
  bindOptCards<"on" | "off">(
    wrap.querySelector<HTMLElement>("#dl-shadow-cards")!,
    () => (getDesktopLyricsShadow() ? "on" : "off"),
    (v) => setDesktopLyricsShadow(v === "on"),
  );
  // 行数：single=只当前句（裁切条带一条），dual=多带下一句 —— 纯偏好，覆盖层经广播现读现换
  bindOptCards<DlMode>(
    wrap.querySelector<HTMLElement>("#dl-mode-cards")!,
    getDesktopLyricsMode,
    (v) => setDesktopLyricsMode(v),
  );
  // 颜色四档：default=白字｜cover=封面染色｜system=系统染色｜custom=自选 HEX。
  // cover/system 的取色源随曲目镜像到覆盖层（主窗侧算好带过去），这里只管档位本身。
  bindOptCards<DlColorMode>(
    wrap.querySelector<HTMLElement>("#dl-color-cards")!,
    getDesktopLyricsColorMode,
    (v) => { setDesktopLyricsColorMode(v); paintDlColorRow(); },
  );
  // 单行居中：仅行数=单行时有意义（开=水平居中；关=左对齐。双行恒左对齐，没有第二开关）
  const dlCenterRow = wrap.querySelector<HTMLElement>("#dl-center-row")!;
  const paintDlCenterRow = () => { dlCenterRow.hidden = getDesktopLyricsMode() !== "single"; };

  bindOptCards<"on" | "off">(
    wrap.querySelector<HTMLElement>("#dl-center-cards")!,
    () => (getDesktopLyricsSingleCenter() ? "on" : "off"),
    (v) => setDesktopLyricsSingleCenter(v === "on"),
  );
  paintDlCenterRow();
  const dlModeCards = wrap.querySelector<HTMLElement>("#dl-mode-cards")!;
  dlModeCards.querySelectorAll<HTMLButtonElement>("button").forEach((b) => b.addEventListener("click", paintDlCenterRow));
  const dlColorRow = wrap.querySelector<HTMLElement>("#dl-color-row")!;
  const dlColorInput = wrap.querySelector<HTMLInputElement>("#dl-color")!;
  const dlColorHex = wrap.querySelector<HTMLInputElement>("#dl-color-hex")!;

  function paintDlColorRow() {
    dlColorRow.hidden = getDesktopLyricsColorMode() !== "custom";
    const hex = getDesktopLyricsColor();
    dlColorInput.value = hex;
    dlColorHex.value = hex;
  }

  paintDlColorRow();
  dlColorInput.oninput = () => {
    setDesktopLyricsColor(dlColorInput.value);
    dlColorHex.value = getDesktopLyricsColor();
  };

  dlColorHex.onchange = () => {
    const raw = dlColorHex.value.trim();
    setDesktopLyricsColor(raw.startsWith("#") ? raw : `#${raw}`);
    paintDlColorRow(); // 认不下的 HEX 由 prefs 回落现值 —— 输入框永远回显「当前生效值」
  };

  // 字重：100..900（滑条 10 一档）。可变字体由 wght 连续轴消费；静态字体由 font-weight 选最近字面。
  const dlWeight = wrap.querySelector<HTMLInputElement>("#dl-weight")!;
  const dlWeightVal = wrap.querySelector<HTMLElement>("#dl-weight-val")!;

  const paintDlWeight = () => {
    const weight = getDesktopLyricsWeight();
    dlWeight.value = String(weight);
    dlWeightVal.textContent = String(weight);
  };

  paintDlWeight();
  dlWeight.oninput = () => {
    setDesktopLyricsWeight(Number(dlWeight.value));
    dlWeightVal.textContent = dlWeight.value;
  };

  const dlScale = wrap.querySelector<HTMLInputElement>("#dl-scale")!;
  const dlScaleVal = wrap.querySelector<HTMLElement>("#dl-scale-val")!;

  const paintDlScale = () => {
    const pct = Math.round(getDesktopLyricsScale() * 100);
    dlScale.value = String(pct);
    dlScaleVal.textContent = `${pct}%`;
  };

  paintDlScale();
  dlScale.oninput = () => {
    setDesktopLyricsScale(Number(dlScale.value) / 100);
    dlScaleVal.textContent = `${dlScale.value}%`;
  };

  // 文字描边（px）：0..4。旧版 drop-shadow 已移除，轮廓只走这条；0 = 无描边。
  const dlBorder = wrap.querySelector<HTMLInputElement>("#dl-border")!;
  const dlBorderVal = wrap.querySelector<HTMLElement>("#dl-border-val")!;

  const paintDlBorder = () => {
    const px = getDesktopLyricsBorder();
    dlBorder.value = String(px);
    dlBorderVal.textContent = `${px.toFixed(1)} px`;
  };

  paintDlBorder();
  dlBorder.oninput = () => {
    setDesktopLyricsBorder(Number(dlBorder.value));
    dlBorderVal.textContent = `${Number(dlBorder.value).toFixed(1)} px`;
  };

  // 阴影参数：单层 text-shadow，四项都可独立调；总开关关掉时这些值仍保留，下次开启即恢复。
  const bindDlNumber = (
    sel: string,
    get: () => number,
    set: (v: number) => void,
    format: (v: number) => string,
    scale = 1,
  ) => {
    const input = wrap.querySelector<HTMLInputElement>(sel)!;
    const label = wrap.querySelector<HTMLElement>(`${sel}-val`)!;

    const paint = () => {
      const v = get();
      input.value = String(v * scale);
      label.textContent = format(v);
    };

    paint();
    input.oninput = () => {
      const v = Number(input.value) / scale;
      set(v);
      label.textContent = format(v);
    };
  };

  bindDlNumber("#dl-shadow-blur", getDesktopLyricsShadowBlur, setDesktopLyricsShadowBlur, (v) => `${Math.round(v)} px`);
  bindDlNumber("#dl-shadow-opacity", getDesktopLyricsShadowOpacity, setDesktopLyricsShadowOpacity, (v) => `${Math.round(v * 100)}%`, 100);
  bindDlNumber("#dl-shadow-x", getDesktopLyricsShadowX, setDesktopLyricsShadowX, (v) => `${Math.round(v)} px`);
  bindDlNumber("#dl-shadow-y", getDesktopLyricsShadowY, setDesktopLyricsShadowY, (v) => `${Math.round(v)} px`);
  // 歌词层不透明度：0.1..1（滑条 10..100%）—— 调的是**字**（内容淡出；悬停控件与背板各管各的）。
  const dlOpacity = wrap.querySelector<HTMLInputElement>("#dl-opacity")!;
  const dlOpacityVal = wrap.querySelector<HTMLElement>("#dl-opacity-val")!;

  const paintDlOpacity = () => {
    const pct = Math.round(getDesktopLyricsOpacity() * 100);
    dlOpacity.value = String(pct);
    dlOpacityVal.textContent = `${pct}%`;
  };

  paintDlOpacity();
  dlOpacity.oninput = () => {
    setDesktopLyricsOpacity(Number(dlOpacity.value) / 100);
    dlOpacityVal.textContent = `${dlOpacity.value}%`;
  };

  // 窗体不透明度（背板）：0..1（滑条 0..100%，默认 0）—— 调的是**整扇窗**那块底，字不受影响。
  // 几何/取色都在覆盖层自己算，这里只写偏好（写盘即广播）。
  const dlBackdrop = wrap.querySelector<HTMLInputElement>("#dl-backdrop")!;
  const dlBackdropVal = wrap.querySelector<HTMLElement>("#dl-backdrop-val")!;

  const paintDlBackdrop = () => {
    const pct = Math.round(getDesktopLyricsBackdrop() * 100);
    dlBackdrop.value = String(pct);
    dlBackdropVal.textContent = `${pct}%`;
  };

  paintDlBackdrop();
  dlBackdrop.oninput = () => {
    setDesktopLyricsBackdrop(Number(dlBackdrop.value) / 100);
    dlBackdropVal.textContent = `${dlBackdrop.value}%`;
  };

  // 配置文件：展示磁盘路径 + 一键定位 / 重置（浏览器 dev 下没有文件，只提示真相在哪）
  const conf = configInfo();
  const confPath = wrap.querySelector<HTMLInputElement>("#conf-path")!;
  const confHint = wrap.querySelector<HTMLElement>("#conf-hint")!;
  const openBtn = wrap.querySelector<HTMLButtonElement>("#open-conf")!;
  const resetBtn = wrap.querySelector<HTMLButtonElement>("#reset-conf")!;

  if (conf.bridged) {
    confPath.value = conf.path;
    confHint.textContent = conf.writable
      ? "手改后重启应用生效（改坏的值会自动回落默认，不影响启动）。"
      : "⚠️ 配置目录不可写，本次改动只在本进程内生效。";
  } else {
    confPath.value = "Fermata Mode 不写入 Config 文件";
    confHint.textContent = "当前为开发模式，改动仅存在本机浏览器，请使用生产模式";
    openBtn.disabled = true;
    resetBtn.disabled = true;
  }

  openBtn.onclick = () => { void revealConfig(); };

  resetBtn.onclick = async () => {
    if (!confirm("用模板重建 quaver.conf？主题 / 字体 / 播放 / 音质等设置会回到默认值，登录凭证不受影响。")) return;
    await resetConfig();
    location.reload(); // 重置后整页重来，省得逐项刷 UI 状态
  };

  // —— 播放引擎：MPV 原生直出 / MPVCompat 原生（兼容）/ Blink 浏览器。热切换保留当前曲目进度。
  const radios = wrap.querySelectorAll<HTMLInputElement>("#decode-radios input");
  const devSel = wrap.querySelector<HTMLSelectElement>("#audio-backend")!;
  const devHint = wrap.querySelector<HTMLElement>("#audio-device-hint")!;
  const engNote = wrap.querySelector<HTMLElement>("#engine-note")!;

  /** mpv 来源标签：随包运行时 / 系统 mpv / QUAVER_MPV 指定（排障时一眼看出跑的哪一份） */
  const MPV_SOURCE_LABEL: Record<string, string> = { bundled: "随包运行时", path: "系统 mpv", env: "QUAVER_MPV 指定" };

  async function paintBackend() {
    const st = await player.probeEngine();
    radios.forEach((r) => {
      r.disabled = (r.value === "MPV" || r.value === "MPVCompat") && !st.available;
      r.checked = r.value === getDecode();
      r.onchange = () => {
        const v = r.value;

        if (!r.checked || (v !== "MPV" && v !== "MPVCompat" && v !== "Blink")) return;
        void player.setBackend(v).then(paintAll);
      };
    });
    const src = MPV_SOURCE_LABEL[st.source] ?? "";
    engNote.textContent = player.backend === "mpv"
      ? `- 原生直出运行中${src ? "（" + src + "）" : ""}`
      : player.backend === "mpv-compat"
        ? `- 原生（兼容）运行中${src ? "（" + src + "）" : ""}`
        : st.available ? `- 默认 MPV（${src}），当前浏览器兜底` : "- " + (st.reason || "mpv 不可用，已回退浏览器音频");
  }

  async function paintDevices() {
    devSel.disabled = true;
    devSel.onchange = null;
    const r = await player.listAudioDevices();

    if (!r) {
      devSel.innerHTML = `<option>系统默认</option>`;
      devHint.textContent = player.backend === "mpv-compat"
        ? "原生（兼容）由渲染层跟随系统输出设备；切到原生直出后可在此直选设备。"
        : "浏览器 <audio> 后端：跟随系统输出设备；切到原生直出后可在此直选设备。";

      return;
    }

    devSel.innerHTML = `<option value="auto">系统默认</option>`
      + r.devices.map((d) => `<option value="${escHtml(d.id)}">${escHtml(d.desc)}</option>`).join("");
    devSel.disabled = false;
    devHint.textContent = "切换即时生效，无需重启。";
    devSel.onchange = () => { void player.selectAudioDevice(devSel.value); };
  }

  // EQ 浮窗按需加载（settings 本身已是动态路由；曲线渲染/APO 解析不必跟着设置页常驻）。
  wrap.querySelector<HTMLButtonElement>("#open-equalizer")!.onclick = () => {
    void import("../components/EqualizerDialog").then((m) => m.openEqualizer());
  };

  async function paintAll() { await paintBackend(); await paintDevices(); }

  void paintAll();
  // 引擎传输热切换（启动探测/设置页切换）后刷新设备列表——只在后端真正变化时，别跟着 4Hz notify 空转。
  // 订阅只留最新一份（watchBackendChange 会退订上一份）：设置页可反复进出，旧订阅若不退订，
  // 会连着整棵已拆卸的设置页 DOM 一直滞留在内存里（每次访问泄漏一整页）。
  let lastBackend = player.backend;
  watchBackendChange(() => {
    if (player.backend !== lastBackend) {
      lastBackend = player.backend;
      void paintBackend();
      void paintDevices();
    }
  });

  // 默认音质：档位由后端按会员等级下发（/stream/tiers）；locked 档画锁标不可选。
  const qBox = wrap.querySelector<HTMLElement>("#quality-grid")!;
  const qNote = wrap.querySelector<HTMLElement>("#q-member-note")!;
  const syncQ = () => syncSel(qBox, "q", getQuality());

  const bindQ = () => {
    qBox.querySelectorAll<HTMLButtonElement>("[data-q]").forEach((b) => {
      if (!b.disabled) b.onclick = () => {
        setQuality(b.dataset.q as Quality | "auto");
        setSessionQuality(null); // 播放条会话覆盖让位给新的默认档（新档自下一首起生效）
        syncQ();
        player.notifyPublic();
      };
    });
  };

  bindQ(); syncQ();
  getStreamTiers(true).then((t) => {
    qNote.textContent = `（当前：${t.membership_label}${t.membership ? "" : "，高档位需会员"}）`;

    for (const tier of t.all_tiers) {
      const btn = document.createElement("button");
      btn.className = "opt-card q";
      btn.dataset.q = tier.id;
      btn.type = "button";
      btn.innerHTML = tier.label + (tier.hi_res ? ' <span class="muted soon">Hi-Res</span>' : "")
        + (tier.locked ? ' <span class="q-lock">🔒会员</span>' : "");

      if (tier.locked) btn.disabled = true;
      qBox.append(btn);
    }

    bindQ(); syncQ();
  }).catch(() => { qNote.textContent = "（音质服务不可用）"; });

  // 调试：日志页面（壳层把 ui/electron-dev.log 经 /api/log 尾部暴露为纯文本，见 relay.ts）
  wrap.querySelector<HTMLElement>("#open-log")!.onclick = () => (location.hash = "#/log");
  // 自检弹窗：一次性动作，无常驻状态（弹窗自己管定时器）
  wrap.querySelector<HTMLElement>("#open-dbg")!.onclick = () => showDebugDialog();
  // 开源致谢：同样是一次性弹窗，仓库链接由主进程交给系统浏览器打开
  wrap.querySelector<HTMLElement>("#open-credits")!.onclick = () => showCreditsDialog();

  // Sparkle 面板：切路由时清理插件设置区的订阅与 render 清理函数
  const sparklePanel = wrap.querySelector<HTMLElement>('[data-panel="plugins"]')!;
  const offSparkle = mountSparklePanel(sparklePanel);
  // 热键面板：录制态残留监听由其 cleanup 收尾
  const hotkeysPanel = wrap.querySelector<HTMLElement>('[data-panel="hotkeys"]')!;
  const offHotkeys = mountHotkeysPanel(hotkeysPanel);

  return () => { offSparkle(); offSparkleThemes(); offHotkeys(); };
}

// —— 调试：日志页面（壳层 electron-dev.log 尾部；由 relay.ts /api/log 提供） ——
