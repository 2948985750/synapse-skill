"use strict";
// discover.js 纯函数单测（浏览器无关）。真浏览器的发现流程归 live 测试管，
// 这里锁住的是守卫逻辑：危险词、同源、URL 归一、入队挑选、预算、draft 骨架。
const test = require("node:test");
const assert = require("node:assert/strict");
const { isInside } = require("../agent/paths");
const {
  isDangerousLabel,
  normalizeUrl,
  sameOriginGuard,
  SKIP_URL_RE,
  FILE_URL_RE,
  clusterByPathPrefix,
  pickEnqueueLinks,
  createBudget,
  buildDraftSkeleton,
  buildSnapshot,
  pruneStructure,
  pruneCapture,
  shapeOutline,
  shapeClickables,
} = require("../runner/discover");

test("isDangerousLabel: CJK includes, ASCII word-boundary, false positives stay null", () => {
  assert.equal(isDangerousLabel("删除账户"), "删除");
  assert.equal(isDangerousLabel("退出登录"), "退出登录");
  assert.equal(isDangerousLabel("Delete Account"), "delete");
  assert.equal(isDangerousLabel("Pay Now"), "pay now");
  assert.equal(isDangerousLabel("Sign Out"), "sign out");
  // 词边界：remove 不该命中 remover / paymented
  assert.equal(isDangerousLabel("remover tool"), null);
  assert.equal(isDangerousLabel("search jobs"), null);
  assert.equal(isDangerousLabel("登录"), null);
  assert.equal(isDangerousLabel(""), null);
});

test("normalizeUrl: strips hash, keeps query, rejects non-http", () => {
  assert.equal(normalizeUrl("https://a.com/x?y=1#frag"), "https://a.com/x?y=1");
  assert.equal(normalizeUrl("https://a.com"), "https://a.com/");
  assert.equal(normalizeUrl("javascript:void(0)"), null);
  assert.equal(normalizeUrl("mailto:a@b.c"), null);
  assert.equal(normalizeUrl("not a url"), null);
});

test("sameOriginGuard: same ok, cross/subdomain/invalid rejected", () => {
  const o = "https://www.upwork.com";
  assert.equal(sameOriginGuard("https://www.upwork.com/nx/search", o).ok, true);
  assert.equal(sameOriginGuard("https://evil.com/x", o).reason, "cross-origin");
  assert.equal(sameOriginGuard("https://sub.upwork.com/x", o).reason, "cross-origin");
  assert.equal(sameOriginGuard("::::", o).reason, "invalid-url");
});

test("SKIP_URL_RE blocks auth walls, FILE_URL_RE blocks assets but not path words", () => {
  assert.ok(SKIP_URL_RE.test("https://a.com/login?next=/x"));
  assert.ok(SKIP_URL_RE.test("https://a.com/nx/signup"));
  assert.ok(!SKIP_URL_RE.test("https://a.com/nx/search/jobs/"));
  assert.ok(FILE_URL_RE.test("https://a.com/doc.pdf"));
  assert.ok(FILE_URL_RE.test("https://a.com/photo.jpg?w=100"));
  assert.ok(!FILE_URL_RE.test("https://a.com/pdf-viewer"));
});

test("pickEnqueueLinks: same-origin only, skips auth/assets/visited, shallow first, capped", () => {
  const origin = "https://a.com";
  const visited = new Set(["https://a.com/seen"]);
  const links = [
    { href: "https://a.com/deep/a/b/c/d", text: "deep" },
    { href: "https://a.com/jobs?x=1#top", text: "jobs" },
    { href: "https://b.com/other", text: "cross" },
    { href: "https://a.com/login", text: "login" },
    { href: "https://a.com/doc.pdf", text: "pdf" },
    { href: "https://a.com/seen", text: "seen" },
    { href: "javascript:void(0)", text: "js" },
  ];
  const { enqueued, filtered } = pickEnqueueLinks(links, {
    origin, maxLinks: 1, visited, depth: 0, maxDepth: 2,
  });
  // 浅路径优先且 maxLinks=1：只留 /jobs?x=1（hash 已去）
  assert.deepEqual(enqueued, [{ url: "https://a.com/jobs?x=1", depth: 1, text: "jobs" }]);
  assert.equal(filtered, 3); // cross + login + pdf

  // 深度到顶后不再入队
  const none = pickEnqueueLinks(links, { origin, maxLinks: 5, visited: new Set(), depth: 2, maxDepth: 2 });
  assert.deepEqual(none.enqueued, []);
});

test("clusterByPathPrefix groups by first 2 path segments", () => {
  const c = clusterByPathPrefix([
    "https://a.com/jobs/1", "https://a.com/jobs/2", "https://a.com/feed",
  ]);
  assert.equal(c["/jobs"].length, 2);
  assert.deepEqual(c["/feed"], ["https://a.com/feed"]);
});

