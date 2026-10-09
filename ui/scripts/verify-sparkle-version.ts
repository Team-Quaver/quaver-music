// Sparkle 宿主版本约束的纯逻辑回归测试。
import { compareSparkleVersions, getSparkleHostVersionError, isSparkleVersionAtLeast, isSparkleVersionValid } from "../electron/sparkle-version.ts";

let failed = 0;
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok) failed++;
};

check("1.3.5 低于 1.4.0", compareSparkleVersions("1.3.5", "1.4.0")! < 0);
check("1.4.0 满足最低版本 1.4.0", isSparkleVersionAtLeast("1.4.0", "1.4.0"));
check("1.4.0-beta.3 低于正式版 1.4.0", !isSparkleVersionAtLeast("1.4.0-beta.3", "1.4.0"));
check("allowBeta 允许同版本 Beta 满足最低版本", isSparkleVersionAtLeast("1.4.0-beta.3", "1.4.0", true));
check("allowBeta 仍拒绝更旧版本 Beta", !isSparkleVersionAtLeast("1.3.9-beta.1", "1.4.0", true));
check("v1.4.1 高于 1.4.0", isSparkleVersionAtLeast("v1.4.1", "1.4.0"));
check("无效版本不会通过校验", !isSparkleVersionAtLeast("not-a-version", "1.4.0") && !isSparkleVersionValid("1.4"));
check("低版本返回可展示的安装错误", getSparkleHostVersionError("1.3.5", "1.4.0")?.includes("需要 Quaver Music 1.4.0") === true);
check("allowBeta 下同版本 Beta 没有安装错误", getSparkleHostVersionError("1.4.0-beta.3", "1.4.0", true) === null);

console.log(`\n${failed ? `${failed} failed` : "all passed"}`);
process.exit(failed ? 1 : 0);
