// Quaver — 路由视图：log（由 src/views/index.ts 按需动态 import，不在首屏解析）
import { api } from "../lib/api";
import { errText, h } from "./_shared";
// —— 调试：日志页面（壳层 electron-dev.log 尾部；由 relay.ts /api/log 提供） ——
export default async function logView(root: HTMLElement) {
  const bar = h("div", "log-bar");
  const pre = h("pre", "log-pre", `<span class="muted">加载中…</span>`);
  const back = h("button", "ghost-btn", "返回设置");
  const refresh = h("button", "ghost-btn", "刷新");
  const meta = h("span", "muted");
  bar.append(back, refresh, meta);
  root.append(bar, pre);
  back.onclick = () => (location.hash = "#/settings");
  async function load() {
    meta.textContent = "读取中…";
    try {
      const r = await fetch("/api/log?tail=800");
      if (!r.ok) {
        const j = (await r.json().catch(() => null)) as { msg?: string } | null;
        throw new Error(j?.msg || `HTTP ${r.status}`);
      }
      pre.textContent = await r.text();
      meta.textContent = "来源 ui/electron-dev.log（尾部 800 行）";
      pre.scrollTop = pre.scrollHeight;
    } catch (e) {
      pre.innerHTML = "";
      pre.append(h("span", "muted", `读不到日志：${errText(e)}（Electron 壳层未运行时属正常）`));
      meta.textContent = "";
    }
  }
  refresh.onclick = load;
  await load();
}

// —— 我的页（点侧栏头像的落点；退出登录按钮长在这里）——
//
// 进场：整页交给 CSS 的 `.me > *` 分级淡入（style.css「我的」段），容器让位不叠动画。
// 离场：退出登录先播 `.leaving`（整页淡出上移）再跳登录页 —— 登录态变化必须走整页
// （location.href）才能重置侧栏与播放器，所以这里只能「先把界面收掉再跳」。
