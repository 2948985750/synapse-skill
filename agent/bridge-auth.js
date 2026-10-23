"use strict";
const auth = require("./ws-auth.js");

// 内置标识：扩展与 agent 两侧写死同一枚（ws-auth.js 里的 DEFAULT_TOKEN）。
// 用途是判断"连进来的服务是不是自家的"——没有配对文件、没有 UI、不需要用户操作。
// 它不是密码：源码公开，能读代码的本机进程就能拿到；它挡的是"不知道这枚标识的
// 其它服务/扩展"，同时让双向 HMAC 握手成立。
function readToken() {
  return auth.DEFAULT_TOKEN;
}
function authenticateServer(
  socket,
  request,
  token,
  onAuthenticated,
  timeoutMs = 5000,
) {
  const origin = request?.headers?.origin;
  const serverNonce = auth.createNonce();
  let settled = false;
  let verifying = false;
  const timer = setTimeout(() => fail("Authentication timed out"), timeoutMs);
  const cleanup = () => {
    clearTimeout(timer);
    socket.off("message", onMessage);
    socket.off("close", onClose);
  };
  const onClose = () => {
    settled = true;
    cleanup();
  };
  function fail(reason) {
    if (settled) return;
    settled = true;
    cleanup();
    try {
      socket.close(1008, reason);
    } catch (_) {
      socket.terminate();
    }
  }
  async function onMessage(raw) {
    if (settled) return;
    if (verifying) {
      fail("Authentication must finish before commands");
      return;
    }
    verifying = true;
    try {
      const message = JSON.parse(raw.toString());
      if (
        message.type !== "auth.response" ||
        message.protocol !== auth.PROTOCOL ||
        !["extension", "client"].includes(message.role)
      )
        throw new Error("Authentication required");
      if (
        origin &&
        (message.role !== "extension" ||
          !/^chrome-extension:\/\/[a-p]{32}$/.test(origin))
      )
        throw new Error("Origin is not allowed");
      if (
        !(await auth.verify(
          token,
          message.role,
          "client",
          serverNonce,
          message.nonce,
          message.proof,
        ))
      )
        throw new Error("Authentication failed");
      const proof = await auth.sign(
        token,
        message.role,
        "server",
        serverNonce,
        message.nonce,
      );
      if (settled || socket.readyState !== 1) return;
      settled = true;
      cleanup();
      socket.send(
        JSON.stringify({ type: "auth.ok", protocol: auth.PROTOCOL, proof }),
      );
      onAuthenticated(message.role);
    } catch (_) {
      fail("Authentication failed");
    }
  }
  socket.on("message", onMessage);
  socket.on("close", onClose);
  socket.on("error", () => fail("Socket error"));
  if (origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) {
    fail("Origin is not allowed");
    return;
  }
  socket.send(
    JSON.stringify({
      type: "auth.challenge",
      protocol: auth.PROTOCOL,
      nonce: serverNonce,
    }),
  );
}
function authenticateClient(socket, token, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let stage = "challenge",
      serverNonce,
      clientNonce;
    let settled = false;
    const timer = setTimeout(
      () => fail("Bridge authentication timed out"),
      timeoutMs,
    );
    function cleanup() {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("error", onError);
      socket.off("close", onClose);
    }
    function fail(reason) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(reason));
    }
    const onError = () => fail("Bridge connection failed");
    const onClose = () => fail("Bridge disconnected before authentication");
    async function onMessage(raw) {
      try {
        const message = JSON.parse(raw.toString());
        if (message.protocol !== auth.PROTOCOL)
          throw new Error("Unexpected bridge protocol");
        if (stage === "challenge" && message.type === "auth.challenge") {
          stage = "signing";
          serverNonce = message.nonce;
          clientNonce = auth.createNonce();
          const proof = await auth.sign(
            token,
            "client",
            "client",
            serverNonce,
            clientNonce,
          );
          if (settled) return;
          stage = "confirmation";
          socket.send(
            JSON.stringify({
              type: "auth.response",
              protocol: auth.PROTOCOL,
              role: "client",
              nonce: clientNonce,
              proof,
            }),
          );
        } else if (stage === "confirmation" && message.type === "auth.ok") {
          stage = "verifying";
          if (
            !(await auth.verify(
              token,
              "client",
              "server",
              serverNonce,
              clientNonce,
              message.proof,
            ))
          )
            throw new Error(
              "Bridge proof is invalid（两端内置标识不一致：扩展与 agent 的 ws-auth.js DEFAULT_TOKEN 必须相同）",
            );
          if (settled) return;
          settled = true;
          cleanup();
          resolve();
        } else throw new Error("Unexpected authentication message");
      } catch (error) {
        fail(error.message);
      }
    }
    socket.on("message", onMessage);
    socket.on("error", onError);
    socket.on("close", onClose);
  });
}
module.exports = {
  readToken,
  authenticateServer,
  authenticateClient,
};
