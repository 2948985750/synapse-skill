# synapse-skill

网页可靠性补齐的用法与边界见 [BROWSER-RELIABILITY.md](BROWSER-RELIABILITY.md)：稳定元素引用、唯一定位、条件等待、上传核对、显式上下文和视口恢复。

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

## 模块

| 模块 | 内容 |
|---|---|
| `agent-collect.js` | 入口：serve/keep、main、对外导出 |
| `cli.js` | 参数解析与命令构造（纯函数） |
| `commands.js` | 命令清单唯一来源，`usage()` 由它渲染 |
| `transport.js` | WS 连接、级联故障转移、命令执行 |
| `capture.js` | 网络响应体捕获的结果整形与多标签编排 |
| `doctor.js` | 链路体检与等待重连，不修改浏览器进程或 profile |
| `registry.js` | 桥发现记录（多会话注册表 / 遗留单文件） |
| `config.js` | 端口段、命令超时、探测时限、锁 TTL |
| `paths.js` | SKILL_ROOT/DATA_ROOT/PROFILES_ROOT/OUTPUT_ROOT 解析与锚内校验 |
| `api.js` | 程序用库入口（connect → tabs/open/run/collectElements/click/type/cdp） |
| `lib/json-store.js` | JSON 读写 + 原子写（tmp + rename） |
| `lib/ui.js` | stdout JSON 出口与错误归一化 |
| `runner/discover.js` | 通用采集程序：有界发现 → 画像（元素快照 + 响应体 + 知识骨架，纯数据） |

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

## 路径配置（打包与数据布局）

三个根，各管一类东西。**SKILL_ROOT 是含 SKILL.md 的目录，运行时自动向上查找得到**——
skill 装进任何 agent 客户端（.zcode/.agents/vendored）相对锚都成立：

| 内容 | 位置 | 随谁走 | 入库 |
|---|---|---|---|
| skill 安装位置（代码/文档/测试） | `<SKILL_ROOT>/` | SKILL_ROOT | git |
| 正式画像（运行时） | `<SKILL_ROOT>/profiles/*.json`（纯数据，无采集代码） | SKILL_ROOT | 视用户决定 |
| 待审画像（`status: draft`） | 同 `<SKILL_ROOT>/profiles/`，靠 `status` 字段区分 | SKILL_ROOT | 视用户决定 |
| 采集产物 | `<DATA_ROOT>/output/<domain>/<task>.json` | DATA_ROOT | 否 |
| 桥注册表 / 维护锁 / 日志 | `<DATA_ROOT>/bridges` 等 | DATA_ROOT | 否 |
| config.json | 固定平台默认目录（与 dataRoot 解耦，防循环依赖） | — | 否 |

- DATA_ROOT 解析：`WB_DATA_DIR` > `config.json dataRoot` > 平台默认
  （Windows `%LOCALAPPDATA%/Synapse/`；macOS `~/Library/Application Support/Synapse/`；
  Linux `~/.local/share/synapse/`）。
- PROFILES_ROOT 解析：`WB_PROFILES_DIR` > `config.json profileRoot` > **默认
  `<SKILL_ROOT>/profiles`（相对安装位置——skill 装到哪，画像跟到哪）**。
- 采集产物根 OUTPUT_ROOT：`SYNAPSE_OUTPUT_DIR` > `config.json outputDir` > `<DATA_ROOT>/output`。

**画像跟着安装位置走**：本机安装位是 junction（`~/.zcode/skills/synapse-skill` →
源码仓），所以运行时画像直接落在源码仓的 `profiles/` 下，不存在第二份副本。

**安装到 agent 客户端**：装好后用 `config set data-root` 注册数据根（桥注册表/日志/即席
采集产物）；画像**不需要注册**——默认就锚在安装位置。**discover 没有任何位置旗标**：
采集结果（快照 + 响应体 + 知识骨架）整体写入
`<PROFILES_ROOT>/<domain>.json`，落点由程序直接计算，agent 无权指定保存位置；
整根重定位只能走操作者层配置（`config set data-root/profile-root/output-dir`
或对应 `WB_*` 环境变量）。

`<skill>/data` 是旧版的数据根（早先 DATA_ROOT 默认落在安装位置下），已废弃——
当前运行时数据一律落在 DATA_ROOT（本机为 `~/.zcode/synapse-data`），代码里已无任何
路径会再建这个目录，残留可直接删除。

## 程序调用（库入口）

