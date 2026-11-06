"use strict";
// 手势层迁移后的测试：
//   1) 扩展侧 page-actions.js 的构建器（手势体 / collector / quiet-dialogs）——
//      这是 DOM 交互的唯一真源，用 vm 沙箱跑页内行为。
//   2) skill 侧 agent/gestures.js 变薄后的信号层——只校验 act 合法性，不产 JS。
//   3) collector 同步守卫：扩展侧 EL_CANDIDATE_SEL / EL_COLLECTOR_SRC /
//      ACT_QUIET_DIALOGS_SRC 的稳定值（跨仓一致性由扩展仓单源保证，skill 侧不再持有）。
const path = require("path");
const fs = require("fs");
const vm = require("vm");
const assert = require("assert");

// 扩展侧 page-actions.js 是 DOM 交互的唯一真源
const extPath = path.join(__dirname, "..", "..", "synapse", "extension", "src", "lib", "page-actions.js");
const pa = require(extPath);
const { buildGestureExpr, isAsyncAct } = require("../agent/gestures");

// ---------------- collector 同步守卫（扩展单源） ----------------
{
  // 稳定值（扩展侧 EL_CANDIDATE_SEL 的黄金串）
  const GOLDEN_SEL =
    'input,button,select,textarea,a,[contenteditable="true"],[role="button"],[role="tab"],[role="link"],[role="menuitem"],[role="checkbox"],[role="radio"],[role="switch"],[data-testid]';
  assert.strictEqual(pa.EL_CANDIDATE_SEL, GOLDEN_SEL, "EL_CANDIDATE_SEL drifted from golden");

  // 结构 marker：collector 必须含 shadowRoot 递归 + 可见性过滤
  for (const marker of ["__elNodes", "shadowRoot", "getBoundingClientRect", "disabled"])
    assert.ok(pa.EL_COLLECTOR_SRC.includes(marker), "collector missing marker: " + marker);
  assert.ok(pa.ACT_QUIET_DIALOGS_SRC.includes("withQuietDialogs"), "quiet-dialogs src missing");
  assert.ok(pa.GESTURE_GUARD_SRC.includes("tools.resolve(el)") && pa.EL_COLLECTOR_SRC.includes("label drift"), "guard must use the shared label-drift resolver");

  console.log("ALL-COLLECTOR-SYNC-OK (extension single source)");
}

// ---------------- 页内行为（vm 沙箱） ----------------
function elStub(name, extra = {}) {
  return Object.assign(
    {
      tagName: "DIV",
      disabled: false,
      value: "",
      events: [],
      getAttribute(n) {
        return n === "aria-label" ? name : null;
      },
      getBoundingClientRect() {
        return { width: 10, height: 10, x: 100, y: 100 };
      },
      dispatchEvent(e) {
        this.events.push(e.type);
      },
      click() {
        this.events.push("click");
      },
      innerText: name,
      textContent: name,
    },
    extra,
  );
}
function makePage(elA, elB) {
  const page = {
    JSON,
    Date,
    Promise,
    setTimeout,
    window: {
      HTMLInputElement: { prototype: {} },
      HTMLTextAreaElement: { prototype: {} },
      scrollBy(x, y) {
        this.scrollByD = (this.scrollByD || 0) + y;
        this.scrollByX = (this.scrollByX || 0) + x;
      },
    },
    document: {
      activeElement: null,
      body: { getBoundingClientRect: () => ({ x: 0, y: 0, width: 0, height: 0 }) },
      querySelectorAll(selector) {
        if (selector === ".boxA") return [elA];
        if (selector === ".boxB") return [elB];
        if (selector === ".missing") return [];
        return [elA, elB];
      },
      querySelector(sel) {
        if (sel === ".boxA") return elA;
        if (sel === ".boxB") return elB;
        return null;
      },
      createRange() {
        const range = {
          node: null,
          start: null,
          end: null,
          selectNodeContents(n) {
            this.node = n;
          },
          setStart(n, o) {
            this.start = { n, o };
          },
          setEnd(n, o) {
            this.end = { n, o };
          },
        };
        return range;
      },
    },
  };
  const selection = {
    ranges: [],
    removed: 0,
    text: "",
    removeAllRanges() {
      this.removed++;
    },
    addRange(r) {
      this.ranges.push(r);
    },
    toString() {
      return this.text;
    },
  };
  page.selection = selection;
  page.window.getSelection = () => selection;
  for (const C of [
    "Event",
    "MouseEvent",
    "PointerEvent",
    "KeyboardEvent",
    "DragEvent",
    "TouchEvent",
  ])
    page[C] = class {
      constructor(type, init = {}) {
        this.type = type;
        Object.assign(this, init);
      }
    };
  page.Touch = class {};
  page.DataTransfer = class {};
  return page;
}

const elA = elStub("src");
const elB = elStub("dst");
const page = makePage(elA, elB);

function runSync(act, el, value) {
  return JSON.parse(vm.runInNewContext(pa.buildGestureExpr(act, el, value), page));
}

