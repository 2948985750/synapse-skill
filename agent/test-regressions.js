"use strict";
// 针对 review 修掉的 bug 的回归测试（每条对应一次真实崩溃/泄漏）。
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createBridgeRouter } = require("./bridge-router");
const { buildCaptureSessionResult } = require("./capture");

function fakeSocket(name) {
  const sent = [];
  return {
    name,
    readyState: 1,
    sent,
    send(raw) {
      sent.push(JSON.parse(raw));
    },
    close(code, reason) {
      this.readyState = 3;
      this.closed = { code, reason };
    },
    terminate() {
      this.readyState = 3;
    },
  };
}

// bug①：扩展收到 client.disconnect 后不回包（MV3 SW 被挂起）时，
// 这条客户端必须被超时释放，而不是永久停在 cleaning 状态。
test("cleanup timeout replies CLEANUP_TIMEOUT and keeps the identity reserved", () => {
  const timers = [];
  const router = createBridgeRouter({
    setTimer: (fn) => {
      timers.push(fn);
      return { id: timers.length };
    },
    clearTimer: () => {},
  });
  const client = fakeSocket("client");
  const extension = fakeSocket("extension");
  router.addClient(client);
  router.attachExtension(extension);

  router.clientMessage(client, {
    type: "cmd",
    id: "c1",
    clientId: "k1",
    cmd: "list",
    args: {},
    timeoutMs: 5000,
  });
  assert.equal(extension.sent.length, 1, "命令应已转发给扩展");

  router.clientMessage(client, { type: "client.disconnect", id: "d1" });
  const cleanupTimer = timers[timers.length - 1];
  assert.equal(typeof cleanupTimer, "function", "清理应挂上超时定时器");

  cleanupTimer();
  const reply = client.sent.find(
    (m) => m.type === "agent.result" && m.code === "CLEANUP_TIMEOUT",
  );
  assert.ok(reply, "超时后必须回 CLEANUP_TIMEOUT，而不是让客户端无声卡住");
  assert.equal(reply.id, "d1");
});

// bug⑥：写坏的 --filter 以前抛原生 SyntaxError，最终被归一成 COMMAND_FAILED，
// 用户看不出是自己正则写错了。
test("invalid --filter yields INVALID_FILTER instead of a bare SyntaxError", async () => {
  await assert.rejects(
    () =>
      buildCaptureSessionResult(
        async () => ({ ok: true, result: {} }),
        { tabId: 1, action: "wait", captureId: "cap" },
        [],
        { filter: "[", durationMs: 10 },
        new Map(),
      ),
    (error) => {
      assert.equal(error.code, "INVALID_FILTER");
      assert.match(error.message, /--filter/);
      return true;
    },
  );
});

// bug⑤：CLI 路径上的非法 --filter 早先抛裸 SyntaxError，被归一成 COMMAND_FAILED。
test("validateOptions rejects an invalid --filter with INVALID_FILTER", () => {
  const { validateOptions } = require("./cli");
  assert.throws(
    () => validateOptions({ waitMs: 1000, durationMs: 1000, bodyMaxKb: 1, snapMax: 1, filter: "[" }),
    (error) => error.code === "INVALID_FILTER",
  );
});

// 鉴权标识是两侧内置的固定常量：不读文件、不需要用户配对。
test("readToken returns the built-in shared identifier", () => {
  const { readToken } = require("./bridge-auth");
  const { DEFAULT_TOKEN, validToken } = require("./ws-auth");
  assert.equal(readToken(), DEFAULT_TOKEN);
  assert.ok(validToken(readToken()), "内置标识必须是合法的 64 位十六进制");
  assert.notEqual(DEFAULT_TOKEN, "0".repeat(64), "不能再用全零默认值");
});

// bug⑦：capture 对所有 loadingFinished 无差别 eager 取体（无过滤、无上限）。
test("capture only eagerly fetches bodies for candidate requests", async () => {
  const { doCaptureMany } = require("./capture");
  const events = new Map();
  const list = [];
  for (let i = 0; i < 120; i++) list.push({ method: "Network.loadingFinished", params: { requestId: "r" + i } });
  list.push({ method: "Network.requestWillBeSent", params: { requestId: "rx", type: "XHR", request: { url: "https://e.test/api" } } });
  list.push({ method: "Network.loadingFinished", params: { requestId: "rx" } });
  events.set("cap1", list);

  const fetched = [];
  const sendCmd = async (obj) => {
    if (obj.cmd === "capture.start") return { ok: true, result: { captureId: "cap1" } };
    if (obj.cmd === "capture.stop") return { ok: true, result: {} };
    if (obj.cmd === "cdp" && obj.args.method === "Network.getResponseBody") {
      fetched.push(obj.args.params.requestId);
      return { ok: true, result: { body: "{}" } };
    }
    return { ok: true, result: {} };
  };
  const results = await doCaptureMany(sendCmd, [{ tabId: 1, action: "wait" }], { durationMs: 400, bodyMaxKb: 1 }, events);
  assert.equal(results.length, 1);
  assert.deepEqual(fetched, ["rx"], "只应对候选请求取体，无关的 120 条不应触发 getResponseBody");
});

