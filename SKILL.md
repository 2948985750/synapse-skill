---
name: synapse-skill
display_name: 浏览器操控
display_name_en: Browser Control & Site Profiles
description: 驱动已运行、已登录的 Chrome/Edge（agent 启本机 WS 服务，扩展拨入调用 chrome.debugger 支持的 CDP 域）。用于读渲染 DOM、点选/输入、跑页内 JS、捕获页面自身 XHR/fetch 响应、复用登录态做网页自动化；已登录站点的发消息/外联/批量操作等任务优先走画像结晶动作。无 --remote-debugging-port、无 native messaging、无服务端。触发词：synapse、CDP、驱动浏览器、点选元素、捕获接口响应、复用登录态、网页版发邮件/发消息。
description_zh: Agent 可以在你已经登录的网站进行几乎任何操作，使用前需要先安装配套浏览器扩展，在浏览器地址栏输入此链接安装扩展：https://microsoftedge.microsoft.com/addons/detail/synapse/eiidjpnhaaiejgagkdanikjhbknmlplm
description_en: Requires the Synapse browser extension. Drives your logged-in Chrome/Edge to click, fill forms and capture API responses
version: 0.2.0
author: 凌惜
allowed-tools: Bash
examples_zh:
  - "用我电脑上已登录的账号，把这批商品的价格和库存批量改掉"
  - "打开后台，把昨天新增的订单导出成 Excel"
  - "批量打开这些链接，把正文和发布时间整理成一张表"
  - "用我登录着的网页版邮箱，把这封外联邮件发给对方（主题正文如下）"
examples_en:
  - "Update prices and stock for this product list using my already-logged-in account"
  - "Open the admin panel and export yesterday's new orders to Excel"
  - "Open these links and compile the article text and publish dates into one table"
  - "Send this outreach email from my logged-in webmail (subject and body below)"
---

# synapse-skill

可靠操作优先传完整元素条目（含 ref）或唯一定位器；需要证明业务完成时声明 waitFor。新增按区域/字段读取、输入与文件核对、显式上下文和视口操作的用法及边界见 `BROWSER-RELIABILITY.md`。这些能力不包含反爬或自动验证码处理，启用新命令前需重载配套扩展。

驱动已运行、已登录的 Chrome/Edge（agent 启动本机的 WS 服务，浏览器扩展拨入并透传
chrome.debugger 支持的 CDP 域）：读渲染 DOM、点选/输入、跑页内 JS、捕获页面自身 XHR/fetch 响应、复用
登录态做网页自动化。不启动新浏览器、不碰 profile、不伪造 cookie/请求头。

**前提**：浏览器已经开着——登录态在里面，扩展会主动拨入本机的 WS 服务。按**单用户
可信本机**设计（鉴权标识非密码，本机能运行代码的进程都可读），勿在多用户或存在不可信
进程的机器上运行。

**入口**：在 skill 根目录运行 `node agent/agent-collect.js <命令>`（命令清单见「命令」，
画像根位置见「怎么用」）。

## 有哪些功能

- **读渲染 DOM**：`collect-elements` 枚举可交互元素（索引化动作空间），`run` 执行任意页内 JS
- **点选与输入**：`click-el`/`type-el` 两个基础动词，加 13 个手势——悬停、双击、长按、
  右键、拖拽、滚动、下拉选、快捷键、触屏滑动、文本选中、媒体控制等（扩展 0.16.0+）
- **捕获接口响应**：`capture` 抓页面自身 XHR/fetch 的响应体（复用登录态，不重放）
- **站点画像**：`profiles/*.json` 纯数据——页面结构证据（`structure`/`capture`）+ 站点知识（`limits`/
  `antiScrape`/`pageNotes`）+ 已结晶 `actions`，可审阅可拷贝。元素清单不入库：agent 用 `collect-elements`/`run` 实时探活 DOM
- **复用已结晶动作**：画像里的 `actions` 两种形态——纯导航（title+url+guards）只做导航与就绪核验；带 `steps`/`verify` 的可按序重放交互（click/type/wait/navigate）并验证结果。护栏硬执行，风险步骤用 `ask` 标记、runner 停下来向用户提问（`--confirmed` 确认后继续）。外发/提交仍需用户授权，`--yes` 只放行 external，不证明业务完成。

所有操作经本机 WS 服务 + 扩展透传 CDP 执行；派发的是合成事件（`isTrusted:false`），
`cdp` 仅能调用 `chrome.debugger` 支持的 CDP 域与目标；`run` 受页面权限与浏览器限制。

