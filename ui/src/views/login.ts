// Quaver — 路由视图：login（由 src/views/index.ts 按需动态 import，不在首屏解析）
import { api, postJson } from "../lib/api";
import type { LoginChannel, QrResp, QrStatusResp } from "./_shared";
import { errText } from "./_shared";
import type { QQQuickResp } from "./_shared";

// —— 登录页：本机 QQ 快速登录优先，二维码作兜底 ——
export default async function loginView(root: HTMLElement) {
  root.classList.add("login-host");

  root.innerHTML = `
    <div class="login-wrap">
      <section id="quick" class="quick-login">
        <div id="quick-state" class="quick-state" aria-live="polite">
          <div class="quick-loading" aria-hidden="true"></div>
          <p class="muted">正在加载…</p>
        </div>
      </section>
      <section id="qr-panel" class="qr-panel" hidden>
        <h2>扫码登录</h2>
        <p class="muted">请使用手机 Q 音、QQ 或微信扫码登录 Quaver Music，该凭证将使用系统指定的密钥环进行保护</p>
        <!-- 登录方式用标签区分（不是下拉）：复用搜索页/歌手页那套 .tag 组件，三档一眼看全，
             data-ch 的取值必须与 sidecar 的 QR_TYPES（qq/wx/mobile）对齐，写错是 422 不是静幕失败 -->
        <div class="tag-tabs" id="channel" role="tablist" aria-label="登录方式">
          <button class="tag sel" type="button" role="tab" aria-selected="true" data-ch="mobile">QQ 音乐 App</button>
          <button class="tag" type="button" role="tab" aria-selected="false" data-ch="qq">手机 QQ</button>
          <button class="tag" type="button" role="tab" aria-selected="false" data-ch="wx">微信</button>
        </div>
        <div class="qr-box">
          <div id="qr" class="qr"><div class="muted">正在生成二维码…</div></div>
          <div id="lstate" class="muted"></div>
          <div class="row-btn">
            <button id="refresh" type="button">重新生成</button>
          </div>
        </div>
        <button id="qr-fallback" type="button" hidden>使用 QQ 快捷登录</button>
      </section>
      <button id="quick-fallback" type="button" hidden>使用二维码登录</button>
    </div>`;

  const quick = root.querySelector<HTMLElement>("#quick")!;
  const state = root.querySelector<HTMLElement>("#quick-state")!;
  const fallback = root.querySelector<HTMLButtonElement>("#quick-fallback")!;
  const qrPanel = root.querySelector<HTMLElement>("#qr-panel")!;
  const qr = qrPanel.querySelector<HTMLElement>("#qr")!;
  const lstate = qrPanel.querySelector<HTMLElement>("#lstate")!;
  const qrFallback = qrPanel.querySelector<HTMLButtonElement>("#qr-fallback")!;
  const tabs = [...qrPanel.querySelectorAll<HTMLButtonElement>("#channel .tag")];
  let channel = (tabs[0]?.dataset.ch ?? "mobile") as LoginChannel;
  let timer: number | undefined;
  let stopped = false;
  let generation = 0;
  let quickReady = false;

  async function detect() {
    const current = ++generation;
    try {
      const d = await api<QQQuickResp>("/login/qq-quick");
      if (stopped || current !== generation) return;

      if (!d.available) throw new Error("unavailable");

      const name = d.nickname?.trim() || "QQ 用户";
      const uin = d.uin ? String(d.uin) : "";
      const avatar = d.avatar || "";

      quickReady = true;

      quick.innerHTML = `
        <button id="quick-login" class="quick-card ready" type="button">
          <span class="quick-avatar">
            ${avatar ? `<img src="${avatar}" alt="${name} 的 QQ 头像" loading="eager"/>` : ""}
          </span>
          <span class="quick-id">
            <strong class="quick-name">${name}</strong>
            <span class="quick-uin">${uin ? `QQ 号 ${uin}` : "本机已登录 QQ"}</span>
          </span>
        </button>
        <p id="quick-error" class="muted" aria-live="polite"></p>`;

      const button = quick.querySelector<HTMLButtonElement>("#quick-login")!;
      const error = quick.querySelector<HTMLElement>("#quick-error")!;
      button.onclick = async () => {
        if (stopped) return;
        button.disabled = true;
        error.textContent = "正在登录…";
        try {
          await postJson("/login/qq-quick", { uin: d.uin });
          if (stopped) return;
          error.textContent = "✅ 登录成功，正在返回…";
          setTimeout(() => { if (!stopped) location.href = "/index.html"; }, 800);
        } catch (e) {
          if (stopped) return;
          button.disabled = false;
          error.textContent = `登录失败：${errText(e)}，可改用二维码登录`;
        }
      };
    } catch {
      if (stopped) return;
      state.innerHTML = `<p class="muted">未检测到本机 QQ，可以使用二维码登录</p>`;
      quick.classList.add("no-client");
    } finally {
      if (!stopped) fallback.hidden = false;
    }
  }

  // —— 以下为二维码兜底（结构不动，避免破坏已验证的轮询语义） ——
  async function start() {
    window.clearInterval(timer);
    const current = ++generation;
    const loginChannel = channel;
    let polling = false;
    qr.innerHTML = `<div class="muted">生成中…</div>`;
    lstate.textContent = "";
    let d: QrResp;

    try {
      d = await api<QrResp>(`/login/qrcode/${loginChannel}`);
    } catch (e) {
      if (stopped || current !== generation) return;
      qr.innerHTML = `<div class="muted">${/429|backoff|频繁/.test(errText(e)) ? "操作太快，等 60-90s 再重试" : errText(e)}</div>`;

      return;
    }

    if (stopped || current !== generation) return;
    qr.innerHTML = `<img src="${d.img}" alt="登录二维码"/>`;
    lstate.textContent = "等待扫码…";

    timer = window.setInterval(async () => {
      if (stopped || current !== generation || polling) return;
      polling = true;

      try {
        const c = await api<QrStatusResp>(`/login/qrcode/${loginChannel}/status?identifier=${encodeURIComponent(d.identifier ?? "")}`);

        if (stopped || current !== generation) return;

        if (c.error) {
          lstate.textContent = c.error;

          if (c.done) window.clearInterval(timer);

          return;
        }

        if (c.event === 1) { lstate.textContent = "等待扫码…"; return; } // SCAN

        if (c.event === 2) { lstate.textContent = "已扫码，请在手机上确认"; return; }

        if (c.event === 3) { lstate.textContent = "二维码已过期，点「重新生成」"; window.clearInterval(timer); return; }

        if (c.event === 4) { lstate.textContent = "已拒绝登录"; window.clearInterval(timer); return; }

        if (c.event === 0 && c.done) {
          window.clearInterval(timer);
          lstate.textContent = "✅ 登录成功，正在返回…";
          setTimeout(() => { if (!stopped && current === generation) location.href = "/index.html"; }, 800);
        }
      } catch (e) {
        if (stopped || current !== generation) return;
        lstate.textContent = `登录请求失败：${errText(e)}。可点「重新生成」重试。`;
      } finally {
        polling = false;
      }
    }, 2000);
  }

  fallback.onclick = () => {
    if (stopped) return;
    quick.hidden = true;
    fallback.hidden = true;
    qrPanel.hidden = false;
    qrFallback.hidden = !quickReady;
    void start();
  };

  qrFallback.onclick = () => {
    if (stopped) return;
    window.clearInterval(timer);
    generation++; // 让还在路上的二维码响应失效，别回头覆盖快捷登录区
    qrPanel.hidden = true;
    quick.hidden = false;
    fallback.hidden = false;
  };

  // 换标签 = 换通道：立刻重开一张二维码（旧轮询在 start 里 clearInterval 掉，不会串台）
  for (const b of tabs) {
    b.addEventListener("click", () => {
      const ch = b.dataset.ch as LoginChannel;

      if (ch === channel) return; // 重复点当前档不重开
      channel = ch;

      for (const x of tabs) {
        const on = x === b;
        x.classList.toggle("sel", on);
        x.setAttribute("aria-selected", String(on));
      }

      void start();
    });
  }

  qrPanel.querySelector<HTMLElement>("#refresh")!.onclick = () => void start();
  void detect();

  return () => { stopped = true; window.clearInterval(timer); };
}
