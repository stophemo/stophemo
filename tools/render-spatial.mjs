import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assetsDir = resolve(root, "assets");
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://127.0.0.1");
    const requestedPath = decodeURIComponent(url.pathname === "/" ? "/scene/index.html" : url.pathname);
    const filePath = resolve(root, `.${requestedPath}`);

    if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
      response.writeHead(403).end("Forbidden");
      return;
    }

    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error("Not a file");
    const body = await readFile(filePath);
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": contentTypes[extname(filePath)] || "application/octet-stream",
    });
    response.end(body);
  } catch {
    response.writeHead(404).end("Not found");
  }
});

const results = [];
let browser;

const captures = [
  {
    name: "desktop",
    output: resolve(assetsDir, "profile-spatial.png"),
    viewport: { width: 960, height: 560 },
  },
  {
    name: "mobile",
    output: resolve(assetsDir, "profile-spatial-mobile.png"),
    viewport: { width: 420, height: 760 },
  },
];

try {
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  browser = await chromium.launch({ headless: true });

  for (const capture of captures) {
    const context = await browser.newContext({
      deviceScaleFactor: 2,
      viewport: capture.viewport,
    });
    const page = await context.newPage();
    const errors = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));

    await page.goto(`http://127.0.0.1:${address.port}/scene/index.html?capture=1`, {
      waitUntil: "networkidle",
    });
    await page.waitForFunction(() => window.__sceneReady === true, null, { timeout: 20_000 });
    const report = await page.evaluate(() => window.__sceneReport());
    if (errors.length) {
      throw new Error(`${capture.name} 渲染报错：${errors.join("；")}`);
    }
    if (
      report.canvas[0] === 0
      || report.canvas[1] === 0
      || report.coverage.visible < 0.07
      || report.coverage.blue < 0.002
      || report.coverage.orange < 0.00008
    ) {
      throw new Error(`${capture.name} 画布像素检查失败：${JSON.stringify(report)}`);
    }

    await page.screenshot({ path: capture.output, type: "png" });
    results.push({ name: capture.name, output: capture.output, report });
    await context.close();
  }
} finally {
  const cleanup = [];
  if (browser) cleanup.push(browser.close());
  if (server.listening) {
    cleanup.push(new Promise((resolveClose) => server.close(resolveClose)));
  }
  await Promise.allSettled(cleanup);
}

for (const result of results) {
  console.log(`已渲染 ${result.name}：${result.output}`);
  console.log(`画布 ${result.report.canvas.join("x")}，${result.report.webgl}`);
  console.log(`像素覆盖 ${JSON.stringify(result.report.coverage)}`);
}
