"use strict";
// Synapse agent-side WS bridge (skill 层：跑在 node 里，不在浏览器扩展内).
// Paths are no longer hard-coded to the skill source dir; they resolve through
// ./paths.js so WB_DATA_DIR / WB_BRIDGE_FILE / WB_BRIDGE_DIR / WB_CDP_EXT_DIR
// can point runtime data and the unpacked extension wherever the user wants.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { createBridgeRouter } = require("./bridge-router");
const { readToken, authenticateServer } = require("./bridge-auth");
const {
  SID_RE,
  writeBridge,
  unlinkBridge,
  writeRegistryEntry,
  unlinkRegistryEntry,
  bridgeCandidates,
} = require("./registry");
const { wait, writeFailure } = require("./lib/ui");
const {
  bindAgentWs,
  connectBridge,
  connectDirect,
  connectBridgeChain,
  executeCommand,
} = require("./transport");
const { probeStatusSnapshot, runStatus, runDoctor } = require("./doctor");
const { usage, parseArgs, buildCmd, validateOptions } = require("./cli");
const {
  STATUS_TIMEOUT_MS,
  PORT_RANGE_START,
  PORT_RANGE_END,
  PORT_RANGE_OVERRIDDEN,
} = require("./config");

// 端口段被覆盖时的双端契约告警：扩展默认只扫 9521–9540（写死同一段），
// 用户若只在 agent 侧设了 WB_AGENT_WS_START/END，扩展会静默发现不了桥。
// 凡是"起监听端口、等扩展拨入"的入口都打一次这条 stderr 告警。
function warnIfPortRangeOverridden() {
  if (!PORT_RANGE_OVERRIDDEN) return;
  console.error(
    "⚠ 你覆盖了 WS 端口段（WB_AGENT_WS_START/END → " +
      PORT_RANGE_START +
      "–" +
      PORT_RANGE_END +
      "）；扩展端默认只扫 9521–9540，若想让扩展也跟随此段，请在扩展 chrome.storage.local 里设置 wbAgentWsRange（{start,end}），否则扩展发现不到桥",
  );
}

// 写注册表失败时必须先关掉监听再抛错：早先 writeRegistryEntry 裸调，
// srv 仍持有事件循环，进程会"报错但活着"，用户看到 JSON 错误却关不掉窗口。
async function registerOrCleanup(srv, session, port) {
  try {
    writeRegistryEntry(session, port);
  } catch (error) {
    try {
      for (const socket of srv.clients) socket.terminate();
    } catch (_) {}
    await new Promise((resolve) => srv.close(resolve));
    throw error;
  }
}

// 逐个试连候选桥（连接层故障转移；命令尚未发出，安全）。全失败抛 NO_BRIDGE。
// serve 与 keep 共用同一套连接接线：鉴权 → 分角色（extension/client）→ 消息分发。
// 两处早先是逐字复制的，协议一改就要同步改两遍。
function wireBridgeServer(srv, router, token) {
  srv.on("connection", (socket, request) => {
    let role = null;
    socket.on("close", () => router.disconnect(socket));
    authenticateServer(socket, request, token, (authenticatedRole) => {
      role = authenticatedRole;
      if (role === "extension") {
        if (!router.attachExtension(socket)) return;
      } else router.addClient(socket);
      socket.on("message", (raw) => {
        let message;
        try {
          message = JSON.parse(raw.toString());
        } catch (_) {
          return;
        }
        if (role === "extension") router.extensionMessage(socket, message);
        else router.clientMessage(socket, message);
      });
    });
  });
}

