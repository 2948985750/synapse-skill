"use strict";
// capture：网络响应体捕获的结果整形与多标签编排。
const { failReply, failEvaluation, wait } = require("./lib/ui");

function requestKey(captureId, requestId, sessionId) {
  return sessionId ? JSON.stringify([captureId, sessionId, requestId]) : captureId + ":" + requestId;
}

function normalizeCaptureOptions(opts = {}) {
  const normalized = { ...opts, durationMs: opts.durationMs == null ? 12000 : opts.durationMs };
  if (!Number.isFinite(normalized.durationMs) || normalized.durationMs <= 0) {
    const error = new Error("capture: durationMs must be positive and finite");
    error.code = "VALIDATION";
    throw error;
  }
  return normalized;
}

// 注意：totalRequestsSeen 只反映"存活缓冲"里看到的请求数——事件缓冲有 2000 条
// 上限（超限 shift 掉最旧的），dropped>0 时该数字被截断，结果靠
// truncated/droppedEventCount 两个字段如实标注，调用方不能再把截断当完整。
async function buildCaptureSessionResult(sendCmd, s, events, opts, bodyStore, dropped = 0) {
  const { tabId, action, captureId } = s;
  const { durationMs } = normalizeCaptureOptions(opts);

  // 合并事件：captureId + sessionId + requestId -> 请求信息。
  const reqs = new Map();
  for (const ev of events) {
    const p = ev.params || {};
    if (ev.method === "Network.requestWillBeSent") {
      reqs.set(requestKey(captureId, p.requestId, ev.sessionId), {
        requestId: p.requestId,
        ...(ev.sessionId ? { sessionId: ev.sessionId } : {}),
        url: p.request && p.request.url,
        method: p.request && p.request.method,
        type: p.type || "",
        status: 0,
        mimeType: "",
        size: 0,
      });
    } else if (ev.method === "Network.responseReceived") {
      const r = reqs.get(requestKey(captureId, p.requestId, ev.sessionId)) || {
        requestId: p.requestId,
        ...(ev.sessionId ? { sessionId: ev.sessionId } : {}),
        url: p.response && p.response.url,
        method: "",
        type: "",
        status: 0,
        mimeType: "",
        size: 0,
      };
      r.status = p.response ? p.response.status : 0;
      r.mimeType = p.response ? p.response.mimeType : "";
      reqs.set(requestKey(captureId, p.requestId, ev.sessionId), r);
    } else if (ev.method === "Network.loadingFinished") {
      const r = reqs.get(requestKey(captureId, p.requestId, ev.sessionId));
      if (r) r.size = p.encodedDataLength || p.totalBytes || 0;
    }
  }

  // 过滤（与 doCapture 一致：默认只留 xhr/fetch 或文本类数据体，二进制 MIME
  // 先杀——站点也用 XHR 拉图片/字体/protobuf（WhatsApp emoji 雪碧、douyin
  // x-protobuf），取它们的体只会浪费 CDP 调用并产生垃圾数据；--all 全留；
  // --filter 正则再筛）。BINARY_MIME 与 runner/discover.js 的 pruneCapture 同源。
  const BINARY_MIME =
    /^(image|font|audio|video)\/|application\/(octet-stream|zip|gzip|pdf|wasm|protobuf|x-protobuf|vnd\.ms-)/i;
  let cands = [...reqs.values()].filter(
    (c) => c.url && c.status && c.status < 500,
  );
  if (!opts.all) {
    cands = cands.filter((c) => {
      const mime = String(c.mimeType || "");
      if (BINARY_MIME.test(mime)) return false;
      const t = String(c.type).toLowerCase();
      return t === "xhr" || t === "fetch" || /json/i.test(mime);
    });
  }
  if (opts.filter) {
    let re;
    try {
      re = new RegExp(opts.filter, "i");
    } catch (error) {
      // 用户给了写坏的正则：给结构化错误码，而不是让原生 SyntaxError 冒到顶层
      // 变成一个看不出原因的 COMMAND_FAILED。
      const wrapped = new Error("--filter 不是合法正则：" + error.message);
      wrapped.code = "INVALID_FILTER";
      throw wrapped;
    }
    cands = cands.filter((c) => re.test(c.url || ""));
  }
  cands.sort((a, b) => (b.size || 0) - (a.size || 0));
  cands = cands.slice(0, 40); // 与 doCapture 一致：最多 40 条

  // 逐条取响应体（body 截断到 bodyMaxKb，防输出膨胀）。窗口内已 eager 取到的
  // 直接用（T-30：窗口关完再取，顶层文档体可能已被浏览器回收）。
  const bodyLimit = (opts.bodyMaxKb || 200) * 1024;
  const decodeBody = (rawBody, base64Encoded) => {
    let body = base64Encoded
      ? Buffer.from(rawBody, "base64").toString("utf8")
      : rawBody;
    let bodyTruncated = false;
    if (body.length > bodyLimit) {
      body = body.slice(0, bodyLimit);
      bodyTruncated = true;
    }
    return { body, bodyTruncated };
  };
  const out = [];
  // 兜底取体的总预算：早先是最多 40 条 × 20s 串行、无总时限，capture 命令可能跑十几分钟。
  const bodyDeadline = Date.now() + (opts.bodyDeadlineMs || 120000);
  for (const c of cands) {
    let body = "";
    let bodyTruncated = false;
    let bodyError = "";
    const pre = bodyStore && bodyStore.get(requestKey(captureId, c.requestId, c.sessionId));
    if (pre) {
      ({ body, bodyTruncated } = decodeBody(pre.body, pre.base64Encoded));
    } else {
      const remaining = bodyDeadline - Date.now();
      if (remaining <= 0) {
        bodyError = "body fetch deadline exceeded";
        out.push({ ...(c.sessionId ? { sessionId: c.sessionId } : {}), url: c.url, method: c.method, type: c.type, status: c.status,
          mimeType: c.mimeType, size: c.size, body, bodyTruncated, bodyError });
        continue;
      }
      try {
        const r = await sendCmd(
          {
            cmd: "cdp",
            args: {
              tabId,
              ...(c.sessionId ? { sessionId: c.sessionId } : {}),
              method: "Network.getResponseBody",
              params: { requestId: c.requestId },
            },
          },
          Math.min(20000, Math.max(1000, remaining)),
        );
        if (r.ok && r.result && typeof r.result.body === "string") {
          ({ body, bodyTruncated } = decodeBody(
            r.result.body,
            r.result.base64Encoded,
          ));
        } else if (!r.ok) {
          bodyError = r.error || "getResponseBody failed";
        }
      } catch (e) {
        bodyError = e.message;
      }
    }
    out.push({
      ...(c.sessionId ? { sessionId: c.sessionId } : {}),
      url: c.url,
      method: c.method,
      type: c.type,
      status: c.status,
      mimeType: c.mimeType,
      size: c.size,
      body,
      bodyTruncated,
      bodyError,
    });
  }

  return {
    tabId,
    action,
    durationMs,
    // 存活缓冲内看到的请求数（dropped>0 时被 2000 上限截断，不是全量）。
    totalRequestsSeen: reqs.size,
    // 事件缓冲截断标记：transport 侧 2000 上限 shift 掉的事件数。
    truncated: dropped > 0,
    droppedEventCount: dropped,
    returned: out.length,
    requests: out,
    captureId,
  };
}

