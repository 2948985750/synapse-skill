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
// 动作执行 = 校验 → 护栏 → 参数展开 → 导航到结晶 URL → 记状态。
//
// 用法：
//   node runner/actions.js <domain> <actionId|list> [--param k=v ...] [--yes] [--dry] [--timeout ms] [--session sid]
//
// Exit codes: 0 成功；1 用法/画像/action 校验失败；2 护栏拦截；3 导航/执行失败（agent 接管点）。
const fs = require("fs");
const path = require("path");

const { PROFILES_ROOT, DATA_ROOT } = require("../agent/paths");
const { isDangerousLabel } = require("./discover");
const { connect } = require("../agent/api");
const { writeJsonAtomic } = require("../agent/lib/json-store");

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
  const existing = sameOrigin.find((tab) => new URL(tab.url).href === entryUrl.href) || sameOrigin[0];
  if (existing) {
    if (new URL(existing.url).href === entryUrl.href) return { tabId: existing.tabId, reused: true, navigated: false };
    const budget = remaining();
    const result = await browser.call("navigate", { tabId: existing.tabId, url: entry.url, waitMs: budget }, { commandTimeoutMs: budget });
    if (result.loaded !== true) throw new Error("Navigation did not finish loading");
    return { tabId: existing.tabId, reused: true, navigated: true };
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

// ---------------- main ----------------

function parseArgv(argv) {
  const rest = [];
  const params = {};
  let yes = false, dry = false, timeoutMs = 180000, session = "", browserId = "", allowFailover = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--param") {
      const kv = String(argv[++i] ?? "");
      const at = kv.indexOf("=");
      if (at <= 0) throw new Error("--param 需要 k=v（值保持原始字符串，不做类型猜测）");
      params[kv.slice(0, at)] = kv.slice(at + 1);
    } else if (a === "--yes") yes = true;
    else if (a === "--dry") dry = true;
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
  return { rest, params, yes, dry, timeoutMs, session, browserId, allowFailover };
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

async function main(argv, deps = {}) {
  const { rest, params, yes, dry, timeoutMs, session, browserId, allowFailover } = parseArgv(argv);
  const [domain, actionId] = rest;
  if (!domain || !actionId) {
    console.error("用法: node runner/actions.js <domain> <actionId|list> [--param k=v ...] [--yes] [--dry] [--session sid] [--timeout ms]");
    process.exit(1);
  }

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

  // 参数声明来自 url 里的 {param} 模板（不再要求独立的 params 字段）。
  const declared = new Set((action.url.match(/{([a-zA-Z0-9_]+)}/g) || []).map((t) => t.slice(1, -1)));
  const missing = [...declared].filter((k) => !params[k]);

  // 护栏状态与检查。--dry 永不执行也不拦截退出码：它只如实展示「真跑会被什么拦」，
  // 拦截决定发生在真跑分支（--yes/interval/cap 在那里硬拦）。
  const sFile = (deps.stateFileFor || stateFileFor)(domain, actionId);
  const state = loadState(sFile);
  const guard = checkGuards(action, state, new Date(), { yes });
  if (dry) {
    console.log("== dry 计划 ==");
    console.log(JSON.stringify({ domain, actionId, params, url: action.url, guards: action.guards || {}, guard, missingParams: missing }, null, 2));
    if (!guard.ok) {
      console.log("注意：按当前状态真跑会被拦 ——\n  " + guard.reasons.join("\n  "));
    }
    if (state) console.log("状态: " + JSON.stringify(state));
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

  if (profile.status === "draft") throw new Error("画像仍是 draft，请先人工审阅并确认后再执行");
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
    const now = new Date();
    const next = {
      ...bumpState(currentState, params, now),
      lastNavigation: { params, finalUrl: result.finalUrl },
    };
    fs.mkdirSync(path.dirname(sFile), { recursive: true });
    (deps.writeState || writeJsonAtomic)(sFile, next);
    log("页面已就绪；业务任务尚未执行或验证");
    console.log(JSON.stringify(result, null, 2));
    return result;
  } catch (e) {
    const out = {
      ok: false,
      error: e.message,
      code: e.code || "ACTION_FAILED",
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
};
