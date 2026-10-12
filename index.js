/**
 * dsh-hindsight-bank-router — 把 Hindsight 编码插件的 bank 身份锚定到【远程仓库】，
 * 而不是【本地目录名】。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────
 * @vectorize-io/hindsight-coding-agents 的 bank 名来自模板
 * `coding-agent::{gitProject}`，而 `{gitProject}` 的取值逻辑（源码 core/bank.ts
 * 的 resolveProjectRoot）是：
 *
 *     if (basename(commonDir) === ".git") return { root: dirname(commonDir) };
 *     ... {gitProject} = basename(root)
 *
 * 即**只读磁盘上的目录名，从不读 remote.origin.url**。后果是同一个仓库因各人
 * `git clone` 得到的目录名不同而分叉成多个互不相通的 bank，且**完全静默**：
 *
 *     你:   git clone → payments-app       → coding-agent::payments-app
 *     同事: git clone → mobile-client    → coding-agent::mobile-client
 *
 * 两者都"正常工作"，记忆却永不交汇。上游把这种静默分叉视为最严重的失败模式
 * （见 git-layout.ts 注释与 issue #3950），但它的解法只覆盖了 worktree 场景，
 * 没覆盖"同一仓库、不同本地目录名"。
 *
 * ── 本插件的做法 ──────────────────────────────────────────────────────
 * 不动 hindsight 插件本身，只喂给它一份**动态生成的 `mapPathToBank`**：
 *
 *   1. 扫描配置的根目录，找出所有 git 仓库
 *   2. 直接解析 `.git/config` 取 remote.origin.url（**绝不 spawn git**）
 *   3. 由远程 URL 推导稳定的 bank 名（`team::<repo>`）
 *   4. 安全合并进 ~/.hindsight/coding-agent.json 的 mapPathToBank
 *
 * 可行性依据（hindsight 源码）：
 *   - `readRaw()` 每次调用都 `readFileSync` 重新读文件，**没有缓存**
 *   - `workspaceFor(root)` 按工作区**懒加载**并在首次会话时构建
 *   → 只要在本插件于进程启动时写入，hindsight 后续解析就会读到
 *
 * ── 为什么不 spawn git ────────────────────────────────────────────────
 * 上游 git-layout.ts 明确记录了删除 spawn 实现的原因：`git rev-parse` 带 1000ms
 * 预算，在机器繁忙时会超时、进程压力下会 `EAGAIN`，两种失败都把结果映射为
 * null —— 与"不是仓库"无法区分，于是把 worktree 分叉进自己的 bank（#3950）。
 * 直接读 .git/config 是纯文件读取：无子进程、无超时、不会因负载失败。
 *
 * ── 安全约束（本插件的核心承诺）────────────────────────────────────────
 *   1. **绝不覆盖用户手工写的映射** —— 用 sidecar state 文件记录自己管理过哪些
 *      路径；删除时只有当该条目的值仍等于我们当初写入的值才动手
 *   2. **无变化不写盘** —— 合并结果与现状相同则完全不动文件，避免无谓的
 *      文件监视触发与 mtime 抖动
 *   3. **失败开放** —— 任何异常只记日志，绝不阻断 DSH 启动或会话
 *   4. **原子写入** —— 临时文件 + rename，保留 0600 权限
 *   5. **非 git 目录不碰** —— 保持 hindsight 的默认回退（当作个人记忆）
 *
 * @module dsh-hindsight-bank-router
 */

