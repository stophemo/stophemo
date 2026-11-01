import { readFileSync, writeFileSync } from "node:fs";

/**
 * 把主页 banner 上的两个数字换成 GitHub 上的实时数据。
 *
 *   PUBLIC REPOS  公开 + 非 fork + 自己拥有的仓库数
 *   OPEN ROUTES   自己名下仍然 open 的 issue + PR（还没走完的路线）
 *
 * SVG 里用 data-stat="repos" / data-stat="open" 标记占位元素，
 * README 里用 <!-- stats:start --> ... <!-- stats:end --> 标记文案块。
 * 两者都是幂等的：重复运行时只改标记内的值，其余内容原样保留。
 *
 * 只有在数字真的变化时才写文件，避免产生空提交。
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
const README_FILE = "README.md";

const query = `
  query FieldStats($login: String!) {
    user(login: $login) {
      repositories(privacy: PUBLIC, isFork: false, ownerAffiliations: OWNER, first: 1) {
        totalCount
      }
      pullRequests(states: OPEN, first: 1) { totalCount }
      issues(states: OPEN, first: 1) { totalCount }
      followers { totalCount }
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
  followers: account.followers.totalCount,
};

// ---- 更新三张 SVG 里的数字 ----

const touched = [];

for (const file of SVG_FILES) {
  const before = readFileSync(file, "utf8");
  let after = before;

  for (const [key, value] of Object.entries(stats)) {
    // 只替换带 data-stat 的元素内部文本，保留标签与属性（含 data-stat 本身）
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

// ---- 更新 README 里的文字版数字 ----

const readmeBefore = readFileSync(README_FILE, "utf8");

const statsBlock = `<!-- stats:start -->
公开仓库 **${stats.repos}** · 未完成路线 **${stats.open}** · 关注者 **${stats.followers}**
<!-- stats:end -->`;

let readmeAfter = readmeBefore.replace(
  /<!-- stats:start -->[\s\S]*?<!-- stats:end -->/,
  statsBlock,
);

if (!readmeAfter.includes("<!-- stats:end -->")) {
  throw new Error("README.md 里没有找到 <!-- stats:start --> / <!-- stats:end --> 标记。");
}

// 数字变了才换 ?v= 时间戳，让 GitHub 的图片代理（camo）重新取图。
// 数字没变就完全不动 URL，保证零提交。
const statsChanged =
  touched.length > 0 || readmeAfter !== readmeBefore;

if (statsChanged) {
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 12);
  readmeAfter = readmeAfter.replace(
    /(cdn\.jsdelivr\.net\/gh\/[^"'\s]+?)(\?v=[0-9A-Za-z]+)?(?=["'\s])/g,
    (_match, base) => `${base}?v=${stamp}`,
  );
}

if (readmeAfter !== readmeBefore) {
  writeFileSync(README_FILE, readmeAfter, "utf8");
  touched.push(README_FILE);
}

// ---- 报告 ----

console.log(
  `统计结果：公开仓库 ${stats.repos} · 未完成路线 ${stats.open} · 关注者 ${stats.followers}`,
);

if (touched.length === 0) {
  console.log("数字没有变化，不修改任何文件。");
} else {
  console.log(`已更新：${touched.join("、")}`);
}
