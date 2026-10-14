// Quaver — 路由视图：login（由 src/views/index.ts 按需动态 import，不在首屏解析）
import { api } from "../lib/api";
import type { LoginChannel, QrResp, QrStatusResp } from "./_shared";
import { errText } from "./_shared";
// —— 登录页（扫码），内容区视图 ——
export default async function loginView(root: HTMLElement) {
  root.innerHTML = `
    <div class="login-wrap">
      <h2>扫码登录</h2>
      <p class="muted">用手机 QQ 音乐 App、QQ 或微信扫码。凭证由本机加密保存（KWallet / 钥匙串 / 凭据管理器等系统密钥管理器），磁盘上不留明文，也不进浏览器。</p>
      <!-- 登录方式用标签区分（不是下拉）：复用搜索页/歌手页那套 .tag 组件，三档一眼看全，
           data-ch 的取值必须与 sidecar 的 QR_TYPES（qq/wx/mobile）对齐，写错是 422 不是静默失败 -->
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
    </div>`;
  const qr = root.querySelector<HTMLElement>("#qr")!;
  const lstate = root.querySelector<HTMLElement>("#lstate")!;
  const tabs = [...root.querySelectorAll<HTMLButtonElement>("#channel .tag")];
  let channel = (tabs[0]?.dataset.ch ?? "mobile") as LoginChannel;
  let timer: number | undefined;
  let stopped = false;
  let generation = 0;

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
  root.querySelector<HTMLElement>("#refresh")!.onclick = () => void start();
  void start();

  return () => { stopped = true; window.clearInterval(timer); };
}

// —— 搜索页（顶部常驻搜索框的落点视图）：热搜词 + 分类标签（歌曲/歌手/专辑/歌单） ——