import {
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
  lstatSync,
  mkdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";

/** Cordis 插件名（用于加载器诊断）。 */
export const name = "dsh-hindsight-bank-router";

/** 不依赖任何服务：启动时执行，只读写文件。 */
export const inject = [];

// ── 默认值 ──────────────────────────────────────────────────────────────

/** hindsight 插件的配置文件（与 core/config.ts 的 CONFIG_PATH 保持一致）。 */
const DEFAULT_CONFIG_PATH = join(homedir(), ".hindsight", "coding-agent.json");

/** 本插件自己的状态文件，记录"哪些 mapPathToBank 条目是我写的"。 */
const DEFAULT_STATE_PATH = join(homedir(), ".hindsight", ".bank-router-state.json");

/** 用户级的工作区覆盖目录（`~/.hindsight/workspaces/`）。 */
const DEFAULT_USER_WORKSPACE_DIR = join(homedir(), ".hindsight", "workspaces");

/**
 * 工作区级覆盖文件名。**在两处查找**，按优先级：
 *   ① <工作区>/.hindsight.json      —— 仓库自带，方便团队随仓库分发
 *   ② <用户目录>/workspaces/*.json   —— 用户自己控制，仓库克隆无法影响
 *
 * ⚠️ ① 触碰了上游明确反对的模式。上游文档原话：
 *     "There is no per-repo opt-in file, for the same reason there is no
 *      repo-carried config at all: a cloned repository must not be able to
 *      turn memory on."
 *   理由是一个克隆下来的仓库不应能决定你的记忆行为（fail-closed）。
 *   本插件保留 ① 是为了团队随仓库统一 bank 命名的便利，但用户级目录 ②
 *   永远优先于它 —— 即：仓库想改你的 bank，你自己在 ② 里写一条就能推翻。
 *   若你完全不接受该风险，设 `allowRepoConfig: false` 关闭 ①。
 */
const WORKSPACE_CONFIG_NAME = ".hindsight.json";

/** git 仓库的 bank 前缀：身份来自远程仓库名。 */
const DEFAULT_GIT_PREFIX = "git::";

/** 非 git 目录的 bank 前缀：身份来自目录名，属个人记忆。 */
const DEFAULT_WORKSPACE_PREFIX = "workspace::";

/** 扫描根目录时的最大递归深度。 */
const DEFAULT_MAX_DEPTH = 3;

/**
 * 非 git 目录是否也生成映射。
 *
 * true  → 为每个非 git 工作区写 `workspace::<目录名>`，把它从 hindsight 默认的
 *         `coding-agent::<目录名>` 显式接管过来。好处是命名空间清晰
 *         （一眼看出是个人记忆而非团队共享），且不受 hindsight 模板变动影响。
 * false → 不生成，让它们走 hindsight 默认回退（等价于当前行为）。
 */
const DEFAULT_ROUTE_NON_GIT = true;

/** 扫描时跳过的目录名（避免走进庞大的无关树）。 */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "vendor",
  "dist",
  "build",
  "target",
  ".venv",
  "venv",
  "__pycache__",
  "Library",
  ".Trash",
  "Pods",
  ".gradle",
  ".idea",
  ".vscode",
]);

// ── 工具函数 ────────────────────────────────────────────────────────────

/** `~` 展开 + 归一化，去掉尾部斜杠。 */
function configuredDir(dir) {
  const expanded = dir === "~" || dir.startsWith("~/") ? join(homedir(), dir.slice(1)) : dir;
  const abs = isAbsolute(expanded) ? expanded : resolve(expanded);
  return normalize(abs).replace(new RegExp(`\\${sep}+$`), "");
}

/** 读取文件，失败返回 null（ENOENT 之类的都当作"没有"）。 */
function readTextOrNull(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** 解析 JSON，失败返回 null 并记录原因。 */
function readJsonOrNull(path, logger) {
  const text = readTextOrNull(path);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    logger?.warn?.(`dsh-hindsight-bank-router: 忽略无法解析的 JSON (${path}): ${String(error)}`);
    return null;
  }
}

/** lstat 简化为三种答案之一。 */
function entryKind(path) {
  try {
    const st = lstatSync(path);
    return st.isDirectory() ? "dir" : "file";
  } catch {
    return "none";
  }
}

/**
 * 从 `.git/config` 的文本里取出 remote.origin.url。
 *
 * 手写解析而非引入 ini 库：格式简单且稳定，且本插件刻意保持零依赖。
 * 只认 `[remote "origin"]` 段内的第一个 `url =`，与 git 自身的优先级一致。
 */
function remoteUrlFromConfig(text) {
  if (!text) return null;
  let inOrigin = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;

    const section = /^\[(.+?)\]$/.exec(line);
    if (section) {
      // 兼容 [remote "origin"] 与 [remote.origin] 两种写法
      const inner = section[1].trim();
      inOrigin = /^remote\s+"origin"$/i.test(inner) || /^remote\.origin$/i.test(inner);
      continue;
    }
    if (!inOrigin) continue;

    const kv = /^url\s*=\s*(.+)$/i.exec(line);
    if (kv) return kv[1].trim();
  }
  return null;
}

