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

test("buildProfileSkeleton: 扁平画像顶层 pages（无 snapshot 包装/无代码字段）", () => {
  const pages = [
    {
      url: "https://a.com/",
      structure: { forms: [{ action: "/x" }], lists: [{ count: 3 }] },
      capture: { requests: [{ url: "https://a.com/api", body: '{"k":1}' }] },
    },
  ];
  const d = buildProfileSkeleton({
    domain: "a.com",
    entry: "https://a.com/",
    visited: ["https://a.com/"],
    observations: { loginRequired: false, limits: { pagesVisited: 1 } },
    pages,
  });
  assert.ok(!("recipes" in d) && !("replay" in d), "画像不得含采集代码字段");
  assert.deepEqual(d.pageNotes, []);
  assert.ok(Array.isArray(d.actions), "actions start empty");
  assert.ok(Array.isArray(d.pending), "pending start empty");
  // pages 扁平挂在画像顶层，无 snapshot 包装、无 chrome 归并
  assert.equal(d.pages, pages);
  assert.ok(!("snapshot" in d), "不再有 snapshot 包装层");
  assert.ok(!("discovery" in d), "discovery 中间块不入画像");
  // digest 目录段：只承载各段规模，不承载业务信号
  assert.equal(d.digest.pages, 1);
  assert.equal(d.digest.forms, 1);
  assert.equal(d.digest.lists, 1);
  assert.equal(d.digest.responseBodies.returned, 1);
  assert.equal(typeof d.digest.snapshotKb, "number");
  assert.ok(!("interactive" in d.digest), "元素清单已移除，interactive 计数不再有来源");
  assert.ok(!("clickables" in d.digest), "元素清单已移除，clickables 计数不再有来源");
  assert.deepEqual(
    Object.keys(d.digest).sort(),
    ["forms", "lists", "pages", "responseBodies", "snapshotKb"],
    "digest 收窄为目录档：接口家底/危险词仍由 LLM 进 pages 段自己看",
  );
});

test("buildSnapshot: 无元素清单，不做 chrome 归并，links/controls/dangerous 不入画像", () => {
  const mk = (url, extra = []) => ({
    url, depth: 1, requestedAt: "t", title: "", finalUrl: url, loginWall: false,
    enqueued: [], structure: { lists: [], forms: [], passwordFields: 0 },
    links: [{ href: "https://a.com/x" }], controls: [{ i: 0 }],
    outline: [{ sig: "A", text: "首页", interactive: true }, ...extra],
    clickables: [{ sig: "DIV.card", text: "卡片" }],
    capture: null,
  });
  const pages = [mk("https://a.com/1"), mk("https://a.com/2"), mk("https://a.com/3")];
  const out = buildSnapshot(pages);
  // 返回裸数组，无 snapshot/chrome 包装
  assert.ok(Array.isArray(out));
  assert.equal(out.length, 3);
  assert.ok(!("chrome" in out[0]) && !("snapshot" in out[0]));
  // 元素清单不冻结进画像：agent 用 collect-elements/run 实时探活
  assert.ok(!("outline" in out[0]), "outline 不入画像");
  assert.ok(!("clickables" in out[0]), "clickables 不入画像");
  // 中间量不入画像
  assert.ok(!("links" in out[0]) && !("controls" in out[0]));
  assert.ok(!("dangerous" in out[0]));
});

test("buildSnapshot: structure 保留、capture 只留同源/JSON，元素清单不入画像", () => {
  const page = {
    url: "https://a.com/1", depth: 0, requestedAt: "t", title: "", finalUrl: "https://a.com/1",
    loginWall: false, enqueued: [], structure: { lists: [], forms: [{ action: "/x" }], passwordFields: 1 },
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
  const out = buildSnapshot([page]);
  assert.ok(!("outline" in out[0]));
  assert.ok(!("clickables" in out[0]));
  assert.deepEqual(out[0].structure.forms, [{ action: "/x" }], "structure 保留供登录墙探测/digest");
  assert.deepEqual(out[0].capture.requests.map((r) => r.url), [
    "https://a.com/api/list",
    "https://cdn.example.com/data.json", // JSON 的跨源响应保留
  ]);
});

test("pruneStructure: SVG/渐变图元噪音剔除、列表截断、哈希签名只留计数+样例", () => {
  const lists = [
    { parent: "svg", child: "path", count: 3, sample: "" },
    { parent: "g", child: "path", count: 12, sample: "" },
    { parent: "linearGradient", child: "stop", count: 8, sample: "" },
    { parent: "UL.list", child: "LI.item", count: 20, sample: "阿里巴巴集团" },
  ];
  const out = pruneStructure({ lists, forms: [], passwordFields: 0 });
  assert.deepEqual(out.lists, [{ count: 20, sample: "阿里巴巴集团" }]);
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
