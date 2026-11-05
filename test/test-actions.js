"use strict";
// actions.js 纯函数单测（浏览器无关）+ 画像 actions 结构断言。
// 锁住的是护栏逻辑：参数展开、schema 校验、间隔/日上限/--yes、never 词表、
// 状态推进（只有成功才计数）、以及「画像里存的是数据不是代码」的结构边界。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const {
  expandParams,
  validateAction,
  checkGuards,
  bumpState,
  labelViolates,
  stateFileFor,
  localDate,
  jsClickRect,
  loadProfile,
  resolveEntry,
  parseArgv,
} = require("../runner/actions");

// ---------------- expandParams ----------------

test("expandParams: 替换已知、缺参报错、无模板原样返回", () => {
  assert.equal(expandParams("{to} <x@y.z>", { to: "a@b.c" }), "a@b.c <x@y.z>");
  assert.equal(expandParams("无模板", { to: "a@b.c" }), "无模板");
  assert.equal(expandParams("{}", {}), "{}"); // 空花括号不是模板
  assert.equal(expandParams("{lower}和{under_1}", { lower: "A", under_1: "B" }), "A和B");
  assert.throws(() => expandParams("{missing}", {}), /missing/);
  assert.throws(() => expandParams("{to}", { to: "  " }), /缺失的参数/);
});

// ---------------- validateAction ----------------

test("validateAction: 合法 action 零错误", () => {
  const errs = validateAction({
    title: "发信",
    url: "https://mail.google.com/mail/u/0/#compose",
    guards: { side_effect: "external", interval_s: 90, daily_cap: 40, never: ["删除"] },
  });
  assert.deepEqual(errs, []);
});

test("validateAction: 合法结构；坏 guards、缺 url/title 都被抓", () => {
  const errs1 = validateAction({
    title: "x",
    url: "https://a.com",
    guards: { side_effect: "maybe", interval_s: -1, never: "删除" },
  });
  assert.ok(errs1.length >= 2, "应抓全所有错误，实际 " + errs1.length);
  assert.ok(errs1.some((e) => e.includes("side_effect")));
  assert.ok(errs1.some((e) => e.includes("interval_s")));
  assert.ok(errs1.some((e) => e.includes("never")));

  const errs2 = validateAction({});
  assert.ok(errs2.some((e) => e.includes("title 必填")));

  const errs3 = validateAction({ title: "x" });
  assert.ok(errs3.some((e) => e.includes("url 必填")));
});

// ---------------- checkGuards ----------------

const NOW = new Date("2026-11-01T10:00:00");

test("checkGuards: external 无 --yes 拦截、interval 未到拦截、daily_cap 顶格拦截", () => {
  const action = { guards: { side_effect: "external", interval_s: 90, daily_cap: 40 } };

  const noYes = checkGuards(action, null, NOW, { yes: false });
  assert.equal(noYes.ok, false);
  assert.ok(noYes.reasons[0].includes("--yes"));

  const fresh = checkGuards(action, null, NOW, { yes: true });
  assert.equal(fresh.ok, true);

  // 上次成功 30s 前 < interval 90s → 拦
  const recent = checkGuards(
    action,
    { lastSuccessAt: "2026-11-01T09:59:30", countDate: localDate(NOW), count: 1 },
    NOW,
    { yes: true },
  );
  assert.equal(recent.ok, false);
  assert.ok(recent.reasons.some((r) => r.includes("间隔")));

  // 上次成功 100s 前 ≥ 90s → 过
  const old = checkGuards(
    action,
    { lastSuccessAt: "2026-11-01T09:58:20", countDate: localDate(NOW), count: 1 },
    NOW,
    { yes: true },
  );
  assert.equal(old.ok, true);

  // 今日已 40 次 = 顶格 → 拦；39 次 → 过
  const capped = checkGuards(
    action,
    { countDate: localDate(NOW), count: 40 },
    NOW,
    { yes: true },
  );
  assert.equal(capped.ok, false);
  assert.ok(capped.reasons[0].includes("日上限"));
  const under = checkGuards(
    action,
    { countDate: localDate(NOW), count: 39 },
    NOW,
    { yes: true },
  );
  assert.equal(under.ok, true);
});

test("checkGuards: 昨天的计数不影响今日上限；external 拦截与 dry 解耦（dry 分支自行展示不拦退出）", () => {
  const action = { guards: { side_effect: "external", daily_cap: 40 } };
  const yesterday = checkGuards(
    action,
    { countDate: "2026-10-31", count: 999 },
    NOW,
    { yes: true },
  );
  assert.equal(yesterday.ok, true); // 跨日清零
  const noYes = checkGuards(action, null, NOW, { yes: false });
  assert.equal(noYes.ok, false); // checkGuards 本身无 dry 概念，真跑必须拦
});

// ---------------- bumpState ----------------