命令行要经过 shell，JSON/JS 里的引号容易被吞（PowerShell 5.1 尤其）。程序直接用库入口：

```js
const { connect } = require("./agent/api");
const browser = await connect({ session: "mywork" });
const collected = await browser.collectElements(tabId);
await browser.click(tabId, collected.items[0].i);   // 索引，不是 JSON
await browser.close();
```

CLI 侧也做了同样的收口：`click-el <tab> <i>`、`type-el <tab> <i> <text>`、
`cdp <tab> <method> @params.json` / `--param k=v`。

## 鉴权与信任模型

扩展与 agent 两侧使用同一枚固定公开标识（`agent/ws-auth.js` 的 `DEFAULT_TOKEN`，
扩展仓库里是同值），连接时做双向 HMAC 挑战/应答以识别协议实现。它不能阻止取得该标识的
本地程序冒充客户端或 agent。**没有安装级密钥、配对码或逐客户端授权。**

这枚标识不是密码——源码公开，能在这台机器上运行代码的进程都可以读到它。
所以本工具按**单用户可信本机**设计，请勿在多用户或存在不可信进程的机器上运行。


## 站点画像（纯数据）

`profiles/` 存站点画像：**纯数据文件（.json，schemaVersion 3）**——`digest`（各段规模
目录）+ `snapshot`（瘦身元素快照，响应体仅 `--capture` 时存在）+ 站点知识
（fieldMap / limits / antiScrape / pageNotes / actions / pending）。
画像里**不含任何可执行采集代码**：采集动作是通用程序（`runner/discover.js` 的单页富快照）
与 agent 的即席桥命令（open / collect-elements / run / capture）；字段怎么取写在 `fieldMap` /
`pageNotes` 里作描述，抽取逻辑由 agent 按现场 DOM 即席写，不存进画像。画像是惰性数据
——随便审阅、随便拷贝，没有"加载即执行"的信任边界。

## 测试

```powershell
npm test             # 单测：bridge 28 + 命令表守卫 + 回归 10 + discover 守卫 13 + actions 守卫 16（零浏览器）
npm run test:agent    # 仅桥
npm run verify
```

真浏览器的流程不进单测：`npm run discover`（单页富快照）需要已登录浏览器、扩展已加载，
以及一条活桥（`node agent/agent-collect.js serve <sid>`）。


## 操作：画像生产与链路恢复（agent 工作流）

三段原本嵌在 SKILL.md 提示词里的操作知识（2026-10-26 提示词瘦身后移出）；
agent 需要画像生产/排障细节时查这里。

### 画像生产（discovery）

分工：`discover.js` 是通用程序（所有站点同一套代码：守卫 + 探针 + 采集）；
知识归纳是 agent 依画像内快照的判断活；晋级靠人审。

#### 路线

- "采集这个网站所有功能" → 下述整站盘点；"采集网页里 xxx 功能" → 下述单功能流程
  （域名已有正式画像就把知识**追加**进画像根副本，不新建文件）。

#### 整站盘点

```powershell
node runner/discover.js --url https://site.com --session <sid>            # 单页富快照 → 画像
node runner/discover.js --url https://site.com --capture --session <sid>  # 按需加抓响应体
```

硬守卫写死（同源 / 危险词只记不点 / 表单不提交 / 单页不跟链接——页间跳转由 agent 交互
观测补全）。产物**只有一个**：`<PROFILES_ROOT>/<domain>.json`——顶层 `digest` 段是各段
规模目录（pages/interactive/clickables/forms/lists/responseBodies/snapshotKb，~10 行）；
采集快照在 `snapshot` 段：每页只含**可交互元素**（`interactive:true` 的 outline）与
`clickables`、结构线索（已剔 SVG 图元）与响应体（仅 `--capture` 时存在）；跨页重复的
站点框架归并进 `snapshot.chrome` 一份。知识字段为空待 agent 补。不存在独立的材料包/报告文件。

1. **读目录 → 读快照**：先看顶层 `digest` 段（各段规模）定盘子，再按需开 `snapshot.pages[0]`
   与 `capture`（仅 `--capture` 时存在），不整文件吞读；超预算响应体带 `shape`+512B 样例

2. **圈功能清单**：路由簇（`limits.routes`）+ 导航类 clickables + 页标题交叉定主功能；
   `/legal`/`/blog`/营销页是噪音；登录墙路由记 pending 不强进；
   危险动作（保存/投递/支付）只记进快照 `dangerous`/`pending`，永不代执行。
