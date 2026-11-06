"use strict";
// 程序用入口：直接 require 本文件，不必经过命令行。
//
// 为什么要有它：CLI 的交互命令需要把参数塞进 argv，而 Windows 的 PowerShell 5.1
// 会吃掉内嵌的双引号（JSON、JS 表达式都受影响）。程序调用完全绕过 shell，
// 参数就是 JS 值，没有序列化损耗。
//
// 用法：
//   const { connect } = require("./agent/api");
//   const browser = await connect({ session: "mywork" });
//   const tabs = await browser.tabs();
//   const el = (await browser.collectElements(tabs[0].tabId))[0];   // {i,tag,role,label}
//   await browser.click(tabs[0].tabId, el.i);
//   await browser.close();
//
// 生命周期：connect() 建立一条 WS 通道并复用；用完必须 close()，
// 否则桥侧会保留这条 client 直到超时。
const crypto = require("crypto");
const { validateUploadFiles } = require("./files");
const { bridgeCandidates } = require("./registry");
const { readToken } = require("./bridge-auth");
const { connectBridgeChain, connectDirect, executeCommand } = require("./transport");

// 交互元素既可以传索引（推荐），也可以传 collect-elements 的完整条目。
function normalizeEl(el) {
  if (typeof el === "number") return { i: el };
  if (el && typeof el === "object" && (Number.isInteger(el.i) || [el.ref, el.sel, el.role, el.testId].some((value) => typeof value === "string" && value))) return el;
  throw new Error("el 需要是 collect-elements 返回的索引或条目对象");
}

