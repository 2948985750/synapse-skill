---
name: synapse-skill
display_name: 浏览器操控
display_name_en: Browser Control & Site Profiles
description: 驱动已运行、已登录的 Chrome/Edge（agent 启本机 WS 服务，扩展拨入透传全量 CDP）。用于读渲染 DOM、点选/输入、跑页内 JS、捕获页面自身 XHR/fetch 响应、复用登录态做网页自动化；已登录站点的发消息/外联/批量操作等任务优先走画像结晶动作。无 --remote-debugging-port、无 native messaging、无服务端。触发词：synapse、CDP、驱动浏览器、点选元素、捕获接口响应、复用登录态、网页版发邮件/发消息。
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

驱动已运行、已登录的 Chrome/Edge（agent 启动本机的 WS 服务，浏览器扩展拨入并透传
全量 CDP）：读渲染 DOM、点选/输入、跑页内 JS、捕获页面自身 XHR/fetch 响应、复用
登录态做网页自动化。不启动新浏览器、不碰 profile、不伪造 cookie/请求头。

**前提**：浏览器已经开着——登录态在里面，扩展会主动拨入本机的 WS 服务。按**单用户
可信本机**设计（鉴权标识非密码，本机能运行代码的进程都可读），勿在多用户或存在不可信
进程的机器上运行。

**入口**：在 skill 根目录运行 `node agent/agent-collect.js <命令>`（命令清单见「命令」，
画像根位置见「怎么用」）。

## 有哪些功能

- **读渲染 DOM**：`snapshot` 枚举可交互元素（索引化动作空间），`run` 执行任意页内 JS
- **点选与输入**：`click-el`/`type-el` 两个基础动词，加 13 个手势——悬停、双击、长按、
  右键、拖拽、滚动、下拉选、快捷键、触屏滑动、文本选中、媒体控制等（扩展 0.16.0+）
- **捕获接口响应**：`capture` 抓页面自身 XHR/fetch 的响应体（复用登录态，不重放）
- **站点画像**：`profiles/*.json` 纯数据——元素快照 + 站点知识（`fieldMap`/`limits`/
  `antiScrape`/`dataEndpoints`）+ 已结晶 `actions`，可审阅可拷贝
- **录制/复用action**：已登录站点的重复任务（发邮件/批量改价/导出）跑画像里的
  `actions`，外发类由护栏硬拦、真跑必须 `--yes`

所有操作经本机 WS 服务 + 扩展透传 CDP 执行；派发的是合成事件（`isTrusted:false`），
只认受信输入的站点用通用通道 `cdp`（全 CDP 域）或 `run`（全 JS）兜底。

## 怎么用

**链路前提**：所有命令经本机的 WS 桥透传给浏览器扩展执行。one-shot 会自动发现活桥
（会话桥 → 其它活桥 → 60s 直连慢路径），全失败报 `NO_BRIDGE`——这时要先起桥：
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
   真跑，跑完把 runner 输出如实转述。查某域有哪些动作：
   `node agent/agent-collect.js actions <domain> list`（只列菜单，不读整个 JSON）。
2. **动作失败不硬重试**：exit 2（护栏拦截）——如实告知用户被什么拦了，别绕；
   exit 3（执行/验证失败）——即席接管完成本次任务（即席接管本身仍守「永不代执行」
   红线：保存/投递/支付/退出登录只给出入口和步骤，由用户手动做），成功后把跑通的
   参数化步骤**回写**进该 action（更新 url 里的选择器/参数模板）——结晶修复循环。
3. **没有匹配动作**（`list` 菜单里没有对应标题派生的 id；直接调用时 runner exit 1 会附
   结晶指引）：即席执行（桥命令 + 画像知识）。**结晶步骤**：任务跑通并端到端验证后，
   把参数化步骤写进该画像 `actions[]`（只保留 `title` + `url`（可含 `{param}` 模板）+
   可选 `guards`；写类只到就绪态，触发词进 `guards.never`）——让下次走快路径。是否结晶
   看任务性质：采集任务全功能都结晶（见下节），日常任务重复才结晶、一次性低价值不结晶。

### 采集画像

用户说「采集 xx 站」「补全 xx 站画像」「把所有站画像跑一遍」时：