/**
 * 定位一个仓库的**公共 git 目录**（worktree 感知），全程只读文件。
 *
 *   <main>/.git/                      目录 → 就是它
 *   <wt>/.git                        文件 → "gitdir: <main>/.git/worktrees/<name>"
 *                                           再读其 commondir（"../.."）得到 <main>/.git
 *   <repo>.git/                      裸仓库 → 就是它
 *
 * 返回绝对路径，或 null。
 */
function resolveCommonGitDir(dotGitPath) {
  const kind = entryKind(dotGitPath);

  if (kind === "dir") {
    const common = join(dotGitPath, "commondir");
    const pointer = entryKind(common) === "file" ? readTextOrNull(common)?.trim() : null;
    if (pointer) return isAbsolute(pointer) ? normalize(pointer) : resolve(dotGitPath, pointer);
    return dotGitPath;
  }

  if (kind === "file") {
    const text = readTextOrNull(dotGitPath);
    if (!text) return null;
    const m = /^\s*gitdir:\s*(.+?)\s*$/m.exec(text);
    if (!m) return null;
    const target = m[1];
    const gitDir = isAbsolute(target) ? normalize(target) : resolve(dirname(dotGitPath), target);

    // worktree 的 gitDir 里有 commondir 指向主仓库
    const common = join(gitDir, "commondir");
    const pointer = entryKind(common) === "file" ? readTextOrNull(common)?.trim() : null;
    if (pointer) return isAbsolute(pointer) ? normalize(pointer) : resolve(gitDir, pointer);
    return gitDir;
  }

  return null;
}

/**
 * 由远程 URL 推导 bank 名。
 *
 *   https://host/a/b/repo.git     → repo
 *   git@host:a/b/repo.git         → repo
 *   ssh://git@host/a/repo         → repo
 *   https://host/a/my%20repo.git  → my-repo
 *   https://host/a/中文仓库.git     → 中文仓库
 *
 * 取最后一段路径、去掉 .git 后缀、清理不安全字符。
 * 无远程地址时返回 null —— 此时**不生成映射**，让 hindsight 走它自己的回退。
 */
