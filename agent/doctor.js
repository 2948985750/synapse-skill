"use strict";
// doctor：只诊断链路和等待重连，不修改浏览器进程或 profile。
const fs = require("fs");
const path = require("path");
const { BRIDGE_DIR } = require("./paths");
const { readJson, unlinkQuiet } = require("./lib/json-store");
const { wait, failReply } = require("./lib/ui");
const { pidAlive, bridgeCandidates } = require("./registry");
const { bindAgentWs, connectBridge } = require("./transport");
const { authenticateServer, readToken } = require("./bridge-auth");
const { STATUS_TIMEOUT_MS, MAINT_LOCK_TTL_MS } = require("./config");

function summarizeDiag(d) {
  return {
    browserId: d.browserId || null,
    extensionId: d.extensionId || null,
    wsAgents: d.wsAgents || [],
    nativeConnected: !!d.nativeConnected,
    captureSessions:
      typeof d.captureSessions === "number" ? d.captureSessions : null,
    lastLog: d.log?.at(-1) || null,
    lastWsLog: d.wsLog?.at(-1) || null,
  };
}

async function probeStatusSnapshot(opts = {}, deps = {}) {
  const candidates = (deps.bridgeCandidates || bridgeCandidates)(opts);
  const token = (deps.readToken || readToken)();
  const budget = deps.timeoutMs || STATUS_TIMEOUT_MS;
  let lastError = null;
  let connected = false;
  const started = Date.now();
  for (const [index, b] of candidates.entries()) {
    const remaining = budget - (Date.now() - started);
    if (remaining <= 0) {
      lastError = lastError || new Error("Status deadline exceeded");
      break;
    }
    let channel;
    try {
      const deadline = Date.now() + Math.max(1, Math.floor(remaining / (candidates.length - index)));
      channel = await (deps.connectBridge || connectBridge)(
        b,
        token,
        { ...opts, skipGracefulDisconnect: true },
        Math.max(1, deadline - Date.now()),
      );
      connected = true;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("Status deadline exceeded");
      const result = failReply(await channel.sendCmd({ cmd: "diag" }, left));
      const expectedId = opts.browserId || process.env.WB_BROWSER_ID;
      if (expectedId && result.browserId !== expectedId) {
        throw new Error("Browser identity mismatch: expected " + expectedId + ", got " + (result.browserId || "unavailable"));
      }
      return {
        ok: true,
        bridge: { pid: b.pid, port: b.port, sid: b.sid, alive: true },
        extension: summarizeDiag(result),
        fastPath: true,
      };
    } catch (error) {
      lastError = error;
    } finally {
      if (channel) await channel.close(false);
    }
  }
  const noBridge = !candidates.length;
  return {
    ok: false,
    bridge: null,
    extension: null,
    bridgeAlive: connected,
    fastPath: !noBridge,
    tried: candidates.map((b) => ({ sid: b.sid, port: b.port })),
    error: noBridge
      ? "No live bridge discovery record"
      : String((lastError && lastError.message) || "status deadline exceeded"),
    code: noBridge ? "NO_BRIDGE" : "STATUS_UNAVAILABLE",
  };
}

async function runStatus(opts) {
  const snap = await probeStatusSnapshot(opts);
  process.stdout.write(JSON.stringify(snap) + "\n");
  if (!snap.ok) process.exitCode = 1;
}

function dataDir() {
  return path.dirname(BRIDGE_DIR);
} // data/

function maintenanceLockFile(dir = dataDir()) {
  return path.join(dir, "maintenance.lock.json");
}

function appendMaintenanceLog(line, dir = dataDir()) {
  try {
    fs.appendFileSync(
      path.join(dir, "maintenance.log"),
      JSON.stringify(
        Object.assign({ ts: Date.now(), pid: process.pid }, line),
      ) + "\n",
    );
  } catch (_) {}
}

async function acquireMaintenanceLock(timeoutMs = 30000, dir = dataDir()) {
  const file = maintenanceLockFile(dir);
  // 全新安装时 data/ 不存在（gitignore 掉了空目录），早先 openSync 直接 ENOENT，
  // 导致 doctor 在任何一次干净安装上都跑不起来。
  fs.mkdirSync(dir, { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      // "wx"（O_CREAT|O_EXCL）原子创建：多会话并发时只有一个赢家。
      const fd = fs.openSync(file, "wx");
      fs.writeSync(
        fd,
        JSON.stringify({
          pid: process.pid,
          ts: Date.now(),
          phase: "hard-refresh",
        }),
      );
      fs.closeSync(fd);
      return { file, acquired: true };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let holder = null;
      holder = readJson(file);
      const stale =
        !holder ||
        !Number.isInteger(holder.pid) ||
        !pidAlive(holder.pid) ||
        Date.now() - (holder.ts || 0) > MAINT_LOCK_TTL_MS;
      if (stale) {
        unlinkQuiet(file);
        continue;
      } // 残留锁（持锁者被强杀）→ 窃取重试
      if (Date.now() >= deadline) return { file, acquired: false, holder };
      await wait(2000); // 活锁：等持锁者完成硬刷
    }
  }
}

