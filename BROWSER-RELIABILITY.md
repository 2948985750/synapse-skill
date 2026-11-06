# 网页操作可靠性补齐

本轮补齐定位、交互、等待、文件赋值验证与显式视口操作。保留扩展 + 本地桥架构，不包含反爬、验证码处理、代理轮换、自动下载管理或完整 CDP 封装。

## 1. 稳定定位与按需读取

`collectElements()` 的条目新增 `ref`。把完整条目传给 `click/type/gesture`，节点即使与同名节点重排，也仍指向原节点。节点删除、导航或引用缓存淘汰时返回 `STALE_ELEMENT`，不会悄悄改点当前索引。每个文档最多保留 2000 个节点引用。裸数字索引继续兼容，但没有同名重排保护。

也可以传 `{sel: "button.save", scope: "#editor"}`、`{role: "button", name: "保存"}` 或 `{testId: "save"}`。匹配多个节点返回 `AMBIGUOUS_TARGET`，不选择第一个。查询与元素收集支持开放 Shadow DOM，包括 scope 本身是 Shadow Host 的情况；封闭 Shadow DOM 不在本轮范围内。

```js
const { connect } = require("./agent/api");
const browser = await connect({ session: "work" });
try {
  const view = await browser.readPage(tabId, { scope: "main", maxChars: 2000 });
  const fields = await browser.readPage(tabId, {
    maxChars: 1000,
    fields: [
      { name: "title", locator: "h1" },
      { name: "website", locator: "a.website", attribute: "href" },
    ],
  });
  const result = await browser.click(tabId, { sel: "button.save", scope: "#editor" }, {
    waitFor: { locator: "#save-status", text: "已保存" },
    waitTimeoutMs: 10000,
  });
  if (result.found === false) throw new Error(result.reason);
} finally {
  await browser.close();
}
```

`maxChars` 限制文本输出；字段读取共用这个字符预算。字段定位失败会保留单字段原因，并标记 `complete:false`。DOM 动作可能返回 `{found:false, code, reason}`，调用方必须检查；这不等于已执行成功。

## 2. 交互与结果验证

- DOM 点击前检查可见性、禁用/inert 状态；输入另查只读、控件类型。
- 普通输入、文本域、下拉框和 contenteditable 在派发 input/change 后，让出事件循环并等待两个渲染机会再核对值；后台页面用有界计时器兜底。这能发现期间的回写或节点删除，不保证更晚的异步更新不会改变值。下拉框的选项不存在或不可选时不写入。`typeCss` 的 `execCommand` 保留原语义；`native-enter` 仅在值核对通过后派发 Enter。
- `browser.click(tabId, locator, {mode:"cdp"})` 或 CLI `click-cdp` 会先滚动目标、检查位置稳定与遮挡，再发一次鼠标按下/释放；默认仍是 DOM 模式。
- 未提供 `waitFor` 的点击只表示已派发，`verified:false`。输入与文件的 `verified:true` 只表示值核对通过，不代表服务器端业务成功。
- 提供 `waitFor` 后查看 `postcondition.verified`。条件超时不重发点击、输入或提交，也不自动从 CDP 切回 DOM。

## 3. 页面就绪

```js
await browser.navigate(tabId, destination, {
  waitFor: { locator: "#results", state: "visible" },
});
await browser.waitFor(tabId, { locator: ".loading", state: "hidden" });
await browser.waitFor(tabId, { url: expectedExactUrl });
```

等待支持 `visible/hidden/attached/detached`、包含文本、精确输入值与精确 URL，可组合 URL 和元素条件。缺省 10 秒，上限 20 秒；SDK `waitFor` 用 `timeoutMs` 调整，动作后等待用 `waitTimeoutMs`。URL 不符会保留实际地址，但不会仅凭 URL 猜测“登录失效”或“反爬”。原有不传条件的导航语义不变；`loaded:true` 不是业务完成。