## 怎么用

**链路前提**：所有命令经本机的 WS 桥透传给浏览器扩展执行。one-shot 会自动发现活桥
（未指定会话时按活桥顺序尝试，再回落直连）；指定 `--session`/`WB_SESSION` 时仅用该桥，失联报 `NO_BRIDGE`——这时要先起桥：
`node agent/agent-collect.js serve`（常驻前台、扩展 SW 会主动拨入；桥注册进
`data/bridges/`，后续命令毫秒级复用）。桥活着但扩展无响应（假死）→ 跑 `doctor`
（见「红线与排障」的「故障转移与健康」）。

### 用画像

已有该站画像、用户下达站点任务（"发个邮件""在 xx 站搜/发/改…"）时：

1. **查画像动作**：从任务里点名的站、`list` 里已开标签、已有的画像三者推断域名，
   读该域画像的 `actions`。画像根取 `node agent/agent-collect.js config` 的
   `profilesRoot.value`（**不要按默认路径硬编码**）。画像是本地纯 JSON，直接读文件，
   不占桥命令。语义匹配（如"发邮件"→`send-mail`）→ 走结晶快路径：先经统一入口
   `node agent/agent-collect.js actions <domain> <actionId> --param k=v … --dry` 核计划，
   缺参数**问用户要、不编**；外发类（`side_effect=external`）经用户确认后才加 `--yes`
   真跑。**纯导航 action**（无 steps）：runner 只检查页面加载与最终 URL，`ready:true,
   taskSucceeded:false` 仅代表入口就绪，不代表业务完成。**带 steps/verify 的 action**：runner
   按序重放交互并核验，`taskSucceeded:true` 代表 verify 全过；遇到 `ask` 步骤会 halt（exit 4）
   返回问题，向用户确认后加 `--confirmed` 重跑。跑完如实报告输出。查某域有哪些动作：
   `node agent/agent-collect.js actions <domain> list`（只列菜单，不读整个 JSON）。
2. **动作失败不硬重试**：exit 2（护栏拦截）——如实告知用户被什么拦了，别绕；
   exit 4（风险步待确认）——把 `ask` 问题转述给用户，同意后加 `--confirmed` 重跑，拒绝就停；
   exit 3（导航/执行失败）——即席接管完成本次任务（即席接管本身仍守「永不代执行」
   红线：保存/投递/支付/退出登录只给出入口和步骤，由用户手动做），成功后把跑通的
   步骤**回写**进该 action 的 `steps[]`（选择器漂移就更新选择器）——结晶修复循环。
3. **没有匹配动作**（`list` 菜单里没有对应标题派生的 id；直接调用时 runner exit 1 会附
   结晶指引）：即席执行（桥命令 + 画像知识）。**结晶步骤**：任务跑通并端到端验证后，
   把参数化步骤写进该画像 `actions[]`（写类只到就绪态，触发词进 `guards.never`）——让下次走快路径。是否结晶
   看任务性质：采集任务全功能都结晶（见下节），日常任务重复才结晶、一次性低价值不结晶。

### 采集画像

采集画像 = 程序出骨架（`runner/discover.js` 只读探针，产出 `pages[]` 证据骨架）+ agent 当场实操结晶（跑通的功能把操作序列参数化成 `steps`+`verify` 写进 `actions[]`）。**接到采集/结晶任务，先读本目录 `PROFILE-COLLECTION.md`**——全站采集流程、字段表、切分边界、结晶规约、steps 步骤机、verify 约束的完整版都在那里。

硬约束三条，采集全程适用：定位一律 `{sel}` 唯一选择器（query-el 多命中 AMBIGUOUS，结晶 verify 前实测匹配数==1）；写类只结晶到就绪态、提交动作挂 `ask`；禁区（支付/下单/账号安全）永不实操、记 `pending` 带入口。跑不通的进 `pending[]` 带原因；`actions[]`/`pending[]` 随采集当场写入、当场定稿。

### 红线与排障

**红线**：
- 保存/投递/支付类写操作**永不代执行**——只记录，由用户手动做。例外：画像里已结晶的
  `actions`（实测跑通后沉淀的声明式流程，纯数据）可经统一入口的 `actions` 子命令
  （`node agent/agent-collect.js actions <domain> <actionId> --param k=v …`）执行；
  外发类（`guards.side_effect=external`）真跑必须加 `--yes`，间隔/日上限/危险词黑名单
  由 runner 硬拦。
