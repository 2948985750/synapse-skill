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
  jsGoto,
  jsType,
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
    id: "send-mail",
    title: "发信",
    params: { to: "收件人" },
    steps: [
      { do: "click", sel: "div.a" },
      { do: "type", sel: "input.b", value: "{to}", mode: "native-enter" },
      { do: "type", sel: "div.c", value: "hi", mode: "execCommand" },
      { do: "wait", ms: 500 },
      { do: "wait", sel: "div.d" },
    ],
    verify: [
      { op: "text", expect: "邮件已发送" },
      { op: "navigate", hash: "#sent", reload: true },
      { op: "exists", sel: "div.e" },
    ],
    entry: { url: "https://x/" },
    guards: { side_effect: "external", interval_s: 90, daily_cap: 40, never: ["删除"] },
  });
  assert.deepEqual(errs, []);
});

test("validateAction: 未知 do/mode/op、缺 sel/value、坏 guards 都被抓", () => {
  const errs = validateAction({
    id: "x",
    title: "x",
    params: {},
    steps: [
      { do: "hover", sel: "div" },          // 未知 do
      { do: "type", value: "v" },           // 缺 sel
      { do: "click", sel: "div" },          // click 不需要 value，合法
      { do: "type", sel: "div" },           // 缺 value
      { do: "type", sel: "div", value: "v", mode: "paste" }, // 未知 mode
      { do: "wait" },                        // 无 ms 无 sel
      { do: "click", sel: "div", timeout: -1 }, // 坏 timeout
    ],
    verify: [
      { op: "grep", expect: "x" },          // 未知 op
      { op: "text" },                        // 缺 expect
      { op: "exists" },                      // 缺 sel
      { op: "navigate" },                    // 缺 hash
    ],
    guards: { side_effect: "maybe", interval_s: -1, never: "删除" },
  });
  // 逐条对号：6 个 step 错误（steps[2] 故意合法）+ 4 个 verify 错误 + 3 个 guards 错误
  assert.ok(errs.length >= 13, "应抓全所有错误，实际 " + errs.length);
  assert.ok(errs.some((e) => e.includes("hover")));
  assert.ok(errs.some((e) => e.includes("paste")));
  assert.ok(errs.some((e) => e.includes("grep")));
  assert.ok(errs.some((e) => e.includes("side_effect")));
  assert.ok(errs.some((e) => e.includes("never")));
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

test("jsGoto: hash 导航带 reload；不带 reload 则原地切", () => {
  assert.ok(jsGoto("#sent", true).includes("location.reload()"));
  assert.ok(!jsGoto("#sent", false).includes("location.reload()"));
  assert.ok(jsGoto('#sent', true).includes(JSON.stringify("#sent")));
});

test("click mode: js 默认；mouse 合法且 offset 必须是数字；未知 mode 被抓", () => {
  const ok = validateAction({
    id: "x", title: "x", params: {},
    steps: [
      { do: "click", sel: "div.a" },                                  // 默认 js
      { do: "click", sel: "div.b", mode: "mouse" },                   // 真鼠标
      { do: "click", sel: "div.c", mode: "mouse", offsetY: 20 },      // 相对元素顶部
    ],
  });
  assert.deepEqual(ok, []);
  const errs = validateAction({
    id: "x", title: "x", params: {},
    steps: [
      { do: "click", sel: "div", mode: "hover" },
      { do: "click", sel: "div", mode: "mouse", offsetX: "left" },
    ],
  });
  assert.equal(errs.length, 2);
  assert.ok(errs.some((e) => e.includes("hover")));
  assert.ok(errs.some((e) => e.includes("offsetX")));
});

test("jsClickRect: 只读定位探针——scrollIntoView + 返回视口 rect，值经 JSON 内嵌", () => {
  const expr = jsClickRect("div.row");
  assert.ok(expr.includes("scrollIntoView"));
  assert.ok(expr.includes("getBoundingClientRect"));
  assert.ok(!expr.includes(".click()")); // 只定位不点击，点击由 Input 域做
  assert.ok(expr.includes(JSON.stringify("div.row")));
});

test("jsType: native 走 value setter + input/change；native-enter 追加 Enter；execCommand 走 insertText", () => {
  const native = jsType("input.a", "v", "native");
  assert.ok(native.includes("HTMLInputElement.prototype"));
  assert.ok(native.includes("new Event('input'"));
  assert.ok(!native.includes("KeyboardEvent"));
  const chip = jsType("input.a", "v", "native-enter");
  assert.ok(chip.includes("KeyboardEvent('keydown'"));
  const exec = jsType("div.a", "v", "execCommand");
  assert.ok(exec.includes("execCommand('insertText'"));
  // 值经 JSON.stringify 内嵌——注入即字面量，没有引号逃逸问题
  assert.ok(jsType("input.a", '他说"hi"', "native").includes(JSON.stringify('他说"hi"')));
});

// ---------------- navigate 步骤 + entry 参数化 ----------------

test("validateAction: navigate 步骤要 url（可带 {param} 模板），sel 不强制", () => {
  assert.deepEqual(
    validateAction({
      id: "x", title: "x", params: { q: "词" },
      steps: [{ do: "navigate", url: "https://a.com/?q={q}" }],
    }),
    [],
  );
  const errs = validateAction({
    id: "x", title: "x", params: {},
    steps: [{ do: "navigate" }],
  });
  assert.ok(errs.some((e) => e.includes("url 必填")));
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

test("画像结构: 所有含 actions 的画像都是合法数据（schema + 必有 verified + guards + on_fail）", () => {
  const profilesRoot = path.join(__dirname, "..", "profiles");
  const files = ["mail.google.com.json"];
  // draft 里也扫：有 actions 就必须合法，防止 draft 里的坏结构日后被原样晋级
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
      assert.deepEqual(errs, [], `${rel}#${action.id} schema: ` + errs.join("; "));
      assert.ok(action.verified, `${rel}#${action.id} 缺 verified（结晶前提：实测跑通才入库）`);
      assert.ok(action.on_fail, `${rel}#${action.id} 缺 on_fail（agent 兜底是 schema 必备，不是可选）`);
      assert.ok(action.guards && action.guards.never, `${rel}#${action.id} 缺 guards.never`);
    }
  }
  assert.ok(checked >= 1, "至少应检查到 Gmail send-mail 一个 action");
});

test("画像结构: send-mail 的 params 声明与 steps/verify 模板引用一致", () => {
  const profile = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "profiles", "mail.google.com.json"), "utf8"),
  );
  const a = profile.actions.find((x) => x.id === "send-mail");
  assert.ok(a, "send-mail 存在");
  const declared = Object.keys(a.params);
  const referenced = new Set();
  for (const st of a.steps) {
    for (const m of String(st.value || "").matchAll(/\{([A-Za-z_]\w*)\}/g)) referenced.add(m[1]);
  }
  for (const v of a.verify) {
    for (const m of String(v.expect || "").matchAll(/\{([A-Za-z_]\w*)\}/g)) referenced.add(m[1]);
  }
  for (const r of referenced) {
    assert.ok(declared.includes(r), `模板引用 {${r}} 但 params 未声明`);
  }
  // 护栏数字与 flows 的措辞一致（90s / 40 封）
  assert.equal(a.guards.interval_s, 90);
  assert.equal(a.guards.daily_cap, 40);
  assert.equal(a.guards.side_effect, "external");
});

test("loadProfile: 从 profiles 根读取，--draft 走 draft/ 子目录", () => {
  const p = loadProfile("mail.google.com", false);
  assert.equal(p.domain, "mail.google.com");
  // draft 里的 gmail 是旧版（无 actions），只是确认能读
  const d = loadProfile("mail.google.com", true);
  assert.equal(d.domain, "mail.google.com");
});

// ---------------- list 菜单（no-action → 结晶跳转台） ----------------

test("formatActionMenu: 列 id/标题/side_effect/params；空画像给结晶指引", () => {
  const { formatActionMenu } = require("../runner/actions");
  const menu = formatActionMenu({
    domain: "x.com",
    actions: [
      { id: "send", title: "发信", params: { to: "收件人" }, guards: { side_effect: "external", interval_s: 90 } },
      { id: "read" }, // 无 side_effect → 默认 local
    ],
  });
  assert.ok(menu.includes("send") && menu.includes("external"));
  assert.ok(menu.includes("to"));
  assert.ok(menu.includes("read") && menu.includes("local"));
  assert.ok(formatActionMenu({ domain: "y.com", actions: [] }).includes("结晶"));
});
