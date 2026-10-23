"use strict";
// doctor：链路体检与协调恢复（探针 → 礼貌等待 → 维护锁内的硬刷）。
// 这是唯一依赖 Windows 细节（taskkill / Edge 路径 / profile 目录）的模块。
const fs = require("fs");
const path = require("path");
const { execSync, spawn } = require("child_process");
const { BRIDGE_DIR, resolveExtDir } = require("./paths");
const { readJson, unlinkQuiet } = require("./lib/json-store");
const { wait, failReply } = require("./lib/ui");
const { pidAlive, bridgeCandidates, listLiveBridges } = require("./registry");
const { bindAgentWs, connectBridge } = require("./transport");
const { authenticateServer, readToken } = require("./bridge-auth");
const { STATUS_TIMEOUT_MS, MAINT_LOCK_TTL_MS } = require("./config");

function summarizeDiag(d) {
  return {
    wsAgents: d.wsAgents || [],
    nativeConnected: !!d.nativeConnected,
    captureSessions:
      typeof d.captureSessions === "number" ? d.captureSessions : null,
    lastLog: d.log?.at(-1) || null,
    lastWsLog: d.wsLog?.at(-1) || null,
  };
}

async function probeStatusSnapshot(opts) {
  const candidates = bridgeCandidates(opts);
  const token = readToken();
  let lastError = null;
  let connected = false;
  const started = Date.now();
  for (const b of candidates) {
    const remaining = STATUS_TIMEOUT_MS - (Date.now() - started);
    if (remaining <= 0) {
      lastError = lastError || new Error("Status deadline exceeded");
      break;
    }
    let channel;
    try {
      channel = await connectBridge(
        b,
        token,
        { ...opts, skipGracefulDisconnect: true },
        Math.max(300, remaining),
      );
      connected = true;
      const left = STATUS_TIMEOUT_MS - (Date.now() - started);
      if (left <= 0) throw new Error("Status deadline exceeded");
      const result = failReply(await channel.sendCmd({ cmd: "diag" }, left));
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

function findEdgeExe() {
  const candidates = [];
  if (process.env.WB_EDGE_EXE) candidates.push(process.env.WB_EDGE_EXE);
  const pf86 = process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
  const pf = process.env.PROGRAMFILES || "C:\\Program Files";
  for (const base of [pf86, pf])
    candidates.push(
      path.join(base, "Microsoft", "Edge", "Application", "msedge.exe"),
    );
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch (_) {}
  }
  return "msedge.exe"; // 交给 PATH
}

function killAllEdge() {
  if (process.platform !== "win32")
    throw new Error(
      "doctor 硬刷目前仅支持 Windows（taskkill）；其它平台请按 T-17 手工恢复",
    );
  try {
    execSync("taskkill /f /im msedge.exe /t", {
      stdio: "ignore",
      timeout: 20000,
    });
  } catch (_) {} // 没有 Edge 也算成功
}

function clearSwCaches() {
  const ud =
    process.env.WB_EDGE_USER_DATA_DIR ||
    path.join(
      process.env.LOCALAPPDATA || ".",
      "Microsoft",
      "Edge",
      "User Data",
      "Default",
    );
  for (const sub of ["Service Worker", "Code Cache"]) {
    try {
      fs.rmSync(path.join(ud, sub), { recursive: true, force: true });
    } catch (_) {}
  }
}

function launchEdge(exe, extDir = resolveExtDir()) {
  const child = spawn(exe, ["--load-extension=" + extDir], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  // spawn 失败（WB_EDGE_EXE 写错/PATH 里没有）是异步 error 事件，不监听会变成未捕获异常，
  // 而此时浏览器已经被杀了 —— 至少要让调用方知道"启动失败"而不是静默留个空桌面。
  child.on("error", (error) => {
    appendMaintenanceLog({ phase: "edge-launch-failed", error: String(error.message || error) });
  });
  child.unref();
  return extDir;
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

async function runDoctor(token, opts) {
  const say = (m) => console.error("[doctor] " + m);
  const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
  const t0 = Date.now();
  // 1) 快查
  let snap = await probeStatusSnapshot(opts);
  if (snap.ok) {
    say(
      "链路健康：桥 " +
        snap.bridge.sid +
        "@" +
        snap.bridge.port +
        " → 扩展在线，无需动作",
    );
    emit({
      ok: true,
      action: "none",
      via: "bridge",
      snapshot: snap,
      ms: Date.now() - t0,
    });
    return;
  }
  // --dry 只看不动：快查失败就直接打印计划返回，不再走 60s 礼貌等待
  // （早先 --dry 也要等满 waitMs，且会被探针再挂住一分钟）。
  if (opts.dry) {
    say(
      "dry-run：将执行 taskkill /f /im msedge.exe + 清默认 profile 的 Service Worker/Code Cache + 重启 msedge --load-extension",
    );
    emit({
      ok: false,
      action: "dry-run",
      plan: { kill: "msedge.exe", clearCaches: true, relaunch: true },
      snapshot: snap,
      ms: Date.now() - t0,
    });
    process.exitCode = 1;
    return;
  }
  // 2) 礼貌等待：探针端口 + 活桥双通道接 SW 重拨（期间别的会话的恢复也会让它变好）
  if (!opts.force) {
    say(
      "扩展不在线（" +
        (snap.error || snap.code || "unknown") +
        "），礼貌等待 " +
        opts.waitMs +
        "ms：宿主探针端口接 SW 重拨，同时轮询活桥",
    );
    const probe = startProbeServer(token, opts.waitMs);
    let probeResult = null;
    probe.promise.then((r) => {
      probeResult = r;
    });
    for (;;) {
      await wait(5000);
      const s = await probeStatusSnapshot(opts);
      if (s.ok) {
        probe.cancel();
        say("链路已恢复（活桥 " + s.bridge.sid + " 收到扩展），无需硬刷");
        emit({
          ok: true,
          action: "waited",
          via: "bridge",
          waitedMs: Date.now() - t0,
        });
        return;
      }
      if (probeResult && probeResult.detected) {
        probe.cancel();
        say(
          "扩展 SW 已重拨探针端口（" +
            (probeResult.port || "?") +
            "），无需硬刷",
        );
        emit({
          ok: true,
          action: "waited",
          via: "probe",
          waitedMs: Date.now() - t0,
        });
        return;
      }
      if (Date.now() - t0 >= opts.waitMs) break;
    }
    probe.cancel();
    say("礼貌等待超时（" + opts.waitMs + "ms），进入协调硬刷");
  }
  // 3) 协调硬刷：锁内的会话独占 kill+清缓存+重启；排上的会话等锁释放后复查
  const lock = await acquireMaintenanceLock(opts.waitMs);
  if (!lock.acquired) {
    const s = await probeStatusSnapshot(opts);
    if (s.ok) {
      say(
        "另一个会话的硬刷已生效（holder pid=" +
          lock.holder.pid +
          "），链路恢复",
      );
      emit({
        ok: true,
        action: "waited",
        via: "concurrent-repair",
        snapshot: s,
      });
      return;
    }
    say(
      "另一个会话正在恢复（holder pid=" +
        (lock.holder && lock.holder.pid) +
        "）且链路仍未好；稍后重试，或 --force 跳过礼貌等待",
    );
    emit({
      ok: false,
      action: "lock-held",
      holder: lock.holder,
      error: "another session holds the maintenance lock",
    });
    process.exitCode = 1;
    return;
  }
  try {
    appendMaintenanceLog({
      phase: "hard-refresh-start",
      reason: snap.error || snap.code || "extension offline",
    });
    // 拿锁之后、动手之前再复查一次：等锁期间别的会话可能已经把链路修好，
    // 按原实现这里会再杀一次浏览器（注释写的是"别人已修好就直接放行"，与代码相反）。
    const recheck = await probeStatusSnapshot(opts);
    if (recheck.ok) {
      say("等锁期间链路已恢复（holder 已修好），跳过硬刷");
      emit({ ok: true, action: "waited", via: "lock-recheck", snapshot: recheck });
      return;
    }
    // 所有可能抛错的准备都在破坏性操作之前完成：
    // 早先是先 kill 再清缓存、最后才由 launchEdge 校验 manifest，路径错了浏览器就留在关闭状态。
    const edgeExe = findEdgeExe();
    const extDir = resolveExtDir();
    killAllEdge();
    await wait(2000); // 等进程退干净（profile 锁释放）
    clearSwCaches();
    launchEdge(edgeExe, extDir);
    appendMaintenanceLog({ phase: "edge-relaunched", extDir });
    // 预算从重启成功开始算，不含前面最长 60s 的礼貌等待与最长 60s 的等锁。
    const hardStart = Date.now();
    const HARD_BUDGET_MS = 150000;
    say("已杀 Edge + 清 SW/Code Cache + 带扩展重启，等待扩展上线（≤90s）");
    const hardProbe = startProbeServer(
      token,
      Math.min(90000, Math.max(5000, HARD_BUDGET_MS - (Date.now() - hardStart))),
    );
    let probeResult = null;
    hardProbe.promise.then((r) => {
      probeResult = r;
    });
    let ok = false;
    while (Date.now() - hardStart < HARD_BUDGET_MS) {
      await wait(5000);
      if (probeResult && probeResult.detected) {
        ok = true;
        break;
      }
      const s = await probeStatusSnapshot(opts);
      if (s.ok) {
        ok = true;
        break;
      }
    }
    // 无论成功/超时都关掉探针：否则它会按自己的 waitMs 继续占着事件循环，
    // 让已经拿到结论的 doctor 进程多挂近一分钟。
    hardProbe.cancel();
    if (ok) {
      appendMaintenanceLog({ phase: "hard-refresh-ok" });
      say("硬刷完成：扩展已上线，链路恢复");
      emit({ ok: true, action: "hard-refresh", ms: Date.now() - t0 });
    } else {
      appendMaintenanceLog({ phase: "hard-refresh-timeout" });
      say(
        "硬刷超时：扩展仍未上线；请手工按 T-17 配方复查（浏览器是否起、扩展是否加载）",
      );
      emit({
        ok: false,
        action: "hard-refresh",
        error: "extension did not come back within hard-refresh budget",
      });
      process.exitCode = 1;
    }
  } finally {
    releaseMaintenanceLock(lock);
  }
}

module.exports = { summarizeDiag, probeStatusSnapshot, runStatus, dataDir, maintenanceLockFile, appendMaintenanceLog, acquireMaintenanceLock, releaseMaintenanceLock, findEdgeExe, killAllEdge, clearSwCaches, launchEdge, startProbeServer, runDoctor };
