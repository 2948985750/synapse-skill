# PROFILE-COLLECTION：采集画像运行时细则

SKILL.md「采集画像」入口指向这里。**接到采集/结晶任务时读本文件**；全站采集流程、字段表、
切分边界、结晶规约、steps 步骤机、verify 约束的完整版都在本文。日常执行任务（用画像路径）
不需要本文。红线与安全约束以 SKILL.md「红线与排障」为准，本文只讲采集细则。

## 采集画像总纲

采集画像 = 程序出骨架 + agent 当场实操结晶：`runner/discover.js` 是只读探针，产出页面证据骨架（`pages[]`）写到画像根 `<domain>.json`（路径见文末）；agent 随即拿骨架把每个功能逐个实操，跑通的功能当场把操作序列参数化成 `steps`+`verify` 结晶进 `actions[]`。骨架是实操的输入，steps 就是这轮实操的结构化记录。

**硬约束三条，采集全程适用**：定位一律 `{sel}` 唯一选择器（query-el 多命中 AMBIGUOUS，结晶 verify 前实测匹配数==1）；写类只结晶到就绪态、提交动作挂 `ask`；禁区（支付/下单/账号安全）永不实操、记 `pending` 带入口。

## 全站采集流程

（agent 拿到骨架后按此顺序推进；全程实时探活 DOM，不依赖采集瞬间冻结的元素）

1. **判站**：打开入口页先确定这是个什么站、主要用来干什么——电商搜索 / 内容社区 / 企业信息查询 / 工具站 / 后台管理……依据页标题、URL 路由、`pages[].structure` 的 forms/lists、可见文本。判站用来定采集边界：划出核心主功能，`/legal`、`/blog`、营销页这类噪音排除；排除清单写进顶层 `excluded`（没有就建），不静默丢弃。
2. **圈功能清单**：`list` 拿入口 tabId → `collect-elements` 全量枚举可交互元素，配合 structure 与页标题交叉确认，按用户意图把交互点归组成功能清单（搜索、筛选、查看详情、登录、发布……）。每个功能先分档再排期：**读类**（浏览/搜索/查看）实操结晶；**写类**（发布/编辑/发消息）只走到就绪态、提交动作挂 `ask`；**禁区**（支付/下单/账号安全类：改密、注销、退出登录）永不实操、记 `pending` 带入口。登录墙后的路由一律记 `pending` 不强进。
3. **逐功能实操并结晶**，每个功能走同一个循环：① 定位入口；② `collect-elements` 枚举该功能的交互点；③ 交互（`click-el`/`type-el`/`click-cdp`/`scroll-el`/`key-el`）——定位一律优先 `{sel}` 唯一选择器，索引/ref 只在当次有效且 label 会漂移（热词轮换/动态 feed 实测即过期），漂移就重抓、不对旧引用硬试；④ 观察效果：落点 URL、页标题、DOM 变化（`run` 查 `location.href`/关键元素）；⑤ 定 verify 条件——先用 `run` 实测候选 sel 在落点页的匹配数必须 ==1（多命中报 AMBIGUOUS 且被 verify 当不存在静默轮询到超时），URL 直接承载结果的优先 url 模板直达，页内交互才上 steps；⑥ 回写：跑通当场参数化成 `steps`+`verify` 写进 `actions[]` 带 `verified`，跑不通进 `pending[]` 带原因和证据。采集期顺 url 观测补 `limits.routes`、坑写 `pageNotes`；确需保存某页结构证据才追加 `pages[]`（同步 `digest.pages`）。
4. **汇报请人审**：功能清单逐条交代去向（结晶/pending/excluded），覆盖率=结晶数/读类功能总数，附知识要点与 `pending`，是否 git 提交由用户定。

## 一条 action 的边界——按用户意图切分

一条 `action` 对应一个能独立完成、单独验证的用户意图。切分标准是"用户会不会只要这一步的结果"：