function bankNameFromRemote(url, prefix) {
  if (!url) return null;
  let s = url.trim();

  // scp 风格 git@host:path → 统一成 path 部分
  const scp = /^[^/@\s]+@[^/:\s]+:(.+)$/.exec(s);
  if (scp) {
    s = scp[1];
  } else {
    try {
      const u = new URL(s);
      s = u.pathname;
    } catch {
      // 不是标准 URL，当作裸路径处理（本地路径 remote 也常见）
    }
  }

  // ⚠️ 必须先解码再做字符清理：`new URL()` 会把空格转成 `%20`、把中文转成
  // `%E4%B8%AD…`。若直接过字符白名单，`my repo` 会变成 `my-20repo`、中文
  // 仓库名会变成一串 `-E4-B8-AD` 乱码。decodeURIComponent 对未编码的字符串
  // 是恒等操作，因此无需判断"是否已编码"。解码可能对畸形百分号序列抛错，
  // 此时保留原串继续，而不是放弃整个映射。
  try {
    s = decodeURIComponent(s);
  } catch {
    /* 畸形编码：保留原串 */
  }

  const segments = s.split(/[/\\]+/).filter(Boolean);
  if (segments.length === 0) return null;
  let last = segments[segments.length - 1];
  if (last.endsWith(".git")) last = last.slice(0, -4);
  if (!last) return null;

  // 白名单保留：Unicode 字母数字（\p{L}\p{N}，含中文/日文/韩文）、下划线、
  // 点、连字符。其余字符替换为 -，再压缩连续的 -。
  // 用 \p{L}\p{N} 而非 \w，是为了让 CJK 仓库名原样保留而不是被清成乱码。
  const safe = last
    .replace(/[^\p{L}\p{N}_.-]+/gu, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  if (!safe) return null;

  return `${prefix}${safe}`;
}

/**
 * 读取工作区级 `.hindsight.json`，取出其中的 bankId。
 *
 * 查找顺序（**用户级优先**，见 WORKSPACE_CONFIG_NAME 的说明）：
 *   ① <用户目录>/workspaces/<basename>.json
 *   ② <工作区>/.hindsight.json        ← 可被 allowRepoConfig 关闭
 *
 * 接受两种写法：
 *   { "bankId": "git::mobile-client" }     ← 推荐
 *   { "bank":   "git::mobile-client" }     ← 兼容 hindsight 的 banks.<id>.bank 用词
 *
 * 返回 bankId 字符串；文件不存在、解析失败、或字段为空/非字符串 → 返回 null
 * （表示"没有显式指定"，交由后续步骤推导，而不是中断整个路由）。
 */
function readWorkspaceOverride(workspaceDir, settings, logger) {
  const candidates = [
    join(settings.userWorkspaceDir, `${basename(workspaceDir)}.json`),
  ];
  if (settings.allowRepoConfig) {
    candidates.push(join(workspaceDir, WORKSPACE_CONFIG_NAME));
  }

  for (const path of candidates) {
    const raw = readJsonOrNull(path, logger);
    if (raw === null) continue;

    const value = raw.bankId ?? raw.bank;
    if (typeof value === "string" && value.trim()) {
      logger?.debug?.(
        `dsh-hindsight-bank-router: ${workspaceDir} 使用显式 bankId "${value.trim()}"（来自 ${path}）`
      );
      return value.trim();
    }
    // 文件存在但没给 bankId —— 记一笔，避免"写了却没生效"的静默困惑
    logger?.debug?.(
      `dsh-hindsight-bank-router: ${path} 存在但未提供 bankId/bank 字段，继续按默认规则推导`
    );
  }
  return null;
}

/**
 * 递归扫描根目录，为每个工作区决定 bank 名。
 *
 * **优先级链**（严格按此顺序，第一个命中者胜出）：
 *   ① 工作区 `.hindsight.json` 的 bankId    —— 显式指定，最高优先
 *   ② git 仓库 → `<gitPrefix><远程仓库名>`   —— 锚定客观身份，可团队共享
 *   ③ git 仓库但无 origin                   —— 不生成映射，交回 hindsight 默认
 *   ④ 非 git 目录 → `<wsPrefix><目录名>`     —— 个人记忆（可关）
 *
 * 深度受限，跳过 SKIP_DIRS；**发现 git 仓库后不再深入该目录**
 * （仓库内嵌套仓库极罕见，且会把扫描成本放大）。
 */
function scanRepos(settings, logger) {
  const { roots, maxDepth, gitPrefix, workspacePrefix, routeNonGit } = settings;
  const found = new Map();

  function walk(dir, depth) {
    if (depth > maxDepth) return;

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 权限不足或不存在的目录，静默跳过
    }

    const dirKey = normalize(dir);
    const hasGit = entries.some((e) => e.name === ".git");

    // ① 显式指定最高优先 —— 无论是否 git 仓库都先看它
    const override = readWorkspaceOverride(dir, settings, logger);
    if (override) {
      found.set(dirKey, override);
      if (hasGit) return; // 已是仓库根，不再向下
    } else if (hasGit) {
      // ② / ③ git 仓库：锚定远程仓库名
      const commonDir = resolveCommonGitDir(join(dir, ".git"));
      if (commonDir) {
        const cfgText = readTextOrNull(join(commonDir, "config"));
        const bank = bankNameFromRemote(remoteUrlFromConfig(cfgText), gitPrefix);
        if (bank) {
          found.set(dirKey, bank);
        } else {
          logger?.debug?.(
            `dsh-hindsight-bank-router: ${dir} 是 git 仓库但无 origin 远程地址 —— 不生成映射`
          );
        }
        return; // 是仓库，不再向下递归
      }
    }

    // 递归子目录
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith(".") && entry.name !== ".config") continue;
      walk(join(dir, entry.name), depth + 1);
    }
  }

  // 根目录自身算 depth 0：这样 maxDepth=1 恰好检查根目录的**直接子目录**，
  // 与配置注释里「1 = 只扫根目录的直接子目录」一致。若从 1 起算，
  // 直接子目录会落到 depth=2 而被 `depth > maxDepth` 挡掉，什么都扫不到。
  for (const root of roots) {
    if (entryKind(root) !== "dir") continue;

    // 根目录本身也可能是一个工作区（有 .git 或 .hindsight.json），先处理它
    const override = readWorkspaceOverride(root, settings, logger);
    if (override) {
      found.set(normalize(root), override);
    } else if (entryKind(join(root, ".git")) !== "none") {
      const commonDir = resolveCommonGitDir(join(root, ".git"));
      const bank = commonDir
        ? bankNameFromRemote(
            remoteUrlFromConfig(readTextOrNull(join(commonDir, "config"))),
            gitPrefix
          )
        : null;
      if (bank) found.set(normalize(root), bank);
    }

    // ④ 非 git 目录：仅对**根目录的直接子目录**生效（即"一个子目录 = 一个工作区"）。
    //    不递归为任意深度的目录建映射，否则会产出大量无意义的 bank。
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith(".") && entry.name !== ".config") continue;

      const child = join(root, entry.name);
      if (entryKind(join(child, ".git")) !== "none") continue; // git 仓库交给 walk 处理

      const childOverride = readWorkspaceOverride(child, settings, logger);
      if (childOverride) {
        found.set(normalize(child), childOverride);
      } else if (routeNonGit) {
        const name = sanitizeBankSegment(entry.name);
        if (name) found.set(normalize(child), `${workspacePrefix}${name}`);
      }
    }

    // 再深入子树找 git 仓库（walk 内部不会为非 git 目录建映射）。
    //
    // ⚠️ 必须从 depth **0** 起算，与上方注释一致：`walk` 内部的守卫是
    // `depth > maxDepth`，root 记为 0 时 maxDepth=1 恰好覆盖 root 的**直接
    // 子目录**。若从 1 起算，直接子目录会落到 depth=2 而被挡掉，git 仓库
    // 一个都扫不到（这是重构时实际引入过的 bug：found 恒为 0）。
    walk(root, 0);
  }

  return found;
}

