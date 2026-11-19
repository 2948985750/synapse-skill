#!/usr/bin/env node
"use strict";
// Profile discovery: the collection program for site profiles.
//
// 设计立场：采集是通用动作——本程序对所有站点都是同一套代码（打开/复用页面 →
// 等渲染 → 结构探针 → XHR capture）。画像就是采集产物
// 本身：页面证据（顶层 pages 段）+ 站点知识，纯数据、无采集代码。没有独立的"材料包"，
// 结构证据与响应体都直接写进画像。元素交互不在采集期冻结成快照——agent 用
// collect-elements/run 实时探活 DOM，跑通的操作当场结晶成 steps。
//
//   run —— open the entry page ONCE and take a single-page structural snapshot:
//          structure probe (lists/forms/password fields) + XHR capture (bodies
//          included), then write ONE profile at <PROFILES_ROOT>/<domain>.json
//          with the pages embedded. No frozen element list: the agent discovers
//          interactive elements live at collection time and crystallizes the
//          operations it actually runs into steps[].
//          The program does NOT auto-follow links to crawl further pages —
//          page-to-page jumps / routes are discovered by the LLM during
//          interactive exploration (click → observe location change → summarize),
//          which also fills the knowledge fields.
//
// Safety is enforced here, not left to model compliance:
//   - same-origin only (cross-origin redirect recorded, never visited);
//   - danger keywords (删除/支付/logout/checkout/…) recorded, never clicked;
//   - forms are never auto-submitted;
//   - single entry page only: no crawl budget, the agent drives navigation;
//   - no location flags: the program decides where to write; promotion to
//     formal profiles is an explicit human step.
//
// Exit codes: 0 ok, 1 usage/exec.
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const { PROFILES_ROOT } = require("../agent/paths");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --opt <value> 解析（原 profile-runner 的 getOpt，runner 退役后内联回来；
// 值以 "--" 开头或缺失时报错，防止旗标吞参数）。
function getOpt(argv, name, fallback) {
  const i = argv.indexOf(name);
  if (i < 0) return fallback;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--"))
    throw new Error(name + " 缺少参数值");
  return v;
}

// 画像一律活在数据根（安装目录只读——paths.js 的原则）。SKILL_ROOT/profiles 里的
// 只是出厂种子：首次使用时播种到数据根，之后 agent 的知识修订/晋级都发生在数据根副本。
// 纯数据画像（.json）：缺哪个补哪个，绝不覆盖已有副本。
function ensureProfilesSeeded() {
  const seedDir = path.join(ROOT, "profiles");
  fs.mkdirSync(PROFILES_ROOT, { recursive: true });
  const seeded = [];
  if (fs.existsSync(seedDir)) {
    for (const f of fs.readdirSync(seedDir)) {
      if (!f.endsWith(".json")) continue;
      const target = path.join(PROFILES_ROOT, f);
      if (!fs.existsSync(target)) {
        fs.copyFileSync(path.join(seedDir, f), target);
        seeded.push(f);
      }
    }
  }
  return seeded;
}

// ---------------- pure helpers（test-discover.js 直接测这些） ----------------

// 危险动作词表：宁可误拦，不可漏拦。供 actions.js 的 labelViolates 在交互时
// 判断点击目标是否危险（步骤级风险提示）；CJK 用 includes，ASCII 用词边界，
// 避免 "remove" 命中 "remover"。
const DANGER_CJK = [
  "删除",
  "注销",
  "退出登录",
  "退出",
  "支付",
  "付款",
  "结算",
  "下单",
  "提交订单",
  "提交申请",
  "转账",
  "退款",
  "解绑",
  "销户",
  "赎回",
];
const DANGER_ASCII = [
  "delete",
  "remove",
  "logout",
  "sign out",
  "signout",
  "checkout",
  "payment",
  "purchase",
  "pay now",
  "unsubscribe",
  "refund",
  "withdraw",
];
const DANGER_ASCII_RE = DANGER_ASCII.map((w) => ({
  word: w,
  re: new RegExp("\\b" + w.replace(/\s+/g, "\\s+") + "\\b"),
}));