async function triggerCapture(sendCmd, session, opts) {
  if (session.action === "reload")
    failReply(
      await sendCmd(
        {
          cmd: "cdp",
          args: { tabId: session.tabId, method: "Page.reload", params: {} },
        },
        20000,
      ),
    );
  else if (session.action !== "wait")
    failReply(
      await sendCmd({
        cmd: "navigate",
        args: { tabId: session.tabId, url: session.action, waitMs: 8000 },
      }),
    );
  if (opts.triggerJs)
    failEvaluation(
      failReply(
        await sendCmd({
          cmd: "cdp",
          args: {
            tabId: session.tabId,
            method: "Runtime.evaluate",
            params: {
              expression: opts.triggerJs,
              awaitPromise: true,
              returnByValue: true,
            },
          },
        }),
      ),
    );
}

// droppedByCapture（可选）：transport 侧事件缓冲 2000 上限的逐 capture 丢弃计数
// （Map captureId -> 条数）。存在时每个会话的结果带 truncated/droppedEventCount。
async function doCaptureMany(sendCmd, pairs, opts, eventsByCapture, droppedByCapture) {
  opts = normalizeCaptureOptions(opts);
  const sessions = [];
  try {
    for (const pair of pairs) {
      const started = failReply(
        await sendCmd({
          cmd: "capture.start",
          args: {
            tabId: pair.tabId,
            domains: ["Network"],
            // 扩展侧 session 只要盖住窗口 + 兜底取体，不需要 15 分钟：
            // 早先是 durationMs + 900000，等于每次 capture 都在扩展里挂 15 分钟会话。
            durationMs: opts.durationMs + 120000,
          },
        }),
      );
      sessions.push({ ...pair, captureId: started.captureId });
    }
    await Promise.all(
      sessions.map((session) => triggerCapture(sendCmd, session, opts)),
    );
    // eager 取响应体（T-30）：loadingFinished 一到就取，不等窗口关完——
    // 顶层 octet-stream 文档体关窗后取会报 No resource。取不到的回落旧路径。
    const bodyStore = new Map(); // requestKey -> {body, base64Encoded}
    // 资源上界：单次 capture 最多缓存 16MB 响应体、同时最多 8 个取体请求。
    // 早先对所有 loadingFinished 无差别 eager 取体且无上限，实测 120 条无关事件
    // 会产生 120 次 getResponseBody / 约 60MB。
    const BODY_STORE_MAX_BYTES = 16 * 1024 * 1024;
    const MAX_INFLIGHT = 8;
    let bodyBytes = 0;
    let active = 0;
    const inflight = [];
    const fetched = new Set();
    const requestInfo = new Map(); // requestKey -> {type,url}
    for (const session of sessions) {
      for (const ev of eventsByCapture.get(session.captureId) || []) {
        if (ev.method !== "Network.requestWillBeSent" || !ev.params) continue;
        if (!ev.params.requestId) continue;
        requestInfo.set(requestKey(session.captureId, ev.params.requestId, ev.sessionId), {
          type: String(ev.params.type || "").toLowerCase(),
          url: (ev.params.request && ev.params.request.url) || "",
        });
      }
    }
    let filterRe = null;
    if (opts.filter) {
      try {
        filterRe = new RegExp(opts.filter, "i");
      } catch (_) {}
    }
    // 只有"可能被保留"的响应才值得 eager 取体（与结果整形阶段对齐：二进制按
    // URL 后缀先挡，随后合并 responseReceived 元信息；漏网的由
    // 整形侧 BINARY_MIME 再杀，bodyStore 16MB 上限兜底）。JSON 的 document 类
    // 响应提前 eager：它们的体只有窗口内取得到（T-30），关窗后兜底必失败。
    const BINARY_URL =
      /\.(png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|css|js|mjs|map|html?|wasm|mp4|mp3|webm|pdf|zip|gz|apk)(\?|#|$)/i;
    const wanted = (info) => {
      if (!info) return false;
      if (opts.all) return true;
      if (BINARY_URL.test(info.url || "")) return false;
      if (info.type === "xhr" || info.type === "fetch") return true;
      if (/json/i.test(info.mimeType || "")) return true;
      if (/json/i.test(info.url || "")) return true;
      return !!(filterRe && filterRe.test(info.url));
    };
    const t0 = Date.now();
    while (Date.now() - t0 < opts.durationMs) {
      for (const session of sessions) {
        const events = eventsByCapture.get(session.captureId) || [];
        for (const ev of events) {
          const params = ev.params || {};
          const key = requestKey(session.captureId, params.requestId, ev.sessionId);
          if (ev.method === "Network.requestWillBeSent") {
            requestInfo.set(key, { type: String(params.type || "").toLowerCase(), url: params.request?.url || "" });
          } else if (ev.method === "Network.responseReceived") {
            const prev = requestInfo.get(key) || {};
            requestInfo.set(key, { ...prev, type: String(params.type || prev.type || "").toLowerCase(), url: params.response?.url || prev.url || "", mimeType: params.response?.mimeType || prev.mimeType || "" });
          }
        }
        for (const ev of events) {
          if (ev.method !== "Network.loadingFinished") continue;
          const rid = ev.params && ev.params.requestId;
          const key = requestKey(session.captureId, rid, ev.sessionId);
          if (!rid || fetched.has(key)) continue;
          if (!wanted(requestInfo.get(key))) {
            continue;
          }
          if (active >= MAX_INFLIGHT) continue; // 配额满：下一轮再取
          fetched.add(key);
          active++;
          inflight.push(
            sendCmd(
              {
                cmd: "cdp",
                args: {
                  tabId: session.tabId,
                  ...(ev.sessionId ? { sessionId: ev.sessionId } : {}),
                  method: "Network.getResponseBody",
                  params: { requestId: rid },
                },
              },
              20000,
            )
              .then((r) => {
                if (!r.ok || !r.result || typeof r.result.body !== "string") return;
                const size = Buffer.byteLength(
                  r.result.body,
                  r.result.base64Encoded ? "base64" : "utf8",
                );
                if (bodyBytes + size > BODY_STORE_MAX_BYTES) return; // 超预算交给兜底路径
                bodyBytes += size;
                bodyStore.set(key, {
                  body: r.result.body,
                  base64Encoded: !!r.result.base64Encoded,
                });
              })
              .catch(() => {})
              .finally(() => {
                active--;
              }),
          );
        }
      }
      await wait(Math.min(400, Math.max(0, opts.durationMs - (Date.now() - t0))));
    }
    await Promise.allSettled(inflight);
    return await Promise.all(
      sessions.map(async (session) => {
        const dropped =
          (droppedByCapture && droppedByCapture.get(session.captureId)) || 0;
        return buildCaptureSessionResult(
          sendCmd,
          session,
          eventsByCapture.get(session.captureId) || [],
          opts,
          bodyStore,
          dropped,
        );
      }),
    );
  } finally {
    await Promise.all(
      sessions.map(async (session) => {
        try {
          await sendCmd(
            {
              cmd: "capture.stop",
              args: { tabId: session.tabId, captureId: session.captureId },
            },
            5000,
          );
        } catch (_) {}
        eventsByCapture.delete(session.captureId);
        if (droppedByCapture) droppedByCapture.delete(session.captureId);
      }),
    );
  }
}

module.exports = { buildCaptureSessionResult, triggerCapture, doCaptureMany, normalizeCaptureOptions };
