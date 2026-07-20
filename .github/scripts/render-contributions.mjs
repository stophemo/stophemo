import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const userName = process.env.GITHUB_USER || process.env.GITHUB_REPOSITORY_OWNER;
const token = process.env.GITHUB_TOKEN;

if (!userName || !token) {
  throw new Error("缺少 GITHUB_USER 或 GITHUB_TOKEN，无法读取贡献记录。");
}

const to = new Date();
to.setUTCHours(23, 59, 59, 999);

const from = new Date(to);
from.setUTCDate(from.getUTCDate() - 364);
from.setUTCHours(0, 0, 0, 0);

const query = `
  query ContributionCalendar($login: String!, $from: DateTime!, $to: DateTime!) {
    user(login: $login) {
      contributionsCollection(from: $from, to: $to) {
        contributionCalendar {
          totalContributions
          weeks {
            contributionDays {
              contributionCount
              contributionLevel
              date
              weekday
            }
          }
        }
      }
    }
  }
`;

const response = await fetch("https://api.github.com/graphql", {
  method: "POST",
  headers: {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "User-Agent": "stophemo-profile-contribution-renderer",
  },
  body: JSON.stringify({
    query,
    variables: {
      login: userName,
      from: from.toISOString(),
      to: to.toISOString(),
    },
  }),
});

if (!response.ok) {
  throw new Error(`GitHub GraphQL 请求失败：${response.status} ${response.statusText}`);
}

const payload = await response.json();

if (payload.errors?.length) {
  throw new Error(`GitHub GraphQL 返回错误：${payload.errors.map(({ message }) => message).join("；")}`);
}

const calendar = payload.data?.user?.contributionsCollection?.contributionCalendar;

if (!calendar) {
  throw new Error(`没有找到 ${userName} 的贡献记录。`);
}

const weeks = calendar.weeks.slice(-53);
const days = weeks.flatMap(({ contributionDays }) => contributionDays);
const activeDays = days.filter(({ contributionCount }) => contributionCount > 0).length;
const latestDate = days.reduce((latest, { date }) => date > latest ? date : latest, "");
const generatedDate = to.toISOString().slice(0, 10);

const colors = {
  NONE: "#191B1E",
  FIRST_QUARTILE: "#2B452D",
  SECOND_QUARTILE: "#54742B",
  THIRD_QUARTILE: "#91B52E",
  FOURTH_QUARTILE: "#D7FF3F",
};

const monthNames = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function number(value) {
  return Number(value.toFixed(2));
}

function getMonthLabels() {
  const labels = [];

  weeks.forEach(({ contributionDays }, column) => {
    const firstDay = contributionDays.find(({ date }) => date.endsWith("-01"));
    if (firstDay) {
      labels.push({ column, label: monthNames[Number(firstDay.date.slice(5, 7)) - 1] });
    }
  });

  if (!labels.length || labels[0].column > 2) {
    const firstDate = weeks[0]?.contributionDays[0]?.date;
    if (firstDate) {
      labels.unshift({ column: 0, label: monthNames[Number(firstDate.slice(5, 7)) - 1] });
    }
  }

  return labels;
}

function renderCells(layout) {
  const weekPitch = layout.gridWidth / Math.max(53, weeks.length);
  const cells = [];
  let currentCell = "";

  weeks.forEach(({ contributionDays }, column) => {
    contributionDays.forEach((day) => {
      const x = number(layout.gridX + column * weekPitch);
      const y = number(layout.gridY + day.weekday * layout.rowPitch);
      const peakClass = day.contributionLevel === "FOURTH_QUARTILE"
        ? ` peak phase-${(column + day.weekday) % 4}`
        : "";

      cells.push(
        `      <rect class="cell${peakClass}" x="${x}" y="${y}" width="${layout.cellWidth}" height="${layout.cellHeight}" fill="${colors[day.contributionLevel] || colors.NONE}"/>`,
      );

      if (day.date === latestDate) {
        currentCell = `      <rect class="current" x="${number(x - 2)}" y="${number(y - 2)}" width="${layout.cellWidth + 4}" height="${layout.cellHeight + 4}" fill="none" stroke="#FF4F5E" stroke-width="2"/>`;
      }
    });
  });

  return `${cells.join("\n")}\n${currentCell}`;
}

