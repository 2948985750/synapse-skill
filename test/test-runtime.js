"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { main, executeNavigation, findOrOpenTab, checkGuards, bumpState } = require("../runner/actions");
const { buildCaptureSessionResult, doCaptureMany, normalizeCaptureOptions } = require("../agent/capture");
const { probeStatusSnapshot } = require("../agent/doctor");
const { executeCommand, createChannel, isRetryable } = require("../agent/transport");
const { EventEmitter } = require("node:events");
const { spawnSync } = require("node:child_process");
const { parseArgs, validateOptions } = require("../agent/cli");

function actionFixture(context, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-navigation-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateFile = path.join(root, "state.json");
  let closed = false;
  const browser = {
    tabs: async () => [],
    open: async () => ({ tabId: 1, loaded: true }),
    cdp: async () => ({ result: { value: { url: "https://example.test/#/compose", readyState: "complete" } } }),
    close: async () => { await new Promise((resolve) => setTimeout(resolve, 5)); closed = true; },
    ...overrides,
  };
  const action = { title: "Compose", url: "https://example.test/#/compose" };
  const deps = {
    loadProfile: () => ({ domain: "example.test", status: "ready", actions: [action] }),
    stateFileFor: () => stateFile,
    connect: async () => browser,
  };
  return { browser, action, deps, stateFile, isClosed: () => closed };
}

test("actions main records page readiness without claiming business success and awaits close", async (context) => {
  const fixture = actionFixture(context);
  const result = await main(["example.test", "compose", "--timeout", "1000"], fixture.deps);
  assert.equal(result.ready, true);
  assert.equal(result.taskSucceeded, false);
  assert.equal(result.outcome, "navigation-ready");
  const state = JSON.parse(fs.readFileSync(fixture.stateFile, "utf8"));
  assert.equal(state.navigationCount, 1);
  assert.equal(state.count, undefined);
  assert.equal(state.lastSuccessAt, undefined);
  assert.equal(fixture.isClosed(), true);
});

test("actions main rejects an unfinished load without incrementing state", async (context) => {
  const previousExit = process.exitCode;
  context.after(() => { process.exitCode = previousExit; });
  const fixture = actionFixture(context, { open: async () => ({ tabId: 1, loaded: false }) });
  await main(["example.test", "compose", "--timeout", "50"], fixture.deps);
  assert.equal(fs.existsSync(fixture.stateFile), false);
  assert.equal(process.exitCode, 3);
  assert.equal(fixture.isClosed(), true);
});

test("actions main refuses a draft before connecting", async (context) => {
  const fixture = actionFixture(context);
  let connected = false;
  fixture.deps.connect = async () => { connected = true; return fixture.browser; };
  fixture.deps.loadProfile = () => ({ status: "draft", actions: [fixture.action] });
  await assert.rejects(main(["example.test", "compose"], fixture.deps), /draft/);
  assert.equal(connected, false);
});

test("navigation verifies final route and does not misreport a redirect as ready", async (context) => {
  const fixture = actionFixture(context, { cdp: async () => ({ result: { value: { url: "https://example.test/login", readyState: "complete" } } }) });
  await assert.rejects(executeNavigation(fixture.browser, fixture.action, {}, 30), { code: "NAVIGATION_NOT_READY" });
});

test("same-origin navigation includes hash routes and propagates failure without opening a fallback", async () => {
  const calls = [];
  const browser = {
    tabs: async () => [{ tabId: 8, url: "https://example.test/#/inbox" }],
    call: async (command, args) => { calls.push({ command, args }); return { loaded: true }; },
    open: async () => { throw new Error("unexpected fallback"); },
  };
  const result = await findOrOpenTab(browser, { url: "https://example.test/#/compose", waitMs: 100 });
  assert.equal(result.reused, true);
  assert.equal(calls[0].args.url, "https://example.test/#/compose");
  browser.call = async () => { throw new Error("navigation failed"); };
  await assert.rejects(findOrOpenTab(browser, { url: "https://example.test/", waitMs: 100 }), /navigation failed/);
});

test("navigation counters enforce guards without creating business success", () => {
  const now = new Date();
  const state = bumpState(null, {}, now);
  assert.equal(checkGuards({ guards: { daily_cap: 1 } }, state, now).ok, false);
  assert.equal(checkGuards({ guards: { interval_s: 60 } }, state, now).ok, false);
  assert.equal(state.lastSuccessAt, undefined);
});