**怎么启动**（采集与结晶都走统一 CLI 子命令）：

- 整站采集：`node agent/agent-collect.js discover --url https://site.com --session <sid>`——**只开入口页**
  取单页富快照（全部可交互元素，**含 SPA 跳转容器**：cursor:pointer/onClick/role=link，
  不止 `<a>`；+ 结构 + 同源/JSON 响应体）。**不自动跟链接翻页**：页间跳转 / 路由发现
  由 LLM 交互观测补全（`click-el` 触发 → 观察 `location` 变化 → 记进画像知识）。
  产物落画像根 `draft/<domain>.json`（知识字段空着等 agent 补）；
- 单功能补画像：不用 discover，直接 `open` + `snapshot` 即席（桥命令，见本节
  「单功能补画像」）；
- 执行已结晶动作：`node agent/agent-collect.js actions <domain> <actionId> --param k=v …`
  （消费侧，见「用画像」）。

**完成标准（强制行为，不是可选项）**：出 draft ≠ 采集完成。收到 draft 后 LLM **必须**对
功能清单逐项做交互实验（点跳转容器 → 观测 location/新面板/新请求 → 端到端验证），验证
通过的读类功能**必须**结晶进 `actions[]`；写类功能停在就绪态（触发词进 `guards.never`）；
验证不了的进 `pending[]`（带原因 + 证据）。`actions[]` 为空且没有 `pending[]` 说明 =
**采集未完成**，不得汇报为完成；汇报必须附功能覆盖率表（已结晶 / pending / 不覆盖）。

1. **先圈全功能清单**：discover 产出后，把路由、clickables、页标题三者交叉比对，
   把站点**所有**功能圈进来（读类：搜索/浏览/详情/作者/会话…；写类：发送/投递/发布/
   私信/下单…），登录墙/危险路由记录不强进。
2. **每个功能即席交互到端到端验证，通过才结晶进 `actions[]`**（`verified` 带日期与证据、
   `on_fail`、`guards` 含 never）。**覆盖单位是"功能"不是"一条链"**——只做了搜索链、
   没做浏览/详情/作者 = 采集未完成；写类/外发功能**只走到不可逆步骤前**：执行到
   「就绪态」（写信窗打开/表单填好/入口验证过）即止并验证，最终触发词记进
   `guards.never`、永不代点（见「红线与排障」）。
3. **验证不了的功能进 `pending[]`**（原因 + 证据 + `action_when_*` 提示），不静默跳过；
   反爬信号（CF/验证码/429）立即停记不硬闯；同站点间动作串行、导航间隔 ≥3s，多站点可并行。
4. **汇报以功能清单为基准**：每个功能标「已结晶 / pending(原因) / 不覆盖(原因)」，
   请人审时给覆盖率；git 提交与否由用户定。

**知识字段**（站点知识，纯描述数据，不写采集逻辑）：`fieldMap` 主取法
优先语义属性（`[data-test=…]`），哈希 class 不可靠；`limits` 记首屏条数与分页是否真有效
（**必须实试，别信文档**）；`antiScrape` 记现象/触发/缓解/实测证据。

**接口记录**（仅在用户点名要接口数据、或 DOM 读不到必须采集时才记；默认不记）：
`interfaces` 为数组，每条只留两个键——`url`（接口地址）+ `for`（中文用途说明，如"通
知列表，count=20"）。**不记**：GraphQL hash、完整参数串、响应体、请求头。hash 会随版
本漂，记了就是噪音；用途一句话说明白就够。

**读 draft 两步协议**：先读顶层 `digest`（各段规模，~10 行）定盘子，再按需开 `snapshot`/
`capture` 段；超预算响应体看 `shape` + 512B 样例即可，不整文件吞读。

**单功能补画像**

1. `open` + `snapshot`，用功能词匹配链接文本/按钮 label/tab/placeholder；
   **匹配不到 → 带证据回问用户**（哪个页面、看到哪些候选），不猜；
2. 命中 → 只探这一条子树：`click-el` 进入、搜索类 `type-el` 填词提交、验证渲染。
   **接口默认不采集**：`capture` 只在用户点名「要接口数据」、或 DOM 读不到（shadow DOM/
   接口才是真数据源）时才跑，跑一次定位数据源即停；跑通靠 DOM 的功能不挂 capture；
