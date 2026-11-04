#!/usr/bin/env node
"use strict";
// 动作结晶：把画像里实测跑通的 flows 沉淀成声明式 action（纯数据），由本通用解释器执行。
//
// 与 discover.js 同一立场：**画像不含可执行代码**。action 是数据（选择器/参数模板/
// 等待条件/验证规则/护栏），解释是通用程序——和 discover.js 一样站在「通用程序」这一侧，
// 信任边界（惰性数据，随便审阅拷贝）不破。与被退役的老 recipes 的区别不在「存不存动作」，
// 而在三件事：
//   1. 结晶式不手写式：agent 先即席跑通（flows 记录过程），跑通才沉淀成 action 数据
//      （带 verified 日期）；action 是「跑通路径的缓存」，不是「要预先维护的程序」。
//   2. 断了有兜底：选择器漂移/页面改版 → 执行失败 → agent 即席接管完成本次任务，
//      再回头修 action 数据。快路径省 token，慢路径保命，没有静默失败。
//   3. 护栏在本程序硬执行，不靠提示词自律：
//        - guards.side_effect = "external" 的动作（发送/提交）必须 --yes 才真跑，
//          --dry 永远只打印计划；
//        - guards.interval_s / guards.daily_cap 落数据根 action-state/，
//          只有 verify 全过才计数——半失败的发送不计入；
//        - 每次点击前读目标元素的 text+aria-label，命中全局危险词（discover 的
//          isDangerousLabel）或 action.guards.never → 立即中止，宁可误拦。
//
// 用法：
//   node runner/actions.js <domain> <actionId|list> [--param k=v ...] [--yes] [--dry] [--draft] [--timeout ms]
//
// Exit codes: 0 成功；1 用法/画像/action 校验失败；2 护栏拦截；3 执行/验证失败（agent 接管点）。
const fs = require("fs");
const path = require("path");

const { PROFILES_ROOT, DATA_ROOT } = require("../agent/paths");
const { isDangerousLabel } = require("./discover");
const { connect } = require("../agent/api");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- 纯函数（test-actions.js 直接测这些） ----------------

// 参数模板展开："…{to}…" → params.to。未知的模板名 = 画像漂移，硬报错不静默。
function expandParams(template, params) {
  const s = String(template);
  return s.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
    if (!params || typeof params[name] !== "string" || !params[name].trim()) {
      throw new Error(`模板引用了缺失的参数 {${name}}（--param ${name}=?）`);
    }
    return params[name];
  });
}

const STEP_OPS = ["click", "type", "wait", "navigate"];
const TYPE_MODES = ["native", "native-enter", "execCommand"];
const VERIFY_OPS = ["text", "exists", "navigate"];