- 用画像执行任务时**不主动抓接口**：不额外跑 `capture` 分析页面 XHR/fetch。
  接口知识是**生产侧**的事，且**仅当用户点名要接口数据**（或 DOM 读不到、接口才是真
  数据源）时才采集——用户没提接口就别抓，别自作主张。

**已知坑**：
- CDP 键入必须用 `Input.dispatchKeyEvent type:"char"`（rawKeyDown 带 text 不落字）。
- CDP wheel 事件 **deltaX 不可省**（校验要求双全）；本桥 wheel 偶发整体超时，回退
  `run` `el.scrollBy(0,N)`。
- `run` 定位前置 IIFE 尾部 `()` **不可省**——漏掉时表达式求值为函数定义，桥回
  `{"type":"function","value":{}}` 取不到值。
- 合成 Ctrl+C 不进剪贴板；复制流随后 `run` `document.execCommand('copy')`。

**边界情况**（共性铁律：出错先跑 `diag` 取诊断，把原始错误和证据带给用户，不编造结果）：
- **页面未渲染**：collect-elements/run 结果空或偏少 → 等 1–2 秒重试，仍空 navigate 重载；别把"没加载"当"没功能"。
- **索引/标签失效**：索引只在当次有效，导航/刷新后重抓，`found:false` 或 label 漂移别猜；`No tab with given id` = 标签被关或浏览器重启，重 `list` 拿新 tabId。
- **CDP 超时**：`CDP_TIMEOUT` = 结果未知，禁止自动重发有副作用的操作；弹窗只记录不自动确认，处理按用户明确决定调 `Page.handleJavaScriptDialog`；关标签可能丢未保存内容，先告知。
- **登录墙**：请用户手动登录；不代填密码/验证码，不伪造 cookie。
- **反爬信号**（验证码/`_security_check`/429、5xx 频发）：停止重试、拉大间隔（≥2s）、带证据报告；不绕过验证码。
- **跨源 iframe**：主文档读不到用 `open-frame` 把子帧开成顶层标签。
- **懒加载/虚拟列表**：先滚动再 collect-elements；"加载更多"按文本找可点容器。
- **capture 时序**：只能抓会话开始后的请求——先开 capture（或 reload）再动作；`capture-many` 的 tabId 必须互不相同。
- **能力之外**（无头/批量多账号/绕风控/破付费）：直接说明做不到，给替代方案。

**故障转移与健康**：`--session`/`WB_SESSION` 严格限定目标桥（失联报 `NO_BRIDGE`，跨会话须显式 `--allow-failover`）；未指定按最新活桥尝试。多浏览器先核实 `diag.browserId`，用 `--browser-id` 固定（不匹配报 `BROWSER_MISMATCH`，业务命令不下发）；browserId 是本机路由标识非认证凭据。桥活扩展假死（`bridgeAlive:true + extension:null`）→ 跑 `doctor`：只诊断+轮询重连（默认 60s，`--force` 跳过等待，`--dry` 只快查），不杀进程不清缓存，超时报告人工步骤。状态原子写入+同 action 互斥锁；残留 `.lock` 先确认无动作运行再手工移除，不删画像。

## 命令

