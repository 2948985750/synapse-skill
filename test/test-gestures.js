"use strict";
// 手势层（agent/gestures.js）的页内行为 + collector 同步守卫。
//
// 1) collector 同步守卫：skill 侧的 EL_CANDIDATE_SEL / COLLECTOR_SRC / QUIET_SRC
//    必须与扩展仓 page-actions.js 逐字一致（枚举顺序相同 snapshot 索引才对齐）。
//    扩展仓在场时做 live 比对；不在场时用结构性 marker 兜底 + 黄金选择器串。
// 2) 页内行为：用 vm 沙箱跑 buildGestureExpr 的产物，断言各手势派发的合成事件
//    序列 / 轴 / sel 定位 / 文本选中 / 异步标记，与扩展侧 lib 测试同规格。
const path = require("path");
const fs = require("fs");
const vm = require("vm");
const assert = require("assert");
const {
  EL_CANDIDATE_SEL,
  COLLECTOR_SRC,
  QUIET_SRC,
  buildGestureExpr,
  isAsyncAct,
  ASYNC_ACTS,
} = require("../agent/gestures");

// ---------------- collector 同步守卫 ----------------
{
  // 黄金选择器串（扩展侧 EL_CANDIDATE_SEL 的稳定值）
  const GOLDEN_SEL =
    'input,button,select,textarea,a,[role="button"],[role="tab"],[role="link"],[role="menuitem"],[role="checkbox"],[role="radio"],[role="switch"],[data-testid]';
  assert.strictEqual(EL_CANDIDATE_SEL, GOLDEN_SEL, "EL_CANDIDATE_SEL drifted from golden");

  // 结构 marker：镜像 collector 必须含 shadowRoot 递归 + 可见性过滤
  for (const marker of ["__elNodes", "shadowRoot", "getBoundingClientRect", "disabled"])
    assert.ok(COLLECTOR_SRC.includes(marker), "collector missing marker: " + marker);
  assert.ok(QUIET_SRC.includes("withQuietDialogs"), "quiet-dialogs src missing");

  // live 比对：扩展仓 page-actions.js 在场时，逐字对齐（这是主守卫）
  const extPath = path.join(
    __dirname, "..", "..", "synapse", "extension", "src", "lib", "page-actions.js",
  );
  let live = false;
  if (fs.existsSync(extPath)) {
    const pa = require(extPath);
    assert.strictEqual(
      pa.EL_CANDIDATE_SEL,
      EL_CANDIDATE_SEL,
      "EL_CANDIDATE_SEL drifted from the extension (collector index would mismatch)",
    );
    assert.strictEqual(
      pa.EL_COLLECTOR_SRC,
      COLLECTOR_SRC,
      "COLLECTOR_SRC drifted from the extension (snapshot indexes would desync)",
    );
    assert.strictEqual(
      pa.ACT_QUIET_DIALOGS_SRC,
      QUIET_SRC,
      "QUIET_SRC drifted from the extension",
    );
    live = true;
  }
  console.log(
    "ALL-COLLECTOR-SYNC-OK (" +
      (live ? "live-matched extension" : "extension absent, golden+markers only") +
      ")",
  );
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
      querySelectorAll() {
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
  return JSON.parse(
    vm.runInNewContext(buildGestureExpr(act, el, value), page),
  );
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
  let tp = JSON.parse(
    vm.runInNewContext(buildGestureExpr("type", { i: 0 }, "new"), inpPage),
  );
  assert.strictEqual(tp.found, true);
  assert.strictEqual(inp.value, "new", "type sets the value via the native setter");
  assert.ok(inp.events.includes("input") && inp.events.includes("change"));
  inp.value = "stale";
  tp = JSON.parse(
    vm.runInNewContext(buildGestureExpr("type", { i: 0 }, "__CLEAR__fresh"), inpPage),
  );
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
  let cr = JSON.parse(
    vm.runInNewContext(
      buildGestureExpr("scroll", { i: 0 }, JSON.stringify({ axis: "h", delta: 300 })),
      carPage,
    ),
  );
  assert.strictEqual(car.scrollLeft, 300, "horizontal scroll moves scrollLeft");
  cr = JSON.parse(
    vm.runInNewContext(
      buildGestureExpr("scroll", { sel: ".boxA" }, JSON.stringify({ axis: "h", delta: 100 })),
      carPage,
    ),
  );
  assert.strictEqual(car.scrollLeft, 400, "sel target resolves to the container");
  cr = JSON.parse(
    vm.runInNewContext(
      buildGestureExpr("scroll", { sel: ".missing" }, ""),
      carPage,
    ),
  );
  assert.strictEqual(cr.found, false);
  assert.match(cr.reason, /sel not found/);

  // swipe：touchstart→touchmove×4→touchend；目标 label 漂移拒绝
  const sA = elStub("src");
  const sB = elStub("dst");
  const swipePage = makePage(sA, sB);
  let sr = JSON.parse(
    vm.runInNewContext(
      buildGestureExpr("swipe", { i: 0, label: "src" }, JSON.stringify({ i: 1, label: "dst" })),
      swipePage,
    ),
  );
  assert.strictEqual(sr.swipedTo, "dst");
  assert.deepStrictEqual(
    sA.events.filter((t) => t.startsWith("touch")),
    ["touchstart", "touchmove", "touchmove", "touchmove", "touchmove"],
  );
  assert.deepStrictEqual(sB.events, ["touchend"]);
  const sC = elStub("dst2");
  const swipePage2 = makePage(elStub("src"), sC);
  sr = JSON.parse(
    vm.runInNewContext(
      buildGestureExpr("swipe", { i: 0 }, JSON.stringify({ i: 1, label: "dst" })),
      swipePage2,
    ),
  );
  assert.match(sr.reason, /swipe target label drift/);

  // select-text：整元素 / 跨 text-node 子串 / 未命中拒绝
  const para = elStub("para", {
    childNodes: [
      { nodeType: 3, nodeValue: "Hello " },
      { nodeType: 3, nodeValue: "world" },
    ],
  });
  const stPage = makePage(para, elStub("other"));
  let tr = JSON.parse(vm.runInNewContext(buildGestureExpr("select-text", { i: 0 }, ""), stPage));
  assert.strictEqual(tr.found, true);
  assert.strictEqual(stPage.selection.ranges[0].node, para);
  tr = JSON.parse(
    vm.runInNewContext(buildGestureExpr("select-text", { i: 0 }, "o w"), stPage),
  );
  assert.strictEqual(stPage.selection.ranges.length, 2);
  const rg = stPage.selection.ranges[1];
  assert.strictEqual(rg.start.o, 4, "start offset = 'o' in 'Hello ' (index 4)");
  assert.strictEqual(rg.end.n, para.childNodes[1]);
  assert.strictEqual(rg.end.o, 1, "end offset = 'w' in 'world'");
  tr = JSON.parse(
    vm.runInNewContext(buildGestureExpr("select-text", { i: 0 }, "zzz"), stPage),
  );
  assert.match(tr.reason, /text not found/);

  // 异步手势：表达式是 async IIFE + isAsyncAct 标记一致
  assert.match(buildGestureExpr("longpress", { i: 0 }, "10"), /^\(async function/);
  assert.match(buildGestureExpr("key", { i: 0 }, JSON.stringify({ key: "a" })), /^\(async function/);
  assert.match(buildGestureExpr("hover", { i: 0 }, ""), /^\(function/);
  assert.strictEqual(isAsyncAct("longpress"), ASYNC_ACTS.longpress);
  assert.strictEqual(isAsyncAct("hover"), false);

  // 未知 act 在 CLI 侧即抛错
  assert.throws(() => buildGestureExpr("teleport", {}, ""), /unknown gesture act/);
})().then(
  () => console.log("ALL-GESTURES-OK (in-page behavior via cdp expression)"),
  (e) => {
    console.error("GESTURES-FAIL:", e);
    process.exit(1);
  },
);
