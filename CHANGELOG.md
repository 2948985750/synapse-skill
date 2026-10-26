# 变更记录

本文件专门记录**修复过的问题**（不只是功能变更），每条写清：现象 / 根因 / 修法 / 提交。
目的：以后回看时能知道「代码为什么长这样」，而不是只看到一堆 diff。

浏览器扩展在本仓库之外：[synapse](https://github.com/2948985750/synapse)。

---

### 变更：画像快照瘦身——只留可交互元素，站点框架归并 chrome（顺带修 snapshot 形状 bug）

- **现象**：快照并入画像后两份 draft 达 1.08/1.16MB。无用数据来自四处：
  outline 收了全部持文本元素（upwork 2,892 条里 interactive 仅 748）；跨页重复的
  导航/侧栏/页脚（zhipin 80% 重复、180 个元素每页出现）；`links`/`controls` 是采集
  中间量；capture 混入第三方埋点/广告（upwork 187 条里 56 条无关）。
- **顺带发现的 bug**：`browser.snapshot()` 返回 `{url,ts,total,count,items}` 而非裸
  数组，`Array.isArray(snap)` 恒假 → `controls`/`dangerous` 永远为空，**危险控件审计
  静默失效**（报告里始终显示 0）。修法：取 `snap.items`，且只保留 dangerous。
- **修法**：新增纯函数 `buildSnapshot`（可单测）：
  - outline 只留 `interactive:true`；纯文本与"仅 cursorPointer"（多为可点容器后代，
    cursor 继承陷阱）不再入画像；
  - 同一 `sig+text` 在**半数以上页面**（最少 3 页）重复出现 = 站点框架，归并进
    `snapshot.chrome` 只存一份。初版阈值定为固定 3 页，实测审计发现会把页面级操作
    （详情页的 Apply now ×7、同族页共享 tab ×8）误当归并，导致 upwork feed 页筛成空，
    已改为按页数自适应（半数）；
  - `links`/`controls` 不入画像（BFS 用 enqueued/skipped 已够）；
  - capture 只留同源或 JSON 响应（第三方埋点/广告丢弃）；
  - structure.lists 剔除 SVG/渐变图元（g/path/linearGradient/stop…）并截断 8 条；
  - 每页 outline 上限 200（与页内探针的整形上限一致；初版 120 会让 zhipin 7 个
    搜索页触顶截断）。
  discover.js 的 page 对象同步移除 links/controls 字段。
- **实测审计**（真浏览器重跑原始探针，与全站并集比对）：upwork 真正丢失 0；
  zhipin 缺失项均为"审计时下拉展开/职位列表更新"的页面状态差异，非过滤规则所致；
  修正阈值与上限后触顶为 0。
- **实操验证**（照画像真跑采集）：发现 zhipin 职位卡在 clickables 里只有文本、没有
  跳转地址（采集时靠现场 DOM 补 href）。已给 clickables 探针补抓容器内第一个
  `a[href]`（chrome 归并同样保留 href），重跑后搜索页 17/17 张卡带 href；仅凭画像
  `snapshot.clickables` 即可列出职位并打开详情（已验证第一条链接打开后职位名一致）。
- **效果**：upwork 1.08MB → **0.40MB（−63%）**，zhipin 1.16MB → **0.57MB（−51%）**；
  危险控件审计恢复（upwork 回填 10 条命中）。知识字段不受影响。

### 变更：画像根改回"相对安装位置"——`<SKILL_ROOT>/profiles`

- **现象**：画像被写到 `~/.zcode/synapse-profiles`（config profileRoot 显式指定），
  而用户要的是**以 skill 安装位置为相对上级路径**——skill 装到哪，画像就落在哪的
  `profiles/` 下。
- **修法**：`agent/paths.js` 的 `resolveProfilesRoot` 默认值改为
  `path.join(SKILL_ROOT, "profiles")`；删掉 config.json 里的 `profileRoot` 覆盖
  （dataRoot 不动，桥/日志/即席产物仍在数据根）。存量两站 draft 已迁入
  `<SKILL_ROOT>/profiles/draft/`（本机安装位是 junction，即源码仓 `profiles/draft/`）。
  `ensureProfilesSeeded` 退化为无害（种子目录与画像根同址）；README 路径表与
  SKILL.md 使用注意同步改口。operator 仍可用 `WB_PROFILES_DIR` / `config set
  profile-root` 整体重定位，但默认跟随安装位置。

### 变更：取消"材料包"——采集结果整体并入画像（snapshot 段）

- **现象/根因**：discover 采集结果原先分两处：材料包（`<DATA_ROOT>/discovery/<domain>/`
  的 pack.json + report.md + captures/）与画像 draft（只有知识骨架）。用户定调：
  **不存在材料包这个概念**，采集产物就是画像本身——元素快照（交互元素标识）、
  每页链接、控件、结构线索、XHR 响应体都应在画像里。
- **修法**：`discover.js` 的 `buildDraftSkeleton` 新增 `snapshot: {capturedAt, pages,
  skipped}`，每页 `capture` 直接内嵌响应请求与 body（原 captures/page-NNN.json 落盘取消）；
  删除 pack.json / report.md / captures 的写出与 `renderReport`/`writePack`；
  plan 与运行摘要只报 draft 路径。存量两站 draft 已把 pack+captures 并入 snapshot
  （upwork 815KB / zhipin 1.16MB，各 20 页），材料包目录（含 `_prev` 历史备份与旧
  verify 残留）已删除。
- **影响**：画像体积变大（快照占大头），但采集→画像单产物、单路径；agent 补知识字段
  直接读 draft.snapshot，无需再拼材料包路径。SKILL.md 使用注意、README 路径表与
  画像生产流程同步改口。

### 变更：采集落点全由程序决定——discover 删除 `--out-dir` / `--draft`

- **动机**：位置约定的旧形态是"旗标可在锚内收窄"（isInside 校验）。用户定调：采集动作
  全流程由程序控制，**agent 无权指定保存位置**——连"锚内收窄"的能力都不该存在。
- **修法**：`runner/discover.js` 删除两个位置旗标及其越界校验（isInside 依赖一并移除）；
  材料包固定 `<DATA_ROOT>/discovery/<domain>/`、draft 固定
  `<PROFILES_ROOT>/draft/<domain>.json`，路径由程序直接计算；**白名单之外的 `--flag`
  一律显式拒绝（不静默忽略）**，并有回归测试钉死（test-discover「位置旗标显式拒绝」）。
  整根重定位只保留操作者层配置：`config set data-root/profile-root/output-dir` 或
  `WB_*` 环境变量。`paths.js` 关于 `--out` 的陈旧注释、README「路径配置」段落同步改口。
- **影响**：discover 的调用方（agent）只能传行为参数（预算/深度/会话/--force/--plan），
  写盘位置完全不可干预。

### 修正：SKILL.md 提示词再瘦身——只留简介段 + 命令表（生成块不动）

- **现象**：提示词里混着「快速启动」「原语直觉」「站点画像（纯数据）」等叙述段，
  与命令表信息重复（快速启动的两条命令都在表里，站点画像段与「画像生产」段互相
  解释字段），agent 读起来信息密度低。用户定调：提示词只留"工具是什么"一段 + 命令表。
- **修法**：SKILL.md 收敛为 frontmatter + 简介段 + `## 命令`（usage 生成块，
  `usage:sync` 与 test-commands 第三腿原样保留）。「画像生产 / 发现顺序与故障转移 /
  健康与恢复」三段操作性知识**不丢弃**，整体移入 README 新增「操作：画像生产与
  链路恢复（agent 工作流）」节（标题降两级）；discover.js / paths.js 里指向
  SKILL.md 旧小节的注释同步改指 README。
- **取舍**：agent 触发本 skill 后若需要画像生产/排障细节，需主动读 README——
  这是"提示词极简"的代价，换取提示词不随流程细节膨胀。

### 变更：去掉 recipes 概念——画像回归纯数据，采集是通用程序

- **现象/根因**：画像文件里嵌着站点专属采集代码（`recipes[].execution.extractFn`），
  画像从"数据"被污染成"加载即执行的代码"。但采集动作本身是通用的
  （`runner/discover.js` 对所有站点同一套代码：开页→探针→抓取→材料包），
  站点专属程序不该住进知识文件——用户拍板：画像只留快照与站点知识（数据），
  采集数据由 agent 按画像知识即席用桥命令执行。
- **修法**：
  - 全部 6 个画像（2 种子 + 2 运行时正式 + 2 draft）删 `recipes`/`replay` 字段，
    容器从 `.js` 模块翻回 `.json`（函数搬走后 JS 容器无存在理由；schemaVersion→3）；
  - 退役 `runner/profile-runner.js`（recipe 执行器）与 `runner/serialize-profile.js`
    （唯一用途是函数画像写盘）；
  - `discover.js` 只留 `run`：verify 子命令（真跑 + status 盖章）删除，
    `getOpt`/`ensureProfilesSeeded` 内联回移；draft 骨架改为知识字段
    （`fieldMap`/`pageNotes` 空占位，无 recipes），落盘 `.json`；
  - 删 `test/test-runner.js`、`test/test-profiles-live.js`；test-discover 骨架用例
    改"无代码字段"断言；package.json 去 `profiles:run`/`test:profiles`/`test:all`；
  - `status` 语义改人审：`draft`（待审）/`reviewed`（人审通过），原 verify 章作废
    （各画像 `provenance.migration` 留了迁移记录）；
  - SKILL.md「站点画像」段重写为"纯数据 + 即席采集"，生产流程砍 verify 步，
    agent 补的是知识字段（fieldMap/limits/antiScrape/params/pageNotes/flows/
    dataEndpoints），晋级=人审合并 draft 进画像根。
- **放弃项（决策记录）**："一条命令按画像重采数据"没了（采集逻辑不持久化，
  现场写、现场跑）；live 契约测试套件（20 例）随 runner 移除；此前记录的字段级
  质量债（fiverr 死变量等）随 extractFn 一并消失，不再单独还。

### 清理：`scripts/` 开发工具目录退役（并入 agent 或移除）

- **动机**：`scripts/` 是重构过程中 agent 侧造的开发工具目录，装在宿主 agent 的
  skill 里不合身份；且其中多数工具使命已完成。
- **处置**：
  - `sync-usage.js` **并入 `agent/commands.js`**——命令表是单一来源，再生成逻辑放在
    源头模块里最干净（`usage:sync` 入口变为 `node agent/commands.js usage:sync`，
    package.json 已改指；新增导出 `syncUsageToSkill`）。漂移守卫机制不变：
    `npm run usage:sync` 再生成 + test-commands.js 精确比对钉死。
  - `convert-profile-to-js.js` **删除**——一次性迁移工具，种子与运行时画像全部
    转换完毕后使命结束（转换记录见「画像存储从 JSON 升级为 JS 模块」条目）。
    兼容期内 .json 画像仍可被 runner 直接读取执行，只是不再有升级工具；真有旧
    .json 需要转换时可按该条目记载的口径重写。

### 清理：删除废弃的 `data/` 与 `out/` 运行时残留，README 同步改口

- **现象**：安装目录下还躺着两个旧版运行时目录——`data/`（旧 DATA_ROOT 默认落点，
  里面只剩 1KB 的 `bridges/probe.json`，10-23 后无人写入）与 `out/`（重构前采集产物
  的默认输出，45KB 旧文件）。两者都在 .gitignore，纯属遗留。
- **根因**：重构把数据根挪进宿主客户端（`~/.zcode/synapse-data`）后，旧目录不再被
  `ensureDataDirs` 等任何路径解析链引用，但也没有人物理清掉；README 里"data/ 是
  运行时工作区"与 runner 示例里的 `out/<domain>` 也还是重构前的写法。
- **修法**：删除 `data/`、`out/`（删前验证：全库无代码再拼 `<SKILL_ROOT>/data` 或
  `<SKILL_ROOT>/out` 路径，mkdir 全部锚在解析后的 DATA_ROOT/PROFILES_ROOT/OUTPUT_ROOT
  上，删后不会复活）；README 两处改口为当前布局。

### 变更：画像存储从 JSON 升级为 JS 模块（extractFn 真函数 + 自定义序列化器）

- **现象**：画像文件是 .json，抽取逻辑只能以「JSON 字符串里的代码」存在（extractJs）——
  无语法高亮、无注释、转义地狱；agent 依材料包写 recipe 时最容易在这一步写错。
- **修法**：画像升级为可执行的 .js 模块（`module.exports = {...}`），抽取逻辑升级为真函数
  `execution.extractFn`（函数优先于遗留字符串 `extractJs`，至少其一；.json 旧格式进入兼容期，
  仍可读可执行）。加载按扩展名分派（`loadProfileFile`：.js → require / .json → JSON.parse，
  每次清 require 缓存，写回后能读到新内容）；`--profile` 裸名与旧 `.json` 写法自动解析到
  `.js`。种子与运行时画像已全部转换（`scripts/convert-profile-to-js.js <in.json> <out.js>`：
  IIFE 壳剥成真函数，转换后 validateProfile 自检；空 recipes 的骨架 draft 合法放行）。
- **序列化器为何存在**：verify 的 status 印章要写回画像文件，而画像现在含函数——
  JSON.stringify 会把函数静默丢掉（JSON 没有函数类型），写回一次画像就废。新增
  `runner/serialize-profile.js`：递归 emit JS 字面量（函数 toString 内联、字符串
  JSON.stringify、2 空格缩进，文件尾固定 `"use strict"` + `module.exports = …;`）；
  verify 写回与 discover 的 draft 落盘一律走它。函数源码不重排缩进，序列化幂等
  （写回 N 次逐字节等于写回 1 次）；代价是写回整体重写文件，画像顶层手写注释不保留。
- **信任边界变化**：画像从「数据文件」变成「加载即执行的代码」（require 画像 = 跑里面的
  顶层代码）。防线：validateProfile 轻校验抽取源不得含 `require(` / `process.` / `global.`
  标记（违规给中文报错，宁可误拦）；SKILL.md 明示「画像加载即执行，只放采集知识不放
  其它代码」。单用户可信本机模型不变，但心智要从「画像=数据」换成「画像=代码」。
- **偏离记录**：任务书给的 IIFE 壳正则 `/^\(function\(\)\{[\s\S]*\}\(\)\)$/` 尾部字面序列
  是 `}())`，只匹配 `(function(){…}())` 变体，对本仓库全部现存画像的 `(function(){…})()`
  形态永远失配（照抄一条都转不了，而验收要求 extractFn 为函数）——转换脚本两种 IIFE
  形态都接受。另：早期并行实现引入的 `extract` 函数字段名在 `resolveExtractSource` 里
  保留为兼容回落，`extractFn` 恒优先。
- **账目**：新增 `runner/serialize-profile.js`、`scripts/convert-profile-to-js.js`；
  profile-runner.js（loadProfileFile/resolveProfileArg/播种双扩展/越权守卫）与 discover.js
  （draft 默认 .js、verify 走序列化器写回）改造；SKILL.md/README 画像段落同步；
  测试新增 loadProfileFile 双格式分派、stringifyProfile 含函数 round-trip（含幂等断言）、
  越权标记逐个拒绝。

---

### 修正：SKILL.md 提示词补足判断性知识（充分 ≠ 污染回潮）

- **问题**：连续两轮瘦身按"没有它 agent 会不会做错"过滤，把判断性知识也砍了——
  一个零记忆的 agent 照 92 行的版本能不犯错，但做不好两条用户指令：不知道怎么从
  材料包判断功能清单、extractJs 怎么写才不踩骨架坑、单功能路线怎么定位与收尾、
  数据无效时怎么处置。
- **原则澄清**：删的是机器路径/历史叙事/打包机制（那才是污染），判断性 how-to 是
  操作必需——两条不冲突。
- **补足**：快速启动（探活→起桥）、退出码语义与结果处置、原语选用直觉、
  分析流程细化（可疑未渲染页判别、路由簇×clickables×标题交叉圈功能、噪音排除）、
  recipe 写法要点（锚语义属性/closest 上溯/整块文本正则/骨架过滤/matchQuery）、
  数据源判定（DOM vs API，API-first 记待办）、verify 缺参数不猜、单功能补画像
  独立成节（定位→回问→子树探索→前后 capture 对比→收尾）。
- **账目**：92 → 171 行（含 40 行生成的用法块），全部是操作 how-to，无路径/历史/打包。

---

### 变更：SKILL.md 内嵌完整用法块（生成 + 精确钉死），提示词自包含

- **决策**：用户拍板提示词要自包含——agent 不该为了知道有哪些命令而先跑一次裸 CLI
  （多一次往返；不知道某命令存在时连问都不会问）。
- **实现**：不做手写全表（会重蹈三处漂移），改用生成——scripts/sync-usage.js 把
  renderUsage() 输出写入 SKILL.md 的 <!-- usage:start/end --> 标记区间（`npm run usage:sync`）；
  test-commands.js 第三条腿从"命令名出现"升级为**整块精确比对**——命令表任何改动
  npm test 即红，提示词被迫跟上。原来手写的 8 条示例块与"未列命令"行删除（已含在生成块内）。
- **账目**：SKILL.md 92 → 128 行，换来自包含；漂移风险由生成 + 测试双重兜住。

---

### 变更：SKILL.md 提示词卫生——位置约定瘦身为操作必需，打包知识移入 README

- **问题**：位置约定章节把 SKILL_ROOT 解析、种子机制、git 入库列、本机路径与 junction
  说明全写进了 SKILL.md——这是注入模型上下文的提示词，机器细节与打包机制每场会话都在
  消耗上下文，属于开发者文档的内容。
- **修正**：SKILL.md 只留 agent 操作必需的两条规则（画像→画像根、数据→数据根）+ config
  查看命令 + 覆盖旗标的锚内约束 + 环境变量清单（约 40 行 → 20 行）；SKILL_ROOT/种子/
  入库/平台默认/安装注册的完整表格与说明移入 README「路径配置（打包与数据布局）」。
- **原则**：SKILL.md 写"怎么用"，README 写"怎么打包与部署"；提示词里不出现本机路径。
- **第二轮**：位置约定与测试两章整体删除——锚定在代码里、越界由代码报错，agent 不需要
  预背错误信息；discover 的摘要 JSON 本来就会打印产物绝对路径，`--profile` 裸名自动解析，
  agent 无需知道实际位置。环境变量/doctor 的 WB_CDP_EXT_DIR 说明由 README 路径配置表承接。
  SKILL.md 212 → 179 行，只剩操作章节：用法/程序调用/模块/消费/生产/发现顺序/健康恢复。
- **第三轮（全文精简）**：178 → 108 行。砍掉：仓库/协议介绍与架构图（README 已有）、
  程序调用章节（README 已有）、模块表（移入 README 并补 paths/api/runner 两行）、
  click-el/type-el 的 JSON 旧写法（与"传索引"建议矛盾）、画像生产的历史叙事
  （"此前缺失的前半段…"）与 step1 的探针实现细节括号、守卫表格（压成一行）、
  重复的登录态声明（前言与消费章节各一次→只留前言）、fiverr 重复示例与 test:profiles
  引用（README 测试章节已有）。保留判据不变：没有它 agent 会不会做错。

---

### 修正：画像与数据分根——synapse-data 只装采集数据，画像独立 synapse-profiles

- **问题**：上一条把画像运行时副本放进 `<DATA_ROOT>/profiles/`——目录名叫 synapse-data，
  画像放进去名实不符（data 该是采到的数据，画像是知识资产）。
- **修正**：paths.js 新增 `resolveProfilesRoot()`/`PROFILES_ROOT`：默认取数据根同级
  `*-profiles`（basename 去掉 -data 后缀再加 -profiles，避免拼出 synapse-data-profiles），
  `WB_PROFILES_DIR` / `config set profile-root` 可覆盖；config 命令展示并允许设置
  profile-root；两个 runner 的画像锚（播种/解析/写回/verify 校验）全部改用 PROFILES_ROOT。
- **本机迁移**：`config set profile-root ~/.zcode/synapse-profiles`，profiles 与 draft
  已从 synapse-data 拆出；discovery/output/bridges 留在 synapse-data（名实相符）。
- **事故记录**：迁移中一次 mv 目标目录不存在（2>/dev/null 吞错）+ 无条件 rm -rf 清源，
  连带删掉了仓库种子 profiles/*.json 与一份已过时的 draft 备份；种子是 git 跟踪文件，
  git checkout 无损恢复（fiverr.com.json 上一次未提交的纯格式化改动随回滚消失，内容无差异），
  运行时副本由种子重新播种。教训：破坏性清理前先验证 mv 成功，2>/dev/null 不该用在 mv 上。

---

### 修正：画像运行时副本与 draft 移出安装目录，数据根注册进宿主客户端主目录

- **问题**：上一条把 draft/正式画像锚在 SKILL_ROOT（安装目录）——违反了 paths.js 自己的
  原则"安装目录只读，用户数据放用户目录"；且 skill 装进不同 agent 客户端时，运行时写入
  落在代码检出目录里，随 git/升级流动，位置不受宿主控制。
- **修正**：画像只活在数据根——正式 `<DATA_ROOT>/profiles/`、draft
  `<DATA_ROOT>/profiles/draft/`；`<SKILL_ROOT>/profiles/` 降级为**出厂种子**（只读、入库），
  `ensureProfilesSeeded()` 首次使用时把缺失的种子拷进数据根。`--profile` 解析顺序：
  数据根内显式路径 → 裸名（补 .json）→ 指向种子的旧写法**自动重定向**到数据根副本
  （写回永远不落在种子上）→ 其它显式路径原样只读。verify 锚校验同步改到数据根画像目录。
- **宿主对接**：agent 客户端目前没有公开 per-skill 数据目录契约，"宿主指定"落为安装时
  的一次注册——`config set data-root` 指进宿主主目录。本机已执行：
  `C:\Users\Administrator\.zcode\synapse-data`（ZCode），discovery 材料、draft、种子副本
  已迁移，config.json 本体仍在平台默认目录（与 dataRoot 解耦）。
- **迁移影响**：`--profile upwork.com.json`（裸名）成为推荐写法；旧写法
  `--profile profiles/upwork.com.json` 仍可用（自动重定向）；仓库 `profiles/draft/`
  不再承接运行时写入（.gitkeep 保留防目录消失）。

---

### 变更：位置约定从文档升级为代码执法（路径旗标锚内校验）

- **背景**：上一条把位置约定写进了 SKILL.md，但覆盖旗标（`--out`/`--out-dir`/`--draft`/
  verify `--profile`）仍接受任意路径——agent 可以用临时旗标把数据写到约定之外。
- **执法**：paths.js 新增 `isInside(root, p)`（path.relative 归一后判包含，跨盘符/前缀
  相同/`..` 逃逸都算越界）。四个写入口全部挂上锚内校验：`--out` ⊆ 产物根、
  `--out-dir` ⊆ 数据根、`--draft` ⊆ `profiles/draft/`、verify `--profile` ⊆ `profiles/`
  （它要写回 status）。越界报错并给出重定位途径（config / WB_DATA_DIR / SYNAPSE_OUTPUT_DIR）。
- **测试配套**：test-profiles-live 的 run() 注入 `SYNAPSE_OUTPUT_DIR=<tmp>`，`--out`
  写临时目录从"任意路径"变成"产物根内的合法收窄"；discover verify 给子进程注入同一
  环境变量，替代原来传给 runner 的 `--out`。
- **为何这样设计**：SKILL_ROOT 由运行时向上查找 SKILL.md 得出，skill 装到任何 agent
  客户端（.zcode/.agents/vendored）相对锚都成立；绝对自由度只保留给用户级显式配置，
  agent 的每次调用都被限制在两棵约定树内。

---

### 变更：位置约定定死——SKILL_ROOT 管代码与画像，DATA_ROOT 管一切运行时数据

- **背景**：画像/产物位置此前是"文档约定 + 代码硬编码"混着两套口径——SKILL.md
  一处说产物写仓库 `out/`、另一处说数据根 `output\`；`config set output-dir` 在
  paths.js 里有完整解析但没有任何 runner 消费（死配置）；discover 的材料包落在
  仓库 `state/`（gitignore），与"安装目录只读、用户数据放用户目录"的原则不符。
- **约定**（SKILL.md「位置约定」章节，一条规则一张表）：**代码与画像随 skill 安装
  位置（SKILL_ROOT）走，一切运行时数据随数据根（DATA_ROOT）走**。正式画像与
  draft 在 `<SKILL_ROOT>/profiles[/draft]/`（版本化资产，入库）；采集产物在
  `<DATA_ROOT>/output/<domain>/`；发现材料包在 `<DATA_ROOT>/discovery/<domain>/`；
  draft 的证据引用指向 DATA_ROOT。
- **代码**：profile-runner 的产物默认从仓库 `out/` 改为 `resolveOutputRoot()`
  （OUTPUT_ROOT，config/环境变量从此真正生效）；discover 的材料包默认从
  `state/discovery/` 改为 `<DATA_ROOT>/discovery/`（接通 DATA_ROOT）；
  `--out`/`--out-dir`/`--draft` 覆盖旗标不变。
- **影响**：仓库里的旧 `out/` 与 `state/` 目录不再有新写入；`.gitignore` 条目保留
  以防历史目录回流。

---

### 变更：新增画像生产层 runner/discover.js（补画像生命周期的前半段）

- **背景**：画像此前只有消费半边（profile-runner 执行 recipes）；生产半边（画像 JSON
  从哪来）零实现——现有两个画像是探索会话的手工产物，探针与捕获用完即丢
  （upwork 画像 provenance.sampleSource 指向的 `docs/upwork/p-*.js` 不在仓库里）。
- **新增**：`runner/discover.js`。`run` = 有界同源爬行（逐页 snapshot/链接/结构探针/
  capture 留证）→ 材料包 `state/discovery/<domain>/`（pack.json + captures/ + report.md）
  + `profiles/draft/` 骨架（recipes 留空）；`verify` = 逐 recipe spawn profile-runner
  真跑（复用校验/off-query/scope 逻辑，不复制），退出码映射 recipe.status 写回 draft。
- **分工**：程序只做机械守卫（同源、危险词只记不点、表单不提交、预算深度2/20页/10分钟、
  同域间隔≥2s）与材料留存；功能识别/字段归纳/extractJs 由 agent 依材料包判断，
  流程写在 SKILL.md「画像生产（discovery）」章节。draft 晋级 `profiles/` 是显式步骤。
- **关键实现约束**：capture 的时长/截断/triggerJs 走 connect options 而非命令 args
  （transport.js 的 executeCommand 把 opts 直接喂给 doCaptureMany，args 只有 tabId/action），
  discover 因此在 connect 时固定 dwellMs/bodyMaxKb。
- **文本骨架探针（outline）+ 可点容器（clickables）**：DOM 去噪的第一层，硬币两面。
  outline：TreeWalker 只遍历文本节点映射到持有元素——纯布局包装层不持有文本节点，
  在采集源头就消失；不走"全元素取 innerText"（layout-dependent API，几千元素会强制
  reflow）。img 没有 innerText 用 alt 兜底成伪条目；无文本的表单控件不进骨架（由
  snapshot 的可交互启发式覆盖，两表互补）；条目带 interactive（tag/role/tabindex/onclick）
  与 cursorPointer 两个机械标志；同签名同文本合并计次。
  clickables：包装层自己成了可点击卡片（cursor:pointer/tabindex/onclick 且非标准交互
  标签）——extension snapshot 的候选选择器（input/button/a/[role=…]/[data-testid]）不认
  它们，骨架表又因无直接文本排除它们，两头盲区；以容器为单位捞回（最外层去重，不炸成
  内部文本叶子），cap 30。
- **验证**：test-discover.js 8 例纯函数单测（危险词/同源/URL 归一/入队挑选/预算/骨架），
  已接入 npm test；真浏览器流程归 test:profiles 同级的 live 验证。

---

### 变更：鉴权改为两侧内置的固定标识（去掉配对文件与 UI）

- **决定**：保留双向 HMAC 握手，但令牌不再由用户配对，而是扩展与 agent 两侧
  `ws-auth.js` 里写死的同一枚 64 位标识（不再是全零默认值）。
- **移除**：`pair` 命令、`pairToken()`、`data/bridge-auth.json`、侧边栏配对 UI、
  扩展侧 `chrome.storage` 令牌读取与 `panel.setToken` 消息。
- **保留**：挑战/应答、双向 proof 校验、Origin 白名单（网页仍然连不上）。
- **信任模型**：标识不是密码，源码公开；按"单用户可信本机"设计，已写入 README。

---

### BUG-21 入口 barrel 收窄 + 测试改用模块直连（P2）

- `agent-collect.js` 的导出从 30 项收窄到 `{ main }`；测试不再通过入口拿内部函数。
- `test-bridge.js` 改为直接 require `cli` / `registry` / `transport` / `capture` / `doctor` / `paths`。
- 顺带清掉入口里 20 余个只为导出而存在的导入。
- 验证：28 + 19 命令 + 8 回归全绿。

---

### 变更：doctor 默认只杀"自己启动的" Edge

- **旧行为**：`taskkill /f /im msedge.exe /t` —— 会把用户自己开的 Edge 窗口一起带走。
- **新行为**：`launchEdge` 记录 pid 到 `data/edge.pid`；硬刷时只 `taskkill /pid <记录> /t /f`，
  没有记录就跳过 kill（日志写 `maintenance.log` 的 `kill-skipped`）。
- **逃生口**：`doctor --force-kill`（或 `WB_EDGE_KILL_ALL=1`）恢复旧的"杀所有 Edge"。
- 新增回归测试：没有 pid 记录时 `killOwnedEdge` 必须返回 `none` 且不动浏览器。
- 文档同步：SKILL.md 的 doctor 段落改成"默认只杀自己的实例 + --force-kill 逃生"。

---

### 变更：数据目录移到用户目录，新增 config 命令（发布前必改）

- **问题**：`DATA_ROOT` 默认是 `<skill>/data`，`--out` 默认是仓库里的 `data/`。
  装到 Program Files 或由包管理器管理时不可写，升级还会把数据一起覆盖。
- **新默认**：Windows `%LOCALAPPDATA%\Synapse`、macOS `~/Library/Application Support/Synapse`、
  Linux `~/.local/share/synapse`（遵守 `XDG_DATA_HOME`）。
- **解析顺序**：`WB_DATA_DIR`（`SYNAPSE_OUTPUT_DIR`）> `config.json` > 平台默认。
- **新增命令**：`config` / `config set data-root <dir>` / `config set output-dir <dir>` / `config reset`，
  首次使用时由使用方指定位置。
- `registry` 写注册表前自建目录（数据根换成用户目录后首次 serve 目录可能不存在）。
- 回归测试：默认值、`config` 覆盖、`reset` 回退（10 例）。

---

## 2026-10-23（晚）— 修掉 review 的 P1/P2 缺口

### BUG-14 `--session` 指定桥不可用时不做故障转移（P1）

- **现象**：`--session a` 的桥进程活着但扩展没拨进来时，命令进入该桥队列，直到 50s 超时。
- **根因**：`bridgeCandidates` 命中 session 就只返回该桥；而且"连接成功"不等于"扩展在线"。
- **修法**：候选改为「指定桥排最前 + 其余活桥跟后」；连接后再做一次短超时 `diag` 探活，
  只有超时/断连才算扩展不在线（扩展回 `ok:false` 说明它活着）。

### BUG-15 级联连接没有总时限（P1）

- **现象**：20 个候选 × 每个 5s，最坏 100s 才失败。
- **修法**：整条链 15s 总预算（`chainDeadlineMs`），每个候选取剩余预算的较小值。

### BUG-16 cleanup 超时提前释放身份，迟到的 disconnect 会误清新会话（P1）

- **现象**：cleanup 5s 超时后删除 `clients` 条目；扩展稍后真正执行 `client.disconnect` 时，
  同 clientId 的新会话可能已被清掉。
- **修法**：超时只回 `CLEANUP_TIMEOUT` 并关掉本地 socket，**保留身份**到扩展 ack 或扩展断开；
  同时用 `MAX_CLEANUPS`（64）保证有界。

### BUG-17 半开的扩展连接会永久拒绝新扩展（P1）

- **现象**：旧扩展 socket 的 TCP 半开（SW 挂起）时 `readyState` 仍为 1，新扩展被 1008 拒绝。
- **修法**：记录 `lastExtensionSeen`，静默超过 20s 视为僵尸并替换。

### BUG-18 单连接挂起命令无上限（P2）

- **修法**：每连接在途命令上限 64，超出回 `CLIENT_BUSY`。

### BUG-19 late-start 补偿后 `earlyEvents` 泄漏（P2）

- **修法**：`capture.stop` 补偿时按 captureId 删除对应缓冲。

### BUG-20 `serve`/`keep` 重复接线 + 入口未使用 import（P2）

- **修法**：抽出 `wireBridgeServer()` 两处共用；清理入口 20 个未使用的导入。

### 文档

- `doctor` 明确只实现 Edge 硬刷；Chrome 下命令照常可用，只是不会自动重启浏览器。

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