// schema 校验：宁可启动即报错，不可跑到一半才发现画像写错。
// 返回错误消息数组（空 = 合法）。
function validateAction(action) {
  const errs = [];
  const at = (m) => errs.push(m);
  if (!action || typeof action !== "object") return ["action 必须是对象"];
  if (typeof action.id !== "string" || !action.id) at("actions[].id 必填");
  if (typeof action.title !== "string" || !action.title) at("actions[].title 必填");
  if (!action.params || typeof action.params !== "object" || Array.isArray(action.params)) {
    at("actions[].params 必须是对象（参数名 → 说明）");
  }
  if (!Array.isArray(action.steps) || !action.steps.length) at("actions[].steps 必须是非空数组");
  for (const [i, st] of (action.steps || []).entries()) {
    const tag = `steps[${i}]`;
    if (!st || typeof st !== "object") { at(tag + " 必须是对象"); continue; }
    if (!STEP_OPS.includes(st.do)) { at(`${tag}.do 未知「${st.do}」（可选：${STEP_OPS.join("|")}）`); continue; }
    if (st.do === "wait") {
      if (!st.ms && !st.sel) at(`${tag}: wait 需要 ms 或 sel`);
    } else if (st.do === "navigate") {
      // URL 驱动导航（可用 {param} 模板）：搜索类站点（upwork ?q= / xhs keyword=）
      // 的受控搜索框 DOM 驱动无效，只能直接开 URL。
      if (typeof st.url !== "string" || !st.url) at(`${tag}.url 必填（可用 {param} 模板）`);
      if (st.waitMs !== undefined && (!Number.isFinite(st.waitMs) || st.waitMs < 0)) {
        at(`${tag}.waitMs 必须是非负数`);
      }
    } else {
      if (typeof st.sel !== "string" || !st.sel) at(`${tag}.sel 必填（CSS 选择器）`);
    }
    if (st.do === "type") {
      if (typeof st.value !== "string") at(`${tag}.value 必填（可用 {param} 模板）`);
      if (st.mode && !TYPE_MODES.includes(st.mode)) {
        at(`${tag}.mode 未知「${st.mode}」（可选：${TYPE_MODES.join("|")}）`);
      }
    }
    if (st.do === "click") {
      // mode "js"（默认，el.click()）| "mouse"（CDP Input 真鼠标序列——对合成点击
      // 无反应的站点用，如 WhatsApp 会话行）；offsetX/offsetY 相对元素左上角，
      // 省略 = 中心。
      if (st.mode && !["js", "mouse"].includes(st.mode)) {
        at(`${tag}.mode 未知「${st.mode}」（click 可选：js|mouse）`);
      }
      for (const k of ["offsetX", "offsetY"]) {
        if (st[k] !== undefined && !Number.isFinite(st[k])) at(`${tag}.${k} 必须是数字`);
      }
    }
    if (st.unless !== undefined && typeof st.unless !== "string") at(`${tag}.unless 必须是选择器`);
    if (st.timeout !== undefined && (!Number.isFinite(st.timeout) || st.timeout <= 0)) {
      at(`${tag}.timeout 必须是正数`);
    }
    if (st.note !== undefined && typeof st.note !== "string") at(`${tag}.note 必须是字符串`);
  }
  if (action.verify !== undefined) {
    if (!Array.isArray(action.verify)) at("actions[].verify 必须是数组");
    for (const [i, v] of (action.verify || []).entries()) {
      const tag = `verify[${i}]`;
      if (!v || typeof v !== "object") { at(tag + " 必须是对象"); continue; }
      if (!VERIFY_OPS.includes(v.op)) { at(`${tag}.op 未知「${v.op}」（可选：${VERIFY_OPS.join("|")}）`); continue; }
      if (v.op === "text" && typeof v.expect !== "string") at(`${tag}.expect 必填`);
      if (v.op === "exists" && typeof v.sel !== "string") at(`${tag}.sel 必填`);
      if (v.op === "navigate" && typeof v.hash !== "string") at(`${tag}.hash 必填`);
    }
  }
  if (action.entry !== undefined) {
    const e = action.entry;
    if (typeof e.url !== "string" || !e.url) at("actions[].entry.url 必填");
  }
  if (action.guards !== undefined) {
    const g = action.guards;
    if (!g || typeof g !== "object") at("actions[].guards 必须是对象");
    else {
      if (g.side_effect !== undefined && !["local", "external"].includes(g.side_effect)) {
        at('guards.side_effect 只能是 "local" | "external"');
      }
      for (const k of ["interval_s", "daily_cap"]) {
        if (g[k] !== undefined && (!Number.isFinite(g[k]) || g[k] <= 0)) at(`guards.${k} 必须是正数`);
      }
      if (g.never !== undefined) {
        if (!Array.isArray(g.never) || g.never.some((w) => typeof w !== "string")) {
          at("guards.never 必须是字符串数组");
        }
      }
    }
  }
  return errs;
}

// 本地日期串（护栏日计数用，按本机时区）。
function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 护栏检查：interval（距上次成功）、daily_cap（今日次数）、external 动作要 --yes。
// 返回 {ok, reasons}——reasons 是给人看的拦截原因。
function checkGuards(action, state, now = new Date(), { yes = false } = {}) {
  const reasons = [];
  const g = (action && action.guards) || {};
  const st = state || {};
  if (g.side_effect === "external" && !yes) {
    reasons.push('这是外发动作（guards.side_effect="external"），真跑必须加 --yes（先 --dry 看计划）');
  }
  if (g.interval_s && st.lastSuccessAt) {
    const last = new Date(st.lastSuccessAt);
    if (!Number.isNaN(last.getTime())) {
      const elapsed = (now.getTime() - last.getTime()) / 1000;
      if (elapsed < g.interval_s) {
        reasons.push(`距上次成功仅 ${Math.round(elapsed)}s，护栏要求间隔 >= ${g.interval_s}s`);
      }
    }
  }
  if (g.daily_cap && st.countDate === localDate(now) && (st.count || 0) >= g.daily_cap) {
    reasons.push(`今日已成功 ${st.count} 次，达到日上限 ${g.daily_cap}`);
  }
  return { ok: reasons.length === 0, reasons };
}

