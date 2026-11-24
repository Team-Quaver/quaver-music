// Quaver — IPC / 外部 JSON 的边界取值。
//
// 主进程收到的 `ipcRenderer.send/invoke` 参数、sidecar 回包、读盘 JSON 在类型上都是「未知形状」。
// 与其在每处写 `unknown` + 断言，不如统一在这里把「JSON 能表达的东西」命名出来，再由
// `isJsonObject` / `jsonString` / `jsonNumber` / `jsonArray` 逐层收窄 —— 解析发生在边界，
// 领域函数只接已解析的具名类型。

/** JSON 能表达的值（含嵌套数组与对象）。 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** JSON 对象（不含数组）。 */
export interface JsonObject {
  [key: string]: JsonValue;
}

/** 判「普通 JSON 对象」：数组/标量/null 都不算。 */
export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return Object.prototype.toString.call(value) === "[object Object]";
}

export function isJsonArray(value: JsonValue | undefined): value is JsonValue[] {
  return Array.isArray(value);
}

function isJsonString(value: JsonValue | undefined): value is string {
  return Object.prototype.toString.call(value) === "[object String]";
}

/** 取字符串字段；缺失或非字符串回落 fallback。 */
export function jsonString(value: JsonValue | undefined, fallback = ""): string {
  return isJsonString(value) ? value : fallback;
}

/** 取数字字段；缺失或非有限数回落 fallback。 */
export function jsonNumber(value: JsonValue | undefined, fallback = 0): number {
  if (Object.prototype.toString.call(value) !== "[object Number]") return fallback;

  const num = Number(value);

  return Number.isFinite(num) ? num : fallback;
}

/** 取布尔字段；只认真正的 true。 */
export function jsonBoolean(value: JsonValue | undefined): boolean {
  return value === true;
}