test("bumpState: 首次/同日累加/跨日清零，recent 留审计痕迹且封顶 10", () => {
  const first = bumpState(null, { to: "a@b.c" }, NOW);
  assert.equal(first.count, 1);
  assert.equal(first.countDate, "2026-11-01");
  assert.equal(first.lastSuccessAt, NOW.toISOString());
  assert.deepEqual(first.recent, [{ at: NOW.toISOString(), params: { to: "a@b.c" } }]);

  const later = new Date("2026-11-01T10:05:00");
  const second = bumpState(first, { to: "d@e.f" }, later);
  assert.equal(second.count, 2);
  assert.equal(second.recent.length, 2);

  const nextDay = bumpState(first, { to: "d@e.f" }, new Date("2026-11-02T09:00:00"));
  assert.equal(nextDay.count, 1); // 跨日清零

  let s = null;
  for (let i = 0; i < 25; i++) s = bumpState(s, { i: String(i) }, new Date(2026, 10, 1, 10, i));
  assert.equal(s.recent.length, 10);
  assert.equal(s.recent.at(-1).params.i, "24");
});

// ---------------- labelViolates ----------------

test("labelViolates: 全局危险词 + 私有 never，命中返回词，放行返回 null", () => {
  assert.equal(labelViolates("永久删除", ["撤回"]), "删除");
  assert.equal(labelViolates("撤回邮件", ["撤回"]), "撤回");
  assert.equal(labelViolates("发送 ‪(Ctrl+Enter)‬", ["删除", "撤回"]), null);
  assert.equal(labelViolates("Send", []), null);
  assert.equal(labelViolates("Save to drafts 存草稿", ["存草稿"]), "存草稿");
  // 私有词表不做词边界（substring），全局词表保留词边界——两者语义不同
  assert.equal(labelViolates("remover", ["remove"]), "remove");
  assert.equal(labelViolates("remover", []), null);
});

// ---------------- 页内表达式（审计：注入的 JS 必须是自包含只读/单点动作） ----------------

test("validateAction: guards.never 必须是数组；其他结构无需额外测试", () => {
  const ok = validateAction({
    title: "x",
    url: "https://a.com",
    guards: { side_effect: "local", never: ["删除"] },
  });
  assert.deepEqual(ok, []);

  const errs = validateAction({
    title: "x",
    url: "https://a.com",
    guards: { never: "删除" }, // 必须是数组
  });
  assert.equal(errs.length, 1);
  assert.ok(errs.some((e) => e.includes("never")));
});

test("jsClickRect: 只读定位探针——scrollIntoView + 返回视口 rect，值经 JSON 内嵌", () => {
  const expr = jsClickRect("div.row");
  assert.ok(expr.includes("scrollIntoView"));
  assert.ok(expr.includes("getBoundingClientRect"));
  assert.ok(!expr.includes(".click()")); // 只定位不点击，点击由 Input 域做
  assert.ok(expr.includes(JSON.stringify("div.row")));
});

test("镜像债：skill 侧不再有 DOM 交互构造器（全部归扩展侧 page-actions.js）", () => {
  const actions = require("../runner/actions");
  const gestures = require("../agent/gestures");
  // 这些曾经在 runner/actions.js 里，迁移后不应再出现
  assert.ok(!("jsQueryInfo" in actions), "jsQueryInfo 已迁移到扩展 query-el");
  assert.ok(!("jsClick" in actions), "jsClick 已迁移到扩展 gesture(click)");
  assert.ok(!("jsType" in actions), "jsType 已迁移到扩展 type-css");
  assert.ok(!("jsGoto" in actions), "jsGoto 已迁移到扩展 goto-hash");
  // 手势层变薄：不再持有 collector/quiet/guard 源码镜像
  assert.ok(!("COLLECTOR_SRC" in gestures), "COLLECTOR_SRC 镜像已清理");
  assert.ok(!("QUIET_SRC" in gestures), "QUIET_SRC 镜像已清理");
  assert.ok(!("GUARD_SRC" in gestures), "GUARD_SRC 镜像已清理");
  assert.ok(!("GESTURE_BODIES" in gestures), "GESTURE_BODIES 已迁移到扩展");
  assert.ok(!("EL_CANDIDATE_SEL" in gestures), "EL_CANDIDATE_SEL 已迁移到扩展");
  // 只留薄信号层
  assert.ok(typeof gestures.buildGestureExpr === "function");
  assert.ok(typeof gestures.isAsyncAct === "function");
});

// ---------------- navigate 步骤 + entry 参数化 ----------------

test("validateAction: url 模板占位符合规范", () => {
  const ok = validateAction({
    title: "x",
    url: "https://a.com/?q={query}",
    guards: { side_effect: "local" },
  });
  assert.deepEqual(ok, []);
});

