#!/usr/bin/env node
"use strict";
// 动作结晶：把画像里实测跑通的任务沉淀成声明式 action（纯数据），由本通用解释器执行。
//
// 与 discover.js 同一立场：**画像不含可执行代码**。action 是数据（title + url + guards：
// url 可含 {param} 模板，同时承担入口与唯一步骤），解释是通用程序——和 discover.js
// 一样站在「通用程序」这一侧，信任边界（惰性数据，随便审阅拷贝）不破。与被退役的
// 老 recipes 的区别不在「存不存动作」，而在三件事：
//   1. 结晶式不手写式：agent 先即席跑通并端到端验证，跑通才沉淀成 action 数据
//      （带 verified 日期）；action 是「跑通路径的缓存」，不是「要预先维护的程序」。
//   2. 断了有兜底：URL 漂移/页面改版 → 导航失败 → exit 3 → agent 即席接管完成本次
//      任务，再回头修 action 数据。快路径省 token，慢路径保命，没有静默失败。
//   3. 护栏在本程序硬执行，不靠提示词自律：
//        - guards.side_effect = "external" 的动作（发送/提交）必须 --yes 才真跑，
//          --dry 永远只打印计划；
//        - guards.interval_s / guards.daily_cap 落数据根 action-state/，
//          只统计加载与最终 URL 已验证的导航，不统计业务成功；
//        - guards.never 触发词黑名单随画像落盘（写类只结晶到就绪态，发送/提交等
//          触发词进 never；匹配语义见 labelViolates 与全局危险词 discover 的
//          isDangerousLabel），由 agent 在交互路径遵守，runner 不代点。
//
// 动作执行 = 校验 → 护栏 → 参数展开 → 导航到结晶 URL → [可选 steps 步骤机] → 记状态。
//
// 两种 action 形态（向后兼容）：
//   1. 纯导航：{title, url, guards}——导航到 url、核验页面就绪即止（taskSucceeded:false）。
//   2. 带步骤：额外 {steps:[...], verify:[...]}——导航到 url 后按 steps 逐步执行交互，
//      verify 全过才算成功（taskSucceeded:true）。steps 只存数据，交互原语全走扩展侧
//      桥命令（query-el/click-el/type-css/wait-for/goto-hash），skill 侧不造页内 JS。
//
// steps 操作：click / type / wait / navigate；每步可带：
//   - ask: "向用户提问的话"——标记该步有风险；runner 执行到此前停住并以 exit 4 返回问题，
//     用户确认后加 --confirmed 重跑（确认状态不落盘，一次一确认）。
//   - unless: CSS 选择器——元素已存在则跳过该步（幂等，如撰写窗口已开）。
//   - note / timeout：排障说明 / 单步超时。
// verify 操作：text（页面含文字）/ exists（选择器命中）/ navigate（hash 到达）。
//
// 用法：
//   node runner/actions.js <domain> <actionId|list> [--param k=v ...] [--yes] [--confirmed] [--dry] [--timeout ms] [--session sid] [--browser-id id] [--allow-failover]
//
// Exit codes: 0 成功；1 用法/画像/action 校验失败；2 护栏拦截；3 导航/执行失败（agent 接管点）；4 风险步骤待用户确认。
const fs = require("fs");
const path = require("path");

const { PROFILES_ROOT, DATA_ROOT } = require("../agent/paths");
const { isDangerousLabel } = require("./discover");
const { connect } = require("../agent/api");
const { writeJsonAtomic } = require("../agent/lib/json-store");

// steps 步骤机：操作白名单。交互原语走扩展桥命令，skill 侧不构造页内 JS。
const STEP_OPS = ["click", "type", "wait", "navigate", "blur"];
const TYPE_MODES = ["native", "native-enter", "execCommand"];
const VERIFY_OPS = ["text", "exists", "navigate"];

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