function isDangerousLabel(text) {
  const t = String(text || "").toLowerCase();
  if (!t) return null;
  for (const w of DANGER_CJK) if (t.includes(w)) return w;
  for (const { word, re } of DANGER_ASCII_RE) if (re.test(t)) return word;
  return null;
}

// 只收 http(s)；保留 query 和 hash 路由。
function normalizeUrl(u) {
  try {
    const url = new URL(String(u));
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href;
  } catch (_) {
    return null;
  }
}

// 按首段路径聚类，给 agent 一个"路由家族"的粗提示（/jobs/1 与 /jobs/2 同族）。
// 真正的 URL 模板归纳是判断活，交给 agent，这里不做。
function clusterByPathPrefix(urls, segs = 1) {
  const out = {};
  for (const u of urls || []) {
    try {
      const key =
        "/" +
        new URL(u).pathname.split("/").filter(Boolean).slice(0, segs).join("/");
      (out[key] = out[key] || []).push(u);
    } catch (_) {}
  }
  return out;
}

// 紧凑目录段（纯数据）：画像的"各段规模"。LLM 读画像的第一步只看这段
// 规模目录（token 经济）：digest 只承载各段规模，LLM 读画像先读它定盘子（~10 行），
// 再按需开 pages[]。入参是画像顶层 pages 数组。
function buildDigest(pages) {
  let forms = 0;
  let lists = 0;
  let bodiesReturned = 0;
  let bodyBytes = 0;
  for (const p of pages || []) {
    const st = p.structure || {};
    forms += (st.forms || []).length;
    lists += (st.lists || []).length;
    for (const r of (p.capture && p.capture.requests) || []) {
      bodiesReturned++;
      bodyBytes += String(r.body || "").length;
    }
  }
  return {
    pages: pages.length,
    forms,
    lists,
    responseBodies: { returned: bodiesReturned, bytesKb: Math.round(bodyBytes / 1024) },
    snapshotKb: Math.round(JSON.stringify(pages || []).length / 1024),
  };
}

function buildProfileSkeleton({ domain, entry, visited, observations, pages }) {
  const today = new Date().toISOString().slice(0, 10);
  return {
    domain,
    // 目录段（token 经济）：只承载各段规模（pages/forms/lists/responseBodies/snapshotKb），
    // LLM 读画像的第一步先看它定盘子（~10 行），再按需开 pages[]。不承载业务信号（接口家底/危险词等由 LLM 进 pages 段自己看）。
    digest: buildDigest(pages),
    createdAt: today,
    access: {
      login: {
        required: observations.loginRequired,
        note: observations.loginNote || "由 discover 运行观察得出",
      },
      entryUrl: entry,
    },
    limits: observations.limits || {},
    antiScrape: [],
    pageNotes: [],
    actions: [],
    pending: [],
    // 采集到的页面：扁平挂在画像顶层，无 snapshot 包装层、无 chrome 归并。
    // 画像本身就是采集产物，无独立材料包。
    pages,
  };
}

// ---------------- 页内探针（只读，不点击、不提交） ----------------

