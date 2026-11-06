"use strict";
// 命令表与实现的漂移守卫。
//
// 背景：usage 曾经是手写的，和 buildCmd 的 switch 各写一遍，结果真的漂了
// ——`setfile` 有实现但没进 usage，用户看不见这条命令。本测试把「表」和
// 「实现」钉在一起：任何一边新增/改名命令而另一边没跟上，立刻失败。
// 字段：
//   name  —— 命令名（与 buildCmd 的 switch 分支一一对应）
//   lines —— 第 1 行为调用形状（纯形状，不带说明），其余为说明行（换行续写的散文，
//            renderUsage 缩进渲染；renderList 以 `shape —— notes` 产无序列表）
//   writes —— 是否会产生副作用（供未来做只读校验/权限分级用）

const COMMANDS = [
  { name: "read-page", lines: ["read-page <tabId> ['<options-json>'|@file]", "按 scope 读取区域文本；maxChars 默认 4000；options 可传 contextId/sessionId。"] },
  { name: "wait-for", lines: ["wait-for <tabId> '<condition-json>'|@file", "等待 locator 的 visible/hidden/attached/detached、text/value 或精确 url；默认 10 秒，超时不重复动作。"] },
  { name: "click-cdp", writes: true, lines: ["click-cdp <tabId> <i|el-json>", "检查可见性、遮挡和位置稳定后发送 CDP 鼠标输入；失败不自动回退为 DOM 点击。"] },
  {
    name: "actions",
    lines: [
      "actions <domain> <actionId|list> [--param k=v ...] [--dry] [--yes] [--timeout ms] [--session sid] [--browser-id id] [--allow-failover]",
      "声明式导航入口（title+url+guards）：拒绝 draft；--dry 只打印计划，external 必须 --yes；验证加载完成与最终 URL（含 hash），exit 0 仅表示页面就绪，返回 taskSucceeded:false，不代表业务任务完成。间隔/日上限限制导航次数；never 由 agent 在交互路径遵守；list 列菜单；exit 1 用法校验 / 2 护栏拦截 / 3 导航失败",
    ],
  },
  {
    name: "attach",
    lines: [
      "attach <tabId>",
      "手动把调试器附加到标签——桥执行命令时会自动 attach，这条只做排障用",
    ],
  },
  {
    name: "capture",
    lines: [
      "capture <tabId> <url|reload|wait> [--duration ms] [--filter <re>] [--body-max kb] [--all]",
      "网络响应体捕获：触发导航/重载后抓该标签的 XHR/fetch 请求 + 响应体",
    ],
  },
  {
    name: "capture-many",
    lines: [
      "capture-many <tabId:action> [<tabId:action> ...] [--duration ms] [--filter <re>] [--body-max kb] [--all]",
      "多标签并行网络捕获：不同 tab 各开一个 capture session，tabId 必须互不相同（同 tab + 同 client 的 capture session 互斥）；action 同 capture",
    ],
  },
  {
    name: "cdp",
    lines: [
      "cdp <tabId> <method> ['<params-json>'|@file] [--param k=v ...]",
      "任意 CDP 方法透传；@file 免 shell 引号，--param k=v 可追加/覆盖 params 里的键，JS 对象无序列化损耗；返回 CDP 原始回复，成功结果取 .result",
    ],
  },
  {
    name: "click-el",
    lines: [
      "click-el <tabId> <i|el-json> [--label <text>]",
      "支持快照完整条目（含 ref）或唯一定位器 {sel,scope}/{role,name}；优先传完整条目，避免同名元素重排误点",
    ],
  },
  {
    name: "close",
    lines: [
      "close <tabId>",
      "关闭标签页；discover 自管标签生命周期，这条一般只在手工交互时用",
    ],
  },
  {
    name: "config",
    lines: [
      "config [set <key> <dir> | reset]",
      "显示数据目录与来源；config set data-root <dir> 指定数据根、config set output-dir <dir> 指定采集产物根、config set profile-root <dir> 指定画像根；config reset 清掉自定义路径回到默认。纯本地命令，无需连接扩展",
    ],
  },
  {
    name: "dblclick-el",
    lines: [
      "dblclick-el <tabId> <i|el-json> [--label <text>]",
      "按 collect-elements 索引双击：mousedown/up×2 + click(detail2) + dblclick；注意小红书/抖音等媒体卡片双击=点赞，此类站点慎用",
    ],
  },
  {
    name: "detach",
    lines: ["detach <tabId>", "解除标签上的调试器，attach 之后想彻底释放用这条"],
  },
  {
    name: "diag",
    lines: [
      "diag",
      "诊断快照：日志环形缓冲、最近弹窗记录、capture 会话状态——排障第一步",
    ],
  },
  {
    name: "discover",
    lines: [
      "discover --url <entry> [--dwell-ms 4000] [--settle-ms 2500] [--keep-tab] [--force] [--capture] [--session sid]",
      "整站盘点（画像采集，单页富快照）：只开入口页，采全部可交互元素（含 SPA 跳转容器：cursor:pointer/onClick/role=link，不止 <a>）+ 结构；不自动跟链接翻页——页间跳转/路由由 LLM 交互观测补全；产物唯一：<PROFILES_ROOT>/<domain>.json，含 digest（规模目录）+ snapshot（瘦身元素快照）+ 知识骨架；--capture 默认关闭、按需抓同源/JSON 响应体；--force 覆盖已有画像（整文件重写：已结晶的 actions 与知识字段一并丢失，先备份再跑）",
    ],
  },
  {
    name: "doctor",
    lines: [
      "doctor [--wait <ms>] [--force] [--dry]",
      "只诊断与轮询活桥等待扩展重连（默认 60s），不杀进程、不清 profile 缓存、不重启浏览器；--force 跳过等待，--dry 只快查；--force-kill 已移除并会报错。超时报告需要人工检查目标会话与扩展",
    ],
  },
  {
    name: "drag-el",
    lines: [
      "drag-el <tabId> <from-i|json> <to-i|json>",
      "HTML5 拖放全序列（dragstart→dragenter/dragover→drop→dragend，带 DataTransfer）；from/to 均为 collect-elements 索引，目标 label 漂移会拒绝",
    ],
  },
  {
    name: "focus-el",
    lines: [
      "focus-el <tabId> <i|el-json> [--label <text>]",
      "聚焦元素（target.focus()）；返回值 active 表示是否成为当前 activeElement",
    ],
  },
  {
    name: "hover-el",
    lines: [
      "hover-el <tabId> <i|el-json> [--label <text>]",
      "悬停（mouseover/mouseenter/mousemove）；用于悬停触发的下拉/气泡/懒加载",
    ],
  },
  {
    name: "key-el",
    lines: [
      "key-el <tabId> <key> [<i|el-json>] [--modifiers ctrl,shift|0-15]",
      "按键（异步；扩展 0.16.0+ 支持）；key=Enter/a/ArrowUp 等；省略 el 打到 document.body；--modifiers 逗号名单或位掩码（Alt1|Ctrl2|Meta4|Shift8）",
    ],
  },
  {
    name: "list",
    lines: ["list", "列出所有标签页：tabId/标题/URL——一切后续命令的 tabId 从这里拿"],
  },
  {
    name: "longpress-el",
    lines: [
      "longpress-el <tabId> <i|el-json> [--hold <ms>]",
      "长按（异步；扩展 0.16.0+ 支持）；pointerdown/mousedown → 按住 hold 毫秒 → up；省略 --hold 默认 600ms；长按在部分站点弹上下文菜单/进多选",
    ],
  },
  {
    name: "media-el",
    lines: [
      "media-el <tabId> <i|el-json> [play|pause|mute|unmute]",
      "媒体控制（play/pause/mute/unmute）；缺省 play；目标是 <audio>/<video> 元素",
    ],
  },
  {
    name: "navigate",
    lines: [
      "navigate <tabId> <url>",
      "复用已有标签页导航到新 URL；默认等 load 完成，--nowait 跳过等待",
    ],
  },
  {
    name: "open",
    lines: ["open <url>", "开新标签页；默认等 load 完成，返回 loaded；--nowait 跳过等待"],
  },
  {
    name: "open-frame",
    lines: [
      "open-frame <tabId> '<url-regex>'",
      "把匹配的子帧开成顶层标签——跨源 iframe 内容回退",
    ],
  },
  {
    name: "rightclick-el",
    lines: [
      "rightclick-el <tabId> <i|el-json> [--label <text>]",
      "右键（contextmenu, button 2）；用于触发站点自定义上下文菜单",
    ],
  },
  {
    name: "run",
    lines: [
      "run <tabId> '<js-expression>'",
      "Runtime.evaluate 跑页内 JS；默认 awaitPromise 等 promise 落定，--sync 不等；返回 CDP 包装 {result:{type,value}}，从 .result.value 取值",
    ],
  },
  {
    name: "scroll-el",
    lines: [
      "scroll-el <tabId> [<i|el-json|{\"sel\":\"css\"}>] [--delta <px>] [--hscroll]",
      "滚动：省略 el 做页面级滚动（target=document.body）；--hscroll 水平轴（轮播/可滚容器）；省略 --delta 则 into-view 滚入视口；el 可为 collect-elements 索引或 {\"sel\":\"css\"} 直接定位容器（overflow-x 的 div 不在 collect-elements 候选里）",
    ],
  },
  {
    name: "select-el",
    lines: [
      "select-el <tabId> <i|el-json> <value>",
      "给 <select> 选一个 option（value = option 的 value）；派发 change/input",
    ],
  },
  {
    name: "select-text-el",
    lines: [
      "select-text-el <tabId> <i|el-json|{\"sel\":\"css\"}> [text]",
      "选中元素内文本（省略 text = 选全部；子串可跨 text-node）落入 selection；复制流随后 run `document.execCommand('copy')`（合成 Ctrl+C 不进剪贴板）",
    ],
  },
  {
    name: "serve",
    lines: [
      "serve [session] [--shared]",
      "常驻 bridge：持有 WS 端口 + 保活扩展 SW，注册 data/bridges/<session>.json；session 省略时自动生成并打印。one-shot 发现顺序：--session/WB_SESSION 指定桥 → 其它活桥（最新优先）→ 直连慢路径；多会话各起各的 serve 互不覆盖。--shared 额外写 data/bridge.json 兼容遗留脚本。Ctrl+C 退出",
    ],
  },
  {
    name: "setfile",
    lines: [
      "setfile <tabId> <selector> <file-path> [file-path ...]",
      "先检查本地普通文件，要求唯一 input[type=file]，赋值后核对 FileList；页面上传成功须另设等待条件",
    ],
  },
  {
    name: "collect-elements",
    lines: [
      "collect-elements <tabId> [--max N]",
      "枚举可交互元素 [{i,tag,role,label,ref}]；ref 绑定当前文档中的节点，失效时拒绝而不回退索引",
    ],
  },
  {
    name: "status",
    lines: [
      "status",
      "有界健康探测：总时限 1.8 秒；多桥时逐个试连，任一桥可达即返回",
    ],
  },
  {
    name: "swipe-el",
    lines: [
      "swipe-el <tabId> <from-i|json> <to-i|json|sel-json>",
      "触摸滑动（touchstart→touchmove×4→touchend）：移动端模拟/下拉刷新/触摸轮播；from/to 是 collect-elements 索引或 {\"sel\":\"css\"}",
    ],
  },
  {
    name: "touch-el",
    lines: [
      "touch-el <tabId> <i|el-json> [--label <text>]",
      "合成触摸点按（touchstart/touchend）；面向触摸事件站点（桌面 Chrome 主要靠合成事件驱动触屏逻辑）",
    ],
  },
  {
    name: "type-el",
    lines: [
      "type-el <tabId> <i|el-json> <text> [--clear] [--label <text>]",
      "按索引键入，兼容受控组件（native value setter + input/change 事件）；--clear 先清空；<i> 来自 collect-elements 条目，旧的完整 JSON 写法仍兼容",
    ],
  }
];

