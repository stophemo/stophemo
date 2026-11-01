import { readFileSync, writeFileSync } from "node:fs";

/**
 * 把主页 banner 上的两个数字换成 GitHub 上的实时数据。
 *
 *   PUBLIC REPOS  公开 + 非 fork + 自己拥有的仓库数
 *   OPEN ROUTES   自己名下仍然 open 的 issue + PR（还没走完的路线）
 *
 * SVG 里用 data-stat="repos" / data-stat="open" 标记占位元素。
 * 脚本只改标记元素内部的文本，其余内容原样保留，因此是幂等的：
 * 数字没变就一个字都不写，不会产生空提交。
 *
 * 图片地址的版本号由 pin-asset-version.mjs 负责，本脚本只管数字。
 */

const login = process.env.GITHUB_USER || process.env.GITHUB_REPOSITORY_OWNER;
const token = process.env.GITHUB_TOKEN;

if (!login) throw new Error("缺少 GITHUB_USER，无法确定要统计哪个账号。");
if (!token) throw new Error("缺少 GITHUB_TOKEN，无法访问 GitHub GraphQL。");

const SVG_FILES = [
  "assets/field-log.svg",
  "assets/field-log-mobile.svg",
  "assets/field-log-compact.svg",
];

const query = `
  query FieldStats($login: String!) {
    user(login: $login) {
      repositories(privacy: PUBLIC, isFork: false, ownerAffiliations: OWNER, first: 1) {
        totalCount
      }
      pullRequests(states: OPEN, first: 1) { totalCount }
      issues(states: OPEN, first: 1) { totalCount }
    }
  }
`;

const response = await fetch("https://api.github.com/graphql", {
  method: "POST",
  headers: {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "User-Agent": "stophemo-field-stats",
  },
  body: JSON.stringify({ query, variables: { login } }),
});

if (!response.ok) {
  throw new Error(`GitHub GraphQL 请求失败：${response.status} ${response.statusText}`);
}

const payload = await response.json();

if (payload.errors?.length) {
  throw new Error(`GitHub GraphQL 返回错误：${JSON.stringify(payload.errors)}`);
}

const account = payload.data?.user;
if (!account) throw new Error(`找不到账号 ${login}。`);

const stats = {
  repos: account.repositories.totalCount,
  open: account.pullRequests.totalCount + account.issues.totalCount,
};

const touched = [];

for (const file of SVG_FILES) {
  const before = readFileSync(file, "utf8");
  let after = before;

  for (const [key, value] of Object.entries(stats)) {
    // 补零到两位，保持 field log 的设计观感（06 而非 6）
    const padded = String(value).padStart(2, "0");
    const pattern = new RegExp(
      `<(text|tspan)([^>]*data-stat="${key}"[^>]*)>([^<]*)</\\1>`,
      "g",
    );
    after = after.replace(
      pattern,
      (_match, tag, attributes) => `<${tag}${attributes}>${padded}</${tag}>`,
    );
  }

  if (after !== before) {
    writeFileSync(file, after, "utf8");
    touched.push(file);
  }
}

console.log(`统计结果：公开仓库 ${stats.repos} · 未完成路线 ${stats.open}`);

if (touched.length === 0) {
  console.log("数字没有变化，不修改任何文件。");
} else {
  console.log(`已更新：${touched.join("、")}`);
}
