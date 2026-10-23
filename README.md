# synapse-skill

**agent 侧桥**：在本机回环起一个 WebSocket server，等浏览器里的 Synapse 扩展主动拨入，
把 CDP 命令透传进你**已经开着、已经登录**的 Chrome/Edge 标签。

不启动新浏览器、不碰 profile、不复用 cookie 文件——登录态就在那个标签里。

```
你的程序 / agent  ──WS──▶  synapse agent（本仓库，127.0.0.1:9521-9540）
                                    ▲
                                    │ 扩展 service worker 主动拨入
                          Synapse 扩展（另一仓库）
                                    ▼
                          你活着的浏览器标签（登录态在里面）
```

## 本仓库只含 node 侧

| 在不在本仓库 | 内容 |
|---|---|
| ✅ 在 | CLI、桥发现/注册表、路由（tab FIFO + clientId 租约）、鉴权（node 侧）、`doctor`、测试 |
| ❌ 不在 | MV3 扩展（manifest、service worker、`chrome.debugger`、页内注入、侧边栏）→ 见 [synapse](https://github.com/2948985750/synapse) |

两侧唯一的"重复"是 `ws-auth.js`：浏览器不能 `require` node 模块，所以协议
`wb-cdp-ws/2`（HMAC 挑战/证明）两边各实现一份，由扩展仓库的 `test-ws-auth.js` 做互通验证。

## 安装

零依赖：`agent/vendor/ws/` 已 vendored ws 8.x，不需要 `npm install`。
只需要 Node ≥ 18。

```powershell
node agent/agent-collect.js serve mysession     # 起常驻桥
node agent/agent-collect.js status --session mysession
node agent/agent-collect.js list   --session mysession
```

完整命令表见 [SKILL.md](SKILL.md)，或直接跑 `node agent/agent-collect.js`（用法由
`agent/commands.js` 生成）。

## 路径配置

| 变量 | 缺省 | 用途 |
|---|---|---|
| `WB_DATA_DIR` | `<repo>/data` | 数据根（注册表 / 遗留单文件 / 维护日志） |
| `WB_BRIDGE_DIR` | `<data>/bridges` | 多会话桥注册表目录 |
| `WB_BRIDGE_FILE` | `<data>/bridge.json` | 遗留单文件桥记录 |
| `WB_CDP_EXT_DIR` | 候选推导 → 报错 | `doctor` 硬刷时的 `--load-extension` 根（须含 `manifest.json`） |
| `WB_EDGE_EXE` | 自动查找 `msedge.exe` | Edge 可执行路径 |
| `WB_AGENT_WS_START` / `WB_AGENT_WS_END` | `9521` / `9540` | 端口段（须与扩展一致） |

`data/` 是运行时工作区，不入库，首次运行自动创建。

## 程序调用（库入口）

命令行要经过 shell，JSON/JS 里的引号容易被吞（PowerShell 5.1 尤其）。程序直接用库入口：

```js
const { connect } = require("./agent/api");
const browser = await connect({ session: "mywork" });
const snap = await browser.snapshot(tabId);
await browser.click(tabId, snap.items[0].i);   // 索引，不是 JSON
await browser.close();
```

CLI 侧也做了同样的收口：`click-el <tab> <i>`、`type-el <tab> <i> <text>`、
`cdp <tab> <method> @params.json` / `--param k=v`。

## 测试

```powershell
npm test           # bridge 28 + 命令表漂移守卫 + review 回归 2 例
npm run test:agent # 仅桥
npm run verify
```

## 相关仓库

- [synapse](https://github.com/2948985750/synapse) — MV3 扩展与商店发布工具。