const FOOTER = [
  "选项: --wait <ms>  --keep  --max <N>  --clear  --label <text>  --param k=v  --sync  --nowait  --client-id <id>  --trigger-js <expr>  --session <sid>  --browser-id <id>  --allow-failover  --shared  --force  --dry  --hold <ms>  --delta <px>  --modifiers <ctrl,shift|0-15>  --hscroll",
  "目标选择: --session/WB_SESSION 严格限定会话，失联报 NO_BRIDGE；只有 --allow-failover 显式允许跨会话。--browser-id/WB_BROWSER_ID 在业务命令前校验 diag.browserId，不匹配报 BROWSER_MISMATCH；--keep 注册临时会话桥。browserId 仅用于本机路由校验，不是身份认证凭据",
];

const NAMES = COMMANDS.map((c) => c.name);

function renderUsage(binName = "agent-collect.js") {
  const lines = ["用法:"];
  for (const command of COMMANDS) {
    lines.push("  " + binName + " " + command.lines[0]);
    for (const extra of command.lines.slice(1)) lines.push("     " + extra);
  }
  return lines.concat(FOOTER).join("\n");
}

// SKILL.md 用的表格视图：命令名称 / 参数 / 用途。与 renderUsage 同源（COMMANDS/FOOTER），
// 由本文件的 usage:sync 入口（npm run usage:sync）写入 SKILL.md，test-commands.js 精确钉死。
function renderList() {
  const esc = (s) => s.replace(/\|/g, "\\|");
  const rows = COMMANDS.map((command) => {
    const parts = command.lines[0].split(/\s+/);
    const name = esc(parts[0]);
    const args = esc(parts.slice(1).join(" ")) || "—";
    const note = esc(command.lines.slice(1).join(""));
    return "| `" + name + "` | `" + args + "` | " + note + " |";
  });
  const head = "| 命令 | 参数 | 用途 |\n|---|---|---|";
  return head + "\n" + rows.join("\n") + "\n\n" + FOOTER.map((f) => "- " + f).join("\n");
}

