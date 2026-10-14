// Quaver — 路由视图：user（由 src/views/index.ts 按需动态 import，不在首屏解析）
import { api, escHtml, identityBadges } from "../lib/api";
import { vipCardHtml, watchVip } from "../lib/vip.ts";
import type { UserMeResp } from "./_shared";
import { exitMe, h, settleIn } from "./_shared";
export default async function userView(root: HTMLElement) {
  const wrap = h("div", "me");
  root.append(wrap);
  try {
    const [home, vip] = await Promise.all([
      api<UserMeResp>("/user/me"),
      api<unknown>("/user/vip").catch(() => null),
    ]);
    const base = home?.base_info;
    if (!base?.name) { location.hash = "#/login"; return; }
    // 会员权益卡（到期时间 + 档位明细 + 续费指路）由 lib/vip.ts 生成：字段口径与上游模型对齐，
    // 这里只负责挂进页面。vip 为 null（上游没响应）时卡片自己说明读不到。
    wrap.innerHTML = `
      <div class="avatar-big">${base.avatar ? `<img src="${String(base.avatar).replace(/^http:/, "https:")}" alt=""/>` : ""}</div>
      <h2 style="margin:12px 0 4px">${escHtml(base.name)}</h2>
      <div class="badges" style="justify-content:center">${identityBadges(home, vip)}</div>
      <p class="muted">UID: ${escHtml(base.encrypted_uin ?? "")}</p>
      ${vipCardHtml(vip)}
      <button id="logout" class="ghost-btn danger">退出登录</button>`;
    const stopVip = watchVip(vip, () => {
      const badges = wrap.querySelector<HTMLElement>(".badges")!;
      const badgeHtml = identityBadges(home, vip);
      if (badges.innerHTML !== badgeHtml) badges.innerHTML = badgeHtml;
      const card = wrap.querySelector<HTMLElement>(".vip-card")!;
      const cardHtml = vipCardHtml(vip);
      if (card.outerHTML !== cardHtml) card.outerHTML = cardHtml;
    });
    const btn = wrap.querySelector<HTMLButtonElement>("#logout")!;
    let leaving = false;
    btn.onclick = async () => {
      if (leaving) return; // 连点：只开一趟登出
      leaving = true;
      stopVip();
      btn.disabled = true;
      btn.textContent = "正在退出…";
      // 离场动画与登出请求并行：动画短、请求可能慢，两个都不许把跳转卡住
      await Promise.all([exitMe(wrap), settleIn(api("/login/logout", { method: "POST" }), 1500)]);
      location.href = "/login.html";
    };
    return stopVip;
  } catch {
    location.hash = "#/login";
  }
}

// —— 登录页（扫码），内容区视图 ——