- 能单独触发、单独出结果的功能，各自单独成条。
- 只有 A、B 必须连着做才能达成某个结果、且用户不会只要其中一步时，才把 A→B 放进同一条 `steps`。
- 前一步的产物是后一步的入口时（如搜索结果页是筛选的入口），用 url 模板衔接（筛选 action 的 `url` 写成 `/search?q={q}` 承接搜索结果），把两步拆成两条 action，各自独立可复用。
- 某功能只是已有 action 的参数特例时（如"分类导航"=预置关键词的搜索页），不独立成条——由被复用的 action 覆盖，归并关系写进 `pageNotes`。
- 例：搜索（输入词→点搜索→出结果）和"搜索结果 + 筛选"是两件事——用户常只要搜索结果，筛选是结果页上的另一个操作。结晶成两条独立 action：`搜索关键词`（`url: /search?q={q}`）与 `筛选结果`（`url` 承接搜索结果页），各自可单独触发、单独验证。

## 画像字段表

下表按"这个字段代表什么事实、起什么作用"来写，取值和结构是次要细节。字段结构是开放的：agent 可按需新增顶层字段（真实画像里已有 `anti_bot` /
`pace_ms` / `coverage` / `scope` / `verifiedActions` / `excluded` / `automationSupport` /
`topicEvidence` 等），读取时以实际画像为准。

| 属性 | 代表什么 | 取值 / 结构 | 谁填 |
|---|---|---|---|
| `domain` | 这份画像属于哪个网站——画像的身份标识 | 入口 URL 的主机名去掉 `www.`（`www.goofish.com` → `goofish.com`）；同时是文件名 `<domain>.json` 和 `actions <domain>` 查询时的键 | 程序 |
| `digest` | 盘子多大——不读整份 JSON 就能判断要不要深挖 | 由 `pages` 统计：`pages` 页数、`forms`/`lists` 表单/列表数、`responseBodies:{returned,bytesKb}` 响应体条数与体积、`snapshotKb` 快照大小（字段名历史遗留，值按 pages 序列化长度算）。体积按字符数估算，非精确字节。元素清单已移除，不再统计 interactive/clickables | 程序 |
| `createdAt` | 采集日期 | `YYYY-MM-DD`（UTC，采集当天） | 程序 |
| `access` | 从哪个 URL 进、入口有没有登录墙 | `entryUrl` 入口 URL；`login.required` 入口探测到登录墙或有因鉴权跳过的页；`login.note` 备注（默认串"由 discover 运行观察得出"）。agent 可改写，如已有登录态时把 `required` 改成 `null` 并加 `observedAuthenticatedSession` | 程序起头，agent 可改写 |
| `limits` | 这个站点能用多少、不能超多少——站点边界知识 | 程序给起点 `{pagesVisited,routes,note}`（单页采集、路由未自动跟）；agent 重写成实测限制，如上传时长/大小、字数上限、每日发布上限、分页是否真有效（必须实试） | 程序起头，agent 补 |
| `antiScrape` | 这个站点的反爬现象：什么触发、怎么缓解、证据 | 数组，程序给空。真实画像当前都为空；goofish 把反爬判断写在顶层自定义字段 `anti_bot` | 程序起头，agent 补 |
| `pageNotes` | 各页面的观察笔记和字段定位线索：某字段在哪、怎么取、有什么坑 | 数组，元素结构不固定——goofish 存纯字符串，creator 存 `{page,note}`。定位优先语义属性（`[data-test=…]`），哈希 class 不可靠 | agent |
| `actions` | 已跑通验证、下次可直接复用的动作（纯导航或带 steps 的交互链） | 数组，元素结构不固定。核心是 `title` + `url`（可含 `{param}` 模板）+ `guards`；可选 `steps[]`（click/type/wait/navigate，带 `ask` 标记风险步）+ `verify[]`（text/exists/navigate）。goofish 另带 `id`/`verified`/`on_fail`/`side_effect`，creator 只带前三者 | agent |
| `pending` | 验证失败或未验证的功能，带原因，提示用户介入时能做什么 | 数组，元素结构不固定，如 `{feature,reason,evidence,action_when_*}` 或 `{feature,reason,next}` | agent |
| `pages` | 采集到的页面原始证据——agent 补全知识的依据 | 数组，discover 产物每项有 `url` / `requestedAt` / `title` / `finalUrl` / `loginWall` / `structure` / `capture`。`structure.lists` 只留 `count`+`sample`（哈希 class 签名改版即变、无法定位，不存）。扁平挂在画像顶层，无 `snapshot` 包装层，也不存元素清单（outline/clickables）——agent 用 `collect-elements`/`run` 实时探活 DOM，跑通的操作直接结晶进 `actions[].steps`。程序只采入口页，后续页由 agent 交互观测追加（默认进 `limits.routes`/`pageNotes`） | 程序 |

