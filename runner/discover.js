#!/usr/bin/env node
"use strict";
// Profile discovery: the collection program for site profiles.
//
// 设计立场：采集是通用动作——本程序对所有站点都是同一套代码（打开/复用页面 →
// 等渲染 → outline/clickables 探针 → 结构探针 → XHR capture）。画像就是采集产物
// 本身：快照（snapshot 段）+ 站点知识，纯数据、无采集代码。没有独立的"材料包"，
// 元素快照与响应体都直接写进画像。
//
//   run —— open the entry page ONCE and take a single-page rich snapshot:
//          all interactive elements (incl. SPA jump containers: cursor:pointer /
//          onclick / role=link divs, not just <a href>) + structure probe + XHR
//          capture (bodies included), then write ONE profile draft at
//          <PROFILES_ROOT>/draft/<domain>.json with the snapshot embedded.
//          The program does NOT auto-follow links to crawl further pages —
//          page-to-page jumps / routes are discovered by the LLM during
//          interactive exploration (click → observe location change → summarize),
//          which also fills the knowledge fields; human review promotes the
//          draft to a formal profile.
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
  fs.mkdirSync(path.join(PROFILES_ROOT, "draft"), { recursive: true });
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

// 危险动作词表：宁可误拦（记录为 skipped/dangerous，agent 可见可复核），
// 不可漏拦。CJK 用 includes，ASCII 用词边界，避免 "remove" 命中 "remover"。
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

