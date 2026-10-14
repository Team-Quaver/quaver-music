// Quaver — 测试用：把拆开的视图模块读成「一份视图源码」
//
// 背景：src/views.ts 已按路由拆成 src/views/<页面>.ts（见 src/views/index.ts 的懒加载注册表），
// 而仓库里二十来个 verify 脚本的断言是**读源码文本做正则**的（本仓既定护栏套路），它们关心的
// 是「视图代码里有没有这条接线」，不是「这条接线在哪个文件」。所以这里按文件名序拼一份全文，
// 让那些断言原样可用 —— 谁再拆一次目录，只需要动这个函数。
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const DIR = resolve(import.meta.dirname, "../src/views");

export function viewsSource(): string {
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".ts"))
    .sort()
    .map((f) => `// ——— src/views/${f} ———\n` + readFileSync(join(DIR, f), "utf8"))
    .join("\n");
}

/** 单页视图源码（断言只想看某一页时用）。 */
export function viewSource(name: string): string {
  return readFileSync(join(DIR, `${name}.ts`), "utf8");
}