test("concurrent runs cannot overwrite the same action state", async (context) => {
  let releaseOpen, signalOpen;
  const entered = new Promise((resolve) => { signalOpen = resolve; });
  const held = new Promise((resolve) => { releaseOpen = resolve; });
  const fixture = actionFixture(context, { open: async () => { signalOpen(); await held; return { tabId: 1, loaded: true }; } });
  const first = main(["example.test", "compose", "--timeout", "2000"], fixture.deps);
  await entered;
  try {
    await assert.rejects(main(["example.test", "compose"], fixture.deps), { code: "ACTION_BUSY" });
  } finally {
    releaseOpen();
    await first;
  }
  assert.equal(JSON.parse(fs.readFileSync(fixture.stateFile, "utf8")).navigationCount, 1);
  assert.equal(fs.existsSync(fixture.stateFile + ".lock"), false);
});

test("a corrupt action state is reported without overwriting it", async (context) => {
  const fixture = actionFixture(context);
  fs.writeFileSync(fixture.stateFile, "{broken");
  await assert.rejects(main(["example.test", "compose"], fixture.deps), SyntaxError);
  assert.equal(fs.readFileSync(fixture.stateFile, "utf8"), "{broken");
});

test("an explicit missing SDK session never waits for a different direct browser", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-session-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = "require('./agent/api').connect({session:'missing',waitMs:1}).then(()=>process.exit(2), error=>{process.stdout.write(error.code);process.exit(error.code==='NO_BRIDGE'?0:1)})";
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
    timeout: 3000,
    windowsHide: true,
    env: { ...process.env, WB_BRIDGE_FILE: path.join(root, "absent.json"), WB_CONFIG_FILE: path.join(root, "config.json"), WB_DATA_DIR: root },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "NO_BRIDGE");
});

test("the expected browser identity travels in every command envelope", async () => {
  const socket = new EventEmitter();
  socket.readyState = 1;
  const frames = [];
  socket.send = (raw) => {
    const frame = JSON.parse(raw);
    frames.push(frame);
    queueMicrotask(() => socket.emit("message", JSON.stringify({ type: "agent.result", id: frame.id, ok: true, result: {} })));
  };
  socket.close = () => { socket.readyState = 3; socket.emit("close"); };
  const channel = createChannel(socket, { clientId: "identity-test", browserId: "profile-expected", skipGracefulDisconnect: true });
  await channel.sendCmd({ cmd: "tabs" });
  assert.equal(frames[0].browserId, "profile-expected");
  await channel.close();
});

test("command timeout budgets reach the transport", async () => {
  let budget;
  await executeCommand({ sendCmd: async (command, timeout) => { budget = timeout; return { ok: true, result: [] }; } }, { cmd: "tabs" }, { commandTimeoutMs: 100 });
  assert.ok(budget > 0 && budget <= 100);
});

test("all Runtime CDP execution methods reject JavaScript exceptions without replaying", async () => {
  for (const method of ["Runtime.evaluate", "Runtime.callFunctionOn", "Runtime.awaitPromise", "Runtime.runScript"]) {
    let dispatched = 0;
    const channel = { sendCmd: async () => {
      dispatched++;
      return { ok: true, result: { exceptionDetails: { exception: { description: "Error: synthetic page failure" } } } };
    } };
    await assert.rejects(executeCommand(channel, { cmd: "cdp", args: { method } }), { code: "EVALUATION_FAILED", message: "Error: synthetic page failure" });
    assert.equal(dispatched, 1);
  }
  const result = { result: { type: "undefined" } };
  assert.equal(await executeCommand({ sendCmd: async () => ({ ok: true, result }) }, { cmd: "cdp", args: { method: "Runtime.evaluate" } }), result);
});