function releaseMaintenanceLock(lock) {
  if (!lock || !lock.acquired) return;
  const cur = readJson(lock.file);
  if (cur && cur.pid === process.pid) unlinkQuiet(lock.file);
}

function startProbeServer(token, waitMs) {
  let state = { done: false };
  let portReadyResolve;
  // 外部取消：runDoctor 一旦提前返回（礼貌等待成功 / 硬刷成功），必须能立刻关掉探针，
  // 否则进程会被探针自己的 waitMs 定时器（默认 60s/90s）继续挂住 —— 实测 --wait 8s
  // 时 5s 已输出结果、8s 才退出，默认等待时多挂近一分钟。
  let cancelDetect = null;
  const portReady = new Promise((r) => {
    portReadyResolve = r;
  });
  const promise = (async () => {
    const t0 = Date.now();
    let srv;
    try {
      const bound = await bindAgentWs();
      srv = bound.srv;
      portReadyResolve(bound.port);
      const detected = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), waitMs);
        if (timer && typeof timer.unref === "function") timer.unref();
        const finish = (v) => {
          if (!state.done) {
            state.done = true;
            clearTimeout(timer);
            resolve(v);
          }
        };
        cancelDetect = () => finish(false);
        srv.on("close", () => finish(false));
        srv.on("connection", (peer, request) => {
          authenticateServer(peer, request, token, (role) => {
            if (role === "extension") {
              finish(true);
              return;
            }
            try {
              peer.close(1008, "probe endpoint accepts an extension only");
            } catch (_) {}
          });
        });
      });
      return {
        detected,
        ms: Date.now() - t0,
        port: srv && srv.address && srv.address().port,
      };
    } catch (error) {
      return {
        detected: false,
        error: String((error && error.message) || error),
        ms: Date.now() - t0,
      };
    } finally {
      if (srv) {
        try {
          for (const p of srv.clients) p.terminate();
        } catch (_) {}
        try {
          await new Promise((resolve) => {
            srv.once("close", resolve);
            srv.close();
          });
        } catch (_) {}
      }
    }
  })();
  return { promise, portReady, cancel: () => { if (cancelDetect) cancelDetect(); } };
}

async function runDoctor(token, opts = {}, deps = {}) {
  const probe = deps.probeStatusSnapshot || probeStatusSnapshot;
  const sleep = deps.wait || wait;
  const emit = deps.emit || ((obj) => process.stdout.write(JSON.stringify(obj) + "\n"));
  const waitMs = opts.waitMs == null ? 60000 : opts.waitMs;
  if (!Number.isFinite(waitMs) || waitMs < 0) throw new Error("doctor: waitMs must be non-negative and finite");
  if (opts.forceKill || process.env.WB_EDGE_KILL_ALL === "1") {
    throw new Error("doctor no longer kills browsers; restart the intended browser manually");
  }
  const started = Date.now();
  let snapshot = await probe(opts);
  if (!snapshot.ok && !opts.dry && !opts.force) {
    const deadline = Date.now() + waitMs;
    while (!snapshot.ok && Date.now() < deadline) {
      await sleep(Math.min(1000, deadline - Date.now()));
      snapshot = await probe(opts);
    }
  }
  const result = {
    ok: snapshot.ok,
    action: snapshot.ok ? (Date.now() - started > 1000 ? "waited" : "none") : (opts.dry ? "dry-run" : "manual-recovery-required"),
    plan: { kill: false, clearCaches: false, relaunch: false },
    snapshot,
    ms: Date.now() - started,
  };
  if (!snapshot.ok) {
    result.error = "Check the selected session bridge and reload Synapse in the intended browser profile; doctor does not modify browser processes or profiles";
    process.exitCode = 1;
  }
  emit(result);
  return result;
}

module.exports = { summarizeDiag, probeStatusSnapshot, runStatus, dataDir, maintenanceLockFile, appendMaintenanceLog, acquireMaintenanceLock, releaseMaintenanceLock, startProbeServer, runDoctor };
