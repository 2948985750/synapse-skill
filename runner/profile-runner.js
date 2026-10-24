#!/usr/bin/env node
"use strict";
// Profile runner: execute one recipe from a site profile against the real
// browser, through the agent API (no shell, no argv quoting).
//
//   node runner/profile-runner.js --profile profiles/upwork.com.json \
//        --task search --param q="AI automation" --param page=1 --limit 10
//
// The profile supplies: the URL template, the in-page extraction script, the
// required fields and minItems. This runner supplies: parameter rendering,
// tab lifecycle, extraction, validation and output.
//
// Exit codes: 0 ok, 2 data validation failed, 1 execution error.
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const AGENT = path.join(ROOT, "agent", "api.js");

// ---------------- pure helpers（也用于 test-runner.js） ----------------
function getOpt(argv, name, fallback) {
  const i = argv.indexOf(name);
  if (i < 0) return fallback;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) throw new Error(name + " 缺少参数值");
  return v;
}

// Collect repeated "--param k=v" flags. Values are strings; numeric-looking
// values are left as strings on purpose (page numbers are interpolated, not
// compared).
function parseParams(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--param") continue;
    const kv = argv[i + 1];
    if (kv === undefined) throw new Error("--param 缺少 k=v");
    const at = kv.indexOf("=");
    if (at <= 0) throw new Error("--param 需要 k=v 形式: " + kv);
    out[kv.slice(0, at)] = kv.slice(at + 1);
  }
  return out;
}