function renderMonths(layout) {
  const weekPitch = layout.gridWidth / Math.max(53, weeks.length);

  return getMonthLabels()
    .map(({ column, label }) => `    <text x="${number(layout.gridX + column * weekPitch)}" y="${layout.monthY}" class="mono month">${label}</text>`)
    .join("\n");
}

function renderSvg(layout) {
  const scanStart = layout.gridX - 44;
  const scanDistance = layout.gridWidth + 66;
  const graphBottom = layout.gridY + layout.rowPitch * 6 + layout.cellHeight;
  const cells = renderCells(layout);
  const months = renderMonths(layout);
  const total = calendar.totalContributions.toLocaleString("en-US");
  const description = `${userName} 过去 365 天共有 ${calendar.totalContributions} 次贡献，分布在 ${activeDays} 个活跃日。`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     width="${layout.width}"
     height="${layout.height}"
     viewBox="0 0 ${layout.width} ${layout.height}"
     role="img"
     aria-labelledby="trace-title trace-desc"
     focusable="false">
  <title id="trace-title">${escapeXml(userName)} 的 GitHub 贡献轨迹</title>
  <desc id="trace-desc">${escapeXml(description)}</desc>

  <style>
    .mono {
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
      letter-spacing: 0;
    }

    .cell { shape-rendering: crispEdges; }
    .month { fill: #747A81; font-size: 10px; font-weight: 700; }
    .scan { animation: scan 8s cubic-bezier(.45, 0, .55, 1) infinite; }
    .peak { animation: peak 3.2s ease-in-out infinite; }
    .phase-1 { animation-delay: -.8s; }
    .phase-2 { animation-delay: -1.6s; }
    .phase-3 { animation-delay: -2.4s; }
    .current { animation: current 1.8s steps(2, end) infinite; }
    .live { animation: live 2.4s steps(2, end) infinite; }

    @keyframes scan {
      from { transform: translateX(0); }
      to { transform: translateX(${number(scanDistance)}px); }
    }

    @keyframes peak {
      0%, 100% { opacity: 1; }
      50% { opacity: .52; }
    }

    @keyframes current {
      0%, 62% { opacity: 1; }
      63%, 100% { opacity: .25; }
    }

    @keyframes live {
      0%, 74% { opacity: 1; }
      75%, 100% { opacity: .28; }
    }

    @media (prefers-reduced-motion: reduce) {
      .scan,
      .peak,
      .current,
      .live { animation: none !important; }

      .scan { display: none; }
      .peak,
      .current,
      .live { opacity: 1; }
    }
  </style>

  <defs>
    <clipPath id="grid-clip">
      <rect x="${layout.gridX}" y="${layout.gridY}" width="${layout.gridWidth}" height="${number(graphBottom - layout.gridY)}"/>
    </clipPath>
  </defs>

  <rect width="${layout.width}" height="${layout.height}" fill="#090A0B"/>
  <rect width="${layout.width}" height="6" fill="#D7FF3F"/>
  ${layout.frame}

  <g class="mono">
    ${layout.header(total, activeDays)}
${months}
    <g aria-hidden="true">
${cells}
    </g>
    ${layout.footer(generatedDate)}
  </g>

  <g clip-path="url(#grid-clip)" aria-hidden="true">
    <g class="scan">
      <rect x="${scanStart}" y="${layout.gridY}" width="44" height="${number(graphBottom - layout.gridY)}" fill="#27D7F2" opacity=".14"/>
      <path d="M${number(scanStart + 33)} ${layout.gridY}V${graphBottom}" stroke="#27D7F2" opacity=".35"/>
      <path d="M${number(scanStart + 43)} ${layout.gridY}V${graphBottom}" stroke="#27D7F2" stroke-width="2"/>
    </g>
  </g>
</svg>
`;
}

const desktop = {
  width: 960,
  height: 220,
  gridX: 232,
  gridY: 52,
  gridWidth: 700,
  rowPitch: 20,
  cellWidth: 9,
  cellHeight: 14,
  monthY: 38,
  frame: `<rect x="8" y="6" width="184" height="214" fill="#121315"/>
  <path d="M192 6V220" stroke="#34373B"/>
  <path d="M216 192H936" stroke="#25282C"/>`,
  header: (total, active) => `<text x="28" y="40" fill="#F4F2EA" font-size="13" font-weight="800">COMMIT</text>
    <text x="28" y="78" fill="#F4F2EA" font-size="36" font-weight="800">TRACE</text>
    <rect x="28" y="90" width="93" height="5" fill="#D7FF3F"/>
    <rect x="127" y="90" width="24" height="5" fill="#27D7F2"/>
    <text x="28" y="126" fill="#747A81" font-size="9" font-weight="700">TOTAL</text>
    <text x="28" y="151" fill="#F4F2EA" font-size="22" font-weight="800">${total}</text>
    <text x="110" y="126" fill="#747A81" font-size="9" font-weight="700">ACTIVE</text>
    <text x="110" y="151" fill="#27D7F2" font-size="22" font-weight="800">${active}</text>
    <rect class="live" x="28" y="181" width="7" height="7" fill="#D7FF3F"/>
    <text x="44" y="188" fill="#D7FF3F" font-size="9" font-weight="700">DAILY SYNC</text>`,
  footer: (date) => `<text x="216" y="209" fill="#747A81" font-size="9" font-weight="700">365 DAYS</text>
    <text x="797" y="209" fill="#747A81" font-size="9" font-weight="700">UPDATED / ${date}</text>
    <g transform="translate(676 201)" aria-hidden="true">
      <rect width="8" height="8" fill="#191B1E"/>
      <rect x="13" width="8" height="8" fill="#2B452D"/>
      <rect x="26" width="8" height="8" fill="#54742B"/>
      <rect x="39" width="8" height="8" fill="#91B52E"/>
      <rect x="52" width="8" height="8" fill="#D7FF3F"/>
    </g>`,
};

const mobile = {
  width: 720,
  height: 300,
  gridX: 24,
  gridY: 126,
  gridWidth: 672,
  rowPitch: 18,
  cellWidth: 9,
  cellHeight: 12,
  monthY: 109,
  frame: `<rect y="6" width="720" height="80" fill="#121315"/>
  <path d="M0 86H720" stroke="#34373B"/>
  <path d="M24 269H696" stroke="#25282C"/>`,
  header: (total, active) => `<text x="24" y="38" fill="#F4F2EA" font-size="14" font-weight="800">COMMIT</text>
    <text x="24" y="69" fill="#F4F2EA" font-size="29" font-weight="800">TRACE</text>
    <rect x="154" y="61" width="70" height="5" fill="#D7FF3F"/>
    <rect x="230" y="61" width="21" height="5" fill="#27D7F2"/>
    <text x="413" y="31" fill="#747A81" font-size="9" font-weight="700">TOTAL</text>
    <text x="413" y="60" fill="#F4F2EA" font-size="23" font-weight="800">${total}</text>
    <text x="552" y="31" fill="#747A81" font-size="9" font-weight="700">ACTIVE</text>
    <text x="552" y="60" fill="#27D7F2" font-size="23" font-weight="800">${active}</text>
    <rect class="live" x="646" y="28" width="7" height="7" fill="#D7FF3F"/>
    <text x="662" y="35" fill="#D7FF3F" font-size="9" font-weight="700">SYNC</text>`,
  footer: (date) => `<text x="24" y="288" fill="#747A81" font-size="9" font-weight="700">365 DAYS</text>
    <text x="555" y="288" fill="#747A81" font-size="9" font-weight="700">${date}</text>
    <g transform="translate(449 280)" aria-hidden="true">
      <rect width="8" height="8" fill="#191B1E"/>
      <rect x="13" width="8" height="8" fill="#2B452D"/>
      <rect x="26" width="8" height="8" fill="#54742B"/>
      <rect x="39" width="8" height="8" fill="#91B52E"/>
      <rect x="52" width="8" height="8" fill="#D7FF3F"/>
    </g>`,
};

const outputs = [
  ["assets/contributions.svg", renderSvg(desktop)],
  ["assets/contributions-mobile.svg", renderSvg(mobile)],
];

for (const [fileName, contents] of outputs) {
  const outputPath = resolve(fileName);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, contents, "utf8");
}

console.log(`已生成 ${userName} 的贡献轨迹：${calendar.totalContributions} 次贡献，${activeDays} 个活跃日。`);
