"use strict";
// synapse 的路径集中配置：用户数据根 / 桥注册表 / 维护锁 / 扩展根目录。
//
// 设计原则：**安装目录只读，用户数据放用户目录**。
// 早先 DATA_ROOT 默认落在 <skill>/data —— 装到 Program Files 或由包管理器管理时
// 那里不可写，升级还会把数据一起覆盖掉。
//
// 数据根解析顺序（从高到低）：
//   1. WB_DATA_DIR          环境变量（CI / 临时覆盖）
//   2. config.json 的 dataRoot（用户首次使用时用 `config set data-root` 指定）
//   3. 平台默认目录
//
// 同一份文件要能同时放在两种布局下：
//   ① 独立 skill   <repo>/synapse/
//   ② cdp 内 vendored <cdp>/extension/native-host/
// 所以不按 __dirname 的相对深度硬推，而是向上找含 SKILL.md 的目录作为 skill 根。
const fs = require("fs");
const path = require("path");
const os = require("os");

// 向上找含 SKILL.md 的目录 = skill 根。找不到（例如被单独拷走后）退回上一级。
function findSkillRoot(start) {
  let dir = path.resolve(start);
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, "SKILL.md"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return path.join(start, "..");
}

const SKILL_ROOT = path.resolve(findSkillRoot(__dirname));
// siblings 目录：<skills>/ ；扩展本体是它的同级 skill。
const SKILLS_DIR = path.dirname(SKILL_ROOT);

// 平台默认数据目录（不含 <data> 子层，直接就是应用目录）。
function defaultDataRoot() {
  if (process.platform === "win32") {
    const base =
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "Synapse");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Synapse");
  }
  const xdg = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(xdg, "synapse");
}

// 配置文件固定在平台默认目录下，与 dataRoot 解耦：
// 否则"配置里写着 dataRoot，而配置本身存在 dataRoot 里"会形成循环依赖。
const CONFIG_FILE = process.env.WB_CONFIG_FILE
  ? path.resolve(process.env.WB_CONFIG_FILE)
  : path.join(defaultDataRoot(), "config.json");

function readConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch (_) {
    return {};
  }
}

function writeConfig(patch) {
  const next = Object.assign({}, readConfig(), patch, {
    updatedAt: new Date().toISOString(),
  });
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2) + "\n", "utf8");
  return next;
}

function resetConfig(keys = ["dataRoot", "outputDir"]) {
  const cfg = readConfig();
  for (const k of keys) delete cfg[k];
  cfg.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  return cfg;
}

// 返回 { value, source }：source 告诉调用方这个路径是谁定的。
function resolveDataRoot(config = readConfig()) {
  if (process.env.WB_DATA_DIR) {
    return { value: path.resolve(process.env.WB_DATA_DIR), source: "env:WB_DATA_DIR" };
  }
  if (typeof config.dataRoot === "string" && config.dataRoot.trim()) {
    return { value: path.resolve(config.dataRoot), source: "config:dataRoot" };
  }
  return { value: defaultDataRoot(), source: "default" };
}

const DATA_RESOLVED = resolveDataRoot();
const DATA_ROOT = DATA_RESOLVED.value;

// 采集产物根：agent 可以用 --out 决定；默认 <data>/output。
function resolveOutputRoot(config = readConfig(), dataRoot = DATA_ROOT) {
  if (process.env.SYNAPSE_OUTPUT_DIR) {
    return { value: path.resolve(process.env.SYNAPSE_OUTPUT_DIR), source: "env:SYNAPSE_OUTPUT_DIR" };
  }
  if (typeof config.outputDir === "string" && config.outputDir.trim()) {
    return { value: path.resolve(config.outputDir), source: "config:outputDir" };
  }
  return { value: path.join(dataRoot, "output"), source: "default" };
}
const OUTPUT_ROOT = resolveOutputRoot().value;

// 桥注册表目录（多会话）：<data>/bridges
const BRIDGE_DIR = process.env.WB_BRIDGE_DIR
  ? path.resolve(process.env.WB_BRIDGE_DIR)
  : path.join(DATA_ROOT, "bridges");

// 遗留单文件桥记录：<data>/bridge.json
const BRIDGE_FILE = process.env.WB_BRIDGE_FILE
  ? path.resolve(process.env.WB_BRIDGE_FILE)
  : path.join(DATA_ROOT, "bridge.json");

// 首次运行时把目录建好（写入失败时由调用方决定是否致命）。
function ensureDataDirs(config = readConfig()) {
  // 按"当前配置"重新解析，而不是用模块加载时的快照：
  // config set 之后立刻生效，不会把目录建到旧路径上。
  const data = resolveDataRoot(config).value;
  const output = resolveOutputRoot(config, data).value;
  const bridgeDir = path.join(data, "bridges");
  for (const dir of [data, bridgeDir, output]) fs.mkdirSync(dir, { recursive: true });
  return { dataRoot: data, bridgeDir, outputDir: output };
}

// 当前生效的路径与来源，供 `config` 命令与 doctor 诊断输出。
function describePaths() {
  const config = readConfig();
  const data = resolveDataRoot(config);
  const output = resolveOutputRoot(config, data.value);
  return {
    configFile: CONFIG_FILE,
    dataRoot: data,
    outputDir: output,
    bridgeDir: path.join(data.value, "bridges"),
    skillRoot: SKILL_ROOT,
  };
}

// doctor 硬刷用的扩展根目录（含 manifest.json 的 unpacked 扩展）。
// 解析顺序：WB_CDP_EXT_DIR → 同级 cdp/extension → cdp-browser/extension →
// ~/.dsh/skills/cdp-browser/extension → 报错
function resolveExtDir() {
  if (process.env.WB_CDP_EXT_DIR) {
    const dir = path.resolve(process.env.WB_CDP_EXT_DIR);
    if (!fs.existsSync(path.join(dir, "manifest.json"))) {
      throw new Error(
        "WB_CDP_EXT_DIR=" +
          dir +
          " 下没有 manifest.json（应指向含 manifest.json 的扩展根目录，不是 src/ 等子目录）",
      );
    }
    return dir;
  }
  const candidates = [
    path.join(SKILLS_DIR, "cdp", "extension"),
    path.join(SKILLS_DIR, "cdp-browser", "extension"),
    path.join(os.homedir(), ".dsh", "skills", "cdp-browser", "extension"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "manifest.json"))) return c;
  }
  throw new Error(
    "找不到 unpacked 扩展根目录。doctor 硬刷需要 WB_CDP_EXT_DIR 指向含 manifest.json 的目录" +
      "（候选：" +
      candidates.join(" | ") +
      "）",
  );
}

module.exports = {
  SKILL_ROOT,
  SKILLS_DIR,
  DATA_ROOT,
  OUTPUT_ROOT,
  BRIDGE_DIR,
  BRIDGE_FILE,
  CONFIG_FILE,
  defaultDataRoot,
  readConfig,
  writeConfig,
  resetConfig,
  resolveDataRoot,
  resolveOutputRoot,
  describePaths,
  ensureDataDirs,
  resolveExtDir,
};