test("SDK run forwards its timeout to both CDP and the command deadline", async () => {
  const calls = [];
  const apiModule = { exports: {} };
  const transport = {
    connectBridgeChain: async () => ({ channel: { close() {} } }),
    executeCommand: async (channel, command, options) => { calls.push({ command, options }); return {}; },
  };
  const source = fs.readFileSync(path.join(__dirname, "../agent/api.js"), "utf8");
  vm.runInNewContext(source, {
    module: apiModule,
    process: { env: {} },
    require: (name) => {
      if (name === "./registry") return { bridgeCandidates: () => [{}] };
      if (name === "./bridge-auth") return { readToken: () => "unused" };
      if (name === "./transport") return transport;
      if (name === "./files") return require("../agent/files");
      return require(name);
    },
  });
  const browser = await apiModule.exports.connect({ commandTimeoutMs: 9000 });
  await browser.run(4, "Promise.resolve(1)", { timeoutMs: 250, awaitPromise: false });
  assert.equal(calls[0].command.args.timeoutMs, 250);
  assert.equal(calls[0].options.commandTimeoutMs, 250);
  assert.equal(calls[0].command.args.params.awaitPromise, false);
  await browser.run(4, "1");
  assert.equal(calls[1].options.commandTimeoutMs, 9000);
  assert.equal(calls[1].command.args.params.awaitPromise, true);
  await browser.run(4, "location.href", { contextId: 7, sessionId: "child" });
  assert.equal(calls[2].command.args.params.contextId, 7);
  assert.equal(calls[2].command.args.sessionId, "child");
  await browser.click(4, { ref: "stable-node" }, { mode: "cdp", waitFor: { locator: "#done" } });
  assert.equal(calls[3].command.cmd, "click-cdp");
  assert.equal(calls[3].command.args.el.ref, "stable-node");
  assert.equal(calls[3].command.args.waitFor.locator, "#done");
  await browser.waitFor(4, { locator: "#spinner", state: "hidden" }, { timeoutMs: 500 });
  assert.equal(calls[4].command.args.timeoutMs, 500);
  assert.equal(calls[4].options.commandTimeoutMs, 5500);
  await browser.readPage(4, { scope: "main", maxChars: 300 });
  assert.equal(calls[5].command.args.scope, "main");
  assert.equal(calls[5].command.args.maxChars, 300);
  await browser.setViewport(4, { width: 900, height: 700 });
  await browser.resetViewport(4);
  assert.equal(calls[6].command.args.method, "Emulation.setDeviceMetricsOverride");
  assert.equal(calls[7].command.args.method, "Emulation.clearDeviceMetricsOverride");
  assert.throws(() => browser.setViewport(4, { width: -1, height: 600 }), { code: "VALIDATION" });
});

test("upload files are checked locally before SDK or CLI dispatch", (context) => {
  const { validateUploadFiles } = require("../agent/files");
  const { buildCmd } = require("../agent/cli");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-upload-test-"));
  context.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const first = path.join(root, "one.txt");
  const second = path.join(root, "two.txt");
  fs.writeFileSync(first, "one");
  fs.writeFileSync(second, "two");
  assert.deepEqual(validateUploadFiles([first, second]), [first, second]);
  assert.deepEqual(buildCmd(["setfile", "1", "#upload", first, second]).args.files, [first, second]);
  assert.throws(() => validateUploadFiles([root]), { code: "INVALID_FILE" });
  assert.throws(() => validateUploadFiles([first, path.join(root, "missing")]), { code: "INVALID_FILE" });
  assert.deepEqual(validateUploadFiles([]), []);
});