/** 把任意字符串清理成可安全用作 bank 名片段的形态。 */
function sanitizeBankSegment(raw) {
  if (!raw) return null;
  const safe = String(raw)
    .replace(/[^\p{L}\p{N}_.-]+/gu, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return safe || null;
}

/**
 * 合并映射表 —— 本插件全部安全性的所在。
 *
 * 规则：
 *   - 从用户当前的 mapPathToBank 出发（**原样保留**）
 *   - 移除"我曾管理过、但现在不再有效"的条目 —— 仅当它的值仍等于我当初写的值
 *   - 写入本次扫描到的条目（覆盖同路径的旧值，因为那个路径本就归我管）
 *
 * 关键：用户手工改过的条目（值与我记录的不同）**永不被删除**。
 */
function mergeMap(currentMap, prevManaged, nextManaged, logger) {
  const merged = { ...(currentMap ?? {}) };
  let removed = 0;
  let added = 0;

  // 1. 清理不再有效的旧条目
  for (const [path, oldBank] of Object.entries(prevManaged ?? {})) {
    if (nextManaged.has(path)) continue;
    if (!(path in merged)) continue;
    if (merged[path] === oldBank) {
      delete merged[path];
      removed += 1;
    } else {
      logger?.info?.(
        `dsh-hindsight-bank-router: 保留 ${path} 的用户自定义映射 ` +
          `(${merged[path]}，我方原值 ${oldBank})`
      );
    }
  }

  // 2. 写入本次结果
  for (const [path, bank] of nextManaged) {
    if (merged[path] !== bank) added += 1;
    merged[path] = bank;
  }

  return { merged, removed, added };
}

/** 两个普通对象是否浅层相等（值都是字符串，够用）。 */
function shallowEqual(a, b) {
  const ka = Object.keys(a ?? {});
  const kb = Object.keys(b ?? {});
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
}

/** 原子写入：临时文件 + rename，权限 0600。 */
function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

// ── 配置 ────────────────────────────────────────────────────────────────

function readSettings(raw) {
  const cfg = raw !== null && typeof raw === "object" ? raw : {};
  const roots = (Array.isArray(cfg.roots) ? cfg.roots : [])
    .filter((r) => typeof r === "string" && r.trim())
    .map(configuredDir);

  return {
    // `enabled` 是本插件 Cordis 行的总开关；`enableBankRouter` 是写进
    // ~/.hindsight/coding-agent.json 的用户级开关。两者都必须为真才工作 ——
    // 前者由 DSH profile 控制，后者由用户自己的配置文件控制。
    enabled: cfg.enabled !== false,
    enableBankRouter: cfg.enableBankRouter !== false,
    dryRun: cfg.dryRun === true,
    roots,
    maxDepth: Number.isInteger(cfg.maxDepth) ? cfg.maxDepth : DEFAULT_MAX_DEPTH,
    gitPrefix: typeof cfg.gitPrefix === "string" ? cfg.gitPrefix : DEFAULT_GIT_PREFIX,
    workspacePrefix:
      typeof cfg.workspacePrefix === "string" ? cfg.workspacePrefix : DEFAULT_WORKSPACE_PREFIX,
    // 兼容旧的单前缀写法（team::）：若用户显式给了 bankPrefix，两个前缀都回退到它
    ...(typeof cfg.bankPrefix === "string"
      ? { gitPrefix: cfg.bankPrefix, workspacePrefix: cfg.bankPrefix }
      : {}),
    routeNonGit: cfg.routeNonGit !== false && DEFAULT_ROUTE_NON_GIT !== false,
    allowRepoConfig: cfg.allowRepoConfig !== false,
    userWorkspaceDir:
      typeof cfg.userWorkspaceDir === "string"
        ? configuredDir(cfg.userWorkspaceDir)
        : DEFAULT_USER_WORKSPACE_DIR,
    configPath: typeof cfg.configPath === "string" ? configuredDir(cfg.configPath) : DEFAULT_CONFIG_PATH,
    statePath: typeof cfg.statePath === "string" ? configuredDir(cfg.statePath) : DEFAULT_STATE_PATH,
  };
}

// ── 主流程 ──────────────────────────────────────────────────────────────

/**
 * 执行一次同步（扫描 + 合并 + 按需写盘）。
 *
 * 全程同步：`apply()` 在加载期调用，而 hindsight 的 bank 解析也发生在加载期之后的
 * 首次会话 —— 同步执行保证写入先于读取，不存在竞态。
 *
 * @returns 本次结果的摘要（供日志与测试断言）。
 */
export function syncOnce(settings, logger) {
  const summary = {
    scanned: 0,
    found: 0,
    added: 0,
    removed: 0,
    written: false,
    skipped: null,
  };

  if (!settings.enabled) {
    summary.skipped = "disabled";
    return summary;
  }
  if (settings.roots.length === 0) {
    summary.skipped = "no-roots";
    return summary;
  }

  // 先读目标配置 —— 两个目的：
  //   1. 取 `enableBankRouter` 开关（用户级总闸，写在 coding-agent.json 里）
  //   2. 拿到现有的 mapPathToBank 供合并
  // 顺序很重要：开关判定必须在任何扫描之前，关闭时连扫描都不做。
  const config = readJsonOrNull(settings.configPath, logger);
  if (config === null && entryKind(settings.configPath) === "file") {
    summary.skipped = "config-unparsable";
    return summary; // 配置文件存在但坏了：绝不覆盖，交给用户处理
  }
  const baseConfig = config ?? {};

  // `enableBankRouter` 必须**显式**为 true 才启用路由。
  // 与 Cordis 行的 `enabled` 是两个独立闸门：
  //   - Cordis `enabled`     由 DSH profile 控制（部署层面）
  //   - `enableBankRouter`   由用户自己的 coding-agent.json 控制（用户层面）
  // 两者都为真才工作；任一为假都彻底不动配置。
  const fileGate = baseConfig.enableBankRouter === true;
  const settingsGate = settings.enableBankRouter !== false;
  if (!fileGate || !settingsGate) {
    summary.skipped = fileGate ? "settings-disabled" : "enableBankRouter-not-true";
    logger?.debug?.(
      `dsh-hindsight-bank-router: 未启用（${summary.skipped}）—— ` +
        `请在 ${settings.configPath} 设置 "enableBankRouter": true`
    );
    return summary;
  }

  const found = scanRepos(settings, logger);
  summary.found = found.size;

  const state = readJsonOrNull(settings.statePath, logger) ?? {};
  const prevManaged = state.managed ?? {};

  const { merged, removed, added } = mergeMap(
    baseConfig.mapPathToBank,
    prevManaged,
    found,
    logger
  );
  summary.added = added;
  summary.removed = removed;

  const nextManaged = Object.fromEntries(found);
  const mapChanged = !shallowEqual(merged, baseConfig.mapPathToBank);
  const stateChanged = !shallowEqual(nextManaged, prevManaged);

  if (!mapChanged && !stateChanged) {
    logger?.debug?.("dsh-hindsight-bank-router: 映射已是最新，无需写盘");
    return summary;
  }

  if (settings.dryRun) {
    summary.skipped = "dry-run";
    logger?.info?.(
      `dsh-hindsight-bank-router: [dry-run] 将写入 ${found.size} 条映射 ` +
        `(+${added}/-${removed})，路径 ${settings.configPath}`
    );
    return summary;
  }

  // 写配置：保留文件里其它一切字段，只更新 mapPathToBank
  const nextConfig = { ...baseConfig, mapPathToBank: merged };
  atomicWriteJson(settings.configPath, nextConfig);
  atomicWriteJson(settings.statePath, { managed: nextManaged, updatedAt: new Date().toISOString() });
  summary.written = true;

  logger?.info?.(
    `dsh-hindsight-bank-router: 已同步 ${found.size} 条 bank 映射 (+${added}/-${removed}) → ${settings.configPath}`
  );
  for (const [path, bank] of found) logger?.debug?.(`  ${path} → ${bank}`);

  return summary;
}

/**
 * Cordis 入口。
 *
 * 时序说明：`apply()` 在插件加载期同步执行一次，覆盖**启动时已存在的**全部仓库
 * ——这正是主要场景，因为 hindsight 的 workspaceFor 是懒加载 + 按根缓存，我们的
 * 写入必定先于它的首次读取。
 *
 * 对**启动后新建/克隆**的仓库，额外在 `agent/session-start` 再跑一次（尽力而为）。
 * 若该根已被 hindsight 缓存，则本次不生效、下次启动 DSH 时生效——这是有意的
 * 取舍：宁可延迟一次，也不去改动 hindsight 的内部缓存。
 */
export function apply(ctx, rawConfig) {
  const settings = readSettings(rawConfig);
  const logger = ctx?.logger;

  // 启动扫描：失败开放，绝不阻断插件加载
  try {
    syncOnce(settings, logger);
  } catch (error) {
    logger?.warn?.(`dsh-hindsight-bank-router: 启动同步失败（已忽略）: ${String(error)}`);
  }

  // 会话开始时的补充扫描（新克隆的仓库）。
  //
  // 用 `ctx.inject(["agents"], ...)` 而不是直接 `ctx.on("agent/...")`：agent
  // 生命周期事件由 `agents` 服务拥有，本插件没有把它列为必需依赖（见上方
  // `inject = []` 的说明），因此必须在服务可用时才挂载监听器。
  //
  // 这正是上游 hindsight 插件对可选的 tools 注册表所用的写法 —— 它的原话是
  // "The tools registry is optional: a composition without it (a bare headless
  // assembly) still gets recall, injection and write-back"。直接 `ctx.on`
  // 在缺少该服务的组合里不会报错，只是永远收不到事件（静默失效）。
  try {
    ctx?.inject?.(["agents"], (agentCtx) => {
      agentCtx.on("agent/session-start", () => {
        try {
          syncOnce(settings, logger);
        } catch (error) {
          logger?.debug?.(`dsh-hindsight-bank-router: 会话同步失败（已忽略）: ${String(error)}`);
        }
      });
    });
  } catch (error) {
    logger?.debug?.(`dsh-hindsight-bank-router: 无法注册会话钩子: ${String(error)}`);
  }
}

export default { name, inject, apply };