// 成功后推进状态：只有 verify 全过才调用（半失败不计入日上限/间隔）。
// recent 留最近 10 次参数作外发审计痕迹。
function bumpState(state, params, now = new Date()) {
  const prev = state || {};
  const today = localDate(now);
  const recent = Array.isArray(prev.recent) ? prev.recent.slice(-9) : [];
  recent.push({ at: now.toISOString(), params: params || {} });
  return {
    lastSuccessAt: now.toISOString(),
    lastRunAt: now.toISOString(),
    countDate: today,
    count: prev.countDate === today ? (prev.count || 0) + 1 : 1,
    recent,
  };
}

// 目标元素文本命中全局危险词或 action 私有黑名单 → 拒绝点击（返回命中词，null = 放行）。
function labelViolates(text, neverWords) {
  const global = isDangerousLabel(text);
  if (global) return global;
  const t = String(text || "");
  for (const w of neverWords || []) if (w && t.includes(w)) return w;
  return null;
}

function stateFileFor(domain, actionId) {
  const safe = (s) => String(s).replace(/[^\w.-]/g, "_");
  return path.join(DATA_ROOT, "action-state", `${safe(domain)}__${safe(actionId)}.json`);
}

// ---------------- 页内探针（只读表达式，参数用 JSON.stringify 内嵌，免引号地狱） ----------------

function jsQueryInfo(sel) {
  return (
    "(function(){var el=document.querySelector(" + JSON.stringify(sel) + ");" +
    "if(!el)return null;" +
    "var r=el.getBoundingClientRect();" +
    "var t=(el.innerText||'').trim();" +
    "var a=(el.getAttribute('aria-label')||'').trim();" +
    "return {found:true,text:t.slice(0,120),aria:a.slice(0,120)," +
    "disabled:!!(el.disabled||el.getAttribute('aria-disabled')==='true')," +
    "visible:r.width>0&&r.height>0}})()"
  );
}

function jsClick(sel) {
  return (
    "(function(){var el=document.querySelector(" + JSON.stringify(sel) + ");" +
    "if(!el)return {ok:false,reason:'missing'};" +
    "try{el.scrollIntoView({block:'center'})}catch(e){};" +
    "el.click();return {ok:true}})()"
  );
}

// 真实鼠标点击的定位探针：scrollIntoView 后返回视口坐标（CDP Input.dispatchMouseEvent
// 吃视口坐标）。WhatsApp 等站点对合成 el.click() 无反应（2026-11-01 A/B 实测，见
// web.whatsapp 画像 antiScrape），必须走 Input 域真鼠标序列。
function jsClickRect(sel) {
  return (
    "(function(){var el=document.querySelector(" + JSON.stringify(sel) + ");" +
    "if(!el)return null;" +
    "try{el.scrollIntoView({block:'center'})}catch(e){};" +
    "var r=el.getBoundingClientRect();" +
    "if(r.width<1||r.height<1)return null;" +
    "return {x:r.x,y:r.y,w:r.width,h:r.height}})()"
  );
}

// 受控组件兼容写法与 type-el 同源：native value setter + input/change 事件。
// native-enter 追加 Enter keydown（收件人 chip 收口）。
function jsType(sel, value, mode) {
  const v = JSON.stringify(value);
  const base =
    "(function(){var el=document.querySelector(" + JSON.stringify(sel) + ");" +
    "if(!el)return {ok:false,reason:'missing'};" +
    "var proto=(el.tagName==='TEXTAREA')?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;" +
    "var d=Object.getOwnPropertyDescriptor(proto,'value');" +
    "if(d&&d.set)d.set.call(el," + v + ");else el.value=" + v + ";" +
    "el.dispatchEvent(new Event('input',{bubbles:true}));" +
    "el.dispatchEvent(new Event('change',{bubbles:true}));";
  const enter =
    "el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,cancelable:true}));";
  const exec =
    "(function(){var el=document.querySelector(" + JSON.stringify(sel) + ");" +
    "if(!el)return {ok:false,reason:'missing'};" +
    "el.focus();" +
    "var ok=document.execCommand('insertText',false," + v + ");" +
    "return ok?{ok:true}:{ok:false,reason:'execCommand 返回 false'}})()";
  if (mode === "execCommand") return exec;
  return base + (mode === "native-enter" ? enter : "") + "return {ok:true}})()";
}

