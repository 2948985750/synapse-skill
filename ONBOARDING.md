# ONBOARDING — Synapse 双仓接手文档

> 单一入口。本文只负责"去哪看/怎么动"，细节在各仓 README，命令速查在 `synapse-skill/SKILL.md` 的表格（由 `agent/commands.js` 表生成，**别手改**，改表后跑 `npm run usage:sync`）。
>
> 适用对象：完全没读过的接手人。按本文从 §1 读到 §7 即可建立足够开工的心智模型。

---

## 1. 这套系统是什么

驱动**本机已运行、已登录**的 Chrome/Edge 做网页自动化（读渲染 DOM、点选输入、捕获页面自身 XHR/fetch 响应、复用登录态）。

技术路线一句话：**浏览器装一个 MV3 扩展（synapse）做 CDP 全量透传，agent 仓在本机回环起 WS server（端口 9521–9540），扩展 service worker 主动外拨接入**。没有 `--remote-debugging-port`、没有 native messaging、没有独立服务端进程。

## 2. 两个仓、三层规则（先钉住这条）

| 层 | 内容 | 所在 | 状态 |
|---|---|---|---|
| L0 传输 | WS server、桥路由/租约、HMAC 鉴权 | `synapse-skill/agent/`（transport/bridge-router/bridge-auth/ws-auth） | 冻结，bug 才碰 |
| L1 观测 | chrome.debugger attach、CDP 透传、捕获、弹窗 | `synapse/extension/`（扩展仓） | **冻结在 0.15.1** |
| L2 动词/手势 | CLI 命令、手势 JS 生成、画像结晶 | `synapse-skill/agent/ + runner/ + profiles/` | 日常迭代的唯一战场 |

**关键理解**：手势（hover/drag/swipe/key/media 等）已从扩展迁到 `agent/gestures.js`——生成页内 IIFE，走扩展的**通用 `cdp` 通道**发射。扩展不认具名手势命令，所以加动作**永远不碰扩展**。`gestures.js` 的 COLLECTOR_SRC/选择器与扩展仓**逐字同步**（`test-gestures.js` 有守卫）。

连接方向是反的：扩展连 agent，不是 agent 连扩展（MV3 SW 不能被外部连）。"扩展没连上" = 9521–9540 没起 server 或端口被占（`WB_AGENT_WS_START/END` env 可覆盖）。

## 3. 扩展仓 `synapse` 速览

```
extension/
  src/background.js      唯一装配点：importScripts 载入 9 个 lib，按依赖序实例化注入互依
  src/ws-bridge.js       L0 主通道：逐口外拨 agent WS，cmd 帧校验后交 commands.js
  src/ws-auth.js         HMAC 握手（内置 64 位 token，UMD 双环境）
  src/tablock.js         按 tab 的 FIFO 互斥锁（CDP 唯一并发闸口）
  src/lib/attach.js      chrome.debugger attach 状态唯一属主
  src/lib/cdp-transport.js  超时 + 挂死重试 + 全量透传
  src/lib/commands.js    agent 命令词汇唯一执行器
  src/lib/capture-store.js  域订阅注册表（捕获事件推回发起 socket）
  src/lib/leases.js      tab 租约（无租约且无捕获才物理 detach）
  src/lib/diag.js        日志环 + 原生弹窗自动 accept
  src/lib/page-actions.js  页内枚举/动作脚本生成（递归 shadowRoot）
  src/lib/panel-rpc.js   侧边面板旁路
build/                   商店构建（build-store.js 出 dist/）+ 零依赖图标生成
scripts/                 e2e-smoke（真 Edge 冒烟）+ verify-version（版本一致性）
test/                    4 个裸 Node 单测（无框架）
store/                   商店物料：0.15.1 zip、截图、文案、隐私政策页
```

每个 lib 都是经典脚本（MV3 SW 不支持 ES module）：文件尾 UMD 段同时挂 `globalThis` 和 `module.exports`，chrome API 靠 `options.chromeApi` 注入以便 Node 单测。

**什么时候才碰扩展**：结构性 bug、安全（鉴权 token）、或商店结构变更。发布流程：`npm test` → `npm run release:check`（版本校验 + build:store）→ 手动 zip `build/dist/synapse/` 传 Edge 开发者中心。已知欠账：`CHANGELOG.md` 末尾记着**商店 zip 落后于源码**，发布前必须重跑 build:store。

## 4. Agent 仓 `synapse-skill` 速览

