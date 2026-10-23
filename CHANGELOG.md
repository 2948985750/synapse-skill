# 变更记录

本文件专门记录**修复过的问题**（不只是功能变更），每条写清：现象 / 根因 / 修法 / 提交。
目的：以后回看时能知道「代码为什么长这样」，而不是只看到一堆 diff。

浏览器扩展在本仓库之外：[synapse](https://github.com/2948985750/synapse)。

---

### 变更：鉴权改为两侧内置的固定标识（去掉配对文件与 UI）

- **决定**：保留双向 HMAC 握手，但令牌不再由用户配对，而是扩展与 agent 两侧
  `ws-auth.js` 里写死的同一枚 64 位标识（不再是全零默认值）。
- **移除**：`pair` 命令、`pairToken()`、`data/bridge-auth.json`、侧边栏配对 UI、
  扩展侧 `chrome.storage` 令牌读取与 `panel.setToken` 消息。
- **保留**：挑战/应答、双向 proof 校验、Origin 白名单（网页仍然连不上）。
- **信任模型**：标识不是密码，源码公开；按"单用户可信本机"设计，已写入 README。

---

## 2026-10-23（下午）— 库入口 + cdp 参数不再走 shell

### 新增 `agent/api.js`：程序调用入口

- `connect({session})` 返回一个客户端：`tabs / open / closeTab / run / snapshot / click / type / cdp / call`。
- 参数就是 JS 值，不需要 JSON 字符串，彻底绕开 PowerShell 的引号问题。
- 内部复用 transport/registry/bridge-auth；自动补 `clientId`（桥要求每条命令带）。
- 实测：`tabs → open → snapshot → click(索引) → 跳转校验 → closeTab` 全链路通过。

### `cdp` 的 params 支持 `@file` 与 `--param k=v`

- `cdp <tab> <method> @params.json`：从文件读 JSON。
- `cdp <tab> <method> --param expression=document.title --param returnByValue=true`。
- 两者可叠加，`--param` 覆盖文件值；非法 JSON / 文件缺失统一报 `INVALID_PARAMS`。
- 旧的 `'<params-json>'` 写法仍然兼容。

---

## 2026-10-23 — 配对闭环 + 两个 P1

### BUG-13 交互命令要求 JSON 走 argv，在 PowerShell 里用不了（P1 易用性）

- **现象**：`click-el <tabId> '{"i":0,"tag":"a","label":"Learn more"}'` 在 PowerShell 5.1 里
  双引号被 shell 吃掉，JSON 解析失败 → 直接打印 usage。`type-el` 同。
  这正是早期 `tools/agent-run.js` 存在的理由，而那个目录已被删除，等于把坑留给了使用方。
- **根因**：快照索引本身是标准化的（`snapshot` 给 `{i,tag,role,label}`），但把"索引"这个
  简单整数包在 JSON 里当 argv 传，等于让 shell 参与序列化。
- **修法**：`click-el <tabId> <i>` / `type-el <tabId> <i> <text>` 直接接受裸索引；
  旧的完整 JSON 写法仍然兼容；新增可选的 `--label <text>` 参与漂移校验。
- **实测**：`click-el 1961500280 0 --session clickidx` → `found:true, clicked:"Learn more"`，
  页面跳转到 iana.org。
- **测试**：`test-commands` 增加裸索引与旧 JSON 两种形态的解析断言。

### BUG-12 capture 没有资源上界（P1）

- **15 分钟会话**：扩展侧 `durationMs` 是 `opts.durationMs + 900000`，每次 capture 都在扩展里
  挂一个 15 分钟会话。现在改为 `+ 120000`（窗口 + 兜底取体所需）。
- **无差别 eager 取体**：对**所有** `Network.loadingFinished` 都发 `getResponseBody`，
  不看 type/URL/filter。实测 120 条无关事件 → 120 次取体、约 60MB。现在先按
  `requestWillBeSent` 的 type/url 建候选，只取 xhr/fetch/命中 filter 的。
- **无上限**：bodyStore 加 16MB 总预算，并发取体限 8 个。
- **兜底路径无总时限**：最多 40 条 × 20s 串行，capture 可能跑十几分钟。现在加
  `bodyDeadlineMs`（默认 120s），单条超时取剩余预算，超时条目标 `bodyError`。
- **回归测试**：120 条无关 `loadingFinished` + 1 条 xhr → 断言只取 1 次体。

### BUG-11 `serve` / `--keep` 写注册表失败会把进程挂住（P1）

- **现象**：注册表写不进去（如 `WB_BRIDGE_DIR` 指向文件下的路径），stdout 已经输出
  `{"ok":false,"error":"ENOTDIR…"}`，进程却仍然活着——因为 `srv` 还持有事件循环。
- **修法**：新增 `registerOrCleanup()`，注册失败先 terminate clients + `srv.close()` 再抛；
  serve / keep 两处共用。
- **实测**：指向非法目录时 0.1s 退出并输出 ENOTDIR（此前会挂着）。

### BUG-10 doctor 的硬刷不是事务（4 个 P1）

- **先杀后校验**：早先 `killAllEdge()` → 清缓存 → 最后才由 `launchEdge` 校验 manifest；
  扩展路径写错时浏览器已经被杀、且不会重启。现在 `findEdgeExe()` / `resolveExtDir()` 都前移，
  校验通过才动手；`launchEdge` 补 `error` 监听并写 maintenance.log。
- **拿锁后不复检**：注释说"别人已修好就直接放行"，代码却直接再杀一次。现在拿锁后先
  `probeStatusSnapshot`，健康则释放锁并返回 `action:"waited"`。
- **预算口径错**：硬刷预算从进程启动 `t0` 算，礼貌等待 60s + 等锁 60s 会把 150s 预算吃光，
  重启后可能一次轮询都不跑。现在从重启成功开始计 `hardStart`，探针等待取剩余预算。
- **探针不可取消**：`startProbeServer` 只返回 `{promise, portReady}`，提前返回后进程被它自己的
  定时器挂住（默认多挂近 60s/90s）。现在提供 `cancel()`，三处提前返回与硬刷结束都会调用；
  `--dry` 也改到快查之后立即返回（原来要等满 60s）。

### BUG-7 配对闭环是死的（P0）：照 UI 提示操作反而连不上

- **现象**：侧边栏让用户「运行 `pair`，把配对码填进来」。照做之后扩展用随机令牌、node 侧仍用默认令牌，
  HMAC 必然失败；doctor 重启浏览器也修不好（问题在密钥，不在浏览器）。
- **根因**：`readToken()` 无条件返回 `DEFAULT_TOKEN`，而 `pairToken()` 仍生成随机令牌落盘 —— 一个写、一个不读。
  扩展侧 `loadBridgeToken()` 同样忽略 storage，配对码只在当次 SW 生命周期内有效。
- **修法**：`readToken()` 读 `data/bridge-auth.json`（有则用、无则回落默认）；扩展 `loadBridgeToken()` 读
  `chrome.storage.local.wbBridgeToken`；`pair` 在 stderr 明确提示「必须填进扩展，否则会断」；
  鉴权失败文案带上「两端密钥不一致」的排查指引。
- **回归测试**：`readToken follows the pairing file and falls back to the default key`。

### BUG-8 非法 `--filter` 的 INVALID_FILTER 在 CLI 路径不可达（P1）

- **现象**：`capture … --filter '['` 返回 `COMMAND_FAILED` + 裸 `SyntaxError`。
- **根因**：`validateOptions` 先 `new RegExp` 直接抛，capture 里的 try/catch 永远走不到；
  上一轮的回归测试只测库函数，属于**测试假绿**。
- **修法**：`validateOptions` 内包 try/catch，抛 `code=INVALID_FILTER`；回归测试改测该入口。

### BUG-9 全新安装没有 `data/` 时加锁直接 ENOENT（P1）

- **现象**：干净 clone（`data/` 被 gitignore）后 `doctor` 完全跑不起来。
- **修法**：`acquireMaintenanceLock` 加锁前 `mkdirSync(dir, {recursive:true})`；实测指向不存在的临时目录时 `acquired=true`。

---

## 2026-10-22

### 仓库拆分

agent 侧从 `synapse` 仓库拆出，本仓库只保留 node 侧（CLI / 桥 / 路由 / 鉴权 / doctor）。
扩展与本仓库通过 `127.0.0.1:9521-9540` 的 `wb-cdp-ws/2` 协议通信，代码互不包含。

`b6786c3` init · `7dda61c` docs

### BUG-1 客户端清理无超时 → 常驻进程僵尸连接

- **现象**：`serve` 跑久了，某些客户端 socket 永久停在 `CLIENT_CLOSING`，`clients` 只增不减。
- **根因**：`cleanupClient` 发出 `client.disconnect` 后等扩展回 `agent.result`，**没有任何超时**。
  扩展收到消息后若 SW 被挂起（MV3 空闲 30s 即挂），这条记录永远不会被清掉。
- **修法**：加 `CLEANUP_TIMEOUT_MS = 5000`，超时释放身份并回 `CLEANUP_TIMEOUT`；三处清理路径
  （回包 / 扩展断开 / `close()`）都 `clearTimer`。
- **回归测试**：`agent/test-regressions.js` —「cleanup is released by timeout…」

### BUG-2 `lateStarts` 在断开路径无上限

- **现象**：客户端反复断连/重连时，补偿队列只增不减。
- **根因**：`expire()` 里有 200 条上限，但 `cleanupClient()` 这条路径直接 `lateStarts.set(...)`。
- **修法**：统一走 `rememberLateStart()`，上限 `LATE_STARTS_MAX = 200`。

### BUG-3 `transport.js` 使用了未引入的 `crypto`

- **现象**：靠 Node 18+ 的全局 `crypto` 才不报错。
- **根因**：`createChannel()` / `close()` 调 `crypto.randomUUID()`，但顶层没有 `require("crypto")`；
  同一仓库的 `agent-collect.js` 却是显式引入的，风格不一致。
- **修法**：显式 `require("crypto")`；`package.json` 补 `engines.node >= 18`。

### BUG-4 非法 `--filter` 抛原生 SyntaxError

- **现象**：`--filter "["` 之类的输入，最终报 `COMMAND_FAILED`，看不出是正则写错。
- **根因**：`new RegExp(opts.filter)` 无保护（顺带发现 `if (re)` 是恒真死判断）。
- **修法**：包成 `INVALID_FILTER`，保留原始正则错误信息。
- **回归测试**：`agent/test-regressions.js` —「invalid --filter yields INVALID_FILTER…」

### BUG-5 `usage()` 里缺 `setfile`

- **现象**：`setfile` 一直是可用命令，但从没出现在用法输出里，用户看不见。
- **根因**：命令清单手写了两份（`buildCmd` 的 switch + `usage()` 的字符串），已经漂移。
- **修法**：`agent/commands.js` 成为唯一来源，`usage()` 由它渲染；
  `agent/test-commands.js` 把命令表与 `buildCmd` 的 switch 钉死，任一边漏改即失败。

### BUG-6 `MAINT_LOCK_TTL_MS` 定义了两遍

- **现象**：常量在文件里出现两次，值相同所以没炸，但任一处被改就会静默不一致。
- **修法**：集中到 `agent/config.js`。

### 其它修复

- **JSON 写入非原子**：桥注册表 / 遗留 `bridge.json` / 令牌 / 维护锁原来都是
  `fs.writeFileSync` 直接覆盖，进程写到一半被杀就留下半个 JSON。
  新增 `agent/lib/json-store.js`（tmp + rename），全部写入改走它。
- **拆分模块时的三处漏引入**（均由真链路冒烟发现，单测覆盖不到）：
  `authenticateServer`（transport 只引入了 client 侧）、`SID_RE`（定义留在 registry）、
  `bridgeCandidates`（doctor 的 status 探测用）。
- **行尾混用 CRLF/LF**：拆分脚本产生混合行尾，统一为 LF。

### 重构（非缺陷）

- `agent-collect.js` 1677 行 → 9 个模块（`cli` / `commands` / `transport` / `capture` /
  `doctor` / `registry` / `config` / `lib/json-store` / `lib/ui`），对外导出保持不变。

---

## 已知未修（需产品决策）

1. **`doctor` 硬刷会杀掉所有 `msedge.exe`**（含用户自己的窗口），并清理默认 profile 的
   `Service Worker` / `Code Cache`。开发机可用，作为对外工具偏激进。
   待办：收窄到「只杀本工具 `--load-extension` 启动的实例」。
2. **鉴权只防网页不防本地进程**：`DEFAULT_TOKEN` 是源码常量，`pairToken()` 生成的令牌
   没有任何代码读取，`pair` 已是死代码。待办：要么恢复真配对，要么明确降级为「本机可信」。