// hash 导航 + 可选 reload（antiScrape：Gmail 改 hash 后必须 reload 才真渲染）。
// reload 会销毁执行环境，所以 fire-and-forget，之后由调用方轮询。
function jsGoto(hash, reload) {
  return (
    "(function(){location.hash=" + JSON.stringify(hash) + ";" +
    (reload ? "setTimeout(function(){location.reload()},80);" : "") +
    "return 'ok'})()"
  );
}

// ---------------- 运行时 ----------------

function log(msg) {
  console.log("[action] " + msg);
}

async function pollUntil(fn, timeoutMs, gapMs = 500, tolerateError = false) {
  const end = Date.now() + timeoutMs;
  let lastErr = null;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastErr = e;
      if (!tolerateError) throw e;
    }
    if (Date.now() > end) {
      const e = new Error("等待超时（" + timeoutMs + "ms）" + (lastErr ? "，最后错误: " + lastErr.message : ""));
      e.code = "POLL_TIMEOUT";
      throw e;
    }
    await sleep(gapMs);
  }
}

function loadProfile(domain, draft) {
  const file = path.join(PROFILES_ROOT, draft ? "draft" : "", `${domain}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`画像不存在：${file}`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// 入口解析（纯函数，可单测）：画像没给 entry 时退回「域根 + 8s 等待」。
// entry.url 的 {param} 模板由调用方（main）负责展开——这里不碰 params。
function resolveEntry(action, domain) {
  const raw = action && action.entry;
  if (raw && typeof raw.url === "string" && raw.url) {
    const entry = { waitMs: 8000, ...raw };
    return entry;
  }
  return { url: `https://${domain}/`, waitMs: 8000 };
}

function loadState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return null;
  }
}

// 复用同源标签（有就复用，没有就按 entry.url 开新的）——与 discover 的标签纪律一致。
// 路径路由 SPA（如 creator.douyin.com）修正：entry.url 带具体路径且复用标签不在该
// 路径时必须真导航，否则 steps/verify 全在旧页面上跑（2026-11-01 实测 upload action
// 在 manage 页上 verify 超时）。entry 只带域（Gmail 式 "/"）维持旧"纯复用"行为，
// 不折腾已打开的视图状态（如未发送的撰写窗口）。
async function findOrOpenTab(browser, entry) {
  const entryUrl = new URL(entry.url);
  const tabs = await browser.tabs();
  for (const t of tabs) {
    try {
      if (t.url && new URL(t.url).origin === entryUrl.origin) {
        const cur = new URL(t.url);
        const entryPath = entryUrl.pathname + entryUrl.search;
        const curPath = cur.pathname + cur.search;
        if (entryPath !== "/" && entryPath !== curPath) {
          await browser.call("navigate", {
            tabId: t.tabId,
            url: entry.url,
            waitMs: entry.waitMs || 8000,
          });
        }
        return { tabId: t.tabId, reused: true };
      }
    } catch (_) {}
  }
  const opened = await browser.open(entry.url, { waitMs: entry.waitMs || 8000 });
  return { tabId: opened.tabId, reused: false };
}

async function queryInfo(browser, tabId, sel, timeoutMs) {
  // 返回找到的元素 info（pollUntil 的返回值）；wait 型步骤只用它的"不抛错"语义，
  // click/type 步骤靠这个返回值做禁用检查与点击前护栏读标签（2026-11-02 补 return：
  // 之前漏写导致 click 步骤恒 undefined）。
  return await pollUntil(async () => {
    const raw = await browser.run(tabId, jsQueryInfo(sel));
    const v = raw && raw.result ? raw.result.value : raw;
    return v && v.found ? v : null;
  }, timeoutMs, 400, true);
}

