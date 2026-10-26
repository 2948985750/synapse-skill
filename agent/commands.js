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
  {
    name: "list",
    lines: ["list", "列出所有标签页：tabId/标题/URL——一切后续命令的 tabId 从这里拿"],
  },
  {
    name: "navigate",
    lines: [
      "navigate <tabId> <url>",
      "复用已有标签页导航到新 URL；默认等 load 完成，--nowait 跳过等待",
    ],
  },
  {
    name: "cdp",
    lines: [
      "cdp <tabId> <method> ['<params-json>'|@file] [--param k=v ...]",
      "任意 CDP 方法透传；@file 免 shell 引号，--param k=v 可追加/覆盖 params 里的键，JS 对象无序列化损耗",
    ],
  },
  {
    name: "run",
    lines: [
      "run <tabId> '<js-expression>'",
      "Runtime.evaluate 跑页内 JS；默认 awaitPromise 等 promise 落定，--sync 不等",
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
    name: "close",
    lines: [
      "close <tabId>",
      "关闭标签页；discover 自管标签生命周期，这条一般只在手工交互时用",
    ],
  },
  {
    name: "setfile",
    lines: [
      "setfile <tabId> <selector> <file-path>",
      "给 input[type=file] 塞本地文件，走 CDP DOM.setFileInputFiles",
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
    name: "config",
    lines: [
      "config [set <key> <dir> | reset]",
      "显示数据目录与来源；config set data-root <dir> 指定数据根、config set output-dir <dir> 指定采集产物根、config set profile-root <dir> 指定画像根；config reset 清掉自定义路径回到默认。纯本地命令，不需要连桥",
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
    name: "doctor",
    lines: [
      "doctor [--wait <ms>] [--force] [--force-kill] [--dry]",
      "链路医生 + 多会话协调恢复：快查 → 礼貌等待 SW 重拨（探针端口/活桥，默认 --wait 60s）→ 锁协调硬刷（data/maintenance.lock.json，同一时刻只有一个会话执行 taskkill+清缓存+重启 Edge，排上的会话等锁释放后复查健康）。多会话恢复统一走 doctor，不要各自手杀 Edge；--force 跳过等待，--dry 只打印计划",
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
    name: "snapshot",
    lines: [
      "snapshot <tabId> [--max N]",
      "索引化动作空间：枚举可交互控件 [{i,tag,role,label}]",
    ],
  },
  {
    name: "click-el",
    lines: [
      "click-el <tabId> <i|el-json> [--label <text>]",
      "按 snapshot 索引点击；--label 参与漂移校验（索引越界/label 变了会拒绝执行）",
    ],
  },
  {
    name: "type-el",
    lines: [
      "type-el <tabId> <i|el-json> <text> [--clear] [--label <text>]",
      "按索引键入，兼容受控组件（native value setter + input/change 事件）；--clear 先清空；<i> 来自 snapshot 条目，旧的完整 JSON 写法仍兼容",
    ],
  },
];

const FOOTER = [
  "选项: --wait <ms>  --keep  --max <N>  --clear  --label <text>  --param k=v  --sync  --nowait  --client-id <id>  --trigger-js <expr>  --session <sid>  --shared  --force  --force-kill  --dry",
  "多会话: WB_SESSION=<sid>（本会话 one-shot 优先走 data/bridges/<sid>.json）；--keep 也会注册为临时会话桥（注册表条目 + 允许多客户端），供同会话后续 one-shot 毫秒级复用",
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

// SKILL.md 用的无序列表视图：`shape` —— 说明。与 renderUsage 同源（COMMANDS/FOOTER），
// 由本文件的 usage:sync 入口（npm run usage:sync）写入 SKILL.md，test-commands.js 精确钉死。
function renderList() {
  const items = COMMANDS.map((command) => {
    const shape = command.lines[0];
    const note = command.lines.slice(1).join("");
    return "- `" + shape + "`" + (note ? " —— " + note : "");
  });
  return items.concat(FOOTER.map((f) => "- " + f)).join("\n");
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