async function runServe(sid, token, opts = {}) {
  const { srv, port } = await bindAgentWs();
  warnIfPortRangeOverridden(); // 监听端口选定处：覆盖端口段时扩展默认扫不到这里
  const router = createBridgeRouter();
  const session = SID_RE.test(sid)
    ? sid
    : "b-" + crypto.randomBytes(3).toString("hex");
  await registerOrCleanup(srv, session, port);
  // --shared：额外写遗留单文件（data/bridge.json 或 WB_BRIDGE_FILE），供未升级脚本发现。
  if (opts.shared) {
    try {
      writeBridge(port);
    } catch (error) {
      console.error(
        "[serve] shared bridge record write failed: " + error.message,
      );
    }
  }
  wireBridgeServer(srv, router, token);
  console.error(
    "[serve] session=" +
      session +
      " listening on 127.0.0.1:" +
      port +
      "（本会话 one-shot：WB_SESSION=" +
      session +
      "）",
  );
  const shutdown = () => {
    router.close();
    unlinkRegistryEntry(session);
    if (opts.shared) unlinkBridge();
    for (const socket of srv.clients) socket.terminate();
    srv.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await new Promise((resolve) => srv.once("close", resolve));
  process.removeListener("SIGINT", shutdown);
  process.removeListener("SIGTERM", shutdown);
}
// --keep：临时会话桥 = serve 语义（注册表条目 + 多客户端路由），但不驻留后台：
// 自身作为第一个客户端执行本次命令，随后 park 到 Ctrl+C。注册表条目让同会话
// 后续 one-shot（WB_SESSION=<打印的 sid>）直接毫秒级复用，不必再走 60s 直连。
// 旧 --keep 的直连 server 只收扩展、拒绝其它客户端，是"会话桥"不可复用的根源。
async function runKeep(command, token, opts) {
  const { srv, port } = await bindAgentWs();
  warnIfPortRangeOverridden();
  const router = createBridgeRouter();
  const rawSid = opts.session || process.env.WB_SESSION || "";
  const session = SID_RE.test(rawSid)
    ? rawSid
    : "k-" + crypto.randomBytes(3).toString("hex");
  await registerOrCleanup(srv, session, port);
  wireBridgeServer(srv, router, token);
  console.error(
    "[keep] session=" +
      session +
      " bridge on 127.0.0.1:" +
      port +
      "（同会话 one-shot 复用：WB_SESSION=" +
      session +
      "；Ctrl+C 结束）",
  );
  const record = { sid: session, pid: process.pid, port, ts: Date.now() };
  let channel = null;
  try {
    channel = await connectBridge(record, token, {
      ...opts,
      skipGracefulDisconnect: true,
    });
    const result = await executeCommand(channel, command, opts);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    await new Promise((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
  } finally {
    if (channel) await channel.close(false);
    router.close();
    unlinkRegistryEntry(session);
    for (const socket of srv.clients) socket.terminate();
    await new Promise((resolve) => srv.close(resolve));
  }
}
// 多会话（T-33）：逐个试连候选桥（会话桥优先），总时限仍为 STATUS_TIMEOUT_MS；
// 不回落 60s 直连路径。bridgeAlive 与 extension 可达性解耦（zhipin 探针只信
// bridgeAlive，避免把"扩展黑坑 T-23"误判为"桥死"而反复重启 serve）。
// probeStatusSnapshot 只做探测（doctor 复用）；runStatus 负责输出与退出码。

async function main(argv = process.argv.slice(2)) {
  // 统一 CLI 子命令：discover / actions 直接委托 runner 程序（各自有自己的参数
  // 白名单与退出码语义）。必须在 parseArgs 之前拦截——全局 parseArgs 会吃掉
  // --param/--dry/--session/--force/--max 等旗标（桥命令语义），与 runner 的语义冲突。
  const [head, ...rawRest] = argv;
  if (head === "discover" || head === "actions") {
    if (head === "discover") {
      const { main: runDiscover } = require("../runner/discover");
      const code = await runDiscover(rawRest).catch((e) => {
        console.error("[discover] 失败: " + (e && e.message ? e.message : e));
        return 1;
      });
      process.exitCode = code || 0;
    } else {
      const { main: runActions } = require("../runner/actions");
      await runActions(rawRest).catch((e) => {
        console.error("[action] 失败: " + (e && e.message ? e.message : e));
        process.exitCode = 1;
      });
    }
    return;
  }
  const opts = parseArgs(argv);
  if (!opts.rest.length) usage();
  const command = buildCmd(opts.rest, opts);
  validateOptions(opts);
  opts.transientClient = !opts.clientId;
  opts.clientId = opts.clientId || "cli-" + crypto.randomUUID();
  if (command.cmd === "config") {
    // 纯本地：查看/指定数据目录，无需扩展连入、不需要令牌。
    const paths = require("./paths");
    const cfgArgs = command.args || {};
    if (cfgArgs.action === "set") {
      if (!cfgArgs.value) {
        throw Object.assign(new Error("config set 需要一个目录，例如 config set data-root D:\\synapse-data"), { code: "INVALID_CONFIG" });
      }
      paths.writeConfig({ [cfgArgs.field]: path.resolve(cfgArgs.value) });
      paths.ensureDataDirs();
    } else if (cfgArgs.action === "reset") {
      paths.resetConfig();
    }
    process.stdout.write(JSON.stringify(Object.assign({ ok: true }, paths.describePaths()), null, 2) + "\n");
    return;
  }
  if (command.cmd === "status") {
    await runStatus(opts);
    return;
  }
  const token = readToken();
  if (command.cmd === "doctor") {
    await runDoctor(token, opts);
    return;
  }
  if (command.cmd === "serve") {
    await runServe(command.args?.sid, token, opts);
    return;
  }
  if (opts.keep) {
    await runKeep(command, token, opts);
    return;
  }
  let channel = null;
  let usedBridge = null;
  try {
    // 多会话发现（T-33）：候选 = 会话桥优先 + 其它活桥（ts 降序）+ 遗留单文件；
    // 逐个试连，全失败才回落 60s 直连慢路径（命令尚未发出，回落安全）。
    const candidates = bridgeCandidates(opts);
    if (candidates.length) {
      try {
        const picked = await connectBridgeChain(candidates, token, opts);
        channel = picked.channel;
        usedBridge = picked.bridge;
      } catch (error) {
        if (error.code !== "NO_BRIDGE" || ((opts.session || process.env.WB_SESSION) && !opts.allowFailover)) throw error;
      }
    }
    if (!channel) {
      if ((opts.session || process.env.WB_SESSION) && !opts.allowFailover) {
        const error = new Error("Selected session has no live bridge; refusing direct fallback");
        error.code = "NO_BRIDGE";
        throw error;
      }
      warnIfPortRangeOverridden(); // 直连慢路径也起监听端口等扩展拨入
      channel = await connectDirect(token, opts);
      if (candidates.length)
        console.error(
          "[collect] no reachable bridge (" +
            candidates.length +
            " tried); falling back to direct slow path (wait ≤ " +
            opts.waitMs +
            "ms)",
        );
    } else {
      console.error(
        "[collect] via bridge sid=" +
          usedBridge.sid +
          " port=" +
          usedBridge.port,
      );
    }
    const result = await executeCommand(channel, command, opts);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } finally {
    if (channel) await channel.close(false);
  }
}
if (require.main === module) main().catch(writeFailure);
module.exports = { main };