// API 入口：索引/条目两种形态。
test("api.normalizeEl accepts an index or a snapshot entry", () => {
  const { normalizeEl } = require("./api");
  assert.deepStrictEqual(normalizeEl(3), { i: 3 });
  assert.deepStrictEqual(normalizeEl({ i: 2, label: "x" }), { i: 2, label: "x" });
  assert.throws(() => normalizeEl("3"), /el 需要/);
});


// 半开扩展：旧 socket readyState 仍是 1，但静默超过阈值时应被新扩展替换，
// 否则新扩展会被永久 1008 拒绝。
test("router replaces an extension that has gone silent", () => {
  let clock = 1000;
  const router = createBridgeRouter({ now: () => clock });
  const a = fakeSocket("extA");
  const b = fakeSocket("extB");
  assert.equal(router.attachExtension(a), true);
  clock += 25000;                       // 超过 STALE_EXTENSION_MS(20s)
  assert.equal(router.attachExtension(b), true, "静默过久的旧扩展应被替换");
  assert.equal(router.attachExtension(fakeSocket("extC")), false, "刚接上的扩展应被保护");
});

// 每连接的挂起命令上限：早先 pending 无界，单客户端可无限灌。
test("router caps in-flight commands per connection", () => {
  const router = createBridgeRouter();
  const client = fakeSocket("client");
  const extension = fakeSocket("extension");
  router.addClient(client);
  router.attachExtension(extension);
  for (let i = 0; i < 64; i++) {
    router.clientMessage(client, { type: "cmd", id: "c" + i, clientId: "k", cmd: "list", args: {}, timeoutMs: 5000 });
  }
  router.clientMessage(client, { type: "cmd", id: "over", clientId: "k", cmd: "list", args: {}, timeoutMs: 5000 });
  const rejected = client.sent.find((m) => m.id === "over");
  assert.ok(rejected, "超出上限的命令应被拒绝");
  assert.equal(rejected.code, "CLIENT_BUSY");
});

// doctor 默认只杀"本工具启动的" Edge：没有 pid 记录时不应该动用户的浏览器。
test("killOwnedEdge does nothing when we never launched a browser", (t) => {
  if (process.platform !== "win32") return t.skip("仅 Windows");
  const { killOwnedEdge } = require("./doctor");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-edge-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(killOwnedEdge({}, dir), "none", "没有自己的 pid 记录时必须跳过 kill");
});

// 数据目录：env > config.json > 平台默认；config set 后当前配置立即生效。
test("data root resolution prefers config over the platform default", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-cfg-"));
  const prevCfg = process.env.WB_CONFIG_FILE;
  const prevData = process.env.WB_DATA_DIR;
  delete process.env.WB_DATA_DIR;
  process.env.WB_CONFIG_FILE = path.join(dir, "config.json");
  t.after(() => {
    if (prevCfg === undefined) delete process.env.WB_CONFIG_FILE; else process.env.WB_CONFIG_FILE = prevCfg;
    if (prevData === undefined) delete process.env.WB_DATA_DIR; else process.env.WB_DATA_DIR = prevData;
    delete require.cache[require.resolve("./paths")];
    fs.rmSync(dir, { recursive: true, force: true });
  });
  delete require.cache[require.resolve("./paths")];
  const paths = require("./paths");

  assert.equal(paths.resolveDataRoot({}).source, "default");
  const chosen = path.join(dir, "mydata");
  paths.writeConfig({ dataRoot: chosen });
  assert.equal(paths.readConfig().dataRoot, chosen);
  assert.equal(paths.resolveDataRoot(paths.readConfig()).value, chosen);
  assert.equal(paths.resolveOutputRoot(paths.readConfig(), chosen).value, path.join(chosen, "output"));

  paths.resetConfig();
  assert.equal(paths.readConfig().dataRoot, undefined, "reset 后回到默认");
});

console.log("ALL-REGRESSIONS-OK (10 cases)");