`pages[]` 是程序产出的结构；agent 加工后会增删键（creator 的 page 加了 `observedAt` / `verifiedLabel`，去掉了
`requestedAt` / `finalUrl` / `loginWall`），读取以实际画像为准。`capture` 键始终存在，
没抓到内容时为 `null`，"仅 --capture"指的是有内容，不是有这个键。

读法：先看 `digest` 定规模，再按需开 `pages[]` 与 `capture`；超预算响应体看
`shape` + 512B 样例即可，不整文件吞读。

## 结晶规约

**结晶规约**（写进 `actions[]`/`pending[]` 的细节），按「圈功能清单」步骤的分档落位：**读类**完整结晶——`steps`+`verify`+`verified`（日期:短证据）+`on_fail`，能 url 模板直达的就不上 steps；**写类**只结晶到就绪态——导航/填表可进 `steps`，提交/发送/保存挂 `ask`+触发词进 `guards.never`，走不到就绪态整条进 `pending[]`；**禁区**永不实操，`pending[]` 带入口与 `action_when_user`。跑不通的进 `pending[]` 带原因。`actions[]`/`pending[]` 随采集当场写入、当场定稿。字段定位写在 `pageNotes` 或 `actions[].on_fail`；画像只存数据，不存可执行代码。

## actions 的 steps 步骤机

（可选，把重放价值高的交互链沉淀成数据）：`url` 仍是入口，先导航核验就绪；
`steps[]` 按顺序执行，每步 `do` ∈ `click`/`type`/`wait`/`navigate`：

- `click`/`type` 靠 `sel`（CSS 选择器）；`type` 另需 `value`（可用 `{param}` 模板）+ 可选 `mode`
  （`native`/`native-enter`/`execCommand`）；`click` 可选 `mode:cdp`（合成点击无效时用真鼠标）。
- `wait` 用 `ms` 或 `sel`；`navigate` 用 `url`。
- 每步可选 `unless`（选择器已存在则跳过，幂等）、`timeout`（单步超时）、`note`。
- **`ask`**：标了 `ask:"问用户的话"` 的步骤，runner 执行到此前停住、以 exit 4 返回问题，
  用户明确同意后加 `--confirmed` 重跑才继续。写类/外发/不可逆操作必须挂 `ask`，配合
  `guards.never` 双保险——runner 不替用户做风险决策。

`verify[]` 全过才算 `taskSucceeded:true`：`{op:text,expect}` / `{op:exists,sel}` / `{op:navigate,hash}`。
两条约束：`verify` 必须与 `steps` 成对（纯导航 action 不接受 verify——想验证导航直达的就绪态，加一个
`wait` 步再配 `verify`）；`{sel}` 必须唯一匹配（query-el 多命中报 AMBIGUOUS 且被 verify 静默轮询到
超时——结晶前实测匹配数，宽了用 `:not()`/结构限定收窄）。

交互原语全部走扩展桥命令（query-el/click-el/type-css/wait-for/goto-hash），skill 侧不构造页内 JS。
steps 的唯一来源是"实操跑通的那一次"：采集期逐功能实操就是主要结晶点；日常执行碰到没结晶过的
动作，跑通端到端后再补写。steps 是跑通路径的缓存，不是预先维护的程序。

## 产物位置

画像根 `<domain>.json`，由 `config` 输出的 `profilesRoot` 定位（默认
`<SKILL_ROOT>/profiles/`）；只有 `config set profile-root` 或 `WB_PROFILES_DIR` 能重定位。
读取侧同理。本机安装位是 junction（`~/.zcode/skills/synapse-skill` → 源码仓），画像直接落源码仓 `profiles/`。
