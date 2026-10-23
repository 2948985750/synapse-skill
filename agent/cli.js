"use strict";
// cli：参数解析与命令构造（不碰网络；params 支持 @file，其余仍是纯函数，便于单测）。
const fs = require("fs");
const { renderUsage } = require("./commands");

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// --param k=v 的值：能当数字/布尔/null 就按字面量，否则当字符串。
function coerceParam(raw) {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (raw !== "" && !Number.isNaN(Number(raw))) return Number(raw);
  return raw;
}

function usage() {
  console.log(renderUsage());
  process.exit(1);
}

function parseArgs(argv) {
  const rest = [];
  // 默认 60s：MV3 service worker 空闲 30s 会挂起，唤醒只靠 30s 的
  // chrome.alarms 心跳。若浏览器处于空闲态，扩展最多 ~30s 才重新探一次
  // agent 端口，所以等待必须跨越至少一个完整心跳周期，默认取 60s。
  // 浏览器近期活跃（SW 存活）时其实 2~5s 就连上，不会真等 60s。
  let waitMs = 60000;
  let keep = false;
  // capture 选项
  let durationMs = 12000;
  let filter = "";
  let bodyMaxKb = 200;
  let all = false;
  // snapshot/click-el/type-el 选项
  let snapMax = 50;
  let clear = false;
  let label = "";
  const params = {};
  let triggerJs = "";
  let clientId = process.env.WB_CLIENT_ID || "";
  // --sync：run 不带 awaitPromise（fire-and-forget，副作用用 window 寄存后二次 run 查询）。
  // 场景：await 一个永不落定的 promise（如 401 认证框挂着的 fetch）会卡到 CDP 超时（T-30）。
  let sync = false;
  // --nowait：open/navigate 不等 load（扩展端默认等 15s，T-30 修复）。
  let nowait = false;
  // 多会话（T-33）：--session <sid> 指定/偏好桥注册表条目（等价 env WB_SESSION）；
  // --shared（仅 serve）额外写 data/bridge.json 兼容遗留脚本。
  // doctor（T-34）：--force 跳过礼貌等待直接进硬刷协调；--dry 只打印硬刷计划。
  let session = "";
  let shared = false;
  let force = false;
  let forceKill = false;
  let dry = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--wait") waitMs = Number(argv[++i]) || waitMs;
    else if (a === "--keep") keep = true;
    else if (a === "--duration") durationMs = Number(argv[++i]) || durationMs;
    else if (a === "--filter") filter = argv[++i] || "";
    else if (a === "--body-max") bodyMaxKb = Number(argv[++i]) || bodyMaxKb;
    else if (a === "--all") all = true;
    else if (a === "--max") snapMax = Number(argv[++i]) || snapMax;
    else if (a === "--clear") clear = true;
    else if (a === "--label") label = argv[++i] || "";
    else if (a === "--param") {
      const kv = String(argv[++i] == null ? "" : argv[i]);
      const at = kv.indexOf("=");
      if (at > 0) params[kv.slice(0, at)] = coerceParam(kv.slice(at + 1));
    }
    else if (a === "--trigger-js") triggerJs = argv[++i] || "";
    else if (a === "--client-id") clientId = argv[++i] || "";
    else if (a === "--sync") sync = true;
    else if (a === "--nowait") nowait = true;
    else if (a === "--session") session = argv[++i] || "";
    else if (a === "--shared") shared = true;
    else if (a === "--force") force = true;
    else if (a === "--force-kill") forceKill = true;
    else if (a === "--dry") dry = true;
    else rest.push(a);
  }
  return {
    rest,
    waitMs,
    keep,
    durationMs,
    filter,
    bodyMaxKb,
    all,
    snapMax,
    clear,
    label,
    params,
    triggerJs,
    clientId,
    sync,
    nowait,
    session,
    shared,
    force,
    forceKill,
    dry,
  };
}

