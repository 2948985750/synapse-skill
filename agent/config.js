"use strict";
// 运行期常量集中处。放在这里而不是各模块各写一份，避免超时值悄悄分叉。

// 端口段：扩展与 agent 必须一致（扩展侧默认写死同一段，可用
// chrome.storage.local.wbAgentWsRange 跟随覆盖段）。
const PORT_RANGE_START = Number(process.env.WB_AGENT_WS_START || 9521);
const PORT_RANGE_END = Number(process.env.WB_AGENT_WS_END || 9540);
// PORT_RANGE_OVERRIDDEN：用户是否显式设置了端口段 env。为 true 时扩展默认
// 只扫 9521–9540，发现不到本桥——启动入口要打告警提示用户同步扩展侧
// chrome.storage.local.wbAgentWsRange（与数值回落语义对齐：任一变量存在即视为覆盖）。
const PORT_RANGE_OVERRIDDEN =
  process.env.WB_AGENT_WS_START != null ||
  process.env.WB_AGENT_WS_END != null;

// 50s：命令传输预算，留出排队与浏览器处理时间。
// 命令超时不会取消已派发的浏览器操作，调用方必须检查实际页面状态。
const CMD_TIMEOUT_MS = 50000;

// status 的有界探测总时限。
const STATUS_TIMEOUT_MS = 1800;

// 维护锁的陈旧判定：持锁者被强杀后，超过这个时长视为残留锁可窃取。
const MAINT_LOCK_TTL_MS = 180000;

module.exports = {
  PORT_RANGE_START,
  PORT_RANGE_END,
  PORT_RANGE_OVERRIDDEN,
  CMD_TIMEOUT_MS,
  STATUS_TIMEOUT_MS,
  MAINT_LOCK_TTL_MS,
};
