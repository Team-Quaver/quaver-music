// 「全站禁选中（输入框除外）」的静态断言
//
// 桌面应用的指针手势是「点 / 拖 / 双击播放」，不是选词：一选中，拖进度条、拖音量、拖队列
// 排序都会在指针后面糊出一片蓝，双击列表还常常变成选中歌名。
// 口径收在**一处**：body 上 `user-select:none`，例外只有「真要输入 / 真要复制」的两类
// （输入类控件 + 调试日志页的 <pre>）。散落各处的重复 user-select 不许再长回来 ——
// 两处口径迟早会打架（曾经就是 `.content-top` 自己禁一遍、再给搜索框单独开一遍）。
//
// 用法：node scripts/verify-noselect.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

let fails = 0;
let checks = 0;
const ok = (name, cond, note = "") => {
  checks++;
  if (cond) console.log(`PASS ${name}${note ? " — " + note : ""}`);
  else { fails++; console.log(`FAIL ${name}${note ? " — " + note : ""}`); }
};

const css = read("src/style.css");
const noComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const plain = noComments(css);

// body 的基础规则（不带类/伪类的那条）—— 全局禁选中的唯一来源
const bodyRule = plain.match(/^body \{([^}]*)\}/m)?.[1] ?? "";
ok("css: body 上禁选中（全站生效，user-select 会继承）",
  /-webkit-user-select:\s*none/.test(bodyRule) && /user-select:\s*none/.test(bodyRule), bodyRule.trim());

// 例外规则
const allowRule = plain.match(/input, textarea,\[?[^\n{]*\{([^}]*)\}/)?.[1]
  ?? plain.match(/^input,[^{]*\{([^}]*)\}/m)?.[1] ?? "";
ok("css: 输入类控件开回可选中（输入框里选不中自己的内容 = 没法改）",
  /user-select:\s*text/.test(allowRule), allowRule.trim());
ok("css: 例外覆盖 input / textarea / contenteditable",
  /^input, textarea, \[contenteditable/.test(plain.match(/^(input, textarea[^{]*)\{/m)?.[1] ?? ""));
ok("css: 调试日志页的 <pre> 也开回可选中（那页存在的意义就是复制）",
  /^input, textarea,\[?,?[^\n{]*\.log-pre/.test(plain) || /\.log-pre[^{]*\{[^}]*user-select:\s*text/.test(plain));

// 反向：口径不许散落
ok("css: 不再有散落的重复口径（.content-top 自己禁一遍 / 搜索框单独开一遍）",
  !/\.content-top \{[^}]*user-select/.test(plain) && !/\.sb-field input \{[^}]*user-select/.test(plain));

// 搜索框真的落在例外里（它是 <input>，不是自绘的 div）
ok("搜索框是 <input>（因此自动命中例外，不需要特例）",
  /<input id="q" type="search"/.test(read("src/components/SearchBox.ts")));
ok("列表内筛选框也是 <input>", /<input class="lt-kw" type="search"/.test(read("src/components/ListTools.ts")));

console.log(`\n${checks - fails}/${checks} passed${fails ? ` — ${fails} FAILED` : ""}`);
process.exit(fails ? 1 : 0);
