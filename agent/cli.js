"use strict";
// cli：参数解析与命令构造（不碰网络；params 支持 @file，其余仍是纯函数，便于单测）。
const fs = require("fs");
const { renderUsage } = require("./commands");
const { buildGestureExpr, isAsyncAct } = require("./gestures");

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
  // 手势族旗标（全量交互原语）：
  //   --hold <ms>       longpress-el 按住时长（省略则扩展默认 600ms）
  //   --delta <px>      scroll-el 像素增量（省略则 into-view 滚入视口）
  //   --modifiers <list> key-el 修饰键（ctrl/shift/alt/meta 逗号分隔，或裸位掩码 0-15）
  let hold = null;
  let delta = null;
  let modifiers = "";
  let hscroll = false;
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
    else if (a === "--trigger-js") {
      // 同上：--trigger-js @file 读文件，避免长 JS 过 argv 被 Windows 重写。
      triggerJs = argv[++i] || "";
      if (triggerJs.startsWith("@")) {
        try {
          triggerJs = fs.readFileSync(triggerJs.slice(1), "utf8");
        } catch (error) {
          throw codedError("INVALID_EXPRESSION", "读不到 --trigger-js 文件：" + error.message);
        }
      }
    }
    else if (a === "--client-id") clientId = argv[++i] || "";
    else if (a === "--sync") sync = true;
    else if (a === "--nowait") nowait = true;
    else if (a === "--session") session = argv[++i] || "";
    else if (a === "--shared") shared = true;
    else if (a === "--force") force = true;
    else if (a === "--force-kill") forceKill = true;
    else if (a === "--dry") dry = true;
    else if (a === "--hold") hold = Number(argv[++i]);
    else if (a === "--delta") delta = Number(argv[++i]);
    else if (a === "--modifiers") modifiers = argv[++i] || "";
    else if (a === "--hscroll") hscroll = true;
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
    hold,
    delta,
    modifiers,
    hscroll,
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
    // 也接受 {"sel":"css"}：直接按 CSS 选择器定位（容器/画布等非候选节点，scroll/swipe/select-text 用）。
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
        if (el && typeof el.sel === "string" && el.sel) return { sel: el.sel };
      } catch (_) {}
      return null;
    }
  // --modifiers：key-el 修饰键。接受逗号分隔的名单（ctrl/shift/alt/meta，别名
  // control/cmd）或裸位掩码数字；映射与扩展端 key act 一致（Alt1|Ctrl2|Meta4|Shift8）。
  // 未知词抛错，避免拼错修饰键静默变成无修饰。
  function parseModifiers(spec) {
    if (spec === undefined || spec === null || spec === "") return 0;
    const s = String(spec).trim();
    if (/^\d+$/.test(s)) return Number(s) & 15;
    let mod = 0;
    const names = new Set(s.toLowerCase().split(",").map((t) => t.trim()).filter(Boolean));
    if (names.size === 0) return 0;
    const map = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, shift: 8 };
    for (const name of names) {
      if (!(name in map))
        throw codedError(
          "INVALID_MODIFIERS",
          "未知修饰键 '" + name + "'（可用：alt|ctrl|meta|shift，逗号分隔；或位掩码 0-15）",
        );
      mod |= map[name];
    }
    return mod & 15;
  }
  // 手势命令发射：走扩展的具名 `gesture` 命令（扩展 0.16.0+ 支持）。
  // async 手势（longpress/key）由扩展侧 Runtime.evaluate 的 awaitPromise 处理。
  function gestureCmd(act, tabId, el, value) {
    const p = buildGestureExpr(act, el, value); // act 合法性校验
    return {
      cmd: "gesture",
      args: {
        tabId: Number(tabId),
        act: p.act,
        el: p.el,
        value: p.value,
      },
    };
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
      const [tabId, exprArg] = args;
      if (!tabId || !exprArg) usage();
      // @file：Windows argv 不能无损承载长 JS（实测 952 字符的页内表达式到子进程只剩
      // 950 字符，正则被改坏后静默返回 []）。脚本一律走文件，argv 只传路径。
      let expr = exprArg;
      if (expr.startsWith("@")) {
        const file = expr.slice(1);
        try {
          expr = fs.readFileSync(file, "utf8");
        } catch (error) {
          throw codedError("INVALID_EXPRESSION", "读不到表达式文件 " + file + "：" + error.message);
        }
      }
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
    case "config": {
      // 纯本地命令：查看/设置用户数据目录，无需扩展连入。
      const [action, key, value] = args;
      if (!action) return { cmd: "config", args: { action: "show" } };
      if (action === "show") return { cmd: "config", args: { action: "show" } };
      if (action === "reset") return { cmd: "config", args: { action: "reset" } };
      if (action !== "set" || !key) usage();
      const allowed = { "data-root": "dataRoot", "output-dir": "outputDir", "profile-root": "profileRoot" };
      const field = allowed[key];
      if (!field) {
        throw Object.assign(new Error("未知配置项 " + key + "（可用：data-root | output-dir）"), { code: "INVALID_CONFIG" });
      }
      return { cmd: "config", args: { action: "set", field, value: value || "" } };
    }
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
      // <tabId> <i|el-json|sel-json>：el = snapshot 条目 {"i":3,"tag":"button","label":"搜索"}。
      // 走扩展的 `gesture` 命令（click 分支），执行前重解析（索引越界/label 漂移 → found:false 不执行）。
      const [tabId, elArg] = args;
      if (!tabId || !elArg) usage();
      const el = parseElArg(elArg, labelOpt);
      if (!el) usage();
      return gestureCmd("click", tabId, el, "");
    }
    case "type-el": {
      // <tabId> <i|el-json|sel-json> <text> [--clear]：键入文本（native value setter +
      // input/change 事件，兼容受控组件）；--clear 先清空。走扩展的 `gesture` 命令。
      const [tabId, elArg, text] = args;
      if (!tabId || !elArg || text === undefined) usage();
      const el = parseElArg(elArg, labelOpt);
      if (!el) usage();
      const value = clear ? "__CLEAR__" + text : text;
      return gestureCmd("type", tabId, el, value);
    }
    // ---- 手势族（全量交互原语）：与扩展端命令名一一对应，均基于 snapshot 索引 el{i,label}，
    // 页内合成事件（isTrusted:false，信任级别同 click-el）。只认受信输入的站点走 cdp 通道。 ----
    case "hover-el":
    case "dblclick-el":
    case "rightclick-el":
    case "focus-el":
    case "touch-el": {
      // <tabId> <i|el-json|sel-json>：单索引手势（悬停/双击/右键/聚焦/触摸点按）。
      // 走扩展的 `gesture` 命令（对应 act 分支）。
      const act = {
        "hover-el": "hover",
        "dblclick-el": "dblclick",
        "rightclick-el": "contextmenu",
        "focus-el": "focus",
        "touch-el": "touch",
      }[cmd];
      const [tabId, elArg] = args;
      if (!tabId || !elArg) usage();
      const el = parseElArg(elArg, labelOpt);
      if (!el) usage();
      return gestureCmd(act, tabId, el, "");
    }
    case "longpress-el": {
      // <tabId> <i|el-json|sel-json> [--hold <ms>]：先按下、按住 hold 毫秒再抬起（异步，
      // awaitPromise）；省略 --hold 默认 600ms
      const [tabId, elArg] = args;
      if (!tabId || !elArg) usage();
      const el = parseElArg(elArg, labelOpt);
      if (!el) usage();
      const hold =
        opts.hold != null && Number(opts.hold) > 0 ? String(Number(opts.hold)) : "";
      return gestureCmd("longpress", tabId, el, hold);
    }
    case "scroll-el": {
      // <tabId> [<i|el-json|sel-json>] [--delta <px>] [--hscroll]：省略 el 做页面级滚动
      // （target=document.body）；--hscroll 水平轴（轮播/可滚容器）；省略 --delta 则
      // into-view 滚入视口。el 可为 snapshot 索引或 {"sel":"css"} 直接定位容器。
      const [tabId, elArg] = args;
      if (!tabId) usage();
      const el = elArg !== undefined ? parseElArg(elArg, labelOpt) : null;
      if (elArg !== undefined && !el) usage();
      const value = JSON.stringify({
        axis: opts.hscroll ? "h" : "v",
        delta: opts.delta == null ? null : Number(opts.delta),
      });
      return gestureCmd("scroll", tabId, el, value);
    }
    case "swipe-el": {
      // <tabId> <from-i|json> <to-i|json|sel-json>：触摸滑动（touchstart→touchmove×4→
      // touchend）。移动端模拟/下拉刷新/触摸轮播；from/to 是 snapshot 索引或 {"sel":"css"}。
      const [tabId, fromArg, toArg] = args;
      if (!tabId || !fromArg || !toArg) usage();
      const from = parseElArg(fromArg, labelOpt);
      const to = parseElArg(toArg, "");
      if (!from || !to) usage();
      return gestureCmd("swipe", tabId, from, JSON.stringify(to));
    }
    case "select-text-el": {
      // <tabId> <i|el-json|sel-json> [text]：选中元素内文本（省略 text = 选全部；子串可跨
      // text-node）落入 selection；复制流随后 run `document.execCommand('copy')`。
      const [tabId, elArg, text] = args;
      if (!tabId || !elArg) usage();
      const el = parseElArg(elArg, labelOpt);
      if (!el) usage();
      return gestureCmd("select-text", tabId, el, text === undefined ? "" : text);
    }
    case "key-el": {
      // <tabId> <key> [<i|el-json|sel-json>] [--modifiers ctrl,shift]：键事件（异步，
      // awaitPromise）；key = Enter/a/ArrowUp 等；省略 el 则打到 document.body；
      // --modifiers 逗号名单（ctrl/shift/alt/meta）或位掩码
      const [tabId, keyArg, elArg] = args;
      if (!tabId || !keyArg) usage();
      const el = elArg !== undefined ? parseElArg(elArg, labelOpt) : null;
      if (elArg !== undefined && !el) usage();
      const mod = parseModifiers(opts.modifiers);
      const value = JSON.stringify({ key: keyArg, code: "", mod });
      return gestureCmd("key", tabId, el, value);
    }
    case "select-el": {
      // <tabId> <i|el-json|sel-json> <value>：给 <select> 选一个 option（value = option 的 value）
      const [tabId, elArg, value] = args;
      if (!tabId || !elArg || value === undefined) usage();
      const el = parseElArg(elArg, labelOpt);
      if (!el) usage();
      return gestureCmd("select", tabId, el, value);
    }
    case "media-el": {
      // <tabId> <i|el-json|sel-json> [play|pause|mute|unmute]：媒体控制，缺省 play
      const [tabId, elArg, action] = args;
      if (!tabId || !elArg) usage();
      const el = parseElArg(elArg, labelOpt);
      if (!el) usage();
      return gestureCmd("media", tabId, el, action || "play");
    }
    case "drag-el": {
      // <tabId> <from-i|json> <to-i|json|sel-json>：HTML5 拖放（dragstart→drop→dragend
      // 全序列，带 DataTransfer）；from/to 都是 snapshot 索引或 {"sel":"css"}
      const [tabId, fromArg, toArg] = args;
      if (!tabId || !fromArg || !toArg) usage();
      const from = parseElArg(fromArg, labelOpt);
      const to = parseElArg(toArg, "");
      if (!from || !to) usage();
      return gestureCmd("drag", tabId, from, JSON.stringify(to));
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
    case "discover":
    case "actions":
      // 委托子命令：实际分派在 agent-collect.js main() 的 parseArgs 之前（参数原样透传
      // 给 runner 程序——各自的旗标白名单/退出码语义不同，全局 parseArgs 会双吃
      // --param/--dry/--session/--force）。此分支是命令表守卫（test-commands.js）的实现锚点。
      return { cmd, argv: args };
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