// 用法块同步（原 scripts/sync-usage.js，已并入本模块——命令表的源头自己负责再生成
// 提示词，开发工具不再单独占一个目录）：把 renderList() 输出写回 SKILL.md 的
// <!-- usage:start/end --> 标记区间。命令表是单一来源，提示词只是再生成物；漂移由
// test-commands.js 的精确比对守住，失败时跑 npm run usage:sync 修复。
function syncUsageToSkill() {
  const fs = require("fs");
  const path = require("path");
  const skillPath = path.join(__dirname, "..", "SKILL.md");
  const START = "<!-- usage:start -->";
  const END = "<!-- usage:end -->";
  let s = fs.readFileSync(skillPath, "utf8");
  if (!s.includes(START) || !s.includes(END)) {
    throw new Error("SKILL.md 缺 " + START + " / " + END + " 标记");
  }
  const block = renderList();
  s =
    s.slice(0, s.indexOf(START) + START.length) +
    "\n" +
    block +
    "\n" +
    s.slice(s.indexOf(END));
  fs.writeFileSync(skillPath, s);
  console.log("usage block synced（" + block.split("\n").length + " 行）→ " + skillPath);
}

module.exports = { COMMANDS, FOOTER, NAMES, renderUsage, renderList, syncUsageToSkill };

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv[0] !== "usage:sync") {
    console.error("用法: node agent/commands.js usage:sync   （等价于 npm run usage:sync）");
    process.exit(2);
  }
  syncUsageToSkill();
}