// 重复结构 = 列表容器的机械线索（父节点下 N 个同签名子元素）。误报多，
// 只作为交给 agent 的线索，不直接进画像知识。
const STRUCTURE_PROBE_JS =
  "(function(){try{var sig=function(e){var c=(typeof e.className==='string')?e.className.trim().replace(/\\s+/g,'.'):'';return e.tagName+(c?'.'+c:'')};var lists=[],seenL={},all=document.querySelectorAll('body *'),cap=Math.min(all.length,6000);" +
  "for(var i=0;i<cap;i++){var p=all[i];if(!p.children||p.children.length<3)continue;" +
  "var s=sig(p.children[0]),same=true;" +
  "for(var j=1;j<p.children.length;j++){if(sig(p.children[j])!==s){same=false;break}}" +
  "if(!same)continue;var key=sig(p)+'>'+s;if(seenL[key])continue;seenL[key]=1;" +
  "lists.push({parent:sig(p),child:s,count:p.children.length,sample:(p.children[0].innerText||'').replace(/\\s+/g,' ').trim().slice(0,60)})}" +
  "lists.sort(function(a,b){return b.count-a.count});" +
  "var forms=[].map.call(document.querySelectorAll('form'),function(f){return {action:f.action,method:f.method,inputs:[].map.call(f.querySelectorAll('input,select,textarea'),function(x){return {tag:x.tagName.toLowerCase(),type:x.type||'',name:x.name||'',placeholder:x.placeholder||''}}).slice(0,12)}}).slice(0,5);" +
  "return {lists:lists.slice(0,8),forms:forms,passwordFields:document.querySelectorAll('input[type=password]').length}}" +
  "catch(e){return {lists:[],forms:[],passwordFields:0,probeError:String(e)}}})()";

// capture 窗口内把页面滚到底一次，给懒加载一个触发机会（对内层滚动容器无效，
// 但无害；容器级滚动交给 agent 的针对性探索）。
const SCROLL_TRIGGER_JS =
  "(function(){try{window.scrollTo(0,document.body.scrollHeight)}catch(e){};return 'ok'})()";

// ---------------- 快照整形（采集结果入画像前的筛选） ----------------

// SVG/渐变等图元不是列表结构，纯噪音。
const STRUCT_NOISE_RE =
  /^(svg|g|path|use|defs|clippath|lineargradient|radialgradient|stop|rect|circle|ellipse|polygon|polyline|mask|filter|symbol)$/i;
