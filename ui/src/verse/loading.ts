// Verse 加载占位：全站「加载中 / 搜索中 / 生成中 / 读取中…」文字的统一替换（转圈）。
// 用法：box.innerHTML = loadingHtml();（块级居中；自带 role=status + aria-label，读屏仍可感知）
// 行内场景（如日志页 meta）：meta.innerHTML = loadingInlineHtml();（无 label 参数时默认「加载中」）
export const loadingHtml = (label = "加载中") =>
  `<div class="v-loading" role="status" aria-label="${label}"><span class="v-spinner" aria-hidden="true"></span></div>`;

export const loadingInlineHtml = (label = "加载中") =>
  `<span class="v-spinner" role="status" aria-label="${label}"></span>`;