<!-- usage:start -->
| 命令 | 参数 | 用途 |
|---|---|---|
| `read-page` | `<tabId> ['<options-json>'\|@file]` | 按 scope 读取区域文本；maxChars 默认 4000；options 可传 contextId/sessionId。 |
| `wait-for` | `<tabId> '<condition-json>'\|@file` | 等待 locator 的 visible/hidden/attached/detached、text/value 或精确 url；默认 10 秒，超时不重复动作。 |
| `click-cdp` | `<tabId> <i\|el-json>` | 检查可见性、遮挡和位置稳定后发送 CDP 鼠标输入；失败不自动回退为 DOM 点击。 |
| `actions` | `<domain> <actionId\|list> [--param k=v ...] [--dry] [--yes] [--confirmed] [--timeout ms] [--session sid] [--browser-id id] [--allow-failover]` | 声明式动作（title+url+guards，可选 steps/verify）：纯导航只核验就绪（taskSucceeded:false）；带 steps 按 click/type/wait/navigate 逐步交互，verify 全过才 true。ask 步骤 exit 4 停下问用户，--confirmed 放行（一次一确认）；--dry 只打印计划；外发必须加 --yes。exit 1 用法 / 2 护栏 / 3 执行失败 / 4 待确认；list 列菜单 |
| `attach` | `<tabId>` | 手动把调试器附加到标签——桥执行命令时会自动 attach，这条只做排障用 |
| `capture` | `<tabId> <url\|reload\|wait> [--duration ms] [--filter <re>] [--body-max kb] [--all]` | 网络响应体捕获：触发导航/重载后抓该标签的 XHR/fetch 请求 + 响应体 |
| `capture-many` | `<tabId:action> [<tabId:action> ...] [--duration ms] [--filter <re>] [--body-max kb] [--all]` | 多标签并行网络捕获：不同 tab 各开一个 capture session，tabId 必须互不相同（同 tab + 同 client 的 capture session 互斥）；action 同 capture |
| `cdp` | `<tabId> <method> ['<params-json>'\|@file] [--param k=v ...]` | 任意 CDP 方法透传；@file 免 shell 引号，--param k=v 可追加/覆盖 params 里的键，JS 对象无序列化损耗；返回 CDP 原始回复，成功结果取 .result |
| `click-el` | `<tabId> <i\|el-json> [--label <text>]` | 支持快照完整条目（含 ref）或唯一定位器 {sel,scope}/{role,name}；优先传完整条目，避免同名元素重排误点 |
| `close` | `<tabId>` | 关闭标签页；discover 自管标签生命周期，这条一般只在手工交互时用 |
| `config` | `[set <key> <dir> \| reset]` | 显示数据目录与来源；config set data-root <dir> 指定数据根、config set output-dir <dir> 指定采集产物根、config set profile-root <dir> 指定画像根；config reset 清掉自定义路径回到默认。纯本地命令，无需连接扩展 |
| `dblclick-el` | `<tabId> <i\|el-json> [--label <text>]` | 按 collect-elements 索引双击：mousedown/up×2 + click(detail2) + dblclick；注意小红书/抖音等媒体卡片双击=点赞，此类站点慎用 |
| `detach` | `<tabId>` | 解除标签上的调试器，attach 之后想彻底释放用这条 |
| `diag` | `—` | 诊断快照：日志环形缓冲、最近弹窗记录、capture 会话状态——排障第一步 |
| `discover` | `--url <entry> [--dwell-ms 4000] [--settle-ms 2500] [--keep-tab] [--force] [--capture] [--session sid]` | 画像采集（单页结构快照）：只开入口页采结构探针+响应体；不冻结元素清单、不自动跟链接——选择器与页间跳转由 agent 实时探活补全。产物唯一：<PROFILES_ROOT>/<domain>.json（digest+顶层 pages[]+知识骨架）。--capture 默认关；--force 整文件重写（已结晶 actions 与知识字段丢失，先备份再跑） |
| `doctor` | `[--wait <ms>] [--force] [--dry]` | 只诊断与轮询活桥等待扩展重连（默认 60s），不杀进程、不清 profile 缓存、不重启浏览器；--force 跳过等待，--dry 只快查；--force-kill 已移除并会报错。超时报告需要人工检查目标会话与扩展 |
| `drag-el` | `<tabId> <from-i\|json> <to-i\|json>` | HTML5 拖放全序列（dragstart→dragenter/dragover→drop→dragend，带 DataTransfer）；from/to 均为 collect-elements 索引，目标 label 漂移会拒绝 |
| `focus-el` | `<tabId> <i\|el-json> [--label <text>]` | 聚焦元素（target.focus()）；返回值 active 表示是否成为当前 activeElement |
| `hover-el` | `<tabId> <i\|el-json> [--label <text>]` | 悬停（mouseover/mouseenter/mousemove）；用于悬停触发的下拉/气泡/懒加载 |
| `key-el` | `<tabId> <key> [<i\|el-json>] [--modifiers ctrl,shift\|0-15]` | 按键（异步；扩展 0.16.0+ 支持）；key=Enter/a/ArrowUp 等；省略 el 打到 document.body；--modifiers 逗号名单或位掩码（Alt1\|Ctrl2\|Meta4\|Shift8） |
| `list` | `—` | 列出所有标签页：tabId/标题/URL——一切后续命令的 tabId 从这里拿 |
| `longpress-el` | `<tabId> <i\|el-json> [--hold <ms>]` | 长按（异步；扩展 0.16.0+ 支持）；pointerdown/mousedown → 按住 hold 毫秒 → up；省略 --hold 默认 600ms；长按在部分站点弹上下文菜单/进多选 |
| `media-el` | `<tabId> <i\|el-json> [play\|pause\|mute\|unmute]` | 媒体控制（play/pause/mute/unmute）；缺省 play；目标是 <audio>/<video> 元素 |
| `navigate` | `<tabId> <url>` | 复用已有标签页导航到新 URL；默认等 load 完成，--nowait 跳过等待 |
| `open` | `<url>` | 开新标签页；默认等 load 完成，返回 loaded；--nowait 跳过等待 |
| `open-frame` | `<tabId> '<url-regex>'` | 把匹配的子帧开成顶层标签——跨源 iframe 内容回退 |
| `rightclick-el` | `<tabId> <i\|el-json> [--label <text>]` | 右键（contextmenu, button 2）；用于触发站点自定义上下文菜单 |
| `run` | `<tabId> '<js-expression>'` | Runtime.evaluate 跑页内 JS；默认 awaitPromise 等 promise 落定，--sync 不等；返回 CDP 包装 {result:{type,value}}，从 .result.value 取值 |
| `scroll-el` | `<tabId> [<i\|el-json\|{"sel":"css"}>] [--delta <px>] [--hscroll]` | 滚动：省略 el 做页面级滚动（target=document.body）；--hscroll 水平轴（轮播/可滚容器）；省略 --delta 则 into-view 滚入视口；el 可为 collect-elements 索引或 {"sel":"css"} 直接定位容器（overflow-x 的 div 不在 collect-elements 候选里） |
| `select-el` | `<tabId> <i\|el-json> <value>` | 给 <select> 选一个 option（value = option 的 value）；派发 change/input |
| `select-text-el` | `<tabId> <i\|el-json\|{"sel":"css"}> [text]` | 选中元素内文本（省略 text = 选全部；子串可跨 text-node）落入 selection；复制流随后 run `document.execCommand('copy')`（合成 Ctrl+C 不进剪贴板） |
| `serve` | `[session] [--shared]` | 常驻 bridge：持有 WS 端口 + 保活扩展 SW，注册 data/bridges/<session>.json；session 省略时自动生成并打印。one-shot 发现顺序：--session/WB_SESSION 指定桥 → 其它活桥（最新优先）→ 直连慢路径；多会话各起各的 serve 互不覆盖。--shared 额外写 data/bridge.json 兼容遗留脚本。Ctrl+C 退出 |
| `setfile` | `<tabId> <selector> <file-path> [file-path ...]` | 先检查本地普通文件，要求唯一 input[type=file]，赋值后核对 FileList；页面上传成功须另设等待条件 |
| `collect-elements` | `<tabId> [--max N]` | 枚举可交互元素 [{i,tag,role,label,ref}]；ref 绑定当前文档中的节点，失效时拒绝而不回退索引 |
| `status` | `—` | 有界健康探测：总时限 1.8 秒；多桥时逐个试连，任一桥可达即返回 |
| `swipe-el` | `<tabId> <from-i\|json> <to-i\|json\|sel-json>` | 触摸滑动（touchstart→touchmove×4→touchend）：移动端模拟/下拉刷新/触摸轮播；from/to 是 collect-elements 索引或 {"sel":"css"} |
| `touch-el` | `<tabId> <i\|el-json> [--label <text>]` | 合成触摸点按（touchstart/touchend）；面向触摸事件站点（桌面 Chrome 主要靠合成事件驱动触屏逻辑） |
| `type-el` | `<tabId> <i\|el-json> <text> [--clear] [--label <text>]` | 按索引键入，兼容受控组件（native value setter + input/change 事件）；--clear 先清空；<i> 来自 collect-elements 条目，旧的完整 JSON 写法仍兼容 |

- 选项: --wait <ms>  --keep  --max <N>  --clear  --label <text>  --param k=v  --sync  --nowait  --client-id <id>  --trigger-js <expr>  --session <sid>  --browser-id <id>  --allow-failover  --shared  --force  --dry  --hold <ms>  --delta <px>  --modifiers <ctrl,shift|0-15>  --hscroll
- 目标选择: --session/WB_SESSION 严格限定会话，失联报 NO_BRIDGE；只有 --allow-failover 显式允许跨会话。--browser-id/WB_BROWSER_ID 在业务命令前校验 diag.browserId，不匹配报 BROWSER_MISMATCH；--keep 注册临时会话桥。browserId 仅用于本机路由校验，不是身份认证凭据
<!-- usage:end -->
