"use strict";

const crypto = require("crypto");

// This router only receives sockets after mutual authentication has completed.
// Deadlines limit dispatch; a timeout cannot undo a command already executed.

// 清理确认的超时：扩展收到 client.disconnect 后若 SW 被挂起（MV3 空闲 30s 即挂），
// 不回包就会让这条 socket 永久停在 cleaning=true 并留在 clients 里 —— 常驻 serve
// 跑几天会攒下一堆僵尸连接。超时后按"未确认"处理并释放身份。
const CLEANUP_TIMEOUT_MS = 5000;
// 扩展 socket 静默超过这个时长就认为它已半开（SW 挂起但 TCP 未断），允许新扩展替换。
const STALE_EXTENSION_MS = 20000;
// 每个客户端同时挂在途命令的上限（早先 pending 无界，单客户端可无限灌）。
const MAX_PENDING_PER_CLIENT = 64;
// cleanups 上限：超时后保留身份是为了避免"迟到的 disconnect 误清新会话"，
// 但必须有界，否则扩展永不回包时会一直攒着。
const MAX_CLEANUPS = 64;
// lateStarts 是"超时后才回来的 capture.start"的补偿队列，必须有上限。
const LATE_STARTS_MAX = 200;
// 心跳 reaper（F-6.1）：STALE_EXTENSION_MS 只在"新扩展拨入"时才救场；
// 扩展彻底失联（SW 挂起、半开）且没有新拨入时，slot 会永久被僵尸占住。
// reaper 周期检查：扩展 socket 静默超过 HEARTBEAT_TIMEOUT_MS 就 terminate，
// 释放 slot、状态不再被当成活桥。周期 10s；阈值 40s = 2×扩展 ping 周期
// （扩展 20s 一次 ping，agent 回 pong；正常活桥的任何帧都会刷新 lastFrameAt）。
const HEARTBEAT_CHECK_MS = 10000;
const HEARTBEAT_TIMEOUT_MS = 40000;
// 纯函数判定：lastFrameAt 距 now 是否超过超时阈值（> 而非 >=，边界可测）。
function isExtensionStale(lastFrameAt, now, timeoutMs = HEARTBEAT_TIMEOUT_MS) {
  return now - lastFrameAt > timeoutMs;
}

