import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

/**
 * 把 README 里 jsDelivr 的分支引用（@main）换成具体提交 SHA。
 *
 * 为什么需要这一步：
 *   jsDelivr 对 @main 这类分支引用会缓存"分支 → 提交"的解析结果，
 *   README 改了图之后它可能在几小时内仍然返回旧文件，
 *   而 GitHub 还会再用 camo 代理按完整 URL 缓存一层。
 *   换成不可变的提交 SHA 之后：内容不变则 URL 不变（缓存有效），
 *   内容一变则 URL 必变（自动穿透两层缓存），不需要依赖 purge 接口。
 *
 * 取的是"最后一次改动这三张 SVG 的提交"，因此指向的版本一定包含当前图片。
 */

const ASSETS = [
  "assets/field-log.svg",
  "assets/field-log-mobile.svg",
  "assets/field-log-compact.svg",
];
const README = "README.md";

const sha = execSync(`git log -1 --format=%H -- ${ASSETS.join(" ")}`, {
  encoding: "utf8",
}).trim();

if (!/^[0-9a-f]{40}$/.test(sha)) {
  throw new Error(`无法确定资源版本提交：${JSON.stringify(sha)}`);
}

const before = readFileSync(README, "utf8");
const after = before.replace(
  /(cdn\.jsdelivr\.net\/gh\/[^"'\s@]+@)([^/"'\s?]+)/g,
  (_match, prefix) => prefix + sha,
);

if (after !== before) {
  writeFileSync(README, after, "utf8");
  console.log(`README 里的图片地址已钉到 ${sha.slice(0, 12)}`);
} else {
  console.log(`图片地址已是最新版本 ${sha.slice(0, 12)}，无需改动`);
}