3. 判数据源、把观察填进对应知识字段（字段条目见上「知识字段」），**并把这个功能的
   交互链结晶进画像 `actions[]`**（`verified` 带日期与证据；写类停就绪态、触发词进
   `guards.never`；结晶不了进 `pending[]` 带原因）；
4. 已有正式画像 → 追加进该画像；没有 → 建 draft 请人审后合并进正式副本。

**产物位置**：加工与结果全部写入画像根（`config` 输出的 `profilesRoot`，默认
`<SKILL_ROOT>/profiles/`）下的 `draft/<domain>.json`；只有 `config set profile-root` 或
`WB_PROFILES_DIR` 能整体重定位。读取侧同理：正式画像在画像根 `<domain>.json`，`draft/`
只留档。本机安装位是 junction（`~/.zcode/skills/synapse-skill` → 源码仓），所以画像直接
落源码仓 `profiles/`。

### 红线与排障

**红线**：
- 保存/投递/支付类写操作**永不代执行**——只记录，由用户手动做。例外：画像里已结晶的
  `actions`（实测跑通后沉淀的声明式流程，纯数据）可经统一入口的 `actions` 子命令
  （`node agent/agent-collect.js actions <domain> <actionId> --param k=v …`）执行；
  外发类（`guards.side_effect=external`）真跑必须加 `--yes`，间隔/日上限/危险词黑名单
  由 runner 硬拦。
- 用画像执行任务时**不主动抓接口**：不额外跑 `capture` 分析页面 XHR/fetch。
  接口知识是**生产侧**的事，且**仅当用户点名要接口数据**（或 DOM 读不到、接口才是真
  数据源）时才采集——用户没提接口，画像里就不留 `dataEndpoints`，别自作主张。

**已知坑**：
- CDP 键入必须用 `Input.dispatchKeyEvent type:"char"`（rawKeyDown 带 text 不落字）。
- CDP wheel 事件 **deltaX 不可省**（校验要求双全）；本桥 wheel 偶发整体超时，回退
  `run` `el.scrollBy(0,N)`。
- `run` 定位前置 IIFE 尾部 `()` **不可省**——漏掉时表达式求值为函数定义，桥回
  `{"type":"function","value":{}}` 取不到值。
- 合成 Ctrl+C 不进剪贴板；复制流随后 `run` `document.execCommand('copy')`。

**边界情况**：
- **页面未渲染完**：snapshot/run 结果为空或明显偏少 → 等 1–2 秒重试，仍空就 navigate
  重载一次；不要把"没加载出来"当作"没有功能"。
- **索引失效**：snapshot 的索引只在当次有效；导航/刷新/页面更新后必须重新 snapshot。
  click-el/type-el 返回 `found:false` 或 label 漂移时重抓索引，不要猜。
- **标签失效**：`No tab with given id` = 标签被关或浏览器重启过——重 `list` 拿新 tabId，
  别对着旧 id 硬试（标签是动态的，测试期间也可能被用户关掉）。
- **页面卡死**：snapshot/run 报 `Runtime.evaluate timed out twice`——先试
  `cdp <tabId> Page.handleJavaScriptDialog '{"action":"dismiss","accept":false}'` 关弹窗；
  若回 `No dialog is showing` 则是主线程卡死（非 JS 弹窗），唯一恢复：`close` + `open`
  重开标签。
- **登录墙/登录过期**：出现登录表单或跳转登录页 → 请用户手动登录；不代填密码/验证码，
  不伪造 cookie。
- **反爬信号**（验证码、`_security_check`、429/5xx 频发）：停止重试、拉大间隔（≥2s），
  带证据报告；不尝试绕过验证码。
- **跨源 iframe**：主文档读不到内容时用 `open-frame` 把匹配的子帧开成顶层标签再操作。
- **懒加载/虚拟列表**：只渲染可视区 → 先滚动再 snapshot；"加载更多"按文本找可点容器。
- **capture 抓不到请求**：只能抓会话开始后触发的请求；先开 capture（或 reload）再执行
  动作，最后 wait。
