"use strict";
// discover.js 纯函数单测（浏览器无关）。真浏览器的发现流程归 live 测试管，
// 这里锁住的是：危险词、URL 归一、路由聚类、画像骨架、探针整形、响应剔除。
const test = require("node:test");
const assert = require("node:assert/strict");
const { isInside } = require("../agent/paths");
const {
  isDangerousLabel,
  normalizeUrl,
  clusterByPathPrefix,
  buildProfileSkeleton,
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

test("normalizeUrl: keeps hash routes and query, rejects non-http", () => {
  assert.equal(normalizeUrl("https://a.com/x?y=1#frag"), "https://a.com/x?y=1#frag");
  assert.equal(normalizeUrl("https://a.com/#/compose"), "https://a.com/#/compose");
  assert.equal(normalizeUrl("https://a.com"), "https://a.com/");
  assert.equal(normalizeUrl("javascript:void(0)"), null);
  assert.equal(normalizeUrl("mailto:a@b.c"), null);
  assert.equal(normalizeUrl("not a url"), null);
});

test("clusterByPathPrefix groups by first 2 path segments", () => {
  const c = clusterByPathPrefix([
    "https://a.com/jobs/1", "https://a.com/jobs/2", "https://a.com/feed",
  ]);
  assert.equal(c["/jobs"].length, 2);
  assert.deepEqual(c["/feed"], ["https://a.com/feed"]);
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

  // 双上限：max=可交互上限，maxText=非交互文本上限；截断按"首次出现"记账
  const capped = shapeOutline(raw, { max: 1, maxText: 1 });
  assert.deepEqual(capped.map((i) => i.text), ["首页", "找工作 平台"]);
  const big = [
    ...Array.from({ length: 201 }, (_, i) => ({ sig: "B" + i, text: "b" + i, interactive: true })),
    ...Array.from({ length: 61 }, (_, i) => ({ sig: "T" + i, text: "t" + i, interactive: false })),
  ];
  const capped2 = shapeOutline(big);
  assert.equal(capped2.length, 260); // 200 交互 + 60 文本
  assert.equal(capped2[200].text, "t0");
  assert.equal(capped2[259].text, "t59");
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
  assert.equal(isInside(root, "D:\\repo\\profiles\\a.json"), true);
  assert.equal(isInside(root, "D:\\repo\\profiles"), true); // 等于锚本身允许
  assert.equal(isInside(root, "D:\\repo\\profiles-other\\a.json"), false); // 前缀相同不是包含
  assert.equal(isInside(root, "D:\\repo\\a.json"), false);
  assert.equal(isInside(root, "D:\\elsewhere\\a.json"), false); // 跨根
  assert.equal(isInside("C:\\data", "D:\\data\\x.json"), false); // 跨盘符
  // ".." 逃逸：path.relative 先归一再判包含，profiles\..\secret.json == repo\secret.json
  assert.equal(isInside(root, "D:\\repo\\profiles\\..\\secret.json"), false);
  assert.equal(isInside(root, "D:\\repo\\profiles\\.\\x.json"), true); // "." 归一后仍在锚内
});

test("buildProfileSkeleton: knowledge profile with embedded snapshot (no code fields)", () => {
  const snapshot = {
    capturedAt: "2026-10-26T00:00:00.000Z",
    chrome: { outline: [], clickables: [] },
    pages: [
      {
        url: "https://a.com/",
        outline: [{ sig: "A", text: "首页", interactive: true }],
        clickables: [{ sig: "DIV.card", text: "卡片" }],
        structure: { forms: [{ action: "/x" }], lists: [{ count: 3 }] },
        capture: { requests: [{ url: "https://a.com/api", body: '{"k":1}' }] },
      },
    ],
    skipped: [{ url: "https://b.com/", reason: "cross-origin" }],
  };
  const d = buildProfileSkeleton({
    domain: "a.com",
    entry: "https://a.com/",
    visited: ["https://a.com/"],
    observations: { loginRequired: false, limits: { pagesVisited: 1 } },
    snapshot,
  });
  assert.equal(d.schemaVersion, 3);
  assert.equal(d.status, "draft");
  assert.ok(!("recipes" in d) && !("replay" in d), "画像不得含采集代码字段");
  assert.deepEqual(d.fieldMap, {});
  assert.deepEqual(d.pageNotes, []);
  assert.ok(Array.isArray(d.actions), "actions start empty");
  assert.ok(Array.isArray(d.pending), "pending start empty");
  // 采集快照进画像（无独立材料包）——1a9f12e 曾误删此接线，这里钉死
  assert.equal(d.snapshot, snapshot);
  assert.ok(!("discovery" in d), "discovery 中间块不入画像");
  // digest 目录段：只承载各段规模，不承载业务信号
  assert.equal(d.digest.pages, 1);
  assert.equal(d.digest.interactive, 1);
  assert.equal(d.digest.clickables, 1);
  assert.equal(d.digest.forms, 1);
  assert.equal(d.digest.lists, 1);
  assert.equal(d.digest.responseBodies.returned, 1);
  assert.equal(typeof d.digest.snapshotKb, "number");
  assert.deepEqual(
    Object.keys(d.digest).sort(),
    ["clickables", "forms", "interactive", "lists", "pages", "responseBodies", "snapshotKb"],
    "digest 收窄为目录档：接口家底/危险词/跳过记录仍由 LLM 进 snapshot 段自己看",
  );
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

test("pruneCapture: 二进制先杀 + JSON优先小体先重排 + 总预算降级 shape/512B 样例", () => {
  const big = JSON.stringify({ items: Array(500).fill(1), meta: "m" }); // 1021 字符 > 512，可验证截断上限
  const cap = {
    totalRequestsSeen: 5,
    returned: 5,
    requests: [
      { url: "https://a.com/big", type: "xhr", mimeType: "application/json", body: big },
      { url: "https://a.com/small.json", type: "xhr", mimeType: "application/json", body: "y".repeat(100) },
      { url: "https://a.com/img", type: "xhr", mimeType: "image/webp", body: "z".repeat(500) },
      { url: "https://a.com/doc", type: "document", mimeType: "application/json", body: '{"k":1}' },
      { url: "https://a.com/bin", type: "fetch", mimeType: "application/x-protobuf", body: "p".repeat(800) },
    ],
  };
  // 默认 256KB 预算：全留；二进制 MIME（webp/x-protobuf）被杀；
  // 重排 = JSON 组在前（doc 的 type 是 document 但 mime 是 json 也进 JSON 组）、组内小体先。
  const out = pruneCapture(cap);
  assert.deepEqual(out.requests.map((r) => r.url), [
    "https://a.com/doc",
    "https://a.com/small.json",
    "https://a.com/big",
  ]);
  assert.ok(out.requests.every((r) => !r.bodyOmitted));
  assert.equal(typeof out.bytesKb, "number");

  // 预算 0：所有体降级 —— JSON 体带 shape，非 JSON 体截 512B 占样
  const tight = pruneCapture(cap, { bodyBudgetKb: 0 });
  const [doc, small, bigR] = tight.requests;
  assert.ok(doc.bodyOmitted && small.bodyOmitted && bigR.bodyOmitted);
  assert.deepEqual(doc.shape, { root: "object", keys: { k: "number" } });
  assert.deepEqual(bigR.shape, { root: "object", keys: { items: "array(500)", meta: "string" } });
  assert.equal("shape" in small, false); // "yyy…" 不是合法 JSON，无 shape 可提
  assert.equal(doc.body.length, 7); // '{"k":1}' 7 字符 < 512，slice 不截不断长
  assert.equal(bigR.body.length, 512);
});

test("jsonShapeOf: 数组取首条记录形状，超 24 键截断", () => {
  const { jsonShapeOf } = require("../runner/discover");
  const many = {};
  for (let i = 0; i < 40; i++) many["k" + i] = i;
  assert.deepEqual(jsonShapeOf([{ id: 1, t: "x" }]), {
    root: "array(1)",
    record: { id: "number", t: "string" },
  });
  assert.equal(Object.keys(jsonShapeOf(many).keys).length, 24);
});

test("discoverRun: 位置旗标（--out-dir/--profile）显式拒绝，不静默忽略", async () => {
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
    const code2 = await main(["--url", "https://example.com/", "--profile", "D:/tmp/x.json"]);
    assert.equal(code2, 1);
    assert.match(logged, /不接受的参数: --profile/);
  } finally {
    console.error = origError;
  }
});