test("status reserves a budget for each bridge and closes both probe channels", async () => {
  const visited = [], closed = [];
  const result = await probeStatusSnapshot({}, {
    timeoutMs: 100,
    readToken: () => "unused",
    bridgeCandidates: () => [{ sid: "silent", port: 1 }, { sid: "healthy", port: 2 }],
    connectBridge: async (bridge) => {
      visited.push(bridge.sid);
      return {
        sendCmd: async (command, timeout) => {
          if (bridge.sid === "silent") {
            await new Promise((resolve) => setTimeout(resolve, timeout));
            throw new Error("probe timed out");
          }
          return { ok: true, result: { browserId: "profile-2" } };
        },
        close: async () => { closed.push(bridge.sid); },
      };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.bridge.sid, "healthy");
  assert.deepEqual(visited, ["silent", "healthy"]);
  assert.deepEqual(closed, visited);
});

test("browser pinning checks identity before business commands", async () => {
  const calls = [];
  const channel = { sendCmd: async (command) => { calls.push(command.cmd); return { ok: true, result: { browserId: "other-profile" } }; } };
  await assert.rejects(executeCommand(channel, { cmd: "open", args: { url: "https://example.test/" } }, { browserId: "intended-profile" }), { code: "BROWSER_MISMATCH" });
  assert.deepEqual(calls, ["diag"]);
  assert.equal(isRetryable({ code: "CDP_TIMEOUT" }), false);
});

test("SDK capture defaults reach capture.start and invalid durations send nothing", async () => {
  assert.equal(normalizeCaptureOptions().durationMs, 12000);
  let duration;
  await assert.rejects(doCaptureMany(async (command) => {
    duration = command.args.durationMs;
    throw new Error("synthetic setup stop");
  }, [{ tabId: 1, action: "wait" }], {}, new Map()), /synthetic setup stop/);
  assert.equal(duration, 132000);
  assert.throws(() => validateOptions(parseArgs(["capture", "1", "wait", "--duration", "0"])), /durationMs/);
  assert.throws(() => parseArgs(["tabs", "--session"]), /session id/);
  for (const invalid of [0, -1, NaN, Infinity, "12000"]) {
    await assert.rejects(doCaptureMany(() => { throw new Error("unexpected send"); }, [], { durationMs: invalid }, new Map()), { code: "VALIDATION" });
  }
});

test("capture learns new request metadata during the window and eagerly fetches its body", async () => {
  const events = new Map();
  let started, fetchedAt;
  const durationMs = 700;
  const result = await doCaptureMany(async (command) => {
    if (command.cmd === "capture.start") {
      events.set("live", []);
      started = Date.now();
      setTimeout(() => events.get("live").push(
        { method: "Network.requestWillBeSent", params: { requestId: "new", type: "Fetch", request: { url: "https://example.test/api", method: "GET" } } },
        { method: "Network.responseReceived", params: { requestId: "new", type: "Fetch", response: { url: "https://example.test/api", status: 200, mimeType: "application/json" } } },
        { method: "Network.loadingFinished", params: { requestId: "new", encodedDataLength: 2 } },
      ), 10);
      return { ok: true, result: { captureId: "live" } };
    }
    if (command.args?.method === "Network.getResponseBody") {
      fetchedAt = Date.now() - started;
      return { ok: true, result: { body: "{}", base64Encoded: false } };
    }
    return { ok: true, result: {} };
  }, [{ tabId: 1, action: "wait" }], { durationMs }, events);
  assert.ok(fetchedAt < durationMs, "body was fetched before the capture window ended");
  assert.equal(result[0].requests[0].body, "{}");
  assert.equal(result[0].durationMs, durationMs);
  assert.equal(events.size, 0);
});

function sessionEvents(sessionId, requestId = "same-request") {
  const identity = sessionId ? { sessionId } : {};
  return [
    { ...identity, method: "Network.requestWillBeSent", params: { requestId, type: "Fetch", request: { url: "https://example.test/" + (sessionId || "root"), method: "GET" } } },
    { ...identity, method: "Network.responseReceived", params: { requestId, type: "Fetch", response: { status: 200, mimeType: "application/json" } } },
    { ...identity, method: "Network.loadingFinished", params: { requestId, encodedDataLength: 10 } },
  ];
}

test("capture fallback keeps identical request ids from root and child sessions separate", async () => {
  const calls = [];
  const events = [undefined, "child-a", "child-b"].flatMap((sessionId) => sessionEvents(sessionId));
  const result = await buildCaptureSessionResult(async (command) => {
    calls.push(command);
    return { ok: true, result: { body: command.args.sessionId || "root" } };
  }, { tabId: 1, action: "wait", captureId: "fallback" }, events, { durationMs: 1 });
  assert.equal(result.totalRequestsSeen, 3);
  assert.equal(result.returned, 3);
  assert.deepEqual(result.requests.map((request) => request.body).sort(), ["child-a", "child-b", "root"]);
  assert.deepEqual(calls.map((command) => command.args.sessionId || "root").sort(), ["child-a", "child-b", "root"]);
  for (const request of result.requests) assert.equal(request.body, request.sessionId || "root");
});

test("capture eager metadata and body caches retain each session identity without duplicate fallback fetches", async () => {
  const events = new Map();
  const bodies = [];
  const allEvents = [undefined, "child-a", "child-b"].flatMap((sessionId) => sessionEvents(sessionId));
  const send = async (command) => {
    if (command.cmd === "capture.start") {
      events.set("live-sessions", allEvents);
      return { ok: true, result: { captureId: "live-sessions" } };
    }
    if (command.args.method === "Network.getResponseBody") {
      bodies.push(command.args.sessionId || "root");
      return { ok: true, result: { body: command.args.sessionId || "root" } };
    }
    return { ok: true, result: {} };
  };
  const [result] = await doCaptureMany(send, [{ tabId: 1, action: "wait" }], { durationMs: 10 }, events);
  assert.equal(result.returned, 3);
  assert.deepEqual(bodies.sort(), ["child-a", "child-b", "root"]);
  for (const request of result.requests) assert.equal(request.body, request.sessionId || "root");
  assert.equal(events.size, 0);
});

test("capture session/request keys cannot collide at separator boundaries", async () => {
  const events = [...sessionEvents("child:a", "b"), ...sessionEvents("child", "a:b")];
  const result = await buildCaptureSessionResult(async (command) => ({ ok: true, result: { body: command.args.sessionId } }), { tabId: 1, action: "wait", captureId: "keys" }, events, { durationMs: 1 });
  assert.equal(result.returned, 2);
  assert.deepEqual(result.requests.map((request) => request.body).sort(), ["child", "child:a"]);
});
