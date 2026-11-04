"use strict";
// 命令表与实现的漂移守卫。
//
// 背景：usage 曾经是手写的，和 buildCmd 的 switch 各写一遍，结果真的漂了
// ——`setfile` 有实现但没进 usage，用户看不见这条命令。本测试把「表」和
// 「实现」钉在一起：任何一边新增/改名命令而另一边没跟上，立刻失败。
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const { COMMANDS, NAMES, renderUsage, renderList } = require("../agent/commands");

const cliSrc = fs.readFileSync(path.join(__dirname, "..", "agent", "cli.js"), "utf8");
const implemented = [...cliSrc.matchAll(/case "([a-z0-9-]+)":/g)].map((m) => m[1]);

const missingInTable = implemented.filter((n) => !NAMES.includes(n));
const missingInCode = NAMES.filter((n) => !implemented.includes(n));

assert.deepStrictEqual(
  missingInTable,
  [],
  "buildCmd 实现了但命令表里没有（usage 会看不见）：" + missingInTable.join(", "),
);
assert.deepStrictEqual(
  missingInCode,
  [],
  "命令表里有但 buildCmd 没实现：" + missingInCode.join(", "),
);

// 第三条腿：提示词。SKILL.md 内嵌 renderUsage() 的完整输出（<!-- usage:start/end -->
// 标记区间），agent 无需跑裸 CLI 即可看到全部命令及注释。命令表任何改动都会让这个
// 精确比对失败——跑 `npm run usage:sync` 重新生成即可。
const skillSrc = fs.readFileSync(path.join(__dirname, "..", "SKILL.md"), "utf8");
const usageBlock = skillSrc.match(
  /<!-- usage:start -->\n([\s\S]*?)\n<!-- usage:end -->/,
);
assert.ok(usageBlock, "SKILL.md 缺 <!-- usage:start/end --> 用法块");
assert.strictEqual(
  usageBlock[1].trim(),
  renderList().trim(),
  "SKILL.md 的用法列表与命令表漂移：跑 npm run usage:sync 重新生成",
);

// 重名会让 usage 出现两条、parse 时也说不清谁优先。
assert.strictEqual(new Set(NAMES).size, NAMES.length, "命令表里有重名");

// 每条命令都必须出现在渲染结果里，且渲染不抛错。
const text = renderUsage();
for (const command of COMMANDS) {
  assert.ok(
    text.includes("agent-collect.js " + command.lines[0]),
    "usage 里缺少命令：" + command.name,
  );
}
assert.ok(text.startsWith("用法:"), "usage 开头固定为「用法:」");
assert.ok(text.includes("--session <sid>"), "usage 必须列出 --session");


// 交互参数形态：索引直传（避免 PowerShell 吃掉 JSON 引号），旧 JSON 写法仍兼容。
{
  const { buildCmd } = require("../agent/cli");
  // click-el/type-el 现在与手势同族：走通用 cdp Runtime.evaluate 通道发射，页内 JS 由
  // agent/gestures.js 构造。el 解析（裸索引/legacy json）仍生效，只是进表达式而非具名 args。
  function cdpExpr(cmdLine, opts) {
    const res = buildCmd(cmdLine, opts || {});
    assert.strictEqual(res.cmd, "cdp", cmdLine[0] + " emits via cdp");
    assert.strictEqual(res.args.method, "Runtime.evaluate");
    return res.args.params.expression;
  }
  let e = cdpExpr(["click-el", "17", "3"]);
  assert.ok(e.indexOf(',"click",') >= 0 && e.indexOf('{"i":3') >= 0, "click-el bare index");
  e = cdpExpr(["click-el", "17", "3"], { label: "搜索" });
  assert.ok(e.indexOf('"label":"搜索"') >= 0, "click-el label drift check");
  e = cdpExpr(["click-el", "17", '{"i":3,"tag":"button","label":"搜索"}']);
  assert.ok(e.indexOf('"i":3') >= 0 && e.indexOf('"tag":"button"') >= 0, "click-el legacy json");
  e = cdpExpr(["type-el", "17", "2", "hello"]);
  assert.ok(e.indexOf(',"type",') >= 0 && e.indexOf('"hello"') >= 0, "type-el text");
  e = cdpExpr(["type-el", "17", "2", "hello"], { clear: true });
  assert.ok(e.indexOf("__CLEAR__") >= 0, "type-el --clear prefixes __CLEAR__");
  console.log("ALL-EL-ARGS-OK (click/type emit via cdp; bare index + legacy json)");
}

