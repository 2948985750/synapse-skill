---
name: synapse-skill
description: 驱动已运行、已登录的 Chrome/Edge（本机回环 WebSocket + 浏览器 MV3 扩展的 chrome.debugger 全量 CDP 透传）。用于读渲染 DOM、点选/输入、跑页内 JS、捕获页面自身 XHR/fetch 响应、复用登录态做网页自动化。无 --remote-debugging-port、无 native messaging、无服务端。触发词：synapse、CDP、驱动浏览器、点选元素、捕获接口响应、复用登录态。
---

# synapse-skill

驱动已运行、已登录的 Chrome/Edge（本机回环 WebSocket + 浏览器 MV3 扩展的
`chrome.debugger` 全量 CDP 透传）：读渲染 DOM、点选/输入、跑页内 JS、捕获页面自身
XHR/fetch 响应、复用登录态做网页自动化。不启动新浏览器、不碰 profile、不伪造
cookie/请求头。**前提：浏览器已经开着**（登录态在里面）；扩展主动拨入本仓库
（node 侧）的回环 WS 服务端。站点画像的读取/生产与链路恢复流程见 README。

## 使用注意

- 采集动作全流程由程序控制：**agent 无权指定任何保存位置**。加工与结果全部写入
  安装位置下的画像目录：`<SKILL_ROOT>/profiles/draft/<domain>.json`（相对安装路径，
  skill 装到哪画像跟到哪；含可交互元素快照 + 响应体 + 站点知识，跨页框架归并
  `snapshot.chrome`），**不存在独立的材料包**；
  换位置只能由装 skill 的人改 `config set profile-root`（或 `WB_PROFILES_DIR`）。
- 保存/投递/支付类写操作**永不代执行**——只记录，由用户手动做。
- 用户没有明确要求"抓取接口"时，**不要自动抓取接口**：不主动捕获/分析页面 XHR/fetch
  响应，也不在画像里补 `dataEndpoints` 等接口信息；默认只采集页面元素与站点知识。

## 命令

<!-- usage:start -->
- `list` —— 列出所有标签页：tabId/标题/URL——一切后续命令的 tabId 从这里拿
- `navigate <tabId> <url>` —— 复用已有标签页导航到新 URL；默认等 load 完成，--nowait 跳过等待
- `cdp <tabId> <method> ['<params-json>'|@file] [--param k=v ...]` —— 任意 CDP 方法透传；@file 免 shell 引号，--param k=v 可追加/覆盖 params 里的键，JS 对象无序列化损耗
- `run <tabId> '<js-expression>'` —— Runtime.evaluate 跑页内 JS；默认 awaitPromise 等 promise 落定，--sync 不等
- `open <url>` —— 开新标签页；默认等 load 完成，返回 loaded；--nowait 跳过等待
- `open-frame <tabId> '<url-regex>'` —— 把匹配的子帧开成顶层标签——跨源 iframe 内容回退
- `close <tabId>` —— 关闭标签页；discover 自管标签生命周期，这条一般只在手工交互时用
- `setfile <tabId> <selector> <file-path>` —— 给 input[type=file] 塞本地文件，走 CDP DOM.setFileInputFiles
- `attach <tabId>` —— 手动把调试器附加到标签——桥执行命令时会自动 attach，这条只做排障用
- `detach <tabId>` —— 解除标签上的调试器，attach 之后想彻底释放用这条
- `diag` —— 诊断快照：日志环形缓冲、最近弹窗记录、capture 会话状态——排障第一步
- `capture <tabId> <url|reload|wait> [--duration ms] [--filter <re>] [--body-max kb] [--all]` —— 网络响应体捕获：触发导航/重载后抓该标签的 XHR/fetch 请求 + 响应体
- `capture-many <tabId:action> [<tabId:action> ...] [--duration ms] [--filter <re>] [--body-max kb] [--all]` —— 多标签并行网络捕获：不同 tab 各开一个 capture session，tabId 必须互不相同（同 tab + 同 client 的 capture session 互斥）；action 同 capture
- `config [set <key> <dir> | reset]` —— 显示数据目录与来源；config set data-root <dir> 指定数据根、config set output-dir <dir> 指定采集产物根、config set profile-root <dir> 指定画像根；config reset 清掉自定义路径回到默认。纯本地命令，不需要连桥
- `status` —— 有界健康探测：总时限 1.8 秒；多桥时逐个试连，任一桥可达即返回
- `doctor [--wait <ms>] [--force] [--force-kill] [--dry]` —— 链路医生 + 多会话协调恢复：快查 → 礼貌等待 SW 重拨（探针端口/活桥，默认 --wait 60s）→ 锁协调硬刷（data/maintenance.lock.json，同一时刻只有一个会话执行 taskkill+清缓存+重启 Edge，排上的会话等锁释放后复查健康）。多会话恢复统一走 doctor，不要各自手杀 Edge；--force 跳过等待，--dry 只打印计划
- `serve [session] [--shared]` —— 常驻 bridge：持有 WS 端口 + 保活扩展 SW，注册 data/bridges/<session>.json；session 省略时自动生成并打印。one-shot 发现顺序：--session/WB_SESSION 指定桥 → 其它活桥（最新优先）→ 直连慢路径；多会话各起各的 serve 互不覆盖。--shared 额外写 data/bridge.json 兼容遗留脚本。Ctrl+C 退出
- `snapshot <tabId> [--max N]` —— 索引化动作空间：枚举可交互控件 [{i,tag,role,label}]
- `click-el <tabId> <i|el-json> [--label <text>]` —— 按 snapshot 索引点击；--label 参与漂移校验（索引越界/label 变了会拒绝执行）
- `type-el <tabId> <i|el-json> <text> [--clear] [--label <text>]` —— 按索引键入，兼容受控组件（native value setter + input/change 事件）；--clear 先清空；<i> 来自 snapshot 条目，旧的完整 JSON 写法仍兼容
- 选项: --wait <ms>  --keep  --max <N>  --clear  --label <text>  --param k=v  --sync  --nowait  --client-id <id>  --trigger-js <expr>  --session <sid>  --shared  --force  --force-kill  --dry
- 多会话: WB_SESSION=<sid>（本会话 one-shot 优先走 data/bridges/<sid>.json）；--keep 也会注册为临时会话桥（注册表条目 + 允许多客户端），供同会话后续 one-shot 毫秒级复用
<!-- usage:end -->