// schema 校验：宁可启动即报错，不可跑到一半才发现画像写错。
// 返回错误消息数组（空 = 合法）。
//
// 精简结构：action 只保留 title + url（可含 {param} 模板）+ guards（可选，
// 护栏载体，砍掉则外发动作失去 --yes 拦截与 never 危险词拦截）。
// id 由 title 派生（小写 + 连字符），不再要求画像写死；url 同时承担 entry 与唯一步骤。
function validateAction(action) {
  const errs = [];
  const at = (m) => errs.push(m);
  if (!action || typeof action !== "object") return ["action 必须是对象"];
  if (typeof action.title !== "string" || !action.title) at("actions[].title 必填");
  if (typeof action.url !== "string" || !action.url) at("actions[].url 必填（可用 {param} 模板）");
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
  // steps / verify 可选：缺席 = 纯导航 action（老画像兼容）；出现则严格校验。
  if (action.steps !== undefined) {
    if (!Array.isArray(action.steps) || !action.steps.length) at("actions[].steps 必须是非空数组");
    else for (const [i, st] of action.steps.entries()) {
      const tag = `steps[${i}]`;
      if (!st || typeof st !== "object") { at(tag + " 必须是对象"); continue; }
      if (!STEP_OPS.includes(st.do)) { at(`${tag}.do 未知「${st.do}」（可选：${STEP_OPS.join("|")}）`); continue; }
      if (st.do === "wait") {
        if (!st.ms && !st.sel) at(`${tag}: wait 需要 ms 或 sel`);
      } else if (st.do === "navigate") {
        if (typeof st.url !== "string" || !st.url) at(`${tag}.url 必填（可用 {param} 模板）`);
        if (st.waitMs !== undefined && (!Number.isFinite(st.waitMs) || st.waitMs < 0)) at(`${tag}.waitMs 必须是非负数`);
      } else if (st.do === "blur") {
        // 失焦即提交的输入组件（价格区间等）：可选 sel 指定目标，省略则失焦当前焦点元素。
        if (st.sel !== undefined && typeof st.sel !== "string") at(`${tag}.sel 必须是选择器`);
      } else {
        if (typeof st.sel !== "string" || !st.sel) at(`${tag}.sel 必填（CSS 选择器）`);
      }
      if (st.do === "type") {
        if (typeof st.value !== "string") at(`${tag}.value 必填（可用 {param} 模板）`);
        if (st.mode && !TYPE_MODES.includes(st.mode)) at(`${tag}.mode 未知「${st.mode}」（可选：${TYPE_MODES.join("|")}）`);
      }
      if (st.do === "click" && st.mode !== undefined && !["js", "cdp"].includes(st.mode)) {
        at(`${tag}.mode 未知「${st.mode}」（click 可选：js|cdp）`);
      }
      if (st.unless !== undefined && typeof st.unless !== "string") at(`${tag}.unless 必须是选择器`);
      if (st.timeout !== undefined && (!Number.isFinite(st.timeout) || st.timeout <= 0)) at(`${tag}.timeout 必须是正数`);
      if (st.ask !== undefined && (typeof st.ask !== "string" || !st.ask.trim())) at(`${tag}.ask 必须是非空提问文本`);
      if (st.note !== undefined && typeof st.note !== "string") at(`${tag}.note 必须是字符串`);
    }
  }
  if (action.verify !== undefined) {
    if (!Array.isArray(action.verify)) at("actions[].verify 必须是数组");
    else for (const [i, v] of action.verify.entries()) {
      const tag = `verify[${i}]`;
      if (!v || typeof v !== "object") { at(tag + " 必须是对象"); continue; }
      if (!VERIFY_OPS.includes(v.op)) { at(`${tag}.op 未知「${v.op}」（可选：${VERIFY_OPS.join("|")}）`); continue; }
      if (v.op === "text" && typeof v.expect !== "string") at(`${tag}.expect 必填`);
      if (v.op === "exists" && typeof v.sel !== "string") at(`${tag}.sel 必填`);
      if (v.op === "navigate" && typeof v.hash !== "string") at(`${tag}.hash 必填`);
    }
  }
  // verify 和 steps 成对出现：只给 verify 而无 steps 无意义，反之则允许（纯交互不验证）。
  if (action.verify !== undefined && action.steps === undefined) at("actions[].verify 需要同时提供 steps");
  return errs;
}