// 手势族参数形态：CLI 命令统一走通用 cdp Runtime.evaluate 通道发射（扩展只当基建，
// 不认具名手势命令）。页内 JS 由 agent/gestures.js 构造，async 手势带 awaitPromise。
{
  const { buildCmd } = require("../agent/cli");
  // 断言发射形态：cmd=cdp + method=Runtime.evaluate + returnByValue；返回 params 供查表达式
  function p(res) {
    assert.strictEqual(res.cmd, "cdp", "gesture emits via the generic cdp channel");
    assert.strictEqual(res.args.method, "Runtime.evaluate");
    assert.strictEqual(res.args.params.returnByValue, true);
    return res.args.params;
  }
  // 同步手势：awaitPromise=false，表达式含 act 名 + 目标索引
  let q = p(buildCmd(["hover-el", "17", "3"], {}));
  assert.strictEqual(q.awaitPromise, false);
  assert.ok(q.expression.indexOf(',"hover",') >= 0 && q.expression.indexOf('{"i":3') >= 0, "hover expr");
  // 异步手势：awaitPromise=true
  q = p(buildCmd(["longpress-el", "17", "3"], { hold: 800 }));
  assert.strictEqual(q.awaitPromise, true, "longpress is async (awaitPromise)");
  assert.ok(q.expression.indexOf(',"longpress",') >= 0 && q.expression.indexOf('"800"') >= 0, "longpress expr");
  q = p(buildCmd(["key-el", "17", "Enter"], { modifiers: "ctrl,shift" }));
  assert.strictEqual(q.awaitPromise, true, "key is async (awaitPromise)");
  assert.ok(q.expression.indexOf(',"key",') >= 0 && q.expression.indexOf("Enter") >= 0, "key expr carries the key name");
  // 省略 el（页面级）
  q = p(buildCmd(["scroll-el", "17"], {}));
  assert.ok(q.expression.indexOf("null") >= 0, "page-level scroll el is null");
  // 带 delta / hscroll
  q = p(buildCmd(["scroll-el", "17", "4"], { delta: 120, hscroll: true }));
  assert.ok(q.expression.indexOf("120") >= 0 && q.expression.indexOf("axis") >= 0, "scroll carries the {axis,delta} JSON");
  // 媒体缺省 play
  q = p(buildCmd(["media-el", "17", "2"], {}));
  assert.ok(q.expression.indexOf(',"media",') >= 0 && q.expression.indexOf('"play"') >= 0, "media defaults to play");
  // drag / swipe 双目标：from 索引 + to JSON
  q = p(buildCmd(["drag-el", "17", "0", "1"], {}));
  assert.ok(q.expression.indexOf(',"drag",') >= 0, "drag expr");
  q = p(buildCmd(["swipe-el", "17", "0", "1"], {}));
  assert.ok(q.expression.indexOf(',"swipe",') >= 0, "swipe expr");
  // 容器定位：{"sel":"css"} 原样进表达式
  q = p(buildCmd(["scroll-el", "17", '{"sel":".carousel"}'], { delta: 300, hscroll: true }));
  assert.ok(q.expression.indexOf('"sel":".carousel"') >= 0 && q.expression.indexOf("300") >= 0, "sel target + delta");
  q = p(buildCmd(["swipe-el", "17", "0", '{"sel":".feed"}'], {}));
  assert.ok(q.expression.indexOf(".feed") >= 0, "swipe sel target");
  // select-text：省略 text = 全选（空串）
  q = p(buildCmd(["select-text-el", "17", "3", "hello"], {}));
  assert.ok(q.expression.indexOf(',"select-text",') >= 0 && q.expression.indexOf('"hello"') >= 0, "select-text expr");
  q = p(buildCmd(["select-text-el", "17", "2"], {}));
  assert.ok(q.expression.indexOf(',"select-text",') >= 0, "select-text whole (empty value)");
  console.log("ALL-GESTURE-ARGS-OK (gesture cmds emit via cdp Runtime.evaluate)");
}

console.log("ALL-COMMANDS-OK (" + NAMES.length + " commands, table === implementation)");