- **多标签抓包**：`capture-many` 的 tabId 必须互不相同；同 tab 同 client 的 capture 会话互斥。
- **能力之外**（无头运行、批量多账号、绕过验证码/风控、破解付费内容）：直接说明做不到，
  给替代方案。
- **出错时**：先跑 `diag` 取诊断，把原始错误和证据带给用户；不编造结果。

**故障转移与健康**：
one-shot 按 `--session`/`WB_SESSION` 找会话桥 → 其它活桥（最新优先）→ 60s 直连慢路径；
找不到桥立即 `NO_BRIDGE`，不等待。daemon 被强杀留下的死条目下次发现时自动清理。
- 桥活但扩展假死：`bridgeAlive:true + extension:null` → 跑 `doctor`。
- `doctor`：快查 → 礼貌等待 60s（探针端口 / 活桥 SW 重拨）→ 维护锁内协调硬刷。
  **多会话统一走 doctor，不要各自手杀浏览器**。硬刷默认只杀**本工具启动的** Edge
  （pid 记在 `data/edge.pid`）；要像旧版那样杀所有 `msedge.exe`（会连带你自己正在用的
  窗口）必须显式 `--force-kill`。**硬刷只实现了 Edge**：用 Chrome 时 `doctor` 不重启
  Chrome，其它命令照常。

## 命令

