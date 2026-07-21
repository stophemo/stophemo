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
              date
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
    "User-Agent": "stophemo-profile-atlas-renderer",
  },
  body: JSON.stringify({
    query,
    variables: {
      login: userName,
      from: from.toISOString(),
      to: to.toISOString(),
    },
  }),
  signal: AbortSignal.timeout(20_000),
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

if (!weeks.length) {
  throw new Error(`${userName} 的贡献日历没有返回周数据。`);
}

const days = weeks.flatMap(({ contributionDays }) => contributionDays);
const weeklyTotals = weeks.map(({ contributionDays }) => (
  contributionDays.reduce((sum, { contributionCount }) => sum + contributionCount, 0)
));
const activeDays = days.filter(({ contributionCount }) => contributionCount > 0).length;
const latestDate = days.reduce((latest, { date }) => date > latest ? date : latest, "");
const latestWeek = weeks.findIndex(({ contributionDays }) => (
  contributionDays.some(({ date }) => date === latestDate)
));
const generatedDate = to.toISOString().slice(0, 10);
const maxWeekly = Math.max(...weeklyTotals, 1);

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

  if (!labels.length || labels[0].column > 3) {
    const firstDate = weeks[0]?.contributionDays[0]?.date;
    if (firstDate) {
      labels.unshift({ column: 0, label: monthNames[Number(firstDate.slice(5, 7)) - 1] });
    }
  }

  return labels;
}

function pointLevel(value) {
  if (value === 0) return "level-none";
  const ratio = value / maxWeekly;
  if (ratio <= 0.25) return "level-one";
  if (ratio <= 0.5) return "level-two";
  if (ratio <= 0.75) return "level-three";
  return "level-four";
}

function renderGrid(layout) {
  return [0, 0.33, 0.66, 1]
    .map((ratio) => {
      const y = number(layout.chartY + layout.chartHeight * ratio);
      return `    <path d="M${layout.chartX} ${y}H${layout.chartX + layout.chartWidth}" stroke="#15191D" opacity=".1"/>`;
    })
    .join("\n");
}

function getSignalPoints(layout) {
  const pitch = layout.chartWidth / Math.max(1, weeks.length - 1);
  const logMax = Math.log1p(maxWeekly);

  return weeklyTotals.map((total, index) => ({
    total,
    x: number(layout.chartX + index * pitch),
    y: number(layout.chartY + layout.chartHeight - (Math.log1p(total) / logMax) * layout.chartHeight),
  }));
}

function renderSignal(layout) {
  const points = getSignalPoints(layout);
  const line = points
    .map(({ x, y }, index) => `${index === 0 ? "M" : "L"}${x} ${y}`)
    .join(" ");
  const baseline = layout.chartY + layout.chartHeight;
  const area = `${line} L${points.at(-1).x} ${baseline} L${points[0].x} ${baseline}Z`;

  const nodes = points.map(({ total, x, y }, index) => {
    const level = pointLevel(total);
    const phase = level === "level-four" ? ` phase-${index % 4}` : "";
    const radius = total === 0 ? layout.emptyRadius : layout.pointRadius;
    return `    <circle class="signal-point ${level}${phase}" cx="${x}" cy="${y}" r="${radius}"/>`;
  }).join("\n");

  const current = latestWeek >= 0
    ? `    <circle class="current-ring" cx="${points[latestWeek].x}" cy="${points[latestWeek].y}" r="${layout.currentRadius}" fill="none" stroke="#15191D" stroke-width="1.5"/>`
    : "";

  return `    <path d="${area}" fill="#15191D" opacity=".05"/>
    <path class="signal-line" d="${line}" fill="none" stroke="#15191D" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
${nodes}
${current}`;
}

function renderMonths(layout) {
  const pitch = layout.chartWidth / Math.max(1, weeks.length - 1);

  return getMonthLabels()
    .map(({ column, label }) => (
      `    <text x="${number(layout.chartX + column * pitch)}" y="${layout.monthY}" class="mono month">${label}</text>`
    ))
    .join("\n");
}