async function connect(opts = {}) {
  // 桥的每条命令都要求 clientId（CLI 由 main 生成）。API 这里必须自己补，
  // 否则会被桥以 "A valid clientId is required" 拒绝。
  const options = {
    transientClient: true,
    ...opts,
    clientId: opts.clientId || "api-" + crypto.randomUUID(),
  };
  const token = readToken();
  const candidates = bridgeCandidates(options);
  let channel;
  if (candidates.length) {
    ({ channel } = await connectBridgeChain(candidates, token, options));
  } else {
    if ((options.session || process.env.WB_SESSION) && !options.allowFailover) {
      const error = new Error("Selected session has no live bridge; refusing direct fallback");
      error.code = "NO_BRIDGE";
      throw error;
    }
    // 没有活桥：走直连慢路径（自己起临时端口等扩展拨入）。
    channel = await connectDirect(token, { ...options, waitMs: options.waitMs || 60000 });
  }
  const call = (cmd, args = {}, commandOptions = {}) => executeCommand(channel, { cmd, args }, {
    ...options,
    commandTimeoutMs: commandOptions.commandTimeoutMs ?? options.commandTimeoutMs,
  });
  const pageOptions = (value = {}) => ({
    ...(value.contextId !== undefined ? { contextId: value.contextId } : {}),
    ...(value.sessionId !== undefined ? { sessionId: value.sessionId } : {}),
    ...(value.waitFor !== undefined ? { waitFor: value.waitFor } : {}),
    ...(value.waitTimeoutMs !== undefined ? { waitTimeoutMs: value.waitTimeoutMs } : {}),
  });
  return {
    channel,
    call,
    close: () => channel.close(),

    tabs: (commandOptions = {}) => call("tabs", {}, { commandTimeoutMs: commandOptions.timeoutMs }),
    // waitMs is forwarded: without it the extension returns as soon as the
    // document loads, which is too early for SPAs (the profile runner then sees
    // an empty list). `nowait: true` keeps the old fire-and-forget behaviour.
    open: (url, o = {}) =>
      call("open", {
        url,
        waitMs: o.nowait ? 0 : o.waitMs,
        ...pageOptions(o),
      }, { commandTimeoutMs: o.timeoutMs }),
    navigate: (tabId, url, o = {}) => call("navigate", { tabId, url, waitMs: o.nowait ? 0 : o.waitMs, ...pageOptions(o) }, { commandTimeoutMs: o.timeoutMs }),
    closeTab: (tabId) => call("close", { tabId }),

    // 页内 JS：默认 awaitPromise + returnByValue，与 CLI 的 run 一致。
    run: (tabId, expression, o = {}) =>
      call("cdp", {
        tabId,
        method: "Runtime.evaluate",
        timeoutMs: o.timeoutMs,
        ...(o.sessionId !== undefined ? { sessionId: o.sessionId } : {}),
        params: {
          expression,
          returnByValue: true,
          awaitPromise: o.awaitPromise !== false,
          ...(o.contextId !== undefined ? { contextId: o.contextId } : {}),
        },
      }, { commandTimeoutMs: o.timeoutMs }),

    // 索引化动作空间：collect-elements 枚举 → click/type 按索引操作。
    collectElements: (tabId, o = {}) => call("collect-elements", { tabId, max: o.max || 50, ...(o.scope ? { scope: o.scope } : {}), ...pageOptions(o) }),
    click: (tabId, el, o = {}) => {
      if (o.mode !== undefined && !["dom", "cdp"].includes(o.mode)) throw Object.assign(new Error("click mode must be dom or cdp"), { code: "VALIDATION" });
      return call(o.mode === "cdp" ? "click-cdp" : "click-el", { tabId, el: normalizeEl(el), ...pageOptions(o) }, { commandTimeoutMs: o.timeoutMs });
    },
    type: (tabId, el, text, o = {}) =>
      call("type-el", { tabId, el: normalizeEl(el), text, clear: !!o.clear, ...pageOptions(o) }, { commandTimeoutMs: o.timeoutMs }),
    readPage: (tabId, o = {}) => call("read-page", { tabId, scope: o.scope, fields: o.fields, maxChars: o.maxChars, ...pageOptions(o) }, { commandTimeoutMs: o.timeoutMs }),
    waitFor: (tabId, condition, o = {}) => call("wait-for", { tabId, condition, timeoutMs: o.timeoutMs, ...pageOptions(o) }, { commandTimeoutMs: (o.timeoutMs ?? 10000) + 5000 }),
    setFiles: (tabId, selector, files, o = {}) => call("setfile", { tabId, selector, files: validateUploadFiles(files), ...pageOptions(o) }, { commandTimeoutMs: o.timeoutMs }),
    setViewport: (tabId, viewport) => {
      const { width, height, deviceScaleFactor = 1, mobile = false } = viewport || {};
      if (![width, height].every((value) => Number.isInteger(value) && value > 0) || !Number.isFinite(deviceScaleFactor) || deviceScaleFactor < 0 || typeof mobile !== "boolean") throw Object.assign(new Error("invalid viewport dimensions or scale"), { code: "VALIDATION" });
      return call("cdp", { tabId, method: "Emulation.setDeviceMetricsOverride", params: { width, height, deviceScaleFactor, mobile } });
    },
    resetViewport: (tabId) => call("cdp", { tabId, method: "Emulation.clearDeviceMetricsOverride", params: {} }),

    // 通用手势：hover/dblclick/contextmenu/focus/touch/scroll/select/media/
    // drag/swipe/longpress/key/select-text（扩展 0.16.0+）。
    gesture: (tabId, act, el, value) =>
      call("gesture", { tabId, act, el: normalizeEl(el), value }),

    // 按 CSS 选择器查询元素（text/aria/disabled/可见性），用于点击前护栏。
    queryEl: (tabId, sel, o = {}) => call("query-el", { tabId, sel, ...pageOptions(o) }),
    // 按 CSS 选择器输入（mode: native|native-enter|execCommand）。
    typeCss: (tabId, sel, value, mode) =>
      call("type-css", { tabId, sel, value, mode: mode || "native" }),
    // hash 导航（可选 reload，用于 antiScrape 站点）。
    gotoHash: (tabId, hash, reload) => call("goto-hash", { tabId, hash, reload }),

    // 任意 CDP：参数直接给对象，没有 JSON 字符串。
    cdp: (tabId, method, params = {}, commandOptions = {}) => call("cdp", { tabId, method, params, timeoutMs: commandOptions.timeoutMs, ...(commandOptions.sessionId !== undefined ? { sessionId: commandOptions.sessionId } : {}) }, { commandTimeoutMs: commandOptions.timeoutMs }),
  };
}

module.exports = { connect, normalizeEl };
