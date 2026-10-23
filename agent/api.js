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
//   const el = (await browser.snapshot(tabs[0].tabId))[0];   // {i,tag,role,label}
//   await browser.click(tabs[0].tabId, el.i);
//   await browser.close();
//
// 生命周期：connect() 建立一条 WS 通道并复用；用完必须 close()，
// 否则桥侧会保留这条 client 直到超时。
const crypto = require("crypto");
const { bridgeCandidates } = require("./registry");
const { readToken } = require("./bridge-auth");
const { connectBridgeChain, connectDirect, executeCommand } = require("./transport");

// 交互元素既可以传索引（推荐），也可以传 snapshot 的完整条目。
function normalizeEl(el) {
  if (typeof el === "number") return { i: el };
  if (el && typeof el === "object" && typeof el.i === "number") return el;
  throw new Error("el 需要是 snapshot 返回的索引或条目对象");
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
    // 没有活桥：走直连慢路径（自己起临时端口等扩展拨入）。
    channel = await connectDirect(token, { ...options, waitMs: options.waitMs || 60000 });
  }
  const call = (cmd, args = {}) => executeCommand(channel, { cmd, args }, options);
  return {
    channel,
    call,
    close: () => channel.close(),

    tabs: () => call("tabs"),
    open: (url, o = {}) =>
      call("open", { url, waitMs: o.nowait ? 0 : undefined }),
    closeTab: (tabId) => call("close", { tabId }),

    // 页内 JS：默认 awaitPromise + returnByValue，与 CLI 的 run 一致。
    run: (tabId, expression, o = {}) =>
      call("cdp", {
        tabId,
        method: "Runtime.evaluate",
        params: {
          expression,
          returnByValue: true,
          awaitPromise: o.awaitPromise !== false,
        },
      }),

    // 索引化动作空间：snapshot 枚举 → click/type 按索引操作。
    snapshot: (tabId, o = {}) => call("snapshot", { tabId, max: o.max || 50 }),
    click: (tabId, el) => call("click-el", { tabId, el: normalizeEl(el) }),
    type: (tabId, el, text, o = {}) =>
      call("type-el", { tabId, el: normalizeEl(el), text, clear: !!o.clear }),

    // 任意 CDP：参数直接给对象，没有 JSON 字符串。
    cdp: (tabId, method, params = {}) => call("cdp", { tabId, method, params }),
  };
}

module.exports = { connect, normalizeEl };