`readPage` 和 `collectElements` 的 `waitFor` 是读取前置条件：通过后再读取，并返回 `precondition.verified`；等待失败不返回快照。稳定 ref 指向的已知节点被移除时，可满足 detached/hidden；引用过期、缓存淘汰或标签漂移不等于已经观察到节点移除。缺失节点不能证明 text/value 条件成立。

CLI 新增 `read-page <tabId> @options.json`、`wait-for <tabId> @condition.json`、`click-cdp <tabId> <i|el-json>`。Windows 推荐 JSON 文件或 Node SDK，避免 shell 引号问题。

## 4. 文件上传

`browser.setFiles(tabId, selector, paths, options)` 与 CLI `setfile` 先检查本地路径存在且为普通文件，再要求唯一文件输入；多个文件还要求 `multiple`。扩展设置后读取实际 `FileList` 文件名核对，并释放临时远程对象。空数组可通过 SDK 清空文件选择。

FileList 核对不证明网络上传已完成。需要时传 `waitFor` 等待页面成功提示。文件在检查后仍可能被移动或删除，此时后续执行或核对会失败；不会自动重传。

## 5. 显式执行上下文

SDK `run/cdp`、DOM 方法与 `readPage` 可传已有的 `sessionId`，页内操作可传 `contextId`。同进程子帧的 DOM 上下文可通过 `Page.getFrameTree` 与 `Page.createIsolatedWorld` 显式取得；隔离世界可读 DOM，但不等同于页面主世界的 JS 全局变量。导航后的上下文需要重新取得，失效不回落到主页面。

传输层和捕获事件保留 sessionId；SDK 抓包的请求合并、即时/兜底取体和缓存均区分 captureId、sessionId、requestId，子会话响应结果附带 sessionId。没有实现全自动子目标发现、Network 域启用或重连；调用方仍须准备好子会话。跨进程子帧支持取决于浏览器，不等于完整 iframe 自动化。CDP 坐标点击拒绝显式子帧上下文，防止坐标系误用；文件上传支持子 sessionId，不接受 contextId。

## 6. 视口默认不变

新 attach 不再强制设置 1440×900。需要时显式 `setViewport(tabId, {width:1280, height:720})`，并在 `finally` 中 `resetViewport(tabId)`。reset 清除设备尺寸覆盖，恢复浏览器默认布局；不承诺还原调用方此前通过原始 CDP 设置的任意覆盖。其他设备/时区/网络模拟暂不扩充。

## 7. 取消、期限与信任边界

命令取得锁后，在新的 CDP 派发前再次检查取消、连接状态和总期限；附件准备或页面观察完成不代表仍获准执行后续动作。取消不会中断已经派发的页内脚本，也不能撤销点击、输入或上传。已经确认按下的鼠标仍配对释放，临时远程对象和失败的捕获启动仍执行清理；这些收尾操作不受取消阻断，不会自动重发业务动作。

连接继续采用单用户可信本机模型。公开内置标识和 HMAC 握手不提供对不可信本地进程或其他扩展的身份隔离；本轮没有引入安装级密钥、配对或客户端授权。

## 验证边界

自动回归覆盖页内函数、真实命令执行模块的模拟 CDP 链路、取消与资源清理、本地文件检查及 SDK 参数透传。另在独立临时 Edge profile 中跑通 19 项端到端检查：连接、导航、抓包、普通/受控/富文本输入、下拉框、开放 Shadow DOM 的区域收集与 ref 点击、节点移除等待及读取前置条件。测试仅使用独立测试标签和注入的受控页面，不操作用户日常 profile。

这些检查不等于所有真实网站验收。子会话抓包目前有隔离回归，完整 OOPIF 生命周期未在真实浏览器验收；复杂富文本编辑器、站点特有成功状态与更晚的输入回写仍需在目标网站验证。使用新命令前应重载扩展，再让本地桥重连。
