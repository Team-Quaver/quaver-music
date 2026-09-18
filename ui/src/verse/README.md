# src/verse — Verse 主题（可复用单元）

本目录是 Verse 界面语言在本项目里的落点。换肤 = 替换 token 文件，
组件与 app 层样式原样复用。

| 文件 | 来源 | 能否手改 |
| --- | --- | --- |
| `verse-tokens.css` | 上游 `design-system/tokens.css` 原样 vendor | 否（上游更新时整体覆盖） |
| `verse-components.css` | 上游 `components/bundle.css` 原样 vendor | 否（类名 `.v-*` 即组件契约） |
| `verse-app.css` | 本项目按 `GUIDELINES.md` 范式手写 | 是，但只许用 `var()` 取值 |
| `tokens.json`（未 vendor） | 上游结构化 token，字阶数值出处 | 按需查，不进构建 |

引入顺序（见 `src/shell.ts`）：tokens → components → app → `style.css`。
`tokens.css` 缺失时组件会塌成无高度行内元素——它必须最先加载。

主题：`<html data-theme="light"|"dark">`，不设则跟随系统；
切换无过渡动画；深色下 accent 上文字走 `--on-accent`（近黑），不许写死白。
字体：`fonts/MiSansVF.ttf`（20MB，可变 100–900）已随包分发，
`@font-face` 在 `verse-app.css` 头部声明；`dist/**` 随 Electron 一起打包，
无需运行时联网下载。上游 `tokens.css` 末尾注释掉的 `@font-face` 不用解开
（vendor 文件保持原样，声明只活在 app 层这一处）。

`--brand-1`（橄榄金备用色）：上游 HANDOFF 要求"给明确用途或删掉"。
本项目不给它第二强调色的用途；为保持 vendor 文件与上游字节一致以便整体覆盖更新，
此处选择**保留变量、零引用**（`grep brand-1 src/` 无命中），不删除、不使用。

自检页：根目录 `verse-preview.html`（dev-only，不进构建）在 dev 服务器下打开，
对照上游 README 的自检清单目检：控件高度、一处青绿填充、数字等宽、深浅两主题。