(async () => {
  // hover：mouseover/mouseenter/mousemove
  let r = runSync("hover", { i: 0, label: "src" }, "");
  assert.strictEqual(r.found, true);
  assert.deepStrictEqual(elA.events, ["mouseover", "mouseenter", "mousemove"]);

  // click：合成 el.click()（isTrusted:false），越界索引拒绝
  elA.events.length = 0;
  r = runSync("click", { i: 0, label: "src" }, "");
  assert.strictEqual(r.found, true);
  assert.deepStrictEqual(elA.events, ["click"]);
  r = runSync("click", { i: 99, label: "src" }, "");
  assert.strictEqual(r.found, false);
  assert.match(r.reason, /index out of range/);

  // type：native value setter + input/change；__CLEAR__ 前缀先清空
  const inp = elStub("field", { tagName: "INPUT", value: "old" });
  const inpPage = makePage(inp, elStub("other"));
  let tp = JSON.parse(await vm.runInNewContext(pa.buildGestureExpr("type", { i: 0 }, "new"), inpPage));
  assert.strictEqual(tp.found, true);
  assert.strictEqual(inp.value, "new", "type sets the value via the native setter");
  assert.ok(inp.events.includes("input") && inp.events.includes("change"));
  inp.value = "stale";
  tp = JSON.parse(await vm.runInNewContext(pa.buildGestureExpr("type", { i: 0 }, "__CLEAR__fresh"), inpPage));
  assert.strictEqual(inp.value, "fresh", "__CLEAR__ prefix clears then types");

  // scroll：水平轴 + 可滚容器走 scrollLeft；sel 定位；旧纯字符串兼容
  const car = elStub("carousel", {
    scrollWidth: 1000,
    clientWidth: 400,
    scrollLeft: 0,
    scrollHeight: 0,
    clientHeight: 0,
  });
  const carPage = makePage(car, elStub("other"));
  let cr = JSON.parse(vm.runInNewContext(pa.buildGestureExpr("scroll", { i: 0 }, JSON.stringify({ axis: "h", delta: 300 })), carPage));
  assert.strictEqual(car.scrollLeft, 300, "horizontal scroll moves scrollLeft");
  cr = JSON.parse(vm.runInNewContext(pa.buildGestureExpr("scroll", { sel: ".boxA" }, JSON.stringify({ axis: "h", delta: 100 })), carPage));
  assert.strictEqual(car.scrollLeft, 400, "sel target resolves to the container");
  cr = JSON.parse(vm.runInNewContext(pa.buildGestureExpr("scroll", { sel: ".missing" }, ""), carPage));
  assert.strictEqual(cr.found, false);
  assert.strictEqual(cr.code, "ELEMENT_NOT_FOUND");

  // swipe：touchstart→touchmove×4→touchend；目标 label 漂移拒绝
  const sA = elStub("src");
  const sB = elStub("dst");
  const swipePage = makePage(sA, sB);
  let sr = JSON.parse(vm.runInNewContext(pa.buildGestureExpr("swipe", { i: 0, label: "src" }, JSON.stringify({ i: 1, label: "dst" })), swipePage));
  assert.strictEqual(sr.swipedTo, "dst");
  assert.deepStrictEqual(
    sA.events.filter((t) => t.startsWith("touch")),
    ["touchstart", "touchmove", "touchmove", "touchmove", "touchmove"],
  );
  assert.deepStrictEqual(sB.events, ["touchend"]);
  const sC = elStub("dst2");
  const swipePage2 = makePage(elStub("src"), sC);
  sr = JSON.parse(vm.runInNewContext(pa.buildGestureExpr("swipe", { i: 0 }, JSON.stringify({ i: 1, label: "dst" })), swipePage2));
  assert.match(sr.reason, /swipe target label drift/);

  // select-text：整元素 / 跨 text-node 子串 / 未命中拒绝
  const para = elStub("para", {
    childNodes: [
      { nodeType: 3, nodeValue: "Hello " },
      { nodeType: 3, nodeValue: "world" },
    ],
  });
  const stPage = makePage(para, elStub("other"));
  let tr = JSON.parse(vm.runInNewContext(pa.buildGestureExpr("select-text", { i: 0 }, ""), stPage));
  assert.strictEqual(tr.found, true);
  assert.strictEqual(stPage.selection.ranges[0].node, para);
  tr = JSON.parse(vm.runInNewContext(pa.buildGestureExpr("select-text", { i: 0 }, "o w"), stPage));
  assert.strictEqual(stPage.selection.ranges.length, 2);
  const rg = stPage.selection.ranges[1];
  assert.strictEqual(rg.start.o, 4, "start offset = 'o' in 'Hello ' (index 4)");
  assert.strictEqual(rg.end.n, para.childNodes[1]);
  assert.strictEqual(rg.end.o, 1, "end offset = 'w' in 'world'");
  tr = JSON.parse(vm.runInNewContext(pa.buildGestureExpr("select-text", { i: 0 }, "zzz"), stPage));
  assert.match(tr.reason, /text not found/);

  // 异步手势：longpress/key 需要 awaitPromise
  assert.ok(pa.ASYNC_GESTURES.longpress);
  assert.ok(pa.ASYNC_GESTURES.key);
  assert.strictEqual(isAsyncAct("longpress"), true);
  assert.strictEqual(isAsyncAct("type"), true);
  assert.strictEqual(isAsyncAct("select"), true);
  assert.deepStrictEqual(require("../agent/gestures").ASYNC_GESTURES, pa.ASYNC_GESTURES);
  assert.strictEqual(isAsyncAct("hover"), false);

  // 未知 act 在 CLI 侧即抛错（buildGestureExpr 校验）
  assert.throws(() => buildGestureExpr("teleport", {}, ""), /unknown gesture act/);
  // 扩展侧构建器也抛
  assert.throws(() => pa.buildGestureExpr("teleport", {}, ""), /unknown gesture act/);
})().then(
  () => console.log("ALL-GESTURES-OK (in-page behavior via extension page-actions.js)"),
  (e) => {
    console.error("GESTURES-FAIL:", e);
    process.exit(1);
  },
);
