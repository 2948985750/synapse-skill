"use strict";
// 机器可读错误码表（跨 WS 边界）：扩展侧给 agent.result 的 code 字段（见扩展仓
// ws-bridge.js 的 classifyError 与各处 throw 站点）+ agent 侧缺省回退值。
// 目的：调用方只看 code 就能区分"可重试"（锁争用 / CDP 超时 / attach 未生效）
// 与"永久性失败"（命令不存在 / 参数校验 / tab 已关），不必解析错误文案。
//
// 纯增量：transport/capture/bridge-router 里已有的码（COMMAND_TIMEOUT、
// NO_BRIDGE、BRIDGE_AUTH_OR_CONNECT、EXTENSION_DISCONNECTED、INVALID_FILTER、
// COMMAND_FAILED、CLIENT_CLOSING、CLIENT_BUSY、QUEUE_FULL、CLEANUP_TIMEOUT…）
// 留在各自模块原样工作，本表只补"扩展抛错 → 跨线 → agent 拒绝"这条主链路。

// CODES：规范码集（code -> 语义，括号内是可重试性）。
const CODES = {
  UNKNOWN_CMD: "permanent — 未知命令名",
  VALIDATION: "permanent — 参数校验失败",
  TAB_GONE: "permanent（对该 tab）— 操作中途 tab 已关/找不到",
  ATTACH_FAILED: "retryable — ensureAttached 未生效",
  LOCK_TIMEOUT: "retryable — TabLock.acquire 超时",
  CDP_TIMEOUT: "unknown outcome — 已派发命令超时，检查页面状态后再决定是否重试",
  EVAL_ERROR: "permanent — 页内 JS 抛错",
  EVALUATION_FAILED: "permanent — 页内 JS 异常或内建 DOM 命令未返回预期值；不自动重试",
  AMBIGUOUS_TARGET: "permanent — 匹配多个目标，需收窄定位",
  STALE_ELEMENT: "permanent — 元素引用或描述已失效，需重新采集",
  ELEMENT_NOT_INTERACTABLE: "permanent — 目标不可见、禁用、只读或不支持当前输入",
  ELEMENT_OBSCURED: "permanent — 目标被遮挡，未派发 CDP 点击",
  ELEMENT_UNSTABLE: "permanent — 目标位置变化，未派发 CDP 点击",
  VALUE_MISMATCH: "unknown outcome — 实际输入或文件列表不符，先检查页面",
  WAIT_TIMEOUT: "unknown outcome — 期望状态未出现，之前动作可能已生效",
  INVALID_FILE: "permanent — 本地文件缺失或不是普通文件",
  INTERNAL: "permanent/unknown — 无法归类的其它错误",
};

// RETRYABLE_CODES：可重试集合。调用方据此决定"稍后再试"还是"别试了"。
const RETRYABLE_CODES = new Set(["ATTACH_FAILED", "LOCK_TIMEOUT"]);

// isRetryable(err)：err.code 落在可重试集合内即真。
function isRetryable(err) {
  return RETRYABLE_CODES.has(err && err.code);
}

module.exports = { CODES, RETRYABLE_CODES, isRetryable };