function renderSvg(layout) {
  const total = calendar.totalContributions.toLocaleString("en-US");
  const description = `${userName} 过去 365 天共有 ${calendar.totalContributions} 次贡献，分布在 ${activeDays} 个活跃日。折线按周聚合，每个点代表一周，颜色与高度从低到高表示活跃程度。`;
  const scanDistance = layout.chartWidth;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     width="${layout.width}"
     height="${layout.height}"
     viewBox="0 0 ${layout.width} ${layout.height}"
     role="img"
     aria-labelledby="trace-title trace-desc"
     focusable="false">
  <title id="trace-title">${escapeXml(userName)} 的 GitHub 贡献信号轨迹</title>
  <desc id="trace-desc">${escapeXml(description)}</desc>

  <style>
    .sans {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
      letter-spacing: 0;
    }

    .mono {
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
      letter-spacing: 0;
    }

    .month { fill: #697174; font-size: ${layout.monthSize}px; font-weight: 700; }
    .signal-point { stroke: #F5F5F0; stroke-width: 1.5; }
    .level-none { fill: #BFC3BF; }
    .level-one { fill: #1D9CB0; }
    .level-two { fill: #7568C8; }
    .level-three { fill: #F25F4B; }
    .level-four { fill: #D4DE3F; stroke: #15191D; }
    .signal-line { animation: draw-signal 12s ease-in-out infinite alternate; }
    .signal-cursor { animation: scan ${layout.scanSeconds}s linear infinite; }
    .level-four { animation: peak 4s ease-in-out infinite; }
    .phase-1 { animation-delay: -1s; }
    .phase-2 { animation-delay: -2s; }
    .phase-3 { animation-delay: -3s; }
    .current-ring { animation: current 2.4s ease-out infinite; transform-box: fill-box; transform-origin: center; }

    @keyframes draw-signal {
      0%, 8% { stroke-dasharray: 1800; stroke-dashoffset: 1800; }
      72%, 100% { stroke-dasharray: 1800; stroke-dashoffset: 0; }
    }

    @keyframes scan {
      from { transform: translateX(0); }
      to { transform: translateX(${number(scanDistance)}px); }
    }

    @keyframes peak {
      0%, 100% { opacity: 1; }
      50% { opacity: .55; }
    }

    @keyframes current {
      0% { opacity: .75; transform: scale(.75); }
      80%, 100% { opacity: 0; transform: scale(1.7); }
    }

    @media (prefers-reduced-motion: reduce) {
      .signal-line,
      .signal-cursor,
      .level-four,
      .current-ring { animation: none !important; }

      .signal-line { stroke-dasharray: none; stroke-dashoffset: 0; }
      .signal-cursor { display: none; }
      .level-four,
      .current-ring { opacity: 1; }
    }
  </style>

  <defs>
    <clipPath id="signal-clip">
      <rect x="${layout.chartX}" y="${layout.chartY - 8}" width="${layout.chartWidth}" height="${layout.chartHeight + 16}"/>
    </clipPath>
  </defs>

  <rect width="${layout.width}" height="${layout.height}" fill="#F5F5F0"/>
  <rect width="${number(layout.width * .37)}" height="7" fill="#F25F4B"/>
  <rect x="${number(layout.width * .37)}" width="${number(layout.width * .31)}" height="7" fill="#1D9CB0"/>
  <rect x="${number(layout.width * .68)}" width="${number(layout.width * .32)}" height="7" fill="#7568C8"/>

  ${layout.frame}

  <g class="sans">
    ${layout.header(total, activeDays, generatedDate, weeks.length)}
  </g>

  <g aria-hidden="true">
${renderGrid(layout)}
  </g>

  <g clip-path="url(#signal-clip)" aria-hidden="true">
${renderSignal(layout)}
    <g class="signal-cursor">
      <path d="M${layout.chartX} ${layout.chartY - 6}V${layout.chartY + layout.chartHeight + 6}" stroke="#D4DE3F" stroke-width="2"/>
      <circle cx="${layout.chartX}" cy="${layout.chartY - 6}" r="3" fill="#D4DE3F" stroke="#15191D"/>
    </g>
  </g>

${renderMonths(layout)}
  ${layout.footer(generatedDate)}
</svg>
`;
}

const desktop = {
  width: 960,
  height: 230,
  chartX: 220,
  chartY: 69,
  chartWidth: 710,
  chartHeight: 98,
  monthY: 190,
  monthSize: 9,
  emptyRadius: 2,
  pointRadius: 4,
  currentRadius: 9,
  scanSeconds: 13,
  frame: `<path d="M196 7V230" stroke="#15191D" opacity=".18"/>
  <path d="M220 205H930" stroke="#15191D" opacity=".18"/>`,
  header: (total, active, date, weekCount) => `<text x="32" y="47" fill="#15191D" font-size="30" font-weight="850">TRACES</text>
    <text x="32" y="72" fill="#697174" font-size="11" font-weight="700">365 DAYS / WEEKLY SIGNAL</text>
    <text x="32" y="126" fill="#15191D" font-size="34" font-weight="850">${total}</text>
    <text x="32" y="148" fill="#697174" font-size="10" font-weight="700">CONTRIBUTIONS</text>
    <circle cx="35" cy="183" r="4" fill="#D4DE3F" stroke="#15191D"/>
    <text x="48" y="187" fill="#15191D" font-size="11" font-weight="700">${active} ACTIVE DAYS</text>
    <text x="220" y="34" fill="#15191D" font-size="12" font-weight="750">CONTRIBUTION SIGNAL / ${weekCount} WEEKS / LOW &gt; HIGH</text>
    <text x="930" y="34" fill="#697174" font-size="9" font-weight="700" text-anchor="end">UPDATED / ${date}</text>`,
  footer: (date) => `<g class="mono" fill="#697174" font-size="9" font-weight="700">
    <text x="220" y="219">SMALL COMMITS, A GROWING MAP.</text>
    <text x="930" y="219" text-anchor="end">${date}</text>
  </g>`,
};

const mobile = {
  width: 420,
  height: 310,
  chartX: 24,
  chartY: 119,
  chartWidth: 372,
  chartHeight: 100,
  monthY: 241,
  monthSize: 8,
  emptyRadius: 1.7,
  pointRadius: 3.3,
  currentRadius: 7,
  scanSeconds: 11,
  frame: `<path d="M24 91H396" stroke="#15191D" opacity=".18"/>
  <path d="M24 260H396" stroke="#15191D" opacity=".18"/>`,
  header: (total, active, date, weekCount) => `<text x="24" y="45" fill="#15191D" font-size="27" font-weight="850">TRACES</text>
    <text x="24" y="68" fill="#697174" font-size="9" font-weight="700">365 DAYS / WEEKLY SIGNAL</text>
    <text x="250" y="46" fill="#15191D" font-size="25" font-weight="850">${total}</text>
    <text x="250" y="67" fill="#697174" font-size="9" font-weight="700">CONTRIBUTIONS</text>
    <circle cx="350" cy="42" r="4" fill="#D4DE3F" stroke="#15191D"/>
    <text x="363" y="46" fill="#15191D" font-size="9" font-weight="700">${active}</text>
    <text x="396" y="68" fill="#697174" font-size="8" font-weight="700" text-anchor="end">ACTIVE DAYS</text>
    <text x="24" y="106" fill="#15191D" font-size="9" font-weight="750">WEEKLY SIGNAL / ${weekCount} / LOW &gt; HIGH</text>
    <text x="396" y="106" fill="#697174" font-size="8" font-weight="700" text-anchor="end">${date}</text>`,
  footer: (date) => `<g class="mono" fill="#697174" font-size="8" font-weight="700">
    <text x="24" y="286">SMALL COMMITS, A GROWING MAP.</text>
    <text x="396" y="286" text-anchor="end">${date}</text>
  </g>`,
};

const outputs = [
  ["assets/atlas-trace.svg", renderSvg(desktop)],
  ["assets/atlas-trace-mobile.svg", renderSvg(mobile)],
];

for (const [fileName, contents] of outputs) {
  const outputPath = resolve(fileName);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, contents, "utf8");
}

console.log(`已生成 ${userName} 的开放探索轨迹：${calendar.totalContributions} 次贡献，${activeDays} 个活跃日。`);