3. **补知识字段**（写进画像，全是数据不写代码）：
   - `fieldMap`：主取法优先语义属性（`[data-test=…]`），哈希 class 不可靠；字段埋在
     大文本里就写清"哪段文本 + 什么形态正则"；
   - `limits`：首屏条数、分页是否真有效（**必须实试，别信文档**）；
   - `antiScrape`：现象 + 触发 + 缓解 + 实测证据；`pageNotes` 照填（接口记录约定见
     SKILL.md「接口记录」：每条只留 `url` + 中文用途说明）。
4. **汇报请人审**（功能清单 + 知识要点 + 覆盖率 + pending）；通过即置 `status: reviewed`；
   是否 git 提交由用户定。

#### 单功能补画像

1. `open` + `collect-elements`，用功能词匹配链接文本/按钮 label/tab/placeholder；
   **匹配不到 → 带证据回问用户**（哪个页面、看到哪些候选），不猜；
2. 命中 → 只探这一条子树：`click-el` 进入、搜索类 `type-el` 填词提交、动作前后各
   `capture` 一次对比新增请求（动作触发的接口 = 该功能的数据源）；
3. 判数据源、把观察填进对应知识字段（同整站第 3 条）；
4. 已有正式画像 → 追加进画像根副本；没有 → 新建待审画像走整站第 4 步人审。

### 发现顺序与故障转移

`--session`/`WB_SESSION` 严格限定桥；失联报 `NO_BRIDGE`，不自动切到其它会话或直连。跨会话只在显式 `--allow-failover` 时允许。未指定会话时按最新活桥尝试，必要时等待直连。daemon 的死条目在下次发现时清理。

多浏览器/profile 时，先在目标浏览器确认 `diag.browserId`，随后使用 `--browser-id <id>`、`WB_BROWSER_ID` 或 SDK `connect({ browserId })` 固定目标。每个业务命令前检查该标识；不匹配报 `BROWSER_MISMATCH`。未固定身份时仍可能选中第一个可用扩展；session 只标识 Node 桥。browserId 是扩展本地存储的路由标识，不是新的认证机制；重装/清扩展存储后需重新确认。

### 健康与恢复

- 桥活但扩展黑坑（MV3 SW 挂起）：`bridgeAlive:true + extension:null` → 跑 `doctor`。
- `doctor`：快查 → 轮询活桥等待重连（默认 60s），超时报告人工检查步骤。不会杀进程、清 profile 缓存或重启浏览器；`--force` 只跳过等待，`--dry` 只快查，旧 `--force-kill` 会报错。
- 原生弹窗仅记录，不自动接受，也不临时覆盖页面 `alert`/`confirm`/`prompt`。需要处理时按用户明确决定调用 CDP `Page.handleJavaScriptDialog`。
- `CDP_TIMEOUT` 表示执行结果未知，扩展不会重发表达式；调用方应先检查页面，避免重复执行有副作用的操作。
- 页内 JavaScript 异常返回 `EVALUATION_FAILED`，保留异常原因，不自动重试。此规则覆盖内建 DOM 命令和 CLI/SDK 的 CDP 执行结果；`query-el` 正常查无元素仍返回 `found:false`。SDK `run(tabId, expression, { timeoutMs })` 同时约束 CDP 等待和命令期限；超时不能证明页面脚本已经停止。

### 导航动作结果

`actions` 是纯 JSON 导航入口，不执行完整业务工作流。拒绝 `status:draft` 画像；验证加载完成与最终 URL（包含 query/hash），只返回 `outcome:"navigation-ready", ready:true, taskSucceeded:false`。exit 0 代表页面就绪，不代表发信/提交/支付等业务完成。登录重定向、加载超时或路由不符不会记成功。

导航次数记在 `lastNavigationAt` / `navigationDate` / `navigationCount`，间隔/日限额按导航检查；旧成功计数只作兼容读取，不再增加。状态采用原子写入与同 action 锁，避免并发突破限额。进程异常退出后如有残留 `.lock`，确认没有动作运行再手动移除该锁。SDK/CLI capture 均默认采集 12000ms，时长须为有限正数。

## 相关仓库

- [synapse](https://github.com/2948985750/synapse) — MV3 扩展与商店发布工具。
- [开源 CDP 工具对比](CDP-COMPARISON.md) — Playwriter、Browser MCP、Playwright MCP、Chrome DevTools MCP 的连接方式、能力边界和本项目取舍（2026-11-06 核对）。