function buildCmd(rest, opts = {}) {
  const snapMax = opts.snapMax || 50;
  const clear = !!opts.clear;
  const labelOpt = opts.label || "";
  // el 参数两种写法都接受：
  //   click-el <tab> 3                 ← 裸索引（PowerShell/cmd 里不用碰 JSON 引号）
  //   click-el <tab> '{"i":3,...}'     ← 兼容旧写法（完整快照条目）
  // 索引由 snapshot 给出，扩展端执行前仍会重解析校验（越界/label 漂移 → found:false）。
  function parseElArg(raw, label) {
    const text = String(raw).trim();
    if (/^\d+$/.test(text)) {
      const el = { i: Number(text) };
      if (label) el.label = label;
      return el;
    }
    try {
      const el = JSON.parse(text);
      if (el && typeof el.i === "number") return label ? { ...el, label } : el;
    } catch (_) {}
    return null;
  }
  const [cmd, ...args] = rest;
  switch (cmd) {
    case "list":
      return { cmd: "tabs" };
    case "navigate": {
      const [tabId, url] = args;
      if (!tabId || !url) usage();
      return {
        cmd: "navigate",
        args: {
          tabId: Number(tabId),
          url,
          waitMs: opts.nowait ? 0 : undefined,
        },
      };
    }
    case "cdp": {
      const [tabId, method, paramsArg] = args;
      if (!tabId || !method) usage();
      // params 三种给法：省略 / 内联 JSON / @file；再加 --param k=v 覆盖。
      // 内联 JSON 在 PowerShell 5.1 里会被吃掉内嵌双引号，@file 是给 shell 用的安全入口。
      let params = {};
      if (paramsArg !== undefined) {
        let raw = paramsArg;
        if (raw.startsWith("@")) {
          const file = raw.slice(1);
          try {
            raw = fs.readFileSync(file, "utf8");
          } catch (error) {
            throw codedError("INVALID_PARAMS", "读不到参数文件 " + file + "：" + error.message);
          }
        }
        try {
          params = raw.trim() ? JSON.parse(raw) : {};
        } catch (error) {
          throw codedError("INVALID_PARAMS", "params 不是合法 JSON：" + error.message);
        }
      }
      Object.assign(params, opts.params || {});
      return { cmd: "cdp", args: { tabId: Number(tabId), method, params } };
    }
    case "run": {
      const [tabId, expr] = args;
      if (!tabId || !expr) usage();
      return {
        cmd: "cdp",
        args: {
          tabId: Number(tabId),
          method: "Runtime.evaluate",
          params: {
            expression: expr,
            returnByValue: true,
            awaitPromise: !opts.sync,
          },
        },
      };
    }
    case "attach":
      return { cmd: "attach", args: { tabId: Number(args[0]) } };
    case "detach":
      return { cmd: "detach", args: { tabId: Number(args[0]) } };
    case "open":
      return {
        cmd: "open",
        args: { url: args[0], waitMs: opts.nowait ? 0 : undefined },
      };
    case "open-frame": {
      const [tabId, urlPattern] = args;
      if (!tabId || !urlPattern) usage();
      return { cmd: "open-frame", args: { tabId: Number(tabId), urlPattern } };
    }
    case "close":
      return { cmd: "close", args: { tabId: Number(args[0]) } };
    case "diag":
      return { cmd: "diag" };
    case "status":
      // 快路径健康探测：逐个试连候选桥（详见 main / runViaBridge 里的 status 分支）
      return { cmd: "status" };
    case "doctor":
      // 链路医生 + 多会话协调恢复（T-34）：快查 → 礼貌等待 SW 重拨 → 锁协调硬刷。
      // 多会话统一走它做恢复，不要各自 taskkill Edge（浏览器反复关开重的来源）。
      return { cmd: "doctor" };
    case "serve": {
      // 常驻 bridge daemon：起 WS server 并保活，注册 data/bridges/<session>.json
      // 供 one-shot 发现（T-33）；[session] 位置参数 = 会话名（多会话各占一条目，互不覆盖），
      // 省略则自动生成并打印（--shared 另写 data/bridge.json 兼容遗留脚本）。
      const [sid] = args;
      return { cmd: "serve", args: { sid: sid || "" } };
    }
    case "capture": {
      const [tabId, action] = args;
      if (!tabId || !action) usage();
      // action: 一个 URL（触发导航并捕获）| "reload"（重载当前页并捕获）| "wait"（不触发，只捕获窗口内已发生的请求）
      return { cmd: "capture", args: { tabId: Number(tabId), action } };
    }
    case "setfile": {
      const [tabId, selector, file] = args;
      if (!tabId || !selector || !file) usage();
      return {
        cmd: "setfile",
        args: { tabId: Number(tabId), selector, files: [file] },
      };
    }
    case "snapshot": {
      // 索引化动作空间（jev 引入）：枚举页面可交互控件为紧凑索引
      // [{i, tag, role, label}]，后续 click-el/type-el 按条目定位，免手写选择器。
      const [tabId] = args;
      if (!tabId) usage();
      return { cmd: "snapshot", args: { tabId: Number(tabId), max: snapMax } };
    }
    case "click-el": {
      // <tabId> <el-json>：el-json = snapshot 返回条目 {"i":3,"tag":"button","label":"搜索"}
      // 扩展端执行前重解析校验（索引越界/label 漂移 → found:false 不执行）。
      const [tabId, elArg] = args;
      if (!tabId || !elArg) usage();
      const el = parseElArg(elArg, labelOpt);
      if (!el) usage();
      return { cmd: "click-el", args: { tabId: Number(tabId), el } };
    }
    case "type-el": {
      // <tabId> <el-json> <text> [--clear]：键入文本（native value setter + input/change
      // 事件，兼容受控组件）；--clear 先清空。
      const [tabId, elArg, text] = args;
      if (!tabId || !elArg || text === undefined) usage();
      const el = parseElArg(elArg, labelOpt);
      if (!el) usage();
      return {
        cmd: "type-el",
        args: { tabId: Number(tabId), el, text, clear },
      };
    }
    case "capture-many": {
      // <tabId:action> pairs；action 同 capture（URL | reload | wait）；
      // tabId 必须互不相同（扩展约束：同 tab + 同 client 的 capture session 互斥）
      if (!args.length) usage();
      const pairs = [];
      const seenTabs = new Set();
      for (const spec of args) {
        // 第一个冒号分隔 tabId 与 action（URL 里自带的冒号不受影响）
        const i = spec.indexOf(":");
        if (i <= 0) {
          console.error(
            "[collect] capture-many: 无效 pair '" +
              spec +
              "'（格式 <tabId:action>，如 123:reload）",
          );
          process.exit(1);
        }
        const tabId = Number(spec.slice(0, i));
        if (!Number.isInteger(tabId) || tabId <= 0) {
          console.error(
            "[collect] capture-many: tabId 必须是正整数，收到 '" +
              spec.slice(0, i) +
              "'",
          );
          process.exit(1);
        }
        const action = spec.slice(i + 1);
        if (!action) {
          console.error(
            "[collect] capture-many: action 不能为空 '" + spec + "'",
          );
          process.exit(1);
        }
        if (seenTabs.has(tabId)) {
          console.error(
            "[collect] capture-many: 重复 tab " +
              tabId +
              "（同 tab 同 client 的 capture session 互斥，请改用不同标签）",
          );
          process.exit(1);
        }
        seenTabs.add(tabId);
        pairs.push({ tabId, action });
      }
      return { cmd: "capture-many", args: { pairs } };
    }
    default:
      usage();
  }
}

function validateOptions(opts) {
  for (const name of ["waitMs", "durationMs", "bodyMaxKb", "snapMax"])
    if (!Number.isFinite(opts[name]) || opts[name] <= 0)
      throw new Error(name + " must be a positive number");
  if (opts.filter) {
    // 早先这里直接 new RegExp，抛的是裸 SyntaxError，CLI 路径上永远走不到
    // capture.js 的 INVALID_FILTER，用户只看到 COMMAND_FAILED。
    try {
      new RegExp(opts.filter, "i");
    } catch (error) {
      const wrapped = new Error("--filter 不是合法正则：" + error.message);
      wrapped.code = "INVALID_FILTER";
      throw wrapped;
    }
  }
  if (
    opts.clientId &&
    (typeof opts.clientId !== "string" || opts.clientId.length > 128)
  )
    throw new Error("clientId must be at most 128 characters");
}

module.exports = { usage, parseArgs, buildCmd, validateOptions };