test("resolveEntry + expandParams: entry.url 的 {param} 模板可展开（douyin /video/{id}、xhs 用户页）", () => {
  const { resolveEntry } = require("../runner/actions");
  const e1 = resolveEntry({ entry: { url: "https://www.douyin.com/video/{id}" } }, "douyin.com");
  assert.equal(expandParams(e1.url, { id: "7703162648518533247" }), "https://www.douyin.com/video/7703162648518533247");
  const e2 = resolveEntry({}, "douyin.com"); // 无 entry → 域根
  assert.equal(e2.url, "https://douyin.com/");
  const e3 = resolveEntry({ entry: { url: "https://www.xiaohongshu.com/user/profile/{user_id}", waitMs: 4000 } }, "xiaohongshu.com");
  assert.equal(e3.waitMs, 4000);
});

// ---------------- parseArgv / stateFileFor ----------------

test("parseArgv: --param 值保持原始字符串不做类型猜测；旗标齐活", () => {
  const p = parseArgv([
    "mail.google.com", "send-mail",
    "--param", "to=a@b.c",
    "--param", "num=00123",   // 前导零：必须还是字符串
    "--param", "s=x=y",        // 值里可以有 =（首个 = 才是分隔）
    "--yes", "--dry", "--draft", "--timeout", "9999",
  ]);
  assert.deepEqual(p.rest, ["mail.google.com", "send-mail"]);
  assert.deepEqual(p.params, { to: "a@b.c", num: "00123", s: "x=y" });
  assert.equal(p.yes, true);
  assert.equal(p.dry, true);
  assert.equal(p.draft, true);
  assert.equal(p.timeoutMs, 9999);
  assert.throws(() => parseArgv(["--param", "noequals"]), /k=v/);
});

test("stateFileFor: 落数据根 action-state/，domain/actionId 非法字符被清洗", () => {
  const f = stateFileFor("mail.google.com", "send-mail");
  assert.ok(f.includes(path.join("action-state", "mail.google.com__send-mail.json")));
  assert.ok(stateFileFor("../../evil", "a/b").startsWith(path.join(require("../agent/paths").DATA_ROOT, "action-state")));
});

// ---------------- 画像结构断言（漂移守卫） ----------------

test("画像结构: 所有含 actions 的画像都是合法数据（title + url + guards）", () => {
  const profilesRoot = path.join(__dirname, "..", "profiles");
  const files = ["mail.google.com.json"];
  const draftDir = path.join(profilesRoot, "draft");
  for (const f of fs.existsSync(draftDir) ? fs.readdirSync(draftDir) : []) {
    if (f.endsWith(".json")) files.push("draft/" + f);
  }
  let checked = 0;
  for (const rel of files) {
    const full = path.join(profilesRoot, rel);
    if (!fs.existsSync(full)) continue;
    const profile = JSON.parse(fs.readFileSync(full, "utf8"));
    for (const action of profile.actions || []) {
      checked++;
      const errs = validateAction(action);
      assert.deepEqual(errs, [], `${rel}#${action.title} schema: ` + errs.join("; "));
    }
  }
  assert.ok(checked >= 1, "至少应检查到一个 action");
});

test("画像结构: send-mail action 存在且结构正确", () => {
  const profilePath = path.join(__dirname, "..", "profiles", "mail.google.com.json");
  if (!fs.existsSync(profilePath)) {
    assert.ok(true, "mail.google.com.json 暂不存在，跳过");
    return;
  }
  const profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
  const a = profile.actions.find((x) => actionIdFromTitle(x.title) === "send-mail");
  assert.ok(a, "send-mail 存在");
  assert.equal(typeof a.title, "string");
  assert.equal(typeof a.url, "string");
  assert.ok(a.guards && typeof a.guards === "object");
  // 护栏数字符合预期
  assert.equal(a.guards.interval_s, 90);
  assert.equal(a.guards.daily_cap, 40);
  assert.equal(a.guards.side_effect, "external");
});

test("loadProfile: 从 profiles 根读取，--draft 走 draft/ 子目录", () => {
  const profilePath = path.join(__dirname, "..", "profiles", "mail.google.com.json");
  if (!fs.existsSync(profilePath)) {
    assert.ok(true, "mail.google.com.json 暂不存在，跳过");
    return;
  }
  const p = loadProfile("mail.google.com", false);
  assert.equal(p.domain, "mail.google.com");
  // draft 里的 gmail 是旧版（无 actions），只是确认能读
  const d = loadProfile("mail.google.com", true);
  assert.equal(d.domain, "mail.google.com");
});

// ---------------- list 菜单（no-action → 结晶跳转台） ----------------

test("formatActionMenu: 列 id/标题/side_effect；空画像给结晶指引", () => {
  const { formatActionMenu } = require("../runner/actions");
  const menu = formatActionMenu({
    domain: "x.com",
    actions: [
      { title: "发信", url: "https://x.com/compose", guards: { side_effect: "external", interval_s: 90 } },
      { title: "阅读", url: "https://x.com/home" }, // 无 side_effect → 默认 local
    ],
  });
  assert.ok(menu.includes("发信") && menu.includes("external"));
  assert.ok(menu.includes("阅读") && menu.includes("local"));
  assert.ok(formatActionMenu({ domain: "y.com", actions: [] }).includes("结晶"));
});
