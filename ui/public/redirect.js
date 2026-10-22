// Quaver — 薄跳转层（旧 <name>.html 深链 → SPA hash 路由）
//
// 这些页面在 SPA 化之后只剩「跳一次」这件事。**必须是外链脚本**：应用页面的 CSP
// 里 script-src 只有 'self' blob:（见 electron/csp.ts），留在 html 里的内联 <script>
// 会被直接拦掉，跳转层就哑了 —— 用户停在一个空白页上。
// 路由名由标签上的 data-route 给出（经典脚本同步执行，document.currentScript 拿得到自己）。
(function () {
  var tag = document.currentScript;
  var route = (tag && tag.getAttribute("data-route")) || "";

  if (!route) return; // 没有路由名就别乱跳（宁可停在原页，也不要跳去一个猜的页面）
  var q = new URLSearchParams(location.search);
  var hash;

  if (route === "playlist") {
    // 旧 ?tid=&name= 深链映射到 SPA 路由 #/playlist?id=&name=
    var id = q.get("id") || q.get("tid") || q.get("dir") || "";
    var name = q.get("name") || "";
    hash = "#/playlist?id=" + encodeURIComponent(id) + "&name=" + encodeURIComponent(name);
  } else {
    hash = "#/" + route + (location.search || "");
  }

  location.replace("/index.html" + hash);
})();