```
agent/agent-collect.js   总入口 main(argv)：serve/keep 起 WS server；status/doctor/diag 分派；
                         discover/actions 原样透传给 runner（不预解析参数）
agent/cli.js             parseArgs（旗标 + @file）+ buildCmd（switch 组 cmd）
agent/commands.js        命令表唯一真源 COMMANDS[]（35 个），用法文本由此渲染
agent/transport.js       L0：bindAgentWs / connectBridgeChain（多候选故障转移）/ executeCommand
agent/bridge-router.js   鉴权后 socket 分发：tab 级 FIFO + 租约、pending 上限 64、僵尸清理
agent/bridge-auth.js     双向 HMAC 握手封装（默认 token 判"自家扩展"）
agent/capture.js         网络响应捕获整形 + 多标签并行
agent/registry.js        桥发现记录（bridge.json + 多会话 bridges/<sid>.json，pid 存活判定）
agent/config.js          常量：端口 9521–9540、CMD_TIMEOUT 50s、维护锁 TTL 3min
agent/paths.js           根目录解析（env > config.json > 平台默认）；PROFILES_ROOT 即仓库目录
agent/doctor.js          链路体检与恢复（唯一碰 Windows 细节：taskkill/Edge 重启/清 SW 缓存）
agent/api.js             程序用库 connect()→browser.tabs/snapshot/click/type/cdp（绕 shell）
agent/gestures.js        L2 手势真源（见 §2 逐字同步守卫）
profiles/                纯数据画像（无采集代码！）：*.json = reviewed，draft/*.json = 待审
runner/discover.js       单页画像采集 → 写 profiles/draft/<domain>.json（危险词只记不点）
runner/actions.js        结晶动作解释器（声明式 steps）；护栏硬执行：
                         side_effect=external 必须 --yes、--dry 只打印、never 词拦截
                         退出码：0 成功 / 1 一般错 / 2 护栏拦截 / 3 失败=agent 即席接管点
test/                    6 个测试（npm test 串跑）
.tmp/                    scratch（结晶会话临时产物），gitignore，无视
```

**一条命令的完整链路**（以 `type-el` 为例——注意它**不**走扩展具名动词，与手势同通道）：

```
cli.js gestureCmd/buildCmd → transport.connectBridgeChain（找到已连入的扩展，HMAC 握手）
  → executeCommand（bridge-router 内 tab 级 FIFO 排队）
  → WS 帧 {cmd:"cdp", Runtime.evaluate} → 扩展 commands.js case cdp（对表达式零解析）
  → withTabLock 内 acquireLease + ensureAttached → cdp-transport 发 Runtime.evaluate（gestures.js 生成的 IIFE）→ 结果弹回
```

扩展端仍有具名 `click-el`/`type-el`/`setfile` case（commands.js:81/107/157），但**当前 CLI 路径无人触发，属休眠基线**：click/type 已在 11-02 迁到 CLI IIFE 通道（"扩展不 bump"架构决定）；setfile 有意留扩展（`DOM.setFileInputFiles` 属 CDP 域能力=基建）。真正活着的具名帧只有 `snapshot`、`tabs`、`navigate`、`close`、`open`、`open-frame`、`attach`/`detach`。

**结晶循环**：

```
即席采集/discover → profiles/draft/*.json（status:draft，带实测 flows）
  → 人工审阅 + 跑通任务回写 actions[] → status:reviewed 正式画像
  → 下次同类任务走 runner/actions 快路径：--dry 核计划，exit 3 时 agent 即席接管并修复回写
```

## 5. 跑起来 / 验证

| 目的 | 命令（哪个仓） |
|---|---|
| 起桥 + 让扩展连入 | `node agent/agent-collect.js serve`（或 `keep`） |
| 查链路 | `status` / `diag` / `doctor` |
| agent 单测 | `npm test`（6 个串跑）；单跑 `test:agent`/`test:commands`/`test:gestures`/`test:actions` |
| 扩展单测 | `npm test`（先 verify-version 再 3 套）；深度 `npm run test:e2e`（真 Edge + 未打包扩展） |
| 发布扩展 | `npm run release:check` → 手动 zip |
| 改命令表后 | `npm run usage:sync`（回写 SKILL.md 用法段） |

坑：本机 node 无 `-I` 标志；改命令表必须"改源头（commands.js）+ usage:sync"，别手改 SKILL.md 生成块。

## 6. 改动纪律（改哪类事动哪些文件）

| 想做的事 | 动哪里 | 不动哪里 |
|---|---|---|
| 加新动作动词 | `agent/commands.js` 表 + `cli.js` buildCmd + 测试；`-el` 族另加 `gestures.js` IIFE + 同步守卫 | 扩展仓 |
| 改画像 | `profiles/*.json`（纯数据），用 `action` 命令 `--dry` 验证 | 不加代码进画像 |
| 修 L0 链路 bug | `agent/transport.js`、`bridge-router.js`、`registry.js` | L2 动词层 |
| 结构性扩展变更 | `synapse/extension/`，跑 `test:e2e`，bump 版本、重跑 build:store | 手势/动词类需求一律走 agent |

## 7. 已知欠账（接手时核对现状，勿照单全收）

- `--check` 未实现（actions 只 dry 不 verify 的中间态）
- 163 登录态被阻塞，相关画像待补
- 写类操作 Plan B（未定方案）
- 旧画像待归一化
- discover 单页实跑验收未完成
- 扩展仓商店 zip 落后于源码（见 §3）

—— 读完本文 + 按 §4 链路走一遍 `status` → `snapshot` → `click-el` → `capture`，即可开工。