// 执行单步。返回 {skipped?:true}；失败抛错（带步骤上下文）。
async function execStep(browser, tabId, st, stepTimeout) {
  if (st.unless) {
    const raw = await browser.run(tabId, jsQueryInfo(st.unless));
    const v = raw && raw.result ? raw.result.value : raw;
    if (v && v.found) return { skipped: true }; // 复用已存在的状态（如撰写窗口已开）
  }
  if (st.do === "wait") {
    if (st.sel) await queryInfo(browser, tabId, st.sel, st.timeout || stepTimeout);
    else await sleep(st.ms || 0);
    return {};
  }
  if (st.do === "navigate") {
    // URL 驱动导航（{param} 模板在 main 里已展开到 st._url）：受控搜索框（upwork/xhs）
    // DOM 驱动无效，直接开 URL。同 entry 语义，复用浏览器既有 navigate（等 load）。
    const url = st._url || st.url;
    if (typeof url !== "string" || !url) throw new Error("navigate 步骤缺 url");
    await browser.call("navigate", { tabId, url, waitMs: st.waitMs !== undefined ? st.waitMs : 8000 });
    return {};
  }

  const info = await queryInfo(browser, tabId, st.sel, st.timeout || stepTimeout);
  if (info.disabled) throw new Error(`目标被禁用（disabled）：${st.sel}`);
  if (st.do === "click") {
    // 点击前读文本+aria-label 过护栏——宁可误拦不可漏拦。
    const label = (info.text + " " + info.aria).trim();
    const hit = labelViolates(label, st._neverWords);
    if (hit) {
      const e = new Error(`点击目标命中危险词「${hit}」，已中止：${st.sel}（label="${label.slice(0, 60)}"）`);
      e.code = "GUARD_BLOCKED";
      throw e;
    }
    if ((st.mode || "js") === "mouse") {
      // CDP Input 域真鼠标序列：对合成 el.click() 无反应的站点（WhatsApp 会话行，
      // 2026-11-01 A/B 实测）。offsetX/Y 相对元素左上角，省略 = 中心。
      const raw = await browser.run(tabId, jsClickRect(st.sel));
      const rect = raw && raw.result ? raw.result.value : raw;
      if (!rect || !rect.w) throw new Error(`定位失败（不可见或 0 尺寸）：${st.sel}`);
      const px = rect.x + (st.offsetX !== undefined ? st.offsetX : rect.w / 2);
      const py = rect.y + (st.offsetY !== undefined ? st.offsetY : rect.h / 2);
      const move = { type: "mouseMoved", x: px, y: py, buttons: 0 };
      const down = { type: "mousePressed", x: px, y: py, button: "left", buttons: 1, clickCount: 1 };
      const up = { type: "mouseReleased", x: px, y: py, button: "left", buttons: 0, clickCount: 1 };
      for (const params of [move, down, up]) await browser.cdp(tabId, "Input.dispatchMouseEvent", params);
      return {};
    }
    const raw = await browser.run(tabId, jsClick(st.sel));
    const v = raw && raw.result ? raw.result.value : raw;
    if (!v || !v.ok) throw new Error(`点击失败：${st.sel}（${(v && v.reason) || "unknown"}）`);
    return {};
  }
  // type
  const raw = await browser.run(tabId, jsType(st.sel, st._value, st.mode || "native"));
  const v = raw && raw.result ? raw.result.value : raw;
  if (!v || !v.ok) throw new Error(`键入失败：${st.sel}（${(v && v.reason) || "unknown"}）`);
  return {};
}

async function runVerify(browser, tabId, verify, params, defaultTimeout) {
  for (const [i, v] of (verify || []).entries()) {
    if (v.op === "navigate") {
      // fire-and-forget：reload 会销毁执行环境；之后轮询 href 直到包含 hash。
      await browser.run(tabId, jsGoto(v.hash, v.reload !== false));
      const waitMs = v.waitMs || defaultTimeout;
      await pollUntil(async () => {
        const raw = await browser.run(tabId, "location.href+'|'+document.readyState");
        const s = raw && raw.result ? raw.result.value : "";
        return typeof s === "string" && s.includes(v.hash) && s.endsWith("complete");
      }, waitMs, 800, true);
      log(`verify[${i}] navigate ${v.hash}${v.reload ? " + reload" : " "} 完成`);
      continue;
    }
    const expect = v.op === "text" ? expandParams(v.expect, params) : v.expect;
    await pollUntil(async () => {
      if (v.op === "text") {
        const raw = await browser.run(tabId, "document.body.innerText");
        const t = raw && raw.result ? raw.result.value : "";
        return typeof t === "string" && t.includes(expect);
      }
      const raw = await browser.run(tabId, jsQueryInfo(v.sel));
      const info = raw && raw.result ? raw.result.value : raw;
      return !!(info && info.found);
    }, v.timeout || 12000, 600, true);
    log(`verify[${i}] ${v.op}${v.op === "text" ? `「${expect.slice(0, 30)}」` : ""} 通过`);
  }
}

