# 开源 CDP 工具对比与 Synapse 的取舍

核对日期：2026-11-06。依据是官方仓库 README、架构说明与 Chrome 扩展 API 文档；没有安装或实测这些第三方工具，不能据此排名速度、稳定性或站点成功率。

## 结论

有直接同类。Playwriter 和 Browser MCP 都使用浏览器扩展、本地服务与 chrome.debugger，将已运行浏览器的能力交给 agent。Synapse 的基本连接架构有同类实践；这不等于本项目已具备同等可靠性。

建议保留当前双仓边界，先补齐失败语义、目标确认与回归验证，不因存在同类就重写。若目标只是获得通用浏览器自动化能力，应先试用同类，再决定是否继续自维护；若目标是轻量 CLI/SDK 加站点知识画像，则保留自己的上层数据与路由有价值。这是工程建议，非实测结论。

## 四个值得对照的项目

| 项目 | 官方资料确认的实现或能力 | 对 Synapse 的参考价值 |
|---|---|---|
| [Playwriter](https://github.com/remorses/playwriter)（MIT） | 扩展通过 chrome.debugger 接入标签，经本地 WebSocket relay 暴露 CDP，由 Playwright 驱动；提供 CLI/MCP，用户点击扩展选择可控标签 | 连接拓扑最接近；参考显式标签选择与 Playwright 上层接口，不能把它的全部能力等同于原始 chrome.debugger 能力 |
| [Browser MCP](https://github.com/BrowserMCP/mcp)（Apache-2.0） | MCP server → 本地 daemon → 扩展 chrome.debugger relay；daemon 使用 Playwright。当前仓库包含扩展与协议代码，README 说明首次配对和 Stop 控制 | 同类完整产品；参考协议兼容、用户可见的控制/停止边界。Synapse 固定共享标识与 browserId 路由校验不等同于该项目的配对机制 |
| [Playwright MCP](https://github.com/microsoft/playwright-mcp)（Apache-2.0） | Playwright 驱动的 MCP server；--extension 模式可连接现有 Chrome/Edge，复用已登录标签 | 参考成熟的动作/导航期限与执行结果契约。应区分普通 profile 模式和接入既有浏览器的扩展模式 |
| [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp)（Apache-2.0） | MCP/CLI 提供浏览器自动化、网络/控制台调试和性能分析，自动化采用 Puppeteer；文档另有接入现有 Chrome 的配置 | 适合参考诊断与性能工具；不是 Synapse 扩展桥的直接替换，接入方式和权限需要按所选模式核对 |

以上许可证仅记录仓库声明；本次没有复制第三方代码、引入依赖或进行许可证兼容性审计。

## 截图里的 CDP 域意味着什么

截图展示的是 CDP 文档的域目录。域名出现在目录中，不证明当前浏览器版本、目标类型或 chrome.debugger 传输支持其全部方法。

Chrome 官方说明 chrome.debugger 只开放指定域。Page、Runtime、DOM、Network、Input 等在其支持列表中；Browser 不在该列表内。即使域受支持，具体方法仍可能受版本、目标与权限约束，应检查真实回复。

本项目的 cdp 是方法透传入口，不是完整浏览器级 CDP server，也没有提供 Playwright/Puppeteer 连接兼容层。不能把 Synapse 的 WebSocket 地址直接当作 chromium.connectOverCDP 的标准端点。

来源：[Chrome debugger API 的 Restricted domains](https://developer.chrome.com/docs/extensions/reference/api/debugger#restricted-domains)。

## 当前实现核验与本次修改

当前代码已包含上一轮审查的修复：显式弹窗决策、超时不重发、导航/关闭共享标签锁、严格 session 与 browserId 检查、只读诊断，以及导航就绪和业务完成分离。本次没有将它们重复算作新增修复。

本次新增回归先复现了三处剩余问题，随后修复：

1. 内建 DOM 命令没有完整处理 CDP 的 exceptionDetails，异常可能变成成功消息包里的空结果或 found:false。现统一抛 EVALUATION_FAILED，保留异常原因；正常查无元素仍返回 found:false。
2. agent 只检查 Runtime.evaluate 的页内异常，漏掉 callFunctionOn、awaitPromise、runScript。现对所有 CDP 回复检查 exceptionDetails；正常返回 undefined 不报错，原始 CDP 协议结构仍由扩展透传。
3. SDK run 的单次 timeoutMs 未使用。现同时传给扩展 CDP 超时与 agent 命令期限；超时仍表示结果未知，不会重发，也不能保证已经派发的脚本停止。

同时把 SKILL.md 的 actions 描述收紧为导航入口；导航成功不能证明发邮件、改价或提交已完成。

## 仍未验证或未实现

- 第三方工具的本机兼容性、实际性能和真实站点成功率未测试。
- 本次修改以隔离 mock 和现有测试验证，未控制真实浏览器、访问登录页面或验证商店已发布版本。
- 没有新增 Playwright 兼容 relay、完整工作流执行器、用户可见的逐标签授权/撤销界面或每安装独立配对；这些属于另行设计的功能。
- 更新扩展源码不会自动更新浏览器已加载的版本，需操作者重新加载开发版或安装相应构建，再进行真实浏览器验收。
