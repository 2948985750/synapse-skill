---
name: synapse-skill
description: 驱动已运行、已登录的 Chrome/Edge（本机回环 WebSocket + 浏览器 MV3 扩展的 chrome.debugger 全量 CDP 透传）。用于读渲染 DOM、点选/输入、跑页内 JS、捕获页面自身 XHR/fetch 响应、复用登录态做网页自动化。无 --remote-debugging-port、无 native messaging、无服务端。触发词：synapse、CDP、驱动浏览器、点选元素、捕获接口响应、复用登录态。
---

# synapse-skill（agent 侧桥）

本仓库**只含 node 侧**：CLI、桥发现/注册表、路由、鉴权、doctor。
浏览器扩展在独立仓库 **[synapse](https://github.com/2948985750/synapse)**，两侧通过
`127.0.0.1:9521-9540` 的 WebSocket 通信，协议 `wb-cdp-ws/2`。

```
你的程序 / agent（agent/agent-collect.js）
      │  本机回环起 WS server
      ▼  ◄── 扩展 SW 主动拨入（连入即保活；掉线自动重拨）
扩展（另一仓库：chrome.debugger.attach → CDP 全透传）
      ▼
你活着的浏览器标签（登录态在里面）
```

浏览器必须是**已经开着的**——登录态就在里面，本仓库不碰 profile、不复用 cookie 文件。

## 用法

```powershell
# 起常驻桥（一条会话一个；注册 data/bridges/<session>.json）
node agent/agent-collect.js serve mysession

# one-shot：带 --session 走自己的桥（毫秒级）
node agent/agent-collect.js status --session mysession
node agent/agent-collect.js list   --session mysession
node agent/agent-collect.js open <url> --session mysession
node agent/agent-collect.js snapshot <tabId> [--max N] --session mysession
node agent/agent-collect.js click-el <tabId> '{"i":18,"tag":"a","role":"","label":"搜索"}' --session mysession
node agent/agent-collect.js type-el <tabId> '{"i":3,"tag":"input","role":""}' <text> [--clear]
node agent/agent-collect.js capture <tabId> <url|reload|wait> --duration <ms> [--filter <re>] [--all]
node agent/agent-collect.js doctor [--wait <ms>] [--force] [--dry]
```

`--session <sid>` 与 `WB_SESSION` 等价；**Windows 下用 `--session`**。
全部命令见 `node agent/agent-collect.js`（用法由 `agent/commands.js` 生成，不再手写）。

**交互命令传索引，不传 JSON**：

```powershell
node agent/agent-collect.js snapshot 17 --session mysession   # → { items:[{i,tag,role,label}] }
node agent/agent-collect.js click-el 17 3 --session mysession  # 3 就是 items[].i
node agent/agent-collect.js type-el  17 2 "hello" --session mysession
```

`cdp` 的 params 同样避开 shell 引号：`cdp <tab> <method> @params.json` 或 `--param k=v`。

## 程序调用（库入口，完全不过 shell）

```js
const { connect } = require("./agent/api");
const browser = await connect({ session: "mysession" });
const snap = await browser.snapshot(tabId);      // { url, count, items:[{i,tag,role,label}] }
await browser.click(tabId, snap.items[0].i);     // 传索引即可
await browser.type(tabId, 2, "hello");
await browser.close();                            // 必须关：否则桥侧保留这条 client
```

方法：`tabs / open / closeTab / run / snapshot / click / type / cdp / call`。
`cdp(tabId, method, params)` 的 `params` 是 JS 对象，没有序列化损耗。

## 模块

| 模块 | 内容 |
|---|---|
| `agent-collect.js` | 入口：serve/keep、main、对外导出 |
| `cli.js` | 参数解析与命令构造（纯函数） |
| `commands.js` | 命令清单唯一来源，`usage()` 由它渲染 |
| `transport.js` | WS 连接、级联故障转移、命令执行 |
| `capture.js` | 网络响应体捕获的结果整形与多标签编排 |
| `doctor.js` | 体检 + 协调恢复（唯一碰 Windows 细节的模块） |
| `registry.js` | 桥发现记录（多会话注册表 / 遗留单文件） |
| `config.js` | 端口段、命令超时、探测时限、锁 TTL |
| `lib/json-store.js` | JSON 读写 + 原子写（tmp + rename） |
| `lib/ui.js` | stdout JSON 出口与错误归一化 |

## 发现顺序与故障转移

`WB_BRIDGE_FILE`（遗留独占）→ 会话桥（`--session` / `WB_SESSION`）→ 其它活桥
（`ts` 降序）→ 遗留 `data/bridge.json` → 全失败才回落 60s 直连慢路径。
daemon 被强杀留下的死条目，下次发现时自动清理。

## 健康与恢复

- `status`：<2s 有界探活；无活桥立即 `NO_BRIDGE`，不等不回落。
- 桥活但扩展黑坑（MV3 SW 挂起）：`bridgeAlive:true + extension:null` → 跑 `doctor`。
- `doctor`：快查 → 礼貌等待 60s（探针端口 / 活桥 SW 重拨）→ 维护锁内协调硬刷。
  **多会话统一走 doctor，不要各自手杀浏览器**。
  硬刷默认只杀**本工具启动的** Edge（pid 记在 `data/edge.pid`）；要像旧版那样杀所有
  `msedge.exe`（会连带你自己正在用的窗口）必须显式 `--force-kill`。
  **硬刷只实现了 Edge**（`msedge.exe` + Edge 默认 profile）；用 Chrome 时 `list/open/run`
  等命令照常工作，只是 `doctor` 不会去重启 Chrome，需要手工恢复。

## 路径

全部走 `agent/paths.js`（`WB_DATA_DIR` / `WB_BRIDGE_DIR` / `WB_BRIDGE_FILE` /
`WB_CDP_EXT_DIR` / `WB_EDGE_EXE` / `WB_AGENT_WS_START|END`）。
`doctor` 的硬刷需要 `WB_CDP_EXT_DIR` 指向含 `manifest.json` 的扩展根（即 synapse 仓库的 `extension/`）。

## 测试

```powershell
npm test     # bridge 28 + 命令表漂移守卫 + review 回归 2 例
npm run verify
```