// 只收 http(s)；去掉 hash（同页锚点不是不同页面），query 保留（?q= 就是功能）。
function normalizeUrl(u) {
  try {
    const url = new URL(String(u));
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
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

// 紧凑目录段（纯数据）：draft 的"各段规模"。LLM 读 draft 的第一步只看这段
// （~10 行）就知道盘子多大，再按需开 snapshot/capture。只承载规模，不承载
// 业务信号（接口家底/危险词等仍由 LLM 进 snapshot 段自己看）。
function buildDigest(snapshot) {
  const pages = (snapshot && snapshot.pages) || [];
  let interactive = 0;
  let clickables = 0;
  let forms = 0;
  let lists = 0;
  let bodiesReturned = 0;
  let bodyBytes = 0;
  for (const p of pages) {
    interactive += (p.outline || []).length;
    clickables += (p.clickables || []).length;
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
    interactive,
    clickables,
    forms,
    lists,
    responseBodies: { returned: bodiesReturned, bytesKb: Math.round(bodyBytes / 1024) },
    snapshotKb: Math.round(JSON.stringify(snapshot || {}).length / 1024),
  };
}

function buildDraftSkeleton({ domain, entry, visited, observations, snapshot }) {
  const today = new Date().toISOString().slice(0, 10);
  return {
    schemaVersion: 3,
    domain,
    siteName: domain,
    goal: "（draft）discover.js 站点发现骨架：采集快照（snapshot，仅可交互元素 + 站点框架归并）与路由/入口/limits 已填，知识字段（fieldMap/params/pageNotes/antiScrape）待 agent 依 snapshot 补全。先读 digest 段再按需开 snapshot。",
    status: "draft",
    digest: buildDigest(snapshot),
    createdAt: today,
    updatedAt: today,
    access: {
      login: {
        required: observations.loginRequired,
        note: observations.loginNote || "由 discover 运行观察得出",
      },
      session: "复用真实浏览器会话，经 CDP 桥；不伪造请求头、不重放鉴权",
      entryUrl: entry,
    },
    limits: observations.limits || {},
    antiScrape: [],
    fieldMap: {},
    pageNotes: "",
    params: {},
    flows: [],
    // 采集快照：仅可交互元素（sig/text/interactive）与可点容器；跨页重复的
    // 站点框架归并在 chrome 一份。画像本身就是采集产物，无独立材料包。
    snapshot,
    discovery: {
      entry,
      visitedCount: visited.length,
      skippedCount: (snapshot.skipped || []).length,
    },
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

// 页面文本骨架：只遍历文本节点映射到持有元素，纯布局包装层不持有文本节点，
// 在数据源头就消失（不走"全元素取 innerText"——那是 layout-dependent API，会强制 reflow）。
// 表单控件没有文本节点，不在此表里——它们由 snapshot 的可交互启发式覆盖，两表互补。
// img 永远没有 innerText，用 alt 兜底成伪条目。
// clickables 是同一枚硬币的另一面：包装层自己成了可点击卡片（cursor:pointer /
// tabindex / onclick，现代站点最常见且 snapshot 选择器不认的功能入口）——纯布局
// 包装必须排除，兼任按钮的包装必须以容器为单位捞回来，不炸成内部文本叶子。
const OUTLINE_PROBE_JS =
  "(function(){try{" +
  "if(!document.body)return{outline:[],clickables:[]}" +
  ";var ITAG={A:1,BUTTON:1,INPUT:1,SELECT:1,TEXTAREA:1,SUMMARY:1,OPTION:1,LABEL:1};" +
  "var IROLE={button:1,tab:1,menuitem:1,menuitemradio:1,menuitemcheckbox:1,checkbox:1,radio:1,switch:1,link:1,option:1,combobox:1,listbox:1,slider:1,spinbutton:1,textbox:1,searchbox:1};" +
  "var sig=function(e){var c=(typeof e.className==='string')?e.className.trim().replace(/\\s+/g,'.').slice(0,40):'';return e.tagName+(e.id?'#'+e.id:'')+(c?'.'+c:'')};" +
  "var owners=new Map(),SKIP={SCRIPT:1,STYLE:1,NOSCRIPT:1,SVG:1,CANVAS:1};" +
  "var w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT,null);" +
  "while(w.nextNode()){var n=w.currentNode,v=n.nodeValue;if(!v||!v.trim())continue;" +
  "var p=n.parentElement;if(!p||SKIP[p.tagName])continue;" +
  "var a=owners.get(p);if(a)a.push(v);else owners.set(p,[v])}" +
  "var items=[],cur=300;" +
  "owners.forEach(function(vs,el){" +
  "var text=vs.join(' ').replace(/\\s+/g,' ').trim();if(!text)return;" +
  "var tag=el.tagName,role=el.getAttribute('role')||'';" +
  "var it={sig:sig(el),tag:tag,role:role,text:text.slice(0,80)," +
  "interactive:!!(ITAG[tag]||(role&&IROLE[role])||el.hasAttribute('tabindex')||el.hasAttribute('onclick')||el.isContentEditable)};" +
  "if(tag==='A'&&el.href)it.href=String(el.href).split('#')[0];" +
  "if(!it.interactive&&cur>0){cur--;try{it.cursorPointer=getComputedStyle(el).cursor==='pointer'}catch(e){}}" +
  "items.push(it)});" +
  "[].forEach.call(document.querySelectorAll('img[alt]'),function(im){" +
  "var alt=(im.getAttribute('alt')||'').trim();if(!alt)return;" +
  "items.push({sig:sig(im),tag:'IMG',role:'',text:'[img] '+alt.slice(0,60),interactive:false})});" +
  "var std=function(e){return ITAG[e.tagName]||IROLE[e.getAttribute('role')||'']};" +
  "var clicks=[],emitted=[],all=document.querySelectorAll('body *'),cap=Math.min(all.length,4000);" +
  "for(var i=0;i<cap;i++){var el=all[i];if(std(el))continue;" +
  "var r=el.getBoundingClientRect();if(r.width<2||r.height<2)continue;" +
  "var c='';try{c=getComputedStyle(el).cursor}catch(_){}" +
  "if(c!=='pointer'&&!el.hasAttribute('tabindex')&&!el.hasAttribute('onclick'))continue;" +
  "var txt=(el.innerText||'').replace(/\\s+/g,' ').trim();if(!txt)continue;" +
  "var covered=false;for(var j=0;j<emitted.length;j++){if(emitted[j].contains(el)){covered=true;break}}" +
  "if(covered)continue;emitted.push(el);" +
  "var la=el.matches('a[href]')?el:el.querySelector('a[href]');" +
  "var it2={sig:sig(el),text:txt.slice(0,80)};" +
  "if(la&&la.href)it2.href=String(la.href).split('#')[0];" +
  "clicks.push(it2);" +
  "if(clicks.length>=30)break}" +
  "return {outline:items,clickables:clicks}" +
  "}catch(e){return{outline:[{sig:'PROBE',tag:'ERROR',role:'',text:String(e).slice(0,80),interactive:false}],clickables:[]}}})()";

// 骨架的 node 侧整形：同签名+同文本的合并计次（导航项"首页"×3 是一个信息不是三条）、
// 截断限量。规则放 node 侧是为了可单测；页内探针只负责采集。
// 双上限（token 经济）：可交互条目信息密度高，放宽到 200；非交互的纯文本骨架
// 是给 LLM 的"页面大意"，60 条足够——token 大头在后者。
function shapeOutline(items, { max = 200, maxText = 60 } = {}) {
  const seen = new Map();
  const out = [];
  let interactiveOut = 0;
  let textOut = 0;
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || typeof it !== "object") continue;
    const text = String(it.text || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    if (!text) continue;
    const key = String(it.sig || it.tag || "?") + "|" + text;
    const prev = seen.get(key);
    if (prev) {
      prev.count = (prev.count || 1) + 1;
      continue;
    }
    const item = {
      sig: String(it.sig || it.tag || "?").slice(0, 80),
      text,
      interactive: !!it.interactive,
    };
    if (it.role) item.role = String(it.role).slice(0, 30);
    if (it.href) item.href = String(it.href);
    if (it.cursorPointer) item.cursorPointer = true;
    // 双上限在"首次出现"时记账（计次合并不再占用额度）
    if (item.interactive) {
      if (interactiveOut >= max) continue;
      interactiveOut++;
    } else {
      if (textOut >= maxText) continue;
      textOut++;
    }
    seen.set(key, item);
    out.push(item);
  }
  return out;
}

// 可点容器的 node 侧整形：同签名+同文本去重（点卡片常整排同构）、截断限量。
function shapeClickables(items, { max = 30 } = {}) {
  const seen = new Set();
  const out = [];
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || typeof it !== "object") continue;
    const text = String(it.text || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    if (!text) continue;
    const sig = String(it.sig || "?").slice(0, 80);
    const key = sig + "|" + text;
    if (seen.has(key)) continue;
    seen.add(key);
    const item = { sig, text };
    if (it.href) item.href = String(it.href);
    out.push(item);
    if (out.length >= max) break;
  }
  return out;
}

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
    .slice(0, maxLists);
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

// 采集结果 → 画像 snapshot：outline 只留可交互元素（interactive:true），
// clickables 保留；同一 sig+text 在多数页面（默认 >= 半数）重复出现 = 站点框架
// （导航/侧栏/页脚），归并进 chrome 只存一份。links/controls 是采集中间量，不入画像。
function buildSnapshot(
  pages,
  { skipped = [], minPages, maxOutline = 200 } = {},
) {
  // 阈值按页面数自适应：至少 3 页、且覆盖半数页面。低于半数的重复元素很可能是
  // 页面级操作（如详情页的 Apply now、同族页共享的 tab），归并会把页面交互面搬空。
  const chromeMin = Math.max(3, Math.ceil((pages.length || 1) / 2));
  // "跨多页重复 = 站点框架"的判定对单页采集不成立：同页三条同卡片是内容不是
  // 框架，归并会把页面交互面搬空。
  const threshold = Number.isFinite(minPages)
    ? minPages
    : (pages.length || 0) >= 2
      ? chromeMin
      : Infinity;
  const counts = new Map();
  const keyOf = (sig, text) => String(sig || "?") + "|" + String(text || "");
  const bump = (kind, it) => {
    const k = keyOf(it.sig, it.text);
    const prev =
      counts.get(k) ||
      {
        kind,
        sig: String(it.sig || "?"),
        text: String(it.text || ""),
        href: it.href ? String(it.href) : "",
        pages: 0,
      };
    prev.pages++;
    counts.set(k, prev);
  };
  for (const pg of pages) {
    for (const it of pg.outline || []) if (it.interactive) bump("outline", it);
    for (const c of pg.clickables || []) bump("clickables", c);
  }
  const isChrome = (it) => {
    const c = counts.get(keyOf(it.sig, it.text));
    return !!c && c.pages >= threshold;
  };
  const chromeOutline = [];
  const chromeClickables = [];
  for (const v of counts.values()) {
    if (v.pages < threshold) continue;
    (v.kind === "outline" ? chromeOutline : chromeClickables).push({
      sig: v.sig,
      text: v.text,
      pages: v.pages,
      ...(v.href ? { href: v.href } : {}),
    });
  }
  const pruned = pages.map((pg) => ({
    url: pg.url,
    requestedAt: pg.requestedAt,
    title: pg.title,
    finalUrl: pg.finalUrl,
    loginWall: pg.loginWall,
    structure: pruneStructure(pg.structure),
    dangerous: pg.dangerous,
    outline: (pg.outline || []).filter((it) => it.interactive && !isChrome(it)).slice(0, maxOutline),
    clickables: (pg.clickables || []).filter((c) => !isChrome(c)),
    capture: pruneCapture(pg.capture),
  }));
  return {
    capturedAt: new Date().toISOString(),
    chrome: { outline: chromeOutline, clickables: chromeClickables },
    pages: pruned,
    skipped,
  };
}

// ---------------- run ----------------

// 位置由程序固定：不接受任何位置旗标。白名单之外的 --flag 一律显式拒绝——
// 不静默忽略，agent 误以为能指定位置时必须立刻失败。
const ALLOWED_FLAGS = new Set([
  "--url",
  "--dwell-ms",
  "--settle-ms",
  "--session",
  "--force",
  "--keep-tab",
]);

async function discoverRun(argv, deps = {}) {
  const urlText = getOpt(argv, "--url");
  if (!urlText) {
    console.error(
      "用法: discover.js --url <入口> [--dwell-ms 4000] [--settle-ms 2500] [--session sid]\n" +
        "      [--force] [--keep-tab]",
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
        "\n  采集结果写入 <PROFILES_ROOT>/draft/<domain>.json（程序固定位置），" +
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

  // 位置完全由程序决定：没有位置旗标，agent 无权指定保存位置。
  // 采集结果直接写进画像（快照在 snapshot 段）——不存在独立的"材料包"。
  const draftPath = path.join(PROFILES_ROOT, "draft", domain + ".json");

  if (fs.existsSync(draftPath) && !force) {
    console.error("[discover] draft 已存在（--force 覆盖）: " + draftPath);
    return 1;
  }

  ensureProfilesSeeded(); // 正式画像种子播种到数据根（不覆盖已有副本）
  const { connect } = deps.connect ? deps : require("../agent/api");
  // capture 的时长/截断/触发 JS 走 connect options（transport.js 直接把 opts
  // 喂给 doCaptureMany，不经过命令 args），所以这里必须带 durationMs。
  const browser = await connect({
    ...(session ? { session } : {}),
    durationMs: dwellMs,
    // token 经济：单条响应体 16KB 上限（draft 是给 LLM 读的，接口"长什么样"
    // 16KB 足够看结构，全量原文是浪费）；超预算条目由 pruneCapture 再降级 shape。
    bodyMaxKb: 16,
    triggerJs: SCROLL_TRIGGER_JS,
  });
  const log = deps.log || ((m) => console.error("[discover] " + m));
  let tabId = null;
  const skipped = [];

  try {
    // 单页富快照：程序只打开入口页，采集全部可交互元素（含 SPA 跳转容器）+ 响应体。
    // 不再跟 <a> 自动翻页——每个元素"点了跳到哪页/发生什么行为"由 LLM 交互时观测
    // 并总结（agent 用 click-el 触发、观察 location 变化、记进画像知识）。
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
      dangerous: [],
      outline: [],
      clickables: [],
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
    try {
      if (!crossOrigin) {
        const shaped = await runValue(OUTLINE_PROBE_JS);
        page.outline = shapeOutline(shaped && shaped.outline);
        page.clickables = shapeClickables(shaped && shaped.clickables);
      }
    } catch (e) {
      page.outline = [];
      page.clickables = [];
      log("outline probe failed: " + e.message);
    }
    if (!crossOrigin)
      page.loginWall =
        page.loginWall ||
        !!(page.structure && page.structure.passwordFields > 0);

    if (!crossOrigin) {
      try {
        const snap = await browser.snapshot(tabId, { max: 60 });
        // snapshot 返回 {url,ts,total,count,items}，不是裸数组。
        const items = Array.isArray(snap) ? snap : (snap && snap.items) || [];
        for (const el of items) {
          const label = String(el.label || "");
          const danger = isDangerousLabel(label);
          if (danger)
            page.dangerous.push({
              where: "snapshot",
              tag: el.tag,
              role: el.role || "",
              label,
              matched: danger,
            });
        }
      } catch (e) {
        log("snapshot failed: " + e.message);
      }
    }

    // 危险词覆盖整页大纲/SPA 可点容器，不只快照前 60 条。带 where 标明出处；
    // 不存 snapshot 的 i 编号（它是当次会话的索引空间，draft 里没有那张表，
    // 实跑时编号也会漂移，只靠 tag/role/sig/label 定位）。
    const seenDanger = new Set();
    for (const it of [...(page.outline || []), ...(page.clickables || [])]) {
      const text = String(it.text || "").replace(/\s+/g, " ").slice(0, 60);
      const danger = isDangerousLabel(text);
      if (!danger) continue;
      const key = String(it.sig || "?") + "|" + text;
      if (seenDanger.has(key)) continue;
      seenDanger.add(key);
      const sig = String(it.sig || "");
      page.dangerous.push({
        where: "outline",
        sig,
        tag: sig.split(/[.#]/)[0],
        label: text,
        matched: danger,
      });
    }

    if (!crossOrigin) {
      try {
        const cap = await browser.call("capture", { tabId, action: "wait" });
        // 响应体随页进画像 snapshot（原独立 captures/ 文件取消）。
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
    const snapshot = buildSnapshot([page], { skipped });
    const draft = buildDraftSkeleton({
      domain,
      entry,
      visited: [entry],
      observations,
      snapshot,
    });
    fs.mkdirSync(path.dirname(draftPath), { recursive: true });
    // draft 是纯数据画像（.json）：采集快照在 snapshot 段，知识字段（fieldMap/
    // params/pageNotes/antiScrape）由 agent 依 snapshot 补全；没有任何代码。
    // 原子写（同目录 tmp + rename，与 agent/lib/json-store 同纪律）：半写坏的
    // draft 会让下次"已存在拒绝"卡在损坏文件上。
    const tmpPath = draftPath + "." + process.pid + ".tmp";
    fs.writeFileSync(tmpPath, JSON.stringify(draft, null, 2) + "\n", "utf8");
    fs.renameSync(tmpPath, draftPath);

    const bodyCount =
      page.capture && page.capture.requests ? page.capture.requests.length : 0;
    log(
      `page: ${page.finalUrl || entry}（可交互 ${
        page.outline.length + page.clickables.length
      }，响应体 ${bodyCount}）`,
    );
    console.log(
      JSON.stringify({
        ok: true,
        domain,
        entry,
        finalUrl: page.finalUrl || entry,
        loginWall: page.loginWall,
        snapshot: {
          interactive: page.outline.length + page.clickables.length,
          responseBodies: bodyCount,
        },
        draft: draftPath,
        note: "单页富快照（含 SPA 跳转容器）已写入 draft.snapshot；页间跳转与路由由 LLM 交互观测补全，知识字段（fieldMap/params/pageNotes/antiScrape）由 agent 依 snapshot 补全（见 SKILL.md「画像生产」）",
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
  buildDraftSkeleton,
  buildSnapshot,
  pruneStructure,
  pruneCapture,
  jsonShapeOf,
  shapeOutline,
  shapeClickables,
  // 页内探针源码（审计/复现用：注入浏览器执行）
  STRUCTURE_PROBE_JS,
  OUTLINE_PROBE_JS,
  main,
};