// 从 title 派生稳定 id（中文保留、标点/空白→连字符），用于菜单展示与状态文件命名。
// 不写进画像，避免 id/title 双份维护。
function actionIdFromTitle(title) {
  return String(title)
    .toLowerCase()
    // 标点、空白、括号 → 连字符
    .replace(/[（）()<>：:、，,。！？!?""''「」【】\[\]\/\\|&*+=%$#@~^`\s]+/g, "-")
    // 其余非字母数字字符（含中文）保留
    .replace(/[^a-z0-9\u4e00-\u9fa5-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "action";
}

// 本地日期串（护栏日计数用，按本机时区）。
function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 护栏检查：interval（距上次导航）、daily_cap（今日导航次数）、external 动作要 --yes。
// 返回 {ok, reasons}——reasons 是给人看的拦截原因。
function checkGuards(action, state, now = new Date(), { yes = false } = {}) {
  const reasons = [];
  const g = (action && action.guards) || {};
  const st = state || {};
  if (g.side_effect === "external" && !yes) {
    reasons.push('这是外发动作（guards.side_effect="external"），真跑必须加 --yes（先 --dry 看计划）');
  }
  if (g.interval_s && (st.lastNavigationAt || st.lastSuccessAt)) {
    const last = new Date(st.lastNavigationAt || st.lastSuccessAt);
    if (!Number.isNaN(last.getTime())) {
      const elapsed = (now.getTime() - last.getTime()) / 1000;
      if (elapsed < g.interval_s) {
        reasons.push(`距上次导航仅 ${Math.round(elapsed)}s，护栏要求间隔 >= ${g.interval_s}s`);
      }
    }
  }
  const count = st.navigationDate === localDate(now) ? (st.navigationCount || 0) : (st.countDate === localDate(now) ? (st.count || 0) : 0);
  if (g.daily_cap && count >= g.daily_cap) {
    reasons.push(`今日已导航 ${count} 次，达到日上限 ${g.daily_cap}`);
  }
  return { ok: reasons.length === 0, reasons };
}

// 导航就绪后推进状态，不写业务成功时间或次数。
// recent 留最近 10 次参数作外发审计痕迹。
function bumpState(state, params, now = new Date()) {
  const prev = state || {};
  const today = localDate(now);
  const recent = Array.isArray(prev.recent) ? prev.recent.slice(-9) : [];
  recent.push({ at: now.toISOString(), params: params || {} });
  return {
    ...prev,
    lastNavigationAt: now.toISOString(),
    navigationDate: today,
    navigationCount: (prev.navigationDate === today ? (prev.navigationCount || 0) : (prev.countDate === today ? (prev.count || 0) : 0)) + 1,
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

// ---------------- 运行时 ----------------

function log(msg) {
  console.log("[action] " + msg);
}

function loadProfile(domain, root = PROFILES_ROOT) {
  if (!/^[a-zA-Z0-9.-]+$/.test(domain) || domain.includes("..")) throw new Error("非法画像域名");
  const file = path.join(root, `${domain}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`画像不存在：${file}`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function loadState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return null;
  }
}

function acquireActionStateLock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lockFile = file + ".lock";
  let descriptor;
  try {
    descriptor = fs.openSync(lockFile, "wx");
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    throw Object.assign(new Error("Action state is locked: " + lockFile + "; after a crash, verify no action is running before removing this lock"), { code: "ACTION_BUSY" });
  }
  try {
    fs.writeSync(descriptor, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  } catch (error) {
    fs.closeSync(descriptor);
    fs.unlinkSync(lockFile);
    throw error;
  }
  return () => {
    fs.closeSync(descriptor);
    fs.unlinkSync(lockFile);
  };
}

// 复用同源标签（有就复用，没有就按结晶 URL 开新的）——与 discover 的标签纪律一致。
// 路径路由 SPA（如 creator.douyin.com）修正：url 带具体路径且复用标签不在该
// 路径时必须真导航，否则后续操作全落在旧页面上（2026-11-01 实测 upload 任务
// 在 manage 页上打转）。url 只带域（Gmail 式 "/"）维持旧"纯复用"行为，
// 不折腾已打开的视图状态（如未发送的撰写窗口）。
async function findOrOpenTab(browser, entry) {
  const entryUrl = new URL(entry.url);
  if (!["http:", "https:"].includes(entryUrl.protocol)) throw new Error("action URL must use http(s)");
  const deadline = Date.now() + (entry.waitMs || 8000);
  const remaining = () => {
    const budget = deadline - Date.now();
    if (budget <= 0) throw Object.assign(new Error("Navigation deadline exceeded"), { code: "NAVIGATION_NOT_READY" });
    return budget;
  };
  const tabs = await browser.tabs({ timeoutMs: remaining() });
  const sameOrigin = tabs.filter((tab) => {
    try { return new URL(tab.url).origin === entryUrl.origin; } catch (_) { return false; }
  });
  // 标签池容错：同源标签逐个作为候选（整 URL 命中优先），附加探测失败
  // （DevTools 占用等报 "Debugger is not attached"）自动换下一个，全失败再新开。
  // 不把不可附加的用户标签当成错误扔给上层——那是程序该处理的琐事。
  const hrefOf = (tab) => { try { return new URL(tab.url).href; } catch (_) { return ""; } };
  const ordered = [
    ...sameOrigin.filter((tab) => hrefOf(tab) === entryUrl.href),
    ...sameOrigin.filter((tab) => hrefOf(tab) !== entryUrl.href),
  ];
  const attachError = (e) => /not attached|already attached/i.test(String((e && e.message) || ""));
  for (const tab of ordered) {
    try {
      // 可附加探测：一次轻量 evaluate；DevTools 占用等情况下 attach 会失败。
      await browser.cdp(tab.tabId, "Runtime.evaluate", { expression: "1", returnByValue: true }, { timeoutMs: Math.min(remaining(), 3000) });
      if (hrefOf(tab) === entryUrl.href) return { tabId: tab.tabId, reused: true, navigated: false };
      const budget = remaining();
      const result = await browser.call("navigate", { tabId: tab.tabId, url: entry.url, waitMs: budget }, { commandTimeoutMs: budget });
      if (result.loaded !== true) throw new Error("Navigation did not finish loading");
      return { tabId: tab.tabId, reused: true, navigated: true };
    } catch (e) {
      if (attachError(e)) continue; // 该标签不可附加，换下一个候选
      throw e;
    }
  }
  const budget = remaining();
  const opened = await browser.open(entry.url, { waitMs: budget, timeoutMs: budget });
  if (opened.loaded !== true) throw new Error("Navigation did not finish loading");
  return { tabId: opened.tabId, reused: false, navigated: true };
}

async function executeNavigation(browser, action, params, timeoutMs = 180000) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout must be positive and finite");
  const started = Date.now();
  const deadline = started + timeoutMs;
  const url = expandParams(action.url, params);
  const tab = await findOrOpenTab(browser, { url, waitMs: timeoutMs });
  let finalUrl = "";
  while (Date.now() < deadline) {
    const response = await browser.cdp(tab.tabId, "Runtime.evaluate", {
      expression: "({url:location.href,readyState:document.readyState})",
      returnByValue: true,
    }, { timeoutMs: Math.min(20000, Math.max(1, deadline - Date.now())) });
    const page = response?.result?.value;
    finalUrl = page?.url || "";
    if (page?.readyState === "complete" && finalUrl && new URL(finalUrl).href === new URL(url).href) {
      return { ok: true, ...tab, ready: true, taskSucceeded: false, outcome: "navigation-ready", finalUrl, elapsedMs: Date.now() - started };
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(200, Math.max(0, deadline - Date.now()))));
  }
  const error = new Error("Target page is not ready at the declared URL: " + finalUrl);
  error.code = "NAVIGATION_NOT_READY";
  throw error;
}

// ---------------- steps 步骤机（可选，交互原语全走扩展桥命令） ----------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// query-el 的返回包装：桥命令直接或包在 result.value 里，两种都取。
function unwrap(resp) {
  if (resp && resp.result && "value" in resp.result) return resp.result.value;
  return resp;
}

// 轮询到条件成立或超时；tolerateError 用于元素尚未出现时的查询。
async function pollUntil(fn, timeoutMs, gapMs = 400, tolerateError = false) {
  const end = Date.now() + timeoutMs;
  let lastErr = null;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (error) {
      lastErr = error;
      if (!tolerateError) throw error;
    }
    if (Date.now() > end) {
      const error = new Error("等待超时（" + timeoutMs + "ms）" + (lastErr ? "，最后错误：" + lastErr.message : ""));
      error.code = "POLL_TIMEOUT";
      throw error;
    }
    await sleep(gapMs);
  }
}

// 查元素信息（text/aria/disabled/visible），等它出现。
function queryInfo(browser, tabId, sel, timeoutMs) {
  return pollUntil(async () => {
    const info = unwrap(await browser.queryEl(tabId, sel));
    return info && info.found ? info : null;
  }, timeoutMs, 400, true);
}

// 执行单步。返回 {skipped?}；风险步在未确认时抛 ASK_USER（带问题文本），失败抛带 code 的错。
// confirmed=true 表示用户已就 ask 明确答复，该步按正常交互执行。
async function execStep(browser, tabId, st, params, stepTimeout, confirmed = false) {
  // unless：元素已存在 → 跳过（幂等）。
  if (st.unless) {
    let exists = false;
    try { exists = !!(await queryInfo(browser, tabId, st.unless, Math.min(stepTimeout, 3000))); } catch (_) {}
    if (exists) return { skipped: true };
  }

  // 风险步骤：未确认则停住，把 ask 交回上层向用户提问（不静默执行）。
  if (st.ask && !confirmed) {
    const error = new Error(st.ask);
    error.code = "ASK_USER";
    error.ask = st.ask;
    throw error;
  }

  const timeout = st.timeout || stepTimeout;
  if (st.do === "wait") {
    if (st.sel) await queryInfo(browser, tabId, st.sel, timeout);
    else await sleep(st.ms || 0);
    return {};
  }
  if (st.do === "navigate") {
    const url = expandParams(st.url, params);
    await browser.navigate(tabId, url, { waitMs: st.waitMs !== undefined ? st.waitMs : 8000 });
    return {};
  }
  if (st.do === "blur") {
    // 失焦即提交的输入组件：先聚焦目标（确保焦点在它上面）再 blur，触发 focusout
    // → React onBlur 应用筛选。省略 sel 时直接失焦当前 activeElement。
    if (st.sel) {
      await browser.run(tabId, "(function(){var e=document.querySelector(" + JSON.stringify(st.sel) + ");if(e&&e.focus){e.focus()}return 'ok'})()");
    }
    await browser.run(tabId, "(function(){var a=document.activeElement;if(a&&a.blur){a.blur()}return 'ok'})()");
    return {};
  }

  // click / type 前先查元素，做禁用检查与危险标签护栏。
  const info = await queryInfo(browser, tabId, st.sel, timeout);
  if (info.disabled) throw new Error(`目标被禁用：${st.sel}`);

  if (st.do === "click") {
    const label = `${info.text || ""} ${info.aria || ""}`.trim();
    const hit = labelViolates(label, st._neverWords || []);
    if (hit) {
      const error = new Error(`点击目标命中危险词「${hit}」，已中止：${st.sel}（label="${label.slice(0, 60)}"）`);
      error.code = "GUARD_BLOCKED";
      throw error;
    }
    await browser.click(tabId, { sel: st.sel }, { mode: st.mode === "cdp" ? "cdp" : "dom" });
    return {};
  }
  // type
  await browser.typeCss(tabId, st.sel, st._value, st.mode || "native");
  return {};
}

// verify：text（页面文字）/ exists（选择器）/ navigate（hash 到达）。
async function runVerify(browser, tabId, verify, params, defaultTimeout) {
  for (const [i, v] of (verify || []).entries()) {
    if (v.op === "navigate") {
      await browser.gotoHash(tabId, v.hash, v.reload !== false);
      await pollUntil(async () => {
        const raw = unwrap(await browser.run(tabId, "location.href+'|'+document.readyState"));
        return typeof raw === "string" && raw.includes(v.hash) && raw.endsWith("complete");
      }, v.waitMs || defaultTimeout, 500, true);
    } else if (v.op === "text") {
      const expect = expandParams(v.expect, params);
      await pollUntil(async () => {
        const text = unwrap(await browser.run(tabId, "document.body.innerText"));
        return typeof text === "string" && text.includes(expect);
      }, v.timeout || defaultTimeout, 600, true);
    } else if (v.op === "exists") {
      await queryInfo(browser, tabId, v.sel, v.timeout || defaultTimeout);
    }
    log(`verify[${i}] ${v.op} 通过`);
  }
}

// ---------------- main ----------------

function parseArgv(argv) {
  const rest = [];
  const params = {};
  let yes = false, dry = false, confirmed = false, timeoutMs = 180000, session = "", browserId = "", allowFailover = false;
  let print = false, emitScript = false, outPath = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--param") {
      const kv = String(argv[++i] ?? "");
      const at = kv.indexOf("=");
      if (at <= 0) throw new Error("--param 需要 k=v（值保持原始字符串，不做类型猜测）");
      params[kv.slice(0, at)] = kv.slice(at + 1);
    } else if (a === "--yes") yes = true;
    else if (a === "--confirmed") confirmed = true;
    else if (a === "--dry") dry = true;
    else if (a === "--print") print = true;
    else if (a === "--emit-script") emitScript = true;
    else if (a === "--out") {
      outPath = argv[++i];
      if (!outPath || outPath.startsWith("--")) throw new Error("--out requires a file path");
    }
    else if (a === "--timeout") {
      timeoutMs = Number(argv[++i]);
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout must be positive and finite");
    }
    else if (a === "--session") {
      session = argv[++i];
      if (!session || session.startsWith("--")) throw new Error("--session requires a session id");
    }
    else if (a === "--browser-id") {
      browserId = argv[++i];
      if (!browserId || browserId.startsWith("--")) throw new Error("--browser-id requires an identity from diag");
    }
    else if (a === "--allow-failover") allowFailover = true;
    else rest.push(a);
  }
  return { rest, params, yes, dry, confirmed, timeoutMs, session, browserId, allowFailover, print, emitScript, outPath };
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
      const id = actionIdFromTitle(a.title);
      return `${id}  ${a.title || ""}\n    side_effect=${side}  url: ${a.url}`;
    })
    .join("\n");
}

// 多 action 连批：子进程逐条执行，复用单条 action 的全部语义（护栏/ask/verify/状态），
// 首败即停并透传该条的退出码。连批不注入 deps（测试路径不受影响）。
function runBatch(domain, ids, options) {
  const { spawnSync } = require("node:child_process");
  const cli = path.resolve(__dirname, "..", "agent", "agent-collect.js");
  for (const [idx, id] of ids.entries()) {
    const argv = [cli, "actions", domain, id];
    for (const [k, v] of Object.entries(options.params || {})) argv.push("--param", `${k}=${v}`);
    if (options.yes) argv.push("--yes");
    if (options.dry) argv.push("--dry");
    if (options.confirmed) argv.push("--confirmed");
    if (options.timeoutMs !== 180000) argv.push("--timeout", String(options.timeoutMs));
    if (options.session) argv.push("--session", options.session);
    if (options.browserId) argv.push("--browser-id", options.browserId);
    if (options.allowFailover) argv.push("--allow-failover");
    console.error(`[batch] ${idx + 1}/${ids.length} → ${id}`);
    const r = spawnSync(process.execPath, argv, { stdio: "inherit" });
    const code = r.status == null ? 1 : r.status;
    if (code !== 0) {
      console.error(`[batch] ${id} 失败（exit ${code}），中止后续 ${ids.length - idx - 1} 条`);
      process.exitCode = code;
      return;
    }
    console.error(`[batch] ${id} ✓`);
  }
}

async function main(argv, deps = {}) {
  const parsed = parseArgv(argv);
  const { rest, params, yes, dry, confirmed, timeoutMs, session, browserId, allowFailover, print, emitScript, outPath } = parsed;
  const [domain, ...actionIds] = rest;
  if (!domain || !actionIds.length) {
    console.error("用法: node runner/actions.js <domain> <actionId|[actionId2 ...]|list> [--param k=v ...] [--yes] [--dry] [--print] [--emit-script [--out path]] [--session sid] [--timeout ms]");
    process.exit(1);
  }
  // 多 action 顺序连批：逐条以子进程执行，首败即停。
  if (actionIds.length > 1) {
    if (actionIds.includes("list")) {
      console.error("list 不能与其它 actionId 混用");
      process.exit(1);
    }
    if (print || emitScript) {
      console.error("--print/--emit-script 只支持单 action");
      process.exit(1);
    }
    runBatch(domain, actionIds, { params, yes, dry, confirmed, timeoutMs, session, browserId, allowFailover });
    return;
  }
  const actionId = actionIds[0];

  const profile = await (deps.loadProfile || loadProfile)(domain);
  if (actionId === "list") {
    console.log(formatActionMenu(profile));
    process.exit(0);
  }
  const action = (profile.actions || []).find(
    (a) => actionIdFromTitle(a.title) === actionId,
  );
  if (!action) {
    const have = (profile.actions || []).map((a) => actionIdFromTitle(a.title)).join(", ") || "（无）";
    console.error(`画像 ${domain} 里没有 action「${actionId}」（现有：${have}；\`list\` 可查全菜单）`);
    console.error(CRYSTALLIZE_HINT);
    process.exit(1);
  }

  const errs = validateAction(action);
  if (errs.length) {
    console.error("action 校验失败：\n  " + errs.join("\n  "));
    process.exit(1);
  }

  // 参数声明扫描 action 全部 {param} 模板位：url + steps.value/steps.url + verify.expect
  // （url 只是入口，参数可能只出现在步骤/验证里——如搜索 action 的 q 在 type.value）。
  const declared = new Set(
    [action.url]
      .concat((action.steps || []).flatMap((st) => [st.value, st.url]))
      .concat((action.verify || []).map((v) => v.expect))
      .filter((s) => typeof s === "string")
      .flatMap((s) => (s.match(/{([a-zA-Z0-9_]+)}/g) || []).map((t) => t.slice(1, -1))),
  );
  const missing = [...declared].filter((k) => !params[k]);

  // 生成器：--print 输出等价的单行命令；--emit-script 生成参数化 bash 包装脚本。
  // 生成物一律包装解释器（actions 命令），不拆步骤——语义零损失：ask 照停、
  // guards.never 照拦、verify 照验、状态照回写。
  if (print || emitScript) {
    const names = [...declared];
    if (print) {
      const parts = ["node", "agent/agent-collect.js", "actions", domain, actionId];
      for (const k of names) parts.push("--param", `"${k}=${params[k] || "{" + k + "}"}"`);
      console.log(parts.join(" "));
      process.exit(0);
    }
    const cliAbs = path.resolve(__dirname, "..", "agent", "agent-collect.js");
    const bashParams = names
      .map((k, i) => '--param "' + k + '=${' + (i + 1) + ":?缺参数 " + k + '}"')
      .join(" ");
    const body = [
      "#!/usr/bin/env bash",
      `# 由画像生成：${domain} / ${action.title || actionId}（${new Date().toISOString().slice(0, 10)}）`,
      `# 改行为请改画像后重新生成，勿手改本文件。参数（按顺序）：${names.join(" ") || "（无）"}`,
      "set -euo pipefail",
      'node "' + cliAbs.replace(/"/g, '\\"') + '" actions ' + domain + " " + actionId + (bashParams ? " " + bashParams : ""),
      "",
    ].join("\n");
    if (outPath) {
      fs.writeFileSync(path.resolve(outPath), body, "utf8");
      console.error("已生成: " + path.resolve(outPath));
    } else {
      process.stdout.write(body);
    }
    process.exit(0);
  }

  // 护栏状态与检查。--dry 永不执行也不拦截退出码：它只如实展示「真跑会被什么拦」，
  // 拦截决定发生在真跑分支（--yes/interval/cap 在那里硬拦）。
  const sFile = (deps.stateFileFor || stateFileFor)(domain, actionId);
  const state = loadState(sFile);
  const guard = checkGuards(action, state, new Date(), { yes });
  if (dry) {
    console.log("== dry 计划 ==");
    console.log(JSON.stringify({ domain, actionId, params, url: action.url, guards: action.guards || {}, guard, missingParams: missing, steps: (action.steps || []).length, verify: (action.verify || []).length }, null, 2));
    if (!guard.ok) {
      console.log("注意：按当前状态真跑会被拦 ——\n  " + guard.reasons.join("\n  "));
    }
    for (const [i, st] of (action.steps || []).entries()) {
      const shown = { ...st };
      if (typeof shown.value === "string") shown.value = expandParams(shown.value, params);
      if (typeof shown.url === "string") shown.url = expandParams(shown.url, params);
      console.log(`  step ${i}: ${JSON.stringify(shown)}${st.ask ? `  ← 待用户确认：${st.ask}` : ""}`);
    }
    for (const v of action.verify || []) console.log(`  verify: ${JSON.stringify(v)}`);
    if (state) {
      const { recent, ...slimState } = state; // recent 是外发审计痕迹，计划展示用不上
      console.log("状态: " + JSON.stringify(slimState));
    }
    process.exit(0);
  }
  if (missing.length) {
    console.error("缺参数：" + missing.map((k) => `--param ${k}=?`).join(" "));
    process.exit(1);
  }
  if (!guard.ok) {
    console.error("护栏拦截：\n  " + guard.reasons.join("\n  "));
    process.exit(2);
  }

  const releaseStateLock = acquireActionStateLock(sFile);
  let browser;
  const trace = [];
  try {
    const currentState = loadState(sFile);
    const currentGuard = checkGuards(action, currentState, new Date(), { yes });
    if (!currentGuard.ok) {
      console.error("护栏拦截：" + currentGuard.reasons.join("; "));
      process.exitCode = 2;
      return;
    }
    const started = Date.now();
    browser = await (deps.connect || connect)({ ...(session ? { session } : {}), browserId, allowFailover, waitMs: timeoutMs, chainDeadlineMs: timeoutMs });
    const remaining = timeoutMs - (Date.now() - started);
    if (remaining <= 0) throw new Error("Action connection deadline exceeded");
    const result = await executeNavigation(browser, action, params, remaining);

    // 纯导航 action：只核验页面就绪即止。
    const hasSteps = Array.isArray(action.steps) && action.steps.length > 0;
    if (!hasSteps) {
      const next = {
        ...bumpState(currentState, params, new Date()),
        lastNavigation: { params, finalUrl: result.finalUrl },
      };
      fs.mkdirSync(path.dirname(sFile), { recursive: true });
      (deps.writeState || writeJsonAtomic)(sFile, next);
      log("页面已就绪；业务任务尚未执行或验证");
      console.log(JSON.stringify(result, null, 2));
      return result;
    }

    // 带 steps：展开参数与护栏词表，逐步执行；每步带索引进 trace。
    const neverWords = (action.guards && action.guards.never) || [];
    const steps = action.steps.map((st) => ({
      ...st,
      _value: typeof st.value === "string" ? expandParams(st.value, params) : st.value,
      _neverWords: neverWords,
    }));
    const stepTimeout = 15000;
    for (const [i, st] of steps.entries()) {
      try {
        const r = await execStep(browser, result.tabId, st, params, stepTimeout, confirmed);
        trace.push({ step: i, do: st.do, ok: true, skipped: !!r.skipped });
        log(`step ${i} ${st.do}${r.skipped ? "（unless 跳过）" : ""} ✓ ${(st.note || "").slice(0, 40)}`);
      } catch (error) {
        error.stepIndex = i;
        throw error;
      }
    }
    await runVerify(browser, result.tabId, action.verify, params, stepTimeout);

    // steps + verify 全过才记成功状态（纯导航仍按导航计数，语义见 docblock）。
    const next = {
      ...bumpState(currentState, params, new Date()),
      lastNavigation: { params, finalUrl: result.finalUrl },
      lastSteps: { count: steps.length, at: new Date().toISOString() },
    };
    fs.mkdirSync(path.dirname(sFile), { recursive: true });
    (deps.writeState || writeJsonAtomic)(sFile, next);
    const out = { ...result, taskSucceeded: true, outcome: "steps-verified", steps: trace };
    log(`steps 执行完成（${steps.length} 步），verify 全过`);
    console.log(JSON.stringify(out, null, 2));
    return out;
  } catch (e) {
    // ASK_USER：风险步待确认——返回问题与已完成 trace，退出码 4，不写状态、不误报失败。
    if (e.code === "ASK_USER") {
      const out = {
        ok: false, code: "ASK_USER", ask: e.ask, stepIndex: e.stepIndex,
        hint: "用户确认后加 --confirmed 重跑；确认不落盘，一次一确认",
        trace,
      };
      console.error(JSON.stringify(out, null, 2));
      process.exitCode = 4;
      return out;
    }
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
    try {
      if (browser) await browser.close();
    } finally {
      releaseStateLock();
    }
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => {
    console.error("[action] 失败: " + (e && e.message ? e.message : e));
    process.exitCode = 1;
  });
}

// ---------------- 测试出口（纯函数） ----------------
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
  loadProfile,
  loadState,
  parseArgv,
  actionIdFromTitle,
  formatActionMenu,
  findOrOpenTab,
  executeNavigation,
  execStep,
  runVerify,
  pollUntil,
  STEP_OPS,
  TYPE_MODES,
  VERIFY_OPS,
};