const tagOf = (sig) => String(sig || "").split(/[.#]/)[0];

function pruneStructure(structure, { maxLists = 8 } = {}) {
  if (!structure || typeof structure !== "object") return structure;
  const lists = (Array.isArray(structure.lists) ? structure.lists : [])
    .filter(
      (l) =>
        !STRUCT_NOISE_RE.test(tagOf(l && l.parent)) &&
        !STRUCT_NOISE_RE.test(tagOf(l && l.child)),
    )
    .slice(0, maxLists)
    // token 经济：parent/child 是带哈希后缀的 class 签名（站点改版即变、无法用于定位），
    // 只留计数+文本样例——判站/统计够用，LLM 读取不再吃哈希噪声。
    .map((l) => ({ count: l.count, sample: l.sample }));
  return { ...structure, lists };
}

// 响应体只留 fetch/xhr（真正的数据接口）；同源静态资源（图片/字体/脚本/样式/文档）
// 一律丢弃——它们对采集知识无价值，还会把画像撑到 MB 级。
// 例外：Content-Type 是 JSON 的（即便 resourceType 标成 document/other）仍保留。
// 注意：站点常把图片/字体也用 XHR 拉（如 WhatsApp 的 emoji 雪碧图 type=XHR, mime=image/webp），
// 所以先按 MIME 判二进制，再看 resourceType。BINARY_MIME 与 agent/capture.js 的整形侧名单保持一致
// （那边同时拦二进制取体，这里兜底）。
// token 经济（默认预算 256KB）：重排为"JSON-mime 优先、体积小者优先"（上游按体积降序取 40 条，
// 专留最大的——对着 token 浪费）；超预算的 JSON 体换掉原文，只留 shape（顶层 keys +
// 首条记录形状）+ 前 512B 样例 + bodyOmitted。程序侧（actions 快路径）不读 capture 段，
// 这里的瘦身不影响执行。
const isJsonBody = (r) =>
  /json/i.test(String((r && r.mimeType) || "")) ||
  /json/i.test(String((r && r.url) || ""));

// JSON 体的"形状"摘要：顶层 keys 或数组首条记录的 keys，值只记类型（叶子）或条数。
// 让 LLM 知道"接口返回什么结构"而不必载入原文。
function jsonShapeOf(v) {
  const typeOf = (o) =>
    o === null
      ? "null"
      : Array.isArray(o)
        ? "array(" + o.length + ")"
        : o && typeof o === "object"
          ? "object"
          : typeof o;
  const keysOf = (o) => {
    const m = {};
    for (const k of Object.keys(o).slice(0, 24)) m[k] = typeOf(o[k]);
    return m;
  };
  if (Array.isArray(v))
    return { root: "array(" + v.length + ")", record: v.length ? keysOf(v[0] || {}) : {} };
  if (v && typeof v === "object") return { root: "object", keys: keysOf(v) };
  return { root: typeOf(v) };
}

function pruneCapture(capture, { bodyBudgetKb = 256 } = {}) {
  if (!capture || !Array.isArray(capture.requests)) return capture;
  const STATIC_EXT =
    /\.(png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|css|js|mjs|map|html?|wasm|mp4|mp3|webm|pdf)(\?|#|$)/i;
  const BINARY_MIME =
    /^(image|font|audio|video)\/|application\/(octet-stream|zip|gzip|pdf|wasm|protobuf|x-protobuf|vnd\.ms-)/i;
  const requests = capture.requests.filter((r) => {
    const u = String((r && r.url) || "");
    const t = String((r && r.type) || "").toLowerCase();
    const mime = String((r && r.mimeType) || "");
    if (BINARY_MIME.test(mime)) return false;
    if (t === "xhr" || t === "fetch") return true;
    if (/json/i.test(mime)) return true;
    if (/json/i.test(u) && !STATIC_EXT.test(u)) return true;
    return false;
  });
  // 稳定排序：JSON 先（信息密度最高），同组内体积小者优先（小体是完整数据，
  // 大体多半是列表/雪碧，shape 就够）
  requests.sort((a, b) => {
    const aj = isJsonBody(a) ? 0 : 1;
    const bj = isJsonBody(b) ? 0 : 1;
    if (aj !== bj) return aj - bj;
    return String(a.body || "").length - String(b.body || "").length;
  });
  // 总预算：超出的 JSON 体降级为 shape + 512B 样例（非 JSON 无 shape 可提，
  // 直接截到 512B 占样）
  const budget = bodyBudgetKb * 1024;
  let used = 0;
  for (const r of requests) {
    const body = String(r.body || "");
    if (!body) continue;
    if (used + body.length <= budget) {
      used += body.length;
      continue;
    }
    if (/json/i.test(String(r.mimeType || ""))) {
      try {
        r.shape = jsonShapeOf(JSON.parse(body));
      } catch (_) {}
    }
    r.body = body.slice(0, 512);
    r.bodyOmitted = true;
    used += 512;
  }
  return { ...capture, requests, bytesKb: Math.round((used / 1024) * 10) / 10 };
}

// 采集结果 → 画像 pages：扁平结构，pages 直接挂画像顶层，无 snapshot 包装层。
// 元素清单（outline/clickables）已移除——agent 采集时用 collect-elements/run 实时探活 DOM，
// steps 直接结晶跑通的操作序列，不再存采集瞬间的元素快照。保留 structure（表单/列表/密码框）
// 供登录墙探测与 digest 规模统计，capture 按需抓。
function buildSnapshot(pages) {
  const pruned = pages.map((pg) => ({
    url: pg.url,
    requestedAt: pg.requestedAt,
    title: pg.title,
    finalUrl: pg.finalUrl,
    loginWall: pg.loginWall,
    structure: pruneStructure(pg.structure),
    capture: pruneCapture(pg.capture),
  }));
  return pruned;
}

// ---------------- run ----------------

// 位置由程序固定：不接受任何位置旗标。白名单之外的 --flag 一律显式拒绝——
// 不静默忽略，agent 误以为能指定位置时必须立刻失败。
const ALLOWED_FLAGS = new Set([
  "--url",
  "--dwell-ms",
  "--settle-ms",
  "--session",
  "--browser-id",
  "--force",
  "--keep-tab",
  "--capture",
]);

async function discoverRun(argv, deps = {}) {
  const urlText = getOpt(argv, "--url");
  if (!urlText) {
    console.error(
      "用法: discover.js --url <入口> [--dwell-ms 4000] [--settle-ms 2500] [--session sid]\n" +
        "      [--force] [--keep-tab] [--capture]"
    );
    return 1;
  }
  const unknown = argv.filter(
    (a) => a.startsWith("--") && !ALLOWED_FLAGS.has(a),
  );
  if (unknown.length) {
    console.error(
      "[discover] 不接受的参数: " +
        unknown.join(" ") +
        "\n  采集结果写入 <PROFILES_ROOT>/<domain>.json（程序固定位置），" +
        "不接受任何位置旗标；重定位请改操作者配置（config set data-root/profile-root 或 WB_* 环境变量）。",
    );
    return 1;
  }
  const entry = normalizeUrl(urlText);
  if (!entry) {
    console.error("[discover] --url 不是合法的 http(s) 地址: " + urlText);
    return 1;
  }
  const entryOrigin = new URL(entry).origin;
  const domain = new URL(entry).hostname.replace(/^www\./, "");

  const dwellMs = Number(getOpt(argv, "--dwell-ms", 4000));
  const settleMs = Number(getOpt(argv, "--settle-ms", 2500));
  const session = getOpt(argv, "--session", "");
  const keepTab = argv.includes("--keep-tab");
  const force = argv.includes("--force");
  // 接口采集是按需行为（用户点名才抓），不是一股脑全抓：默认关闭，
  // 只在 --capture 时跑，且只记 url + 中文用途说明（见 pageNotes 的接口记录约定）。
  const doCapture = argv.includes("--capture");

  // 位置完全由程序决定：没有位置旗标，agent 无权指定保存位置。
  // 采集结果直接写进画像（页面证据在 pages 段）——不存在独立的"材料包"。
  const profilePath = path.join(PROFILES_ROOT, domain + ".json");

  if (fs.existsSync(profilePath) && !force) {
    console.error("[discover] 画像已存在（--force 覆盖）: " + profilePath);
    return 1;
  }

  ensureProfilesSeeded(); // 正式画像种子播种到数据根（不覆盖已有副本）
  const { connect } = deps.connect ? deps : require("../agent/api");
  // capture 的时长/截断/触发 JS 走 connect options（transport.js 直接把 opts
  // 喂给 doCaptureMany，不经过命令 args），所以这里必须带 durationMs。
  const browser = await connect({
    ...(session ? { session } : {}),
    browserId: getOpt(argv, "--browser-id", ""),
    durationMs: dwellMs,
    // token 经济：单条响应体 16KB 上限（响应体是给 LLM 读的，接口"长什么样"
    // 16KB 足够看结构，全量原文是浪费）；超预算条目由 pruneCapture 再降级 shape。
    bodyMaxKb: 16,
    triggerJs: SCROLL_TRIGGER_JS,
  });
  const log = deps.log || ((m) => console.error("[discover] " + m));
  let tabId = null;
  const skipped = [];

  try {
    // 单页结构快照：程序只打开入口页，采结构探针 + 响应体。元素交互不在采集期
    // 冻结——agent 用 collect-elements/run 实时探活，跑通的操作当场结晶成 steps。
    const opened = await browser.open(entry, { waitMs: 8000 });
    tabId = opened.tabId;
    await sleep(settleMs);

    const page = {
      url: entry,
      requestedAt: new Date().toISOString(),
      title: "",
      finalUrl: "",
      loginWall: false,
      structure: null,
      capture: null,
    };

    // 页内探针走 returnByValue 返回：对象就是对象，location.href/document.title
    // 是裸字符串。早先统一 JSON.parse 被 catch 吞掉，finalUrl/title 恒空，
    // 下面的跨源判断整段成了死代码。
    const runValue = async (js) => {
      const raw = await browser.run(tabId, js);
      const value = raw && raw.result ? raw.result.value : raw;
      return value;
    };
    try {
      page.finalUrl = normalizeUrl(await runValue("location.href")) || "";
      page.title = String((await runValue("document.title")) || "");
    } catch (_) {}
    let crossOrigin = false;
    if (page.finalUrl && new URL(page.finalUrl).origin !== entryOrigin) {
      // 跳出同源（SSO 登录跳转等）：只记录、不进入——异源页的探针/快照/响应体
      // 不进本域画像（LLM 会把异源数据当成本域知识）。
      crossOrigin = true;
      page.loginWall = true;
      skipped.push({ url: entry, reason: "redirect-out: " + page.finalUrl });
    }

    try {
      if (!crossOrigin) page.structure = await runValue(STRUCTURE_PROBE_JS);
    } catch (e) {
      log("structure probe failed: " + e.message);
    }
    if (!crossOrigin)
      page.loginWall =
        page.loginWall ||
        !!(page.structure && page.structure.passwordFields > 0);

    if (!crossOrigin && doCapture) {
      try {
        const cap = await browser.call("capture", { tabId, action: "wait" });
        // 响应体随页进画像 pages（原独立 captures/ 文件取消）。
        page.capture = {
          totalRequestsSeen: cap.totalRequestsSeen,
          returned: cap.returned,
          requests: cap.requests || [],
        };
      } catch (e) {
        page.capture = { error: e.message };
        log("capture failed: " + e.message);
      }
    }

    const observations = {
      loginRequired: page.loginWall || skipped.some((s) => s.reason === "auth"),
      loginNote: page.loginWall ? entry : "",
      limits: {
        pagesVisited: 1,
        routes: clusterByPathPrefix([page.finalUrl || entry]),
        note: "单页富快照；页间跳转/路由由 LLM 交互观测补全（discover 不再自动跟链接）",
      },
    };
    const pages = buildSnapshot([page]);
    const profile = buildProfileSkeleton({
      domain,
      entry,
      visited: [entry],
      observations,
      pages,
    });
    fs.mkdirSync(path.dirname(profilePath), { recursive: true });
    // 画像本身是采集产物（纯数据）：页面证据在 pages 段，知识字段（pageNotes/antiScrape）由 agent 依 pages 补全；没有任何代码。
    // 原子写（同目录 tmp + rename，与 agent/lib/json-store 同纪律）：半写坏的
    // 文件会让下次"已存在拒绝"卡在损坏文件上。
    const tmpPath = profilePath + "." + process.pid + ".tmp";
    fs.writeFileSync(tmpPath, JSON.stringify(profile, null, 2) + "\n", "utf8");
    fs.renameSync(tmpPath, profilePath);

    const bodyCount =
      page.capture && page.capture.requests ? page.capture.requests.length : 0;
    log(`page: ${page.finalUrl || entry}（响应体 ${bodyCount}）`);
    console.log(
      JSON.stringify({
        ok: true,
        domain,
        entry,
        finalUrl: page.finalUrl || entry,
        loginWall: page.loginWall,
        pages: { responseBodies: bodyCount },
        profile: profilePath,
        note: "单页富快照已写入 pages 段（无元素清单：agent 用 collect-elements/run 实时探活、steps 结晶操作序列）；页间跳转与路由由 LLM 交互观测补全，知识字段（pageNotes/antiScrape）由 agent 依 pages 补全（见 SKILL.md「画像生产」）",
      }),
    );
    return 0;
  } finally {
    if (tabId != null && !keepTab) {
      try {
        await browser.closeTab(tabId);
      } catch (_) {}
    }
    await browser.close().catch(() => {});
  }
}

// ---------------- CLI ----------------

async function main(argv = process.argv.slice(2), deps = {}) {
  return discoverRun(argv, deps);
}

if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e) => {
      console.error("[discover] 失败: " + (e && e.message ? e.message : e));
      process.exitCode = 1;
    });
}

module.exports = {
  isDangerousLabel,
  normalizeUrl,
  clusterByPathPrefix,
  buildProfileSkeleton,
  buildSnapshot,
  pruneStructure,
  pruneCapture,
  jsonShapeOf,
  // 页内探针源码（审计/复现用：注入浏览器执行）
  STRUCTURE_PROBE_JS,
  main,
};
