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
  // click-el/type-el 走扩展的 `gesture` 命令（act="click"/"type"）。el 解析
  //（裸索引/legacy json）仍生效，只是进 args 而非页内表达式。
  function g(cmdLine, opts) {
    const res = buildCmd(cmdLine, opts || {});
    assert.strictEqual(res.cmd, "gesture", cmdLine[0] + " emits via gesture");
    return res.args;
  }
  let a = g(["click-el", "17", "3"]);
  assert.strictEqual(a.act, "click", "click-el act");
  assert.deepStrictEqual(a.el, { i: 3 }, "click-el bare index");
  assert.strictEqual(a.value, "", "click-el value");
  a = g(["click-el", "17", "3"], { label: "搜索" });
  assert.deepStrictEqual(a.el, { i: 3, label: "搜索" }, "click-el label drift check");
  a = g(["click-el", "17", '{"i":3,"tag":"button","label":"搜索"}']);
  assert.deepStrictEqual(a.el, { i: 3, tag: "button", label: "搜索" }, "click-el legacy json");
  a = g(["type-el", "17", "2", "hello"]);
  assert.strictEqual(a.act, "type", "type-el act");
  assert.deepStrictEqual(a.el, { i: 2 }, "type-el bare index");
  assert.strictEqual(a.value, "hello", "type-el text");
  a = g(["type-el", "17", "2", "hello"], { clear: true });
  assert.strictEqual(a.value, "__CLEAR__hello", "type-el --clear prefixes __CLEAR__");
  console.log("ALL-EL-ARGS-OK (click/type emit via gesture; bare index + legacy json)");
}

// 手势族参数形态：CLI 命令统一走扩展的 `gesture` 命令（扩展 0.16.0+ 支持）。
{
  const { buildCmd } = require("../agent/cli");
  function p(cmdLine, opts) {
    const res = buildCmd(cmdLine, opts || {});
    assert.strictEqual(res.cmd, "gesture", "gesture emits via the extension gesture command");
    return res.args;
  }
  // 同步手势：act 名 + 目标索引
  let q = p(["hover-el", "17", "3"], {});
  assert.strictEqual(q.act, "hover", "hover act");
  assert.deepStrictEqual(q.el, { i: 3 }, "hover el");
  assert.strictEqual(q.value, "", "hover value");
  // 异步手势：longpress/key 由扩展侧 Runtime.evaluate 的 awaitPromise 处理
  q = p(["longpress-el", "17", "3"], { hold: 800 });
  assert.strictEqual(q.act, "longpress", "longpress act");
  assert.strictEqual(q.value, "800", "longpress hold");
  q = p(["key-el", "17", "Enter"], { modifiers: "ctrl,shift" });
  assert.strictEqual(q.act, "key", "key act");
  assert.strictEqual(JSON.parse(q.value).key, "Enter", "key carries the key name");
  // 省略 el（页面级）
  q = p(["scroll-el", "17"], {});
  assert.strictEqual(q.el, null, "page-level scroll el is null");
  // 带 delta / hscroll
  q = p(["scroll-el", "17", "4"], { delta: 120, hscroll: true });
  assert.strictEqual(JSON.parse(q.value).axis, "h", "scroll carries {axis,delta}");
  assert.strictEqual(JSON.parse(q.value).delta, 120, "scroll delta");
  // 媒体缺省 play
  q = p(["media-el", "17", "2"], {});
  assert.strictEqual(q.value, "play", "media defaults to play");
  // drag / swipe 双目标：from 索引 + to JSON
  q = p(["drag-el", "17", "0", "1"], {});
  assert.strictEqual(q.act, "drag", "drag act");
  assert.strictEqual(JSON.parse(q.value).i, 1, "drag to index");
  q = p(["swipe-el", "17", "0", "1"], {});
  assert.strictEqual(q.act, "swipe", "swipe act");
  // 容器定位：{"sel":"css"} 原样进 el
  q = p(["scroll-el", "17", '{"sel":".carousel"}'], { delta: 300, hscroll: true });
  assert.deepStrictEqual(q.el, { sel: ".carousel" }, "sel target");
  q = p(["swipe-el", "17", "0", '{"sel":".feed"}'], {});
  assert.strictEqual(JSON.parse(q.value).sel, ".feed", "swipe sel target");
  // select-text：省略 text = 全选（空串）
  q = p(["select-text-el", "17", "3", "hello"], {});
  assert.strictEqual(q.value, "hello", "select-text expr");
  q = p(["select-text-el", "17", "2"], {});
  assert.strictEqual(q.value, "", "select-text whole (empty value)");
  console.log("ALL-GESTURE-ARGS-OK (gesture cmds emit via extension gesture command)");
}

console.log("ALL-COMMANDS-OK (" + NAMES.length + " commands, table === implementation)");