// ---------------- main ----------------

function parseArgv(argv) {
  const rest = [];
  const params = {};
  let yes = false, dry = false, draft = false, timeoutMs = 180000, session = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--param") {
      const kv = String(argv[++i] ?? "");
      const at = kv.indexOf("=");
      if (at <= 0) throw new Error("--param 需要 k=v（值保持原始字符串，不做类型猜测）");
      params[kv.slice(0, at)] = kv.slice(at + 1);
    } else if (a === "--yes") yes = true;
    else if (a === "--dry") dry = true;
    else if (a === "--draft") draft = true;
    else if (a === "--timeout") timeoutMs = Number(argv[++i]) || timeoutMs;
    else if (a === "--session") session = argv[++i] || "";
    else rest.push(a);
  }
  return { rest, params, yes, dry, draft, timeoutMs, session };
}

// ---------------- 画像动作菜单（agent 查现有动作；list 子命令） ----------------

// 结晶指引（not-found 时随错误打印）：缺的不是 action 数据，是「即席跑通再写回」这一步——
// 写哪、必带什么字段、写类边界，都指回 SKILL.md，runner 只指路不代写。
const CRYSTALLIZE_HINT =
  "→ 结晶步骤：该任务由 agent 即席跑通并端到端验证后，写进本画像 actions[]（必带 " +
  "verified（日期+证据）/ on_fail / guards（含 never）；写类只到就绪态，触发词进 never）。" +
  "采集任务全覆盖、日常任务重复才结晶——见 SKILL.md「任务处理前置说明」第 3 条与「采集画像」。";

function formatActionMenu(profile) {
  const actions = profile.actions || [];
  if (!actions.length) {
    return `画像 ${profile.domain} 还没有 actions——任务即席完成后按「结晶步骤」写入 actions[]。`;
  }
  return actions
    .map((a) => {
      const side = (a.guards || {}).side_effect || "local";
      const p = Object.keys(a.params || {}).join(", ") || "—";
      return `${a.id}  ${a.title || ""}\n    side_effect=${side}  params: ${p}`;
    })
    .join("\n");
}