// Render ${name} placeholders. Every value is URI-encoded (query-string
// semantics); an absolute URL assigned to a whole placeholder is passed through
// untouched, because encoding it would break navigation templates.
function renderTemplate(template, params = {}) {
  return String(template).replace(/\$\{([A-Za-z0-9_]+)\}/g, (_, name) => {
    if (!Object.prototype.hasOwnProperty.call(params, name) || params[name] === undefined) {
      throw new Error("画像 URL 缺参数 " + name + "（用 --param " + name + "=... 提供）");
    }
    const value = String(params[name]);
    if (/^https?:\/\//i.test(value)) return value;
    return encodeURIComponent(value);
  });
}

function validateProfile(profile) {
  if (!profile || typeof profile !== "object") throw new Error("画像不是对象");
  if (![1, 2].includes(profile.schemaVersion)) {
    throw new Error("不支持的 schemaVersion: " + profile.schemaVersion);
  }
  if (typeof profile.domain !== "string" || !profile.domain.trim()) {
    throw new Error("画像缺 domain");
  }
  if (!Array.isArray(profile.recipes) || !profile.recipes.length) {
    throw new Error("画像没有 recipes");
  }
  const seen = new Set();
  for (const r of profile.recipes) {
    if (!r || typeof r.purpose !== "string" || !r.purpose) throw new Error("recipe 缺 purpose");
    if (seen.has(r.purpose)) throw new Error("recipe purpose 重复: " + r.purpose);
    seen.add(r.purpose);
    const e = r.execution;
    if (!e || e.kind !== "dom-extract") {
      throw new Error("recipe " + r.purpose + " 只支持 dom-extract（当前：" + (e && e.kind) + "）");
    }
    if (typeof e.openUrlTemplate !== "string" || !e.openUrlTemplate) {
      throw new Error("recipe " + r.purpose + " 缺 openUrlTemplate");
    }
    if (typeof e.extractJs !== "string" || !e.extractJs.trim()) {
      throw new Error("recipe " + r.purpose + " 缺 extractJs");
    }
  }
  return profile;
}

function getRecipe(profile, purpose) {
  const recipe = profile.recipes.find((r) => r.purpose === purpose);
  if (!recipe) {
    throw new Error("画像没有 recipe: " + purpose + "（可用：" + profile.recipes.map((r) => r.purpose).join(", ") + "）");
  }
  return recipe;
}

function isEmpty(value) {
  return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
}

// requiredFields missing + minItems; `limit` only caps output, never becomes a
// floor (that was a real bug in the old executor).
function validateItems(items, execution, { limit } = {}) {
  const list = Array.isArray(items) ? items : [];
  const selected = limit === undefined ? list : list.slice(0, limit);
  const required = execution.requiredFields || [];
  const minItems = Number.isFinite(execution.minItems) ? execution.minItems : 1;
  const missing = [];
  for (const item of selected) {
    const absent = required.filter((f) => isEmpty(item && item[f]));
    if (absent.length) missing.push({ fields: absent, item });
  }
  const got = selected.length;
  const ok = got > 0 && got >= minItems && missing.length === 0;
  const state = got === 0 ? "blank" : ok ? "ok" : "invalid";
  const reason = got === 0
    ? "画像要求至少 " + minItems + " 条，实际 0 条"
    : missing.length
      ? "缺字段: " + missing[0].fields.join(",")
      : got < minItems
        ? "条数不足: " + got + " < " + minItems
        : "";
  return { ok, state, got, missing: missing.length, reason, items: selected };
}

// Resolve the collection scope: recipe defaults, explicit --param/--limit
// overrides, the hard cap, and the write guard. Pure: nothing is opened here.
function resolveScope(recipe, argv) {
  const params = { ...(recipe.defaults || {}), ...parseParams(argv) };
  const limitText = getOpt(argv, "--limit");
  const effectiveLimit = limitText === undefined
    ? (recipe.defaults && recipe.defaults.limit !== undefined ? Number(recipe.defaults.limit) : undefined)
    : Number(limitText);
  if (effectiveLimit !== undefined && (!Number.isFinite(effectiveLimit) || effectiveLimit <= 0)) {
    throw new Error("--limit 必须是正整数");
  }
  const maxLimit = Number(recipe.maxLimit || 50);
  if (effectiveLimit !== undefined && effectiveLimit > maxLimit) {
    throw new Error("--limit 超过画像上限 maxLimit=" + maxLimit + "（想要更多请改画像）");
  }
  if (recipe.writes === true && !argv.includes("--allow-write")) {
    throw new Error("recipe 是写操作，需显式 --allow-write");
  }
  const scope = {
    page: params.page === undefined ? null : Number(params.page),
    limit: effectiveLimit === undefined ? null : effectiveLimit,
    maxLimit,
    showMore: false,
    pages: 1,
  };
  return { limit: effectiveLimit, params, scope };
}

// ---------------- CLI ----------------
async function main(argv = process.argv.slice(2), deps = {}) {
  const profilePath = getOpt(argv, "--profile");
  const task = getOpt(argv, "--task");
  if (!profilePath || !task) {
    console.error("用法: profile-runner.js --profile <画像> --task <purpose> [--param k=v ...] [--limit N] [--out 文件] [--session sid] [--keep-tab]");
    return 1;
  }
  const profile = validateProfile(
    JSON.parse(fs.readFileSync(path.resolve(ROOT, profilePath), "utf8")),
  );
  const recipe = getRecipe(profile, task);
  const { limit, params, scope } = resolveScope(recipe, argv);
  const session = getOpt(argv, "--session", "");
  const keepTab = argv.includes("--keep-tab");
  const outPath = getOpt(argv, "--out", path.join("out", profile.domain, task + ".json"));
  const settleMs = Number(getOpt(argv, "--settle", String(recipe.execution.settleMs || 2500)));

  const url = renderTemplate(recipe.execution.openUrlTemplate, params);
  const { connect } = deps.connect ? deps : require(AGENT);
  const browser = await connect(session ? { session } : {});
  const log = deps.log || ((m) => console.error("[profile] " + m));
  let tabId = null;
  try {
    log("open " + url);
    const opened = await browser.open(url, { waitMs: 8000 });
    tabId = opened.tabId;
    if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs));
    // SPA pages can finish loading before their list renders: retry briefly.
    const retryUntil = Date.now() + Number(getOpt(argv, "--retry-ms", "6000"));
    let items = [];
    for (;;) {
      const raw = await browser.run(tabId, recipe.execution.extractJs);
      const value = raw && raw.result ? raw.result.value : raw;
      items = typeof value === "string" ? JSON.parse(value) : value;
      if (!Array.isArray(items)) items = [];
      if (items.length > 0 || Date.now() >= retryUntil) break;
      log("no items yet, retrying extraction");
      await new Promise((r) => setTimeout(r, 800));
    }
    const result = validateItems(items, recipe.execution, { limit });
    // Some sites answer a no-match query with unrelated recommendations.
    // When the recipe names its query param, require at least half of the items
    // to mention one of its tokens; otherwise the data is off-query garbage.
    const matchParam = recipe.execution.matchQuery;
    if (result.ok && matchParam) {
      const tokens = String(params[matchParam] || "")
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length >= 2);
      if (tokens.length) {
        const hits = result.items.filter((it) => {
          const hay = [it.title, it.name, it.desc, it.description, it.headline,
            Array.isArray(it.skills) ? it.skills.join(" ") : ""].filter(Boolean).join(" ").toLowerCase();
          return tokens.some((t) => hay.includes(t));
        }).length;
        if (hits * 2 < result.items.length) {
          result.ok = false;
          result.state = "off-query";
          result.reason = "结果与查询无关（命中 " + hits + "/" + result.items.length + "），站点可能回退到推荐岗位";
        }
      }
    }
    const outFile = path.resolve(ROOT, outPath);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(result.items, null, 2) + "\n", "utf8");
    console.log(JSON.stringify({
      ok: result.ok,
      state: result.state,
      task,
      domain: profile.domain,
      url,
      got: result.got,
      scope,
      missing: result.missing,
      reason: result.reason,
      out: outFile,
    }));
    return result.ok ? 0 : 2;
  } finally {
    if (tabId != null && !keepTab) {
      try {
        await browser.closeTab(tabId);
      } catch (_) {}
    }
    await browser.close().catch(() => {});
  }
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((e) => {
    console.error("[profile] 失败: " + (e && e.message ? e.message : e));
    process.exitCode = 1;
  });
}

module.exports = { renderTemplate, validateProfile, getRecipe, validateItems, parseParams, resolveScope, main };