<!-- usage:start -->
| 命令 | 参数 | 用途 |
|---|---|---|
| `actions` | `<domain> <actionId\|list> [--param k=v ...] [--dry] [--yes] [--draft] [--timeout ms] [--session sid]` | 执行结晶动作（纯数据解释器，消费侧快路径）：--dry 只打印计划永不执行；外发类（side_effect=external）真跑必须加 --yes；间隔/日上限/危险词黑名单由 runner 硬拦；list 列该域动作菜单；exit 0 成功 / 1 用法校验 / 2 护栏拦截 / 3 执行验证失败（agent 即席接管 + 结晶回写点） |
| `attach` | `<tabId>` | 手动把调试器附加到标签——桥执行命令时会自动 attach，这条只做排障用 |
| `capture` | `<tabId> <url\|reload\|wait> [--duration ms] [--filter <re>] [--body-max kb] [--all]` | 网络响应体捕获：触发导航/重载后抓该标签的 XHR/fetch 请求 + 响应体 |
| `capture-many` | `<tabId:action> [<tabId:action> ...] [--duration ms] [--filter <re>] [--body-max kb] [--all]` | 多标签并行网络捕获：不同 tab 各开一个 capture session，tabId 必须互不相同（同 tab + 同 client 的 capture session 互斥）；action 同 capture |
| `cdp` | `<tabId> <method> ['<params-json>'\|@file] [--param k=v ...]` | 任意 CDP 方法透传；@file 免 shell 引号，--param k=v 可追加/覆盖 params 里的键，JS 对象无序列化损耗；返回 CDP 原始回复，成功结果取 .result |
| `click-el` | `<tabId> <i\|el-json> [--label <text>]` | 按 snapshot 索引点击；--label 参与漂移校验（索引越界/label 变了会拒绝执行） |
| `close` | `<tabId>` | 关闭标签页；discover 自管标签生命周期，这条一般只在手工交互时用 |
| `config` | `[set <key> <dir> \| reset]` | 显示数据目录与来源；config set data-root <dir> 指定数据根、config set output-dir <dir> 指定采集产物根、config set profile-root <dir> 指定画像根；config reset 清掉自定义路径回到默认。纯本地命令，无需连接扩展 |
| `dblclick-el` | `<tabId> <i\|el-json> [--label <text>]` | 按 snapshot 索引双击：mousedown/up×2 + click(detail2) + dblclick；注意小红书/抖音等媒体卡片双击=点赞，此类站点慎用 |
| `detach` | `<tabId>` | 解除标签上的调试器，attach 之后想彻底释放用这条 |
| `diag` | `—` | 诊断快照：日志环形缓冲、最近弹窗记录、capture 会话状态——排障第一步 |
| `discover` | `--url <entry> [--dwell-ms 4000] [--settle-ms 2500] [--keep-tab] [--force] [--session sid]` | 整站盘点（画像采集，单页富快照）：只开入口页，采全部可交互元素（含 SPA 跳转容器：cursor:pointer/onClick/role=link，不止 <a>）+ 结构 + 同源/JSON 响应体；不自动跟链接翻页——页间跳转/路由由 LLM 交互观测补全；产物唯一：<PROFILES_ROOT>/draft/<domain>.json；--force 覆盖已有 draft（整文件重写：已结晶的 actions 与知识字段一并丢失，先备份再跑） |
| `doctor` | `[--wait <ms>] [--force] [--force-kill] [--dry]` | 链路医生 + 多会话协调恢复：快查 → 礼貌等待 SW 重拨（探针端口/活桥，默认 --wait 60s）→ 锁协调硬刷（data/maintenance.lock.json，同一时刻只有一个会话执行 taskkill+清缓存+重启 Edge，排上的会话等锁释放后复查健康）。多会话恢复统一走 doctor，不要各自手杀 Edge；--force 跳过等待，--dry 只打印计划 |
| `drag-el` | `<tabId> <from-i\|json> <to-i\|json>` | HTML5 拖放全序列（dragstart→dragenter/dragover→drop→dragend，带 DataTransfer）；from/to 均为 snapshot 索引，目标 label 漂移会拒绝 |
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
| `scroll-el` | `<tabId> [<i\|el-json\|{"sel":"css"}>] [--delta <px>] [--hscroll]` | 滚动：省略 el 做页面级滚动（target=document.body）；--hscroll 水平轴（轮播/可滚容器）；省略 --delta 则 into-view 滚入视口；el 可为 snapshot 索引或 {"sel":"css"} 直接定位容器（overflow-x 的 div 不在 snapshot 候选里） |
| `select-el` | `<tabId> <i\|el-json> <value>` | 给 <select> 选一个 option（value = option 的 value）；派发 change/input |
| `select-text-el` | `<tabId> <i\|el-json\|{"sel":"css"}> [text]` | 选中元素内文本（省略 text = 选全部；子串可跨 text-node）落入 selection；复制流随后 run `document.execCommand('copy')`（合成 Ctrl+C 不进剪贴板） |
| `serve` | `[session] [--shared]` | 常驻 bridge：持有 WS 端口 + 保活扩展 SW，注册 data/bridges/<session>.json；session 省略时自动生成并打印。one-shot 发现顺序：--session/WB_SESSION 指定桥 → 其它活桥（最新优先）→ 直连慢路径；多会话各起各的 serve 互不覆盖。--shared 额外写 data/bridge.json 兼容遗留脚本。Ctrl+C 退出 |
| `setfile` | `<tabId> <selector> <file-path>` | 给 input[type=file] 塞本地文件，走 CDP DOM.setFileInputFiles |
| `snapshot` | `<tabId> [--max N]` | 索引化动作空间：枚举可交互元素 [{i,tag,role,label}] |
| `status` | `—` | 有界健康探测：总时限 1.8 秒；多桥时逐个试连，任一桥可达即返回 |
| `swipe-el` | `<tabId> <from-i\|json> <to-i\|json\|sel-json>` | 触摸滑动（touchstart→touchmove×4→touchend）：移动端模拟/下拉刷新/触摸轮播；from/to 是 snapshot 索引或 {"sel":"css"} |
| `touch-el` | `<tabId> <i\|el-json> [--label <text>]` | 合成触摸点按（touchstart/touchend）；面向触摸事件站点（桌面 Chrome 主要靠合成事件驱动触屏逻辑） |
| `type-el` | `<tabId> <i\|el-json> <text> [--clear] [--label <text>]` | 按索引键入，兼容受控组件（native value setter + input/change 事件）；--clear 先清空；<i> 来自 snapshot 条目，旧的完整 JSON 写法仍兼容 |

- 选项: --wait <ms>  --keep  --max <N>  --clear  --label <text>  --param k=v  --sync  --nowait  --client-id <id>  --trigger-js <expr>  --session <sid>  --shared  --force  --force-kill  --dry  --hold <ms>  --delta <px>  --modifiers <ctrl,shift|0-15>  --hscroll
- 多会话变量: WB_SESSION=<sid>（本会话 one-shot 优先走 data/bridges/<sid>.json）；--keep 也会注册为临时会话桥（注册表条目 + 允许多客户端），供同会话后续 one-shot 毫秒级复用
<!-- usage:end -->