function createBridgeRouter({
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let extension = null;
  const clients = new Map();
  const pending = new Map();
  const queue = [];
  const captureOwners = new Map();
  const cleanups = new Map();
  const lateStarts = new Map();
  const earlyEvents = new Map();
  let lastExtensionSeen = 0;
  let reaperTimer = null;

  function send(socket, message) {
    if (!socket || socket.readyState !== 1) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch (_) {
      return false;
    }
  }
  function finish(entry, reply) {
    if (!pending.delete(entry.wireId)) return;
    clearTimer(entry.timer);
    const index = queue.indexOf(entry);
    if (index !== -1) queue.splice(index, 1);
    if (reply)
      send(entry.socket, { ...reply, type: "agent.result", id: entry.id });
  }
  function rememberLateStart(wireId, command) {
    lateStarts.set(wireId, command);
    while (lateStarts.size > LATE_STARTS_MAX)
      lateStarts.delete(lateStarts.keys().next().value);
  }
  function expire(entry) {
    if (entry.dispatched) {
      send(extension, { type: "cancel", id: entry.wireId });
      if (entry.command.cmd === "capture.start")
        rememberLateStart(entry.wireId, entry.command);
    }
    finish(entry, {
      ok: false,
      error:
        "Command deadline exceeded; any operation already dispatched may have executed",
      code: "COMMAND_TIMEOUT",
    });
  }
  function forward(entry) {
    if (!clients.has(entry.socket) || entry.socket.readyState !== 1) {
      finish(entry);
      return;
    }
    if (entry.deadlineAt <= now()) {
      expire(entry);
      return;
    }
    if (
      send(extension, {
        ...entry.command,
        id: entry.wireId,
        deadlineAt: entry.deadlineAt,
      })
    )
      entry.dispatched = true;
  }
  function attachExtension(socket) {
    if (extension && extension !== socket && extension.readyState === 1) {
      // 稳定身份优先；但旧连接可能是"半开"的（SW 挂起、TCP 还在），
      // 那种情况下新扩展会被永久 1008 拒绝，所以静默超过阈值就替换。
      if (now() - lastExtensionSeen < STALE_EXTENSION_MS) {
        socket.close(1008, "An extension is already connected");
        return false;
      }
      try {
        extension.terminate();
      } catch (_) {}
      extension = null;
    }
    extension = socket;
    lastExtensionSeen = now();
    // 心跳 reaper 启动（只在无活动时挂）：静默超过阈值即使没有新扩展拨入，
    // 也把半开 socket terminate 掉，释放 slot。
    armReaper();
    for (const entry of [...queue]) {
      const index = queue.indexOf(entry);
      if (index !== -1) queue.splice(index, 1);
      forward(entry);
    }
    return true;
  }
  // reaper 定时器在真实 setTimeout 下 unref（serve 进程本身被 WS server 挂着，
  // 不需要靠它续命；也避免"router 忘了 close"时定时器把测试进程钉住 10s）。
  function armReaper() {
    if (reaperTimer != null) return;
    reaperTimer = setTimer(reapStaleExtension, HEARTBEAT_CHECK_MS);
    if (reaperTimer && typeof reaperTimer.unref === "function")
      reaperTimer.unref();
  }
  function reapStaleExtension() {
    // 本条定时器已触发（harness/真定时器皆然）：标记失效，走完检查后重新挂。
    reaperTimer = null;
    // 无 socket 时纯 no-op（仍然自续期，扩展随时可能拨入）。
    if (
      extension &&
      extension.readyState === 1 &&
      lastExtensionSeen > 0 &&
      isExtensionStale(lastExtensionSeen, now())
    ) {
      try {
        extension.terminate();
      } catch (_) {
        try {
          extension.close(1008, "stale extension");
        } catch (__) {}
      }
      // 真实 socket：terminate 后 close 事件会走 disconnect() 做全套清理，不重复。
      // 假 socket（测试桩，无 close 事件）terminate 后 readyState 仍是 1：
      // 本地直接 disconnect，否则 slot 永远停在僵尸上。
      if (extension.readyState === 1) disconnect(extension);
    }
    armReaper();
  }
  function addClient(socket) {
    clients.set(socket, { clientId: null, transientClient: true });
  }
  function clientMessage(socket, message) {
    const client = clients.get(socket);
    if (!client || !message || message.id == null) return;
    if (message.type === "client.disconnect") {
      cleanupClient(socket, client, message.id);
      return;
    }
    if (client.cleaning) {
      send(socket, {
        type: "agent.result",
        id: message.id,
        ok: false,
        error: "Client cleanup is still in progress",
        code: "CLIENT_CLOSING",
      });
      return;
    }
    if (message.type === "cancel") {
      for (const entry of [...pending.values()])
        if (entry.socket === socket && entry.id === message.id) expire(entry);
      return;
    }
    if (!["cmd", "agent.cmd"].includes(message.type)) return;
    if (
      typeof message.clientId !== "string" ||
      !message.clientId ||
      message.clientId.length > 128
    ) {
      send(socket, {
        type: "agent.result",
        id: message.id,
        ok: false,
        error: "A valid clientId is required",
        code: "INVALID_CLIENT",
      });
      return;
    }
    if (client.clientId && client.clientId !== message.clientId) {
      send(socket, {
        type: "agent.result",
        id: message.id,
        ok: false,
        error: "A connection cannot change clientId",
        code: "INVALID_CLIENT",
      });
      return;
    }
    if (
      [...clients.entries()].some(
        ([other, value]) =>
          other !== socket && value.clientId === message.clientId,
      )
    ) {
      send(socket, {
        type: "agent.result",
        id: message.id,
        ok: false,
        error: "clientId is already active on another connection",
        code: "CLIENT_BUSY",
      });
      return;
    }
    client.clientId = message.clientId;
    client.transientClient = message.transientClient !== false;
    const timeoutMs =
      Number.isFinite(message.timeoutMs) && message.timeoutMs > 0
        ? Math.min(message.timeoutMs, 300000)
        : 30000;
    const deadlineAt = Math.min(
      now() + timeoutMs,
      Number.isFinite(message.deadlineAt) ? message.deadlineAt : Infinity,
    );
    const entry = {
      socket,
      id: message.id,
      wireId: crypto.randomUUID(),
      command: { ...message, clientId: client.clientId },
      deadlineAt,
      dispatched: false,
      timer: null,
    };
    let mine = 0;
    for (const other of pending.values()) if (other.socket === socket) mine++;
    if (mine >= MAX_PENDING_PER_CLIENT) {
      send(socket, {
        type: "agent.result",
        id: message.id,
        ok: false,
        error: "Too many in-flight commands on this connection",
        code: "CLIENT_BUSY",
      });
      return;
    }
    pending.set(entry.wireId, entry);
    entry.timer = setTimer(
      () => expire(entry),
      Math.max(0, deadlineAt - now()),
    );
    if (deadlineAt <= now()) {
      expire(entry);
      return;
    }
    if (extension && extension.readyState === 1) forward(entry);
    else if (queue.length >= 200)
      finish(entry, {
        ok: false,
        error: "Bridge command queue is full",
        code: "QUEUE_FULL",
      });
    else queue.push(entry);
  }
  function extensionMessage(socket, message) {
    if (socket !== extension || !message) return;
    // 任何帧（含 pong）都刷新心跳基准——这是 reaper 的存活证据。
    lastExtensionSeen = now();
    if (message.type === "ping") {
      // 心跳应答（F-6.1 双向）：serve 守护进程路径也要回 pong，
      // 否则扩展端拿不到 liveness 信号，挂起的 agent 成僵尸。
      send(socket, { type: "pong", ts: message.ts });
      return;
    }
    if (message.type === "agent.result") {
      const cleanup = cleanups.get(message.id);
      if (cleanup) {
        cleanups.delete(message.id);
        if (cleanup.timer) clearTimer(cleanup.timer);
        clients.delete(cleanup.socket);
        if (cleanup.replyId)
          send(cleanup.socket, { ...message, id: cleanup.replyId });
        return;
      }
      const late = lateStarts.get(message.id);
      if (late) {
        lateStarts.delete(message.id);
        if (message.ok && message.result?.captureId) {
          // 这条 capture 已被补偿停止，之前缓冲的早期事件不再需要。
          earlyEvents.delete(message.result.captureId);
          send(extension, {
            type: "cmd",
            id: crypto.randomUUID(),
            cmd: "capture.stop",
            args: {
              tabId: late.args?.tabId,
              captureId: message.result.captureId,
            },
            clientId: late.clientId,
            transientClient: late.transientClient,
            timeoutMs: 5000,
            deadlineAt: now() + 5000,
          });
        }
        return;
      }
      const entry = pending.get(message.id);
      if (!entry) return;
      if (entry.deadlineAt <= now()) {
        expire(entry);
        return;
      }
      if (
        message.ok &&
        entry.command.cmd === "capture.start" &&
        message.result?.captureId
      ) {
        captureOwners.set(message.result.captureId, {
          socket: entry.socket,
          clientId: entry.command.clientId,
        });
      }
      if (
        message.ok &&
        entry.command.cmd === "capture.stop" &&
        entry.command.args?.captureId
      )
        captureOwners.delete(entry.command.args.captureId);
      finish(entry, message);
      if (message.ok && entry.command.cmd === "capture.start") {
        const early = earlyEvents.get(message.result?.captureId);
        earlyEvents.delete(message.result?.captureId);
        if (early) for (const event of early) extensionMessage(socket, event);
      }
    } else if (message.type === "event.push") {
      const owner = captureOwners.get(message.captureId);
      if (
        owner &&
        message.clientId === owner.clientId &&
        clients.has(owner.socket)
      )
        send(owner.socket, message);
      else if (
        !owner &&
        [...pending.values()].some(
          (entry) =>
            entry.command.cmd === "capture.start" &&
            entry.command.clientId === message.clientId &&
            entry.command.args?.tabId === message.tabId,
        )
      ) {
        let buffer = earlyEvents.get(message.captureId);
        if (!buffer && earlyEvents.size < 200) {
          buffer = [];
          earlyEvents.set(message.captureId, buffer);
        }
        if (buffer && buffer.length < 100) buffer.push(message);
      }
    }
  }
  function cleanupClient(socket, client, replyId) {
    if (client.cleaning) return;
    client.cleaning = true;
    for (const entry of [...pending.values()])
      if (entry.socket === socket) {
        if (entry.dispatched) {
          send(extension, { type: "cancel", id: entry.wireId });
          if (entry.command.cmd === "capture.start")
            rememberLateStart(entry.wireId, entry.command);
        }
        finish(entry);
      }
    for (const [captureId, owner] of captureOwners)
      if (owner.socket === socket) captureOwners.delete(captureId);
    for (const [captureId, events] of earlyEvents)
      if (events[0]?.clientId === client.clientId)
        earlyEvents.delete(captureId);
    if (!client.clientId || !extension || extension.readyState !== 1) {
      clients.delete(socket);
      if (replyId)
        send(socket, {
          type: "agent.result",
          id: replyId,
          ok: true,
          result: { disconnected: true },
        });
      return;
    }
    const id = crypto.randomUUID();
    const timer = setTimer(() => {
      if (!cleanups.has(id)) return;
      // 不释放 identity：扩展可能稍后才真正执行这条 disconnect；若此时同 clientId 的
      // 新会话已建立，提前释放会让迟到的清理误伤新会话。这里只回超时并关掉本地 socket，
      // 身份留到扩展 ack 或扩展断开时回收；同时用 MAX_CLEANUPS 保证有界。
      if (replyId)
        send(socket, {
          type: "agent.result",
          id: replyId,
          ok: false,
          error: "Client cleanup was not acknowledged in time",
          code: "CLEANUP_TIMEOUT",
        });
      try {
        socket.close(1008, "cleanup timeout");
      } catch (_) {}
      while (cleanups.size > MAX_CLEANUPS) {
        const oldest = cleanups.keys().next().value;
        const stale = cleanups.get(oldest);
        cleanups.delete(oldest);
        if (stale && stale.timer) clearTimer(stale.timer);
        if (stale) clients.delete(stale.socket);
      }
    }, CLEANUP_TIMEOUT_MS);
    if (timer && typeof timer.unref === "function") timer.unref();
    cleanups.set(id, { socket, client, replyId, timer });
    send(extension, {
      type: "client.disconnect",
      id,
      clientId: client.clientId,
      releaseLeases: client.transientClient,
    });
    // Keep the identity reserved until the worker acknowledges cleanup. Releasing
    // it on a timer would let an old cleanup destroy a newly opened session.
  }
  function disconnect(socket) {
    if (socket === extension) {
      extension = null;
      captureOwners.clear();
      earlyEvents.clear();
      lateStarts.clear();
      // 扩展 slot 已空：停掉心跳 reaper（新扩展接入时会重新挂上）。
      if (reaperTimer) {
        clearTimer(reaperTimer);
        reaperTimer = null;
      }
      for (const entry of [...pending.values()])
        if (entry.dispatched)
          finish(entry, {
            ok: false,
            error:
              "Extension disconnected; the dispatched operation may have executed",
            code: "EXTENSION_DISCONNECTED",
          });
      for (const cleanup of cleanups.values()) {
        if (cleanup.timer) clearTimer(cleanup.timer);
        clients.delete(cleanup.socket);
        if (cleanup.replyId)
          send(cleanup.socket, {
            type: "agent.result",
            id: cleanup.replyId,
            ok: false,
            error: "Extension disconnected during cleanup",
            code: "EXTENSION_DISCONNECTED",
          });
      }
      cleanups.clear();
    }
    const client = clients.get(socket);
    if (client) cleanupClient(socket, client);
  }
  function close() {
    for (const socket of [...clients.keys()]) disconnect(socket);
    for (const entry of [...pending.values()]) finish(entry);
    captureOwners.clear();
    earlyEvents.clear();
    lateStarts.clear();
    if (reaperTimer) {
      clearTimer(reaperTimer);
      reaperTimer = null;
    }
    for (const cleanup of cleanups.values())
      if (cleanup.timer) clearTimer(cleanup.timer);
    cleanups.clear();
    clients.clear();
  }
  return {
    addClient,
    clientMessage,
    attachExtension,
    extensionMessage,
    disconnect,
    close,
  };
}

module.exports = {
  createBridgeRouter,
  isExtensionStale,
  HEARTBEAT_CHECK_MS,
  HEARTBEAT_TIMEOUT_MS,
};
