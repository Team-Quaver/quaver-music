// Quaver — 校验脚本的测试替身入口。
//
// 单测里经常要伪造 `Storage` / `Document` / `Window` 这类大接口：替身只实现被测代码真正
// 用到的那几个成员，类型上却必须声明成完整接口。集中在这里做一次转换，调用点就不必
// 到处写 `as unknown as X`（anti-slop 也把链式断言当作丢失类型证据）。

/** 把最小形状的替身交给运行期；断言结果由脚本里的行为检查兜底。 */
export function testDouble<T, V>(value: V): T {
  // SAFETY: 测试替身只实现被测代码真正访问的成员；缺的成员一旦被调用，脚本会当场报错。
  return value as T & V;
}
