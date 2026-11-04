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
| `paths.js` | SKILL_ROOT/DATA_ROOT/PROFILES_ROOT/OUTPUT_ROOT 解析与锚内校验 |
| `api.js` | 程序用库入口（connect → tabs/open/run/snapshot/click/type/cdp） |
| `lib/json-store.js` | JSON 读写 + 原子写（tmp + rename） |
| `lib/ui.js` | stdout JSON 出口与错误归一化 |
| `runner/discover.js` | 通用采集程序：有界发现 → 画像 draft（元素快照 + 响应体 + 知识骨架，画像为纯数据） |

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
| 画像 draft（待审） | `<SKILL_ROOT>/profiles/draft/*.json` | SKILL_ROOT | 视用户决定 |
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
`<PROFILES_ROOT>/draft/<domain>.json`，落点由程序直接计算，agent 无权指定保存位置；
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
const snap = await browser.snapshot(tabId);
await browser.click(tabId, snap.items[0].i);   // 索引，不是 JSON
await browser.close();
```

CLI 侧也做了同样的收口：`click-el <tab> <i>`、`type-el <tab> <i> <text>`、
`cdp <tab> <method> @params.json` / `--param k=v`。

## 鉴权与信任模型

扩展与 agent 两侧写死同一枚固定标识（`agent/ws-auth.js` 的 `DEFAULT_TOKEN`，
扩展仓库里是同值），连接时做双向 HMAC 挑战/应答：不知道这枚标识的服务连不上桥，
扩展也不会把控制权交给冒充的 agent。**没有配对码、没有 UI、不需要用户操作。**

这枚标识不是密码——源码公开，能在这台机器上运行代码的进程都可以读到它。
所以本工具按**单用户可信本机**设计，请勿在多用户或存在不可信进程的机器上运行。


## 站点画像（纯数据）

`profiles/` 存站点画像：**纯数据文件（.json，schemaVersion 3）**——元素快照 + 站点知识
（fieldMap / limits / antiScrape / params / pageNotes / flows / dataEndpoints）。
画像里**不含任何可执行采集代码**：采集动作是通用程序（`runner/discover.js` 的发现爬行）
与 agent 的即席桥命令（open / snapshot / run / capture）；字段怎么取写在 `fieldMap` /
`pageNotes` 里作描述，抽取逻辑由 agent 按现场 DOM 即席写，不存进画像。画像是惰性数据
——随便审阅、随便拷贝，没有"加载即执行"的信任边界。

## 测试

```powershell
npm test             # 单测：bridge 28 + 命令表守卫 + 回归 10 + discover 守卫 11（零浏览器）
npm run test:agent    # 仅桥
npm run verify
```

真浏览器的流程不进单测：`npm run discover`（发现爬行）需要已登录浏览器、扩展已加载，
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
node runner/discover.js --url https://site.com --plan          # 不起浏览器，先核对预算
node runner/discover.js --url https://site.com --max-pages 20 --depth 2 --session <sid>
```

硬守卫写死（同源 / 危险词只记不点 / 表单不提交 / 预算超限即停——提前停是正常行为，
看快照里的 skipped 别当故障）。产物**只有一个**：`<PROFILES_ROOT>/draft/<domain>.json`
——采集快照在 `snapshot` 段：每页只含**可交互元素**（`interactive:true` 的 outline）与
`clickables`、结构线索（已剔 SVG 图元）与同源/JSON 响应体；跨页重复的站点框架归并进
`snapshot.chrome` 一份。知识字段为空待 agent 补。不存在独立的材料包/报告文件。

1. **读目录 → 读快照**：先看 draft 的 `digest` 段（各段规模）定盘子，再按需开 `snapshot.pages[0]`，不整文件吞读；并提一句超预算响应体带 `shape`+512B 样例

2. **圈功能清单**：路由簇（`limits.routes`）+ 导航类 clickables + 页标题交叉定主功能；
   `/legal`/`/blog`/营销页是噪音；登录墙路由记 pending 不强进；
   危险动作（保存/投递/支付）**只记 `flows`，永不代执行**。
3. **补知识字段**（写进 draft，全是数据不写代码）：
   - `dataEndpoints`：capture 里活跃的同源 JSON 接口——DOM 是骨架占位而接口有全量
     数据时优先记接口（比 DOM 稳）；
   - `fieldMap`：主取法优先语义属性（`[data-test=…]`），哈希 class 不可靠；字段埋在
     大文本里就写清"哪段文本 + 什么形态正则"；
   - `limits`：首屏条数、分页是否真有效（**必须实试，别信文档**）；
   - `antiScrape`：现象 + 触发 + 缓解 + 实测证据；`params`/`pageNotes`/`flows` 照填。
4. **汇报请人审**（功能清单 + 知识要点 + 覆盖率 + pending）；通过后把 draft 合并进
   画像根正式副本（`status: reviewed`），draft 留档；是否 git 提交由用户定。

#### 单功能补画像

1. `open` + `snapshot`，用功能词匹配链接文本/按钮 label/tab/placeholder；
   **匹配不到 → 带证据回问用户**（哪个页面、看到哪些候选），不猜；
2. 命中 → 只探这一条子树：`click-el` 进入、搜索类 `type-el` 填词提交、动作前后各
   `capture` 一次对比新增请求（动作触发的接口 = 该功能的数据源）；
3. 判数据源、把观察填进对应知识字段（同整站第 3 条）；
4. 已有正式画像 → 追加进画像根副本；没有 → 建 draft 走整站第 4 步人审。

### 发现顺序与故障转移

one-shot 按 `--session`/`WB_SESSION` 找会话桥 → 其它活桥（最新优先）→ 60s 直连慢路径；
找不到桥立即 `NO_BRIDGE`，不等待。daemon 被强杀留下的死条目下次发现时自动清理。

### 健康与恢复

- 桥活但扩展黑坑（MV3 SW 挂起）：`bridgeAlive:true + extension:null` → 跑 `doctor`。
- `doctor`：快查 → 礼貌等待 60s（探针端口 / 活桥 SW 重拨）→ 维护锁内协调硬刷。
  **多会话统一走 doctor，不要各自手杀浏览器**。
  硬刷默认只杀**本工具启动的** Edge（pid 记在 `data/edge.pid`）；要像旧版那样杀所有
  `msedge.exe`（会连带你自己正在用的窗口）必须显式 `--force-kill`。
  **硬刷只实现了 Edge**；用 Chrome 时其它命令照常工作，`doctor` 不会去重启 Chrome。

## 相关仓库

- [synapse](https://github.com/2948985750/synapse) — MV3 扩展与商店发布工具。
