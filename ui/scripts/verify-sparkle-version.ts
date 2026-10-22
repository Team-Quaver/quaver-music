// Sparkle 宿主版本约束的纯逻辑回归测试。
import { compareSparkleVersions, getSparkleHostVersionError, isSparkleNightly, isSparkleVersionAtLeast, isSparkleVersionValid } from "../electron/sparkle-version.ts";

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

check("nightly 构建满足更高版线 + allowBeta", isSparkleVersionAtLeast("1.4.0-abc1234-nightly", "1.4.1", true));

check("nightly 构建满足更高版线（无 allowBeta 也放行）", isSparkleVersionAtLeast("1.4.0-abc1234-nightly", "1.4.1"));

check("产物名形态的 nightly（无 -nightly 后缀）同样放行", isSparkleVersionAtLeast("1.4.0-abc1234", "1.4.1"));

check("nightly 满足同版线最低版本", isSparkleVersionAtLeast("1.4.0-abc1234-nightly", "1.4.0"));

check("isSparkleNightly 只认 sha 形 prerelease", isSparkleNightly("1.4.0-abc1234-nightly") && !isSparkleNightly("1.4.0-beta.1") && !isSparkleNightly("1.4.0") && !isSparkleNightly("1.4.0-nightly"));

check("nightly 无安装错误", getSparkleHostVersionError("1.4.0-abc1234-nightly", "1.4.1", true) === null);

check("同版线 Beta 在 nightly 规则外不受影响", !isSparkleVersionAtLeast("1.4.0-beta.3", "1.4.1", true));

check("裸 nightly 字符串（老构建 git describe 撞滚动 tag）按 nightly 放行", isSparkleVersionAtLeast("nightly", "1.4.1"));

console.log(`\n${failed ? `${failed} failed` : "all passed"}`);

process.exit(failed ? 1 : 0);