async function main(argv) {
  const { rest, params, yes, dry, draft, timeoutMs, session } = parseArgv(argv);
  const [domain, actionId] = rest;
  if (!domain || !actionId) {
    console.error("用法: node runner/actions.js <domain> <actionId|list> [--param k=v ...] [--yes] [--dry] [--draft] [--session sid] [--timeout ms]");
    process.exit(1);
  }

  const profile = await loadProfile(domain, draft);
  if (actionId === "list") {
    console.log(formatActionMenu(profile));
    process.exit(0);
  }
  const action = (profile.actions || []).find((a) => a.id === actionId);
  if (!action) {
    const have = (profile.actions || []).map((a) => a.id).join(", ") || "（无）";
    console.error(`画像 ${domain} 里没有 action「${actionId}」（现有：${have}；\`list\` 可查全菜单）`);
    console.error(CRYSTALLIZE_HINT);
    process.exit(1);
  }

  // 参数校验：params 声明的必填项必须都给了（模板展开还会兜底查一遍）。
  const errs = validateAction(action);
  if (errs.length) {
    console.error("action 校验失败：\n  " + errs.join("\n  "));
    process.exit(1);
  }
  const missing = Object.keys(action.params || {}).filter((k) => !params[k]);
  if (missing.length) {
    console.error("缺参数：" + missing.map((k) => `--param ${k}=?（${action.params[k] || ""}）`).join(" "));
    process.exit(1);
  }

  // 护栏状态与检查。--dry 永不执行也不拦截退出码：它只如实展示「真跑会被什么拦」，
  // 拦截决定发生在真跑分支（--yes/interval/cap 在那里硬拦）。
  const sFile = stateFileFor(domain, actionId);
  const state = loadState(sFile);
  const guard = checkGuards(action, state, new Date(), { yes });
  if (dry) {
    console.log("== dry 计划 ==");
    console.log(JSON.stringify({ domain, actionId, params, guards: action.guards || {}, guard }, null, 2));
    if (!guard.ok) {
      console.log("注意：按当前状态真跑会被拦 ——\n  " + guard.reasons.join("\n  "));
    }
    for (const [i, st] of action.steps.entries()) {
      const rendered = { ...st };
      if (typeof rendered.value === "string") rendered.value = expandParams(rendered.value, params);
      console.log(`  step ${i}: ${JSON.stringify(rendered)}`);
    }
    for (const v of action.verify || []) console.log(`  verify: ${JSON.stringify(v)}`);
    if (state) console.log("状态: " + JSON.stringify(state));
    process.exit(0);
  }
  if (!guard.ok) {
    console.error("护栏拦截：\n  " + guard.reasons.join("\n  "));
    process.exit(2);
  }

  // 展开（steps 里的 {param} → 实值；never 词表挂到步骤上供点击护栏读）。
  const steps = action.steps.map((st) => ({
    ...st,
    _value: typeof st.value === "string" ? expandParams(st.value, params) : st.value,
    _url: typeof st.url === "string" ? expandParams(st.url, params) : st.url,
    _neverWords: (action.guards && action.guards.never) || [],
  }));

  const browser = await connect(session ? { session } : {});
  const trace = [];
  try {
    // entry.url 同样展开 {param}（douyin /video/{id}、upwork ?q={query} 式参数化入口）。
    const entry = { ...resolveEntry(action, domain) };
    entry.url = expandParams(entry.url, params);
    const { tabId, reused } = await findOrOpenTab(browser, entry);
    log(`tab ${tabId}${reused ? "（复用）" : "（新开）"} ← ${entry.url}`);

    const started = Date.now();
    for (const [i, st] of steps.entries()) {
      try {
        const r = await execStep(browser, tabId, st, 15000);
        trace.push({ step: i, do: st.do, sel: st.sel || st.ms, ok: true, skipped: !!r.skipped });
        log(`step ${i} ${st.do}${r.skipped ? "（unless 跳过）" : ""} ✓ ${(st.note || "").slice(0, 40)}`);
      } catch (e) {
        e.stepIndex = i;
        throw e;
      }
    }
    await runVerify(browser, tabId, action.verify, params, 15000);

    // 只有 verify 全过才计数（护栏的间隔/日上限以成功为准）。
    const next = bumpState(state, params);
    fs.mkdirSync(path.dirname(sFile), { recursive: true });
    fs.writeFileSync(sFile, JSON.stringify(next, null, 2) + "\n", "utf8");
    log(`成功（${Date.now() - started}ms），状态已记 ${path.basename(sFile)}`);
    console.log(JSON.stringify({ ok: true, tabId, elapsedMs: Date.now() - started }, null, 2));
  } catch (e) {
    // 失败不计数、不写状态。带 trace 输出，给 agent 接管留上下文。
    const out = {
      ok: false,
      error: e.message,
      code: e.code || "ACTION_FAILED",
      failedStep: e.stepIndex,
      trace,
      on_fail: action.on_fail || "agent 即席接管完成本次任务，然后修订画像里的 action 数据（选择器漂移/流程变化）",
    };
    console.error(JSON.stringify(out, null, 2));
    process.exitCode = 3;
  } finally {
    browser.close();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => {
    console.error("[action] 失败: " + (e && e.message ? e.message : e));
    process.exitCode = 1;
  });
}

// ---------------- 测试出口（纯函数 + 表达式构造器可注入审计） ----------------
// main 必须导出：agent-collect.js 的统一 CLI 委托（actions 子命令）靠它进 main()
module.exports = {
  main,
  expandParams,
  validateAction,
  checkGuards,
  bumpState,
  labelViolates,
  stateFileFor,
  localDate,
  jsQueryInfo,
  jsClick,
  jsClickRect,
  jsType,
  jsGoto,
  loadProfile,
  loadState,
  resolveEntry,
  parseArgv,
  formatActionMenu,
  STEP_OPS,
  TYPE_MODES,
  VERIFY_OPS,
};
