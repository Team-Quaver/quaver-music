// Sparkle 的宿主版本约束使用 SemVer 比较。
// 这个模块只依赖标准 JS，渲染层和 Electron 主进程可以共用同一套口径。

interface SparkleVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

const VERSION_RE = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function parseSparkleVersion(value: unknown): SparkleVersion | null {
  if (typeof value !== "string") return null;
  const m = VERSION_RE.exec(value.trim());

  if (!m) return null;

  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split(".") : [],
  };
}

/** 返回负数、0、正数，分别表示 a 小于、等于、大于 b。 */
export function compareSparkleVersions(a: unknown, b: unknown): number | null {
  const left = parseSparkleVersion(a);
  const right = parseSparkleVersion(b);

  if (!left || !right) return null;

  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }

  // SemVer 规定：正式版高于同版本的所有预发布版；两个预发布段逐项比较。
  if (!left.prerelease.length || !right.prerelease.length) {
    return left.prerelease.length ? -1 : right.prerelease.length ? 1 : 0;
  }

  const length = Math.max(left.prerelease.length, right.prerelease.length);

  for (let i = 0; i < length; i++) {
    const l = left.prerelease[i];
    const r = right.prerelease[i];

    if (l === undefined) return -1;

    if (r === undefined) return 1;

    if (l === r) continue;
    const lNumeric = /^\d+$/.test(l);
    const rNumeric = /^\d+$/.test(r);

    if (lNumeric && rNumeric) return Number(l) - Number(r);

    if (lNumeric !== rNumeric) return lNumeric ? -1 : 1;

    return l < r ? -1 : 1;
  }

  return 0;
}

/** nightly 构建（CI 版本 = <包版本>-<短sha>-nightly，产物名形态省略 -nightly 后缀）。
 *  prerelease 段与 update-core.ts 的 parseVersion 同一口径：短 commit id（十六进制 7-10 位）。 */
export function isSparkleNightly(value: unknown): boolean {
  // 裸 "nightly"：滚动 tag 名。老构建的 git describe 命中过它，把 "nightly" 原样注入
  // __APP_VERSION__ —— 与 update-core 的口径对齐，认作 nightly 而不是「解析失败的版本」。
  if (value === "nightly") return true;
  const v = parseSparkleVersion(value);

  return !!v?.prerelease.length && /^([0-9a-f]{7,10})(-nightly)?$/.test(v.prerelease.join("-"));
}

export function isSparkleVersionAtLeast(current: unknown, minimum: unknown, allowBeta = false): boolean {
  const comparison = compareSparkleVersions(current, minimum);

  if (comparison !== null && comparison >= 0) return true;

  // Nightly 是 main 的末端，但 CI 版本号沿用包版本（只在发布时抬），SemVer 排序上永远低于
  // 下一版线 —— 插件把 minHostVersion 指向未发布版本（1.4.1 + allowBeta）时，下面的同 x.y.z
  // 门在 nightly 上永不成立，可那份代码恰恰只在 nightly 里。所以 nightly 视为高于一切最低版本。
  if (isSparkleNightly(current)) return true;

  if (!allowBeta) return false;

  // allowBeta 只放行「当前版本是目标正式版本的预发布版」这一种情况，不能让更旧的 Beta 越过最低版本。
  const currentVersion = parseSparkleVersion(current);
  const minimumVersion = parseSparkleVersion(minimum);

  if (!currentVersion?.prerelease.length || minimumVersion?.prerelease.length) return false;

  return (["major", "minor", "patch"] as const).every((key) => currentVersion[key] === minimumVersion?.[key]);
}

export function isSparkleVersionValid(value: unknown): value is string {
  return parseSparkleVersion(value) !== null;
}

/** 返回用户可直接展示的最低宿主版本错误；没有声明最低版本时返回 null。 */
export function getSparkleHostVersionError(current: unknown, minimum: unknown, allowBeta = false): string | null {
  if (minimum === undefined) return null;

  if (typeof minimum !== "string" || !isSparkleVersionValid(minimum)) return "插件最低本体版本号不合法";

  if (typeof allowBeta !== "boolean") return "插件 Beta 版本开关不合法";

  if (isSparkleVersionAtLeast(current, minimum, allowBeta)) return null;

  return `插件需要 Quaver Music ${minimum} 或更高版本，当前版本为 ${String(current)}`;
}