test("createBudget: page quota counts, time starts near zero", () => {
  const b = createBudget({ maxPages: 2, maxDurationMs: 60000, minGapMs: 1 });
  assert.equal(b.outOfPages(), false);
  b.spendPage();
  b.spendPage();
  assert.equal(b.outOfPages(), true);
  assert.ok(b.elapsedMs() < 1000);
  assert.equal(b.outOfTime(), false);
});

test("shapeOutline: dedup with count, drops empties, caps and keeps first-seen order", () => {
  const raw = [
    { sig: "A.nav#home", text: "首页", interactive: true, href: "https://a.com/" },
    { sig: "A.nav#jobs", text: "职位", interactive: true, href: "https://a.com/jobs" },
    { sig: "A.nav#home", text: "首页", interactive: true, href: "https://a.com/" },
    { sig: "H1.title", text: "  找工作\n平台  ", interactive: false },
    { sig: "DIV.card", text: "", interactive: false }, // 空文本丢弃
    null, // 非对象丢弃
    { sig: "DIV.hot", text: "热榜", interactive: false, cursorPointer: true },
  ];
  const out = shapeOutline(raw);
  assert.equal(out.length, 4);
  assert.deepEqual(
    out.map((i) => i.text),
    ["首页", "职位", "找工作 平台", "热榜"], // 换行空白归一
  );
  assert.equal(out[0].count, 2); // 同签名同文本合并计次
  assert.equal(out[0].href, "https://a.com/");
  assert.equal(out[3].cursorPointer, true);
  assert.equal("cursorPointer" in out[2], false);

  // max 截断：先见者优先
  const capped = shapeOutline(raw, { max: 2 });
  assert.equal(capped.length, 2);
  assert.equal(capped[0].text, "首页");
});

test("shapeClickables: dedup, drops empties, caps, keeps href", () => {
  const raw = [
    { sig: "DIV.job-card", text: "Senior Engineer  $50/hr", href: "https://a.com/jobs/1" },
    { sig: "DIV.job-card", text: "Product Designer $30/hr" }, // 不同文本不合并
    { sig: "DIV.job-card", text: "Senior Engineer $50/hr", href: "https://a.com/jobs/1" }, // 空白归一后与前一条同键 → 去重
    { sig: "DIV.banner", text: "" }, // 空文本丢弃
    null,
  ];
  const out = shapeClickables(raw);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((i) => i.sig), ["DIV.job-card", "DIV.job-card"]);
  assert.deepEqual(out.map((i) => i.text), ["Senior Engineer $50/hr", "Product Designer $30/hr"]);
  assert.equal(out[0].href, "https://a.com/jobs/1"); // 可点容器的跳转地址随条目保留
  assert.ok(!("href" in out[1]));
  assert.equal(shapeClickables(raw, { max: 1 }).length, 1);
  assert.deepEqual(shapeClickables("nope"), []);
});

test("isInside: containment guard rejects escape and cross-drive, accepts equal and nested", () => {
  const root = "D:\\repo\\profiles";
  assert.equal(isInside(root, "D:\\repo\\profiles\\draft\\a.json"), true);
  assert.equal(isInside(root, "D:\\repo\\profiles"), true); // 等于锚本身允许
  assert.equal(isInside(root, "D:\\repo\\profiles-other\\a.json"), false); // 前缀相同不是包含
  assert.equal(isInside(root, "D:\\repo\\a.json"), false);
  assert.equal(isInside(root, "D:\\elsewhere\\a.json"), false); // 跨根
  assert.equal(isInside("C:\\data", "D:\\data\\x.json"), false); // 跨盘符
  // ".." 逃逸：path.relative 先归一再判包含，profiles\..\secret.json == repo\secret.json
  assert.equal(isInside(root, "D:\\repo\\profiles\\..\\secret.json"), false);
  assert.equal(isInside(root, "D:\\repo\\profiles\\draft\\..\\x.json"), true); // 归一后仍在锚内
});

test("buildDraftSkeleton: knowledge draft with embedded snapshot (no code fields)", () => {
  const snapshot = {
    capturedAt: "2026-10-26T00:00:00.000Z",
    chrome: { outline: [], clickables: [] },
    pages: [{ url: "https://a.com/", outline: [], clickables: [] }],
    skipped: [{ url: "https://b.com/", reason: "cross-origin" }],
  };
  const d = buildDraftSkeleton({
    domain: "a.com",
    entry: "https://a.com/",
    visited: ["https://a.com/"],
    observations: { loginRequired: false, limits: { pagesVisited: 1 } },
    snapshot,
  });
  assert.equal(d.schemaVersion, 3); // 纯数据版：recipes/replay 已不存在
  assert.equal(d.status, "draft");
  assert.ok(!("recipes" in d) && !("replay" in d), "画像不得含采集代码字段");
  assert.deepEqual(d.fieldMap, {});
  assert.equal(d.pageNotes, "");
  // 采集快照进画像（无独立材料包）
  assert.equal(d.snapshot, snapshot);
  assert.equal(d.discovery.visitedCount, 1);
  assert.equal(d.discovery.skippedCount, 1);
  assert.ok(!("report" in d.discovery), "discovery 块不得残留材料包路径");
});

