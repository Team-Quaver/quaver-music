/** HTML 转义（文本节点与双引号属性值都安全）；入参宽容（unknown），null/undefined 归空串 */
export const escHtml = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

