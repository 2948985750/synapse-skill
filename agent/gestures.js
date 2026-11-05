"use strict";
// 手势层（CLI 侧薄信号层）：只做 act 合法性校验，真正的页内 JS 由扩展侧
// page-actions.js 的 buildGestureExpr 构造，走扩展的 `gesture` 命令发射。
//
// 为什么 skill 侧不再持有 DOM 交互逻辑：
//   - click/type/13 种手势的页内表达式全部在扩展侧，扩展 0.16.0+ 支持 `gesture` 命令；
//   - 之前 skill 侧持有一份 collector/quiet/guard 源码镜像（EL_CANDIDATE_SEL /
//     COLLECTOR_SRC / ACT_QUIET_DIALOGS_SRC），与扩展侧逐字同步。现在扩展是唯一真源，
//     镜像债消失，test-gestures.js 的同步守卫改为直接断言扩展侧的稳定值。
//
// 页内事件都是合成事件（isTrusted:false，信任级别同 click-el）；只认受信输入的
// 站点用 `cdp Input.dispatch*` 配方兜底（配方要点见 SKILL.md「红线与排障」的已知坑）。

// 合法 act 列表（与扩展侧 GESTURE_BODIES 的键一致；新增手势必须同时改两侧）。
const GESTURE_ACTS = new Set([
  "click", "type", "hover", "dblclick", "contextmenu", "focus", "touch",
  "scroll", "select", "media", "drag", "swipe", "longpress", "key", "select-text",
]);

// 异步手势：Runtime.evaluate 需 awaitPromise:true（扩展侧 ASYNC_GESTURES 同步）。
const ASYNC_GESTURES = { longpress: true, key: true };

// buildGestureExpr(act, el, value)：只校验 act 合法性并返回标准化参数包，
// 真正的页内表达式在扩展侧构造。未知 act 在 CLI 侧就抛错，不产出坏命令。
function buildGestureExpr(act, el, value) {
  if (!GESTURE_ACTS.has(act))
    throw new Error("unknown gesture act: " + act + " (known: " + Array.from(GESTURE_ACTS).join(", ") + ")");
  return {
    act,
    el: el || null,
    value: value == null ? "" : String(value),
  };
}

function isAsyncAct(act) {
  return !!ASYNC_GESTURES[act];
}

module.exports = {
  buildGestureExpr,
  isAsyncAct,
  // 仅暴露供 SKILL.md 命令表引用（文档层）
  GESTURE_ACTS,
  ASYNC_GESTURES,
};