test("buildSnapshot: 只留可交互元素，跨页框架归并 chrome，links/controls 不入画像", () => {
  const mk = (url, extra = []) => ({
    url, depth: 1, requestedAt: "t", title: "", finalUrl: url, loginWall: false,
    enqueued: [], structure: { lists: [], forms: [], passwordFields: 0 },
    dangerous: [], links: [{ href: "https://a.com/x" }], controls: [{ i: 0 }],
    outline: [
      { sig: "A", text: "首页", interactive: true },
      { sig: "H1", text: "标题", interactive: false },
      ...extra,
    ],
    clickables: [{ sig: "DIV.card", text: "卡片" }],
    capture: null,
  });
  const pages = [mk("https://a.com/1"), mk("https://a.com/2"), mk("https://a.com/3")];
  const snap = buildSnapshot(pages, { origin: "https://a.com", skipped: [] });
  // 纯文本元素被筛掉；交互元素保留（本页只有被归并的"首页"）
  assert.deepEqual(snap.pages[0].outline, []);
  // "A|首页" 与 clickables 在 3 页都出现 → 归并进 chrome
  assert.equal(snap.chrome.outline.length, 1);
  assert.equal(snap.chrome.outline[0].text, "首页");
  assert.equal(snap.chrome.outline[0].pages, 3);
  assert.equal(snap.chrome.clickables.length, 1);
  assert.equal(snap.pages[0].outline.length, 0);
  assert.equal(snap.pages[0].clickables.length, 0);
  // 中间量不入画像
  assert.ok(!("links" in snap.pages[0]) && !("controls" in snap.pages[0]));
});

test("buildSnapshot: 未达 chrome 阈值的交互元素保留；capture 只留同源/JSON", () => {
  const page = {
    url: "https://a.com/1", depth: 0, requestedAt: "t", title: "", finalUrl: "https://a.com/1",
    loginWall: false, enqueued: [], structure: null, dangerous: [],
    outline: [{ sig: "BUTTON", text: "搜索", interactive: true }],
    clickables: [],
    capture: {
      totalRequestsSeen: 9, returned: 3,
      requests: [
        { url: "https://a.com/api/list", mimeType: "application/json", body: "{}" },
        { url: "https://ads.example.com/track", mimeType: "image/gif", body: "" },
        { url: "https://cdn.example.com/data.json", mimeType: "text/plain", body: "[]" },
      ],
    },
  };
  const snap = buildSnapshot([page], { origin: "https://a.com", minPages: 3 });
  assert.deepEqual(snap.pages[0].outline.map((i) => i.text), ["搜索"]);
  assert.deepEqual(snap.chrome.outline, []);
  assert.deepEqual(snap.pages[0].capture.requests.map((r) => r.url), [
    "https://a.com/api/list",
    "https://cdn.example.com/data.json", // JSON 的跨源响应保留
  ]);
});

test("pruneStructure: SVG/渐变图元噪音剔除、列表截断", () => {
  const lists = [
    { parent: "svg", child: "path", count: 3 },
    { parent: "g", child: "path", count: 12 },
    { parent: "linearGradient", child: "stop", count: 8 },
    { parent: "UL.list", child: "LI.item", count: 20 },
  ];
  const out = pruneStructure({ lists, forms: [], passwordFields: 0 });
  assert.deepEqual(out.lists, [{ parent: "UL.list", child: "LI.item", count: 20 }]);
  assert.deepEqual(pruneStructure({ lists }, { maxLists: 0 }).lists, []);
});

test("discoverRun: 位置旗标（--out-dir/--draft）显式拒绝，不静默忽略", async () => {
  const { main } = require("../runner/discover");
  const origError = console.error;
  let logged = "";
  console.error = (m) => { logged += String(m); };
  try {
    // 未知旗标在连浏览器之前就被拒（返回 1），不会产生任何写盘。
    const code1 = await main(["--url", "https://example.com/", "--out-dir", "D:/tmp/x"]);
    assert.equal(code1, 1);
    assert.match(logged, /不接受的参数: --out-dir/);
    logged = "";
    const code2 = await main(["--url", "https://example.com/", "--draft", "D:/tmp/x.json"]);
    assert.equal(code2, 1);
    assert.match(logged, /不接受的参数: --draft/);
  } finally {
    console.error = origError;
  }
});
