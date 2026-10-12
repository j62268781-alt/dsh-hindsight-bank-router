/**
 * dsh-hindsight-bank-router 的自测脚本 —— 不依赖任何测试框架，`node test-harness.mjs` 即可。
 *
 * 重点验证三件容易出错的事：
 *   1. 远程 URL 推导 bank 名（含 scp 风格、SSH、嵌套路径、无 .git 后缀）
 *   2. 扫描发现的仓库集合正确（含 worktree、无 origin 的仓库、深度限制）
 *   3. **合并逻辑永不破坏用户手工配置** —— 这是本插件的核心安全承诺
 *
 * 全程在临时目录里跑，绝不触碰 ~/.hindsight/。
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { syncOnce, apply } from "./index.js";

let passed = 0;
let failed = 0;

function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.log(`  ❌ ${label}\n      期望: ${e}\n      实际: ${a}`);
  }
}

/** 静默 logger，把输出收集起来供断言。 */
function makeLogger() {
  const lines = [];
  const push = (lv) => (msg) => lines.push(`${lv}: ${msg}`);
  return {
    lines,
    debug: push("debug"),
    info: push("info"),
    warn: push("warn"),
  };
}

/**
 * 在目标配置里种下 `enableBankRouter: true`（本插件的用户级开关）。
 *
 * 每个场景用各自的 configPath，因此都需要这一步 —— 少了它插件会被开关
 * 拦下（`skipped: "enableBankRouter-not-true"`），后续断言全部落空。
 * `extra` 用于需要预置其它字段的场景。
 */
function seedEnabled(path, extra = {}) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ enableBankRouter: true, ...extra }, null, 2));
}

/** 造一个假的 git 仓库目录。 */
function makeRepo(root, name, { remoteUrl, worktreeOf } = {}) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });

  if (worktreeOf) {
    // 模拟 linked worktree：.git 是文件，指向主仓库的 worktrees/<name>
    const gitDir = join(worktreeOf, ".git", "worktrees", name);
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, "commondir"), "../..\n");
    writeFileSync(join(dir, ".git"), `gitdir: ${gitDir}\n`);
    return dir;
  }

  const gitDir = join(dir, ".git");
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n");
  if (remoteUrl) {
    writeFileSync(
      join(gitDir, "config"),
      `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${remoteUrl}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`
    );
  } else {
    writeFileSync(join(gitDir, "config"), `[core]\n\trepositoryformatversion = 0\n`);
  }
  return dir;
}

const work = mkdtempSync(join(tmpdir(), "bank-router-test-"));
console.log(`临时工作区: ${work}\n`);

try {
  // ── 场景 1：基本扫描 + 远程名推导 ──────────────────────────────────
  console.log("场景 1：扫描并推导 bank 名");
  const scans = join(work, "scans");
  mkdirSync(scans, { recursive: true });

  makeRepo(scans, "payments-app", {
    remoteUrl:
      "https://git.example.com/org/team/frontend/mobile-client.git",
  });
  makeRepo(scans, "web-console", {
    remoteUrl: "https://example.com/team/web-console.git",
  });
  makeRepo(scans, "scp-style", { remoteUrl: "git@github.com:org/repo-via-scp.git" });
  makeRepo(scans, "no-origin", {});
  // URL 编码与 CJK：new URL() 会把空格转成 %20、把中文转成 %E4%B8%AD…
  // 若在解码之前就做字符清理，这两类会产出 `my-20repo` / `-E4-B8-AD` 乱码。
  makeRepo(scans, "encoded-space", { remoteUrl: "https://host/a/my%20repo.git" });
  makeRepo(scans, "cjk-name", { remoteUrl: "https://host/a/中文仓库.git" });
  mkdirSync(join(scans, "not-a-repo", "sub"), { recursive: true });

  const cfgPath = join(work, "cfg", "coding-agent.json");
  const stPath = join(work, "cfg", ".state.json");
  const log = makeLogger();

  const settings = {
    enabled: true,
    enableBankRouter: true,
    dryRun: false,
    roots: [scans],
    maxDepth: 2,
    gitPrefix: "git::",
    workspacePrefix: "workspace::",
    routeNonGit: false, // 场景 1 只关心 git 仓库
    allowRepoConfig: true,
    userWorkspaceDir: join(work, "user-ws"),
    configPath: cfgPath,
    statePath: stPath,
  };

  // ⭐ 开关闸门：enableBankRouter 未显式为 true 时，插件必须彻底不动
  const gated = syncOnce({ ...settings, dryRun: false }, log);
  check("未设 enableBankRouter 时被跳过", gated.skipped, "enableBankRouter-not-true");
  check("未启用时不写盘", gated.written, false);

  // 写入开关后正常工作 —— 这正是用户的真实配置形态
  seedEnabled(cfgPath);

  const s1 = syncOnce(settings, log);
  check("发现的仓库数（5 个有 origin，1 个无）", s1.found, 5);
  check("写入成功", s1.written, true);

  const written = JSON.parse(readFileSync(cfgPath, "utf8"));
  check("嵌套路径取末段仓库名", written.mapPathToBank[join(scans, "payments-app")], "git::mobile-client");
  check("普通仓库名", written.mapPathToBank[join(scans, "web-console")], "git::web-console");
  check("scp 风格 URL", written.mapPathToBank[join(scans, "scp-style")], "git::repo-via-scp");
  check("无 origin 的仓库不进映射", join(scans, "no-origin") in written.mapPathToBank, false);
  check("非仓库目录不进映射（routeNonGit=false）", join(scans, "not-a-repo") in written.mapPathToBank, false);
  // ⭐ 回归保护：URL 编码必须先解码再清理，否则 %20 → "-20"、中文 → 乱码
  check("URL 编码的空格被正确解码", written.mapPathToBank[join(scans, "encoded-space")], "git::my-repo");
  check("CJK 仓库名原样保留", written.mapPathToBank[join(scans, "cjk-name")], "git::中文仓库");
  check("开关字段本身被保留", written.enableBankRouter, true);

  // ── 场景 2：仅更新 mapPathToBank，保留其它字段 ─────────────────────
  console.log("\n场景 2：不破坏配置文件里的其它字段");
  // 模拟用户的真实配置形态：开关 + 服务器设置 + 我方写入的映射共存。
  // ⚠️ 必须带上 enableBankRouter，否则后续所有场景都会被开关拦下
  // （skipped: "enableBankRouter-not-true"），断言静默落空。
  writeFileSync(
    cfgPath,
    JSON.stringify(
      {
        apiUrl: "http://sz-00575123-01/hindsight",
        serverMode: "self-hosted",
        reflectTimeoutMs: 45000,
        enableBankRouter: true,
        mapPathToBank: JSON.parse(readFileSync(cfgPath, "utf8")).mapPathToBank,
      },
      null,
      2
    )
  );
  const s2 = syncOnce(settings, log);
  check("无变化时不写盘", s2.written, false);

  const reread = JSON.parse(readFileSync(cfgPath, "utf8"));
  check("apiUrl 仍在", reread.apiUrl, "http://sz-00575123-01/hindsight");
  check("reflectTimeoutMs 仍在", reread.reflectTimeoutMs, 45000);
  check("enableBankRouter 仍在", reread.enableBankRouter, true);

  // ── 场景 3：用户手工映射必须存活 ⭐ 核心安全承诺 ────────────────────
  console.log("\n场景 3：用户手工写的映射不被覆盖/删除");
  const manualPath = join(scans, "manual-repo");
  makeRepo(scans, "manual-repo", { remoteUrl: "https://example.com/x/manual-repo.git" });

  // 用一个**我方从未管理过**的路径模拟"用户手写的条目"。
  // 该路径不对应任何真实目录，因此插件永远不会把它纳入 managed 清单，
  // 也就永远没有理由删除它 —— 这正是要验证的安全承诺。
  const ghost = join(scans, "ghost-user-entry");

  // ⚠️ 每次都从磁盘**重新读取**再改再写，而不是复用旧快照。
  // 复用旧快照会把插件在这期间写入的其它改动一起回滚，
  // 让后续场景看到不一致的状态（这个错误曾让场景 4 误报失败）。
  {
    const cur = JSON.parse(readFileSync(cfgPath, "utf8"));
    cur.mapPathToBank = { ...(cur.mapPathToBank ?? {}), [manualPath]: "user::hand-written", [ghost]: "user::keep-me" };
    writeFileSync(cfgPath, JSON.stringify(cur, null, 2));
  }

  syncOnce(settings, log);
  const after3b = JSON.parse(readFileSync(cfgPath, "utf8"));
  check("用户自建条目（我方从未管理）被保留", after3b.mapPathToBank[ghost], "user::keep-me");

  // ── 场景 4：仓库消失后清理自己写的条目 ────────────────────────────
  console.log("\n场景 4：仓库消失时清理我方条目（但只清我方的）");
  rmSync(join(scans, "scp-style"), { recursive: true, force: true });
  const s4 = syncOnce(settings, log);
  const after4 = JSON.parse(readFileSync(cfgPath, "utf8"));
  check("消失仓库的映射被移除", join(scans, "scp-style") in after4.mapPathToBank, false);
  check("用户条目依然健在", after4.mapPathToBank[ghost], "user::keep-me");
  check("其余仓库映射仍在", after4.mapPathToBank[join(scans, "web-console")], "git::web-console");

  // ── 场景 5：用户改写过我方条目 → 不再删除 ─────────────────────────
  console.log("\n场景 5：用户改写过我方条目后，我方不再删除它");
  const target = join(scans, "web-console");
  const mod = JSON.parse(readFileSync(cfgPath, "utf8"));
  mod.mapPathToBank[target] = "user::overridden";
  writeFileSync(cfgPath, JSON.stringify(mod, null, 2));
  rmSync(target, { recursive: true, force: true });
  syncOnce(settings, log);
  const after5 = JSON.parse(readFileSync(cfgPath, "utf8"));
  check("被用户改过的条目不会被删", after5.mapPathToBank[target], "user::overridden");

  // ── 场景 6：worktree 解析到主仓库 ─────────────────────────────────
  console.log("\n场景 6：linked worktree 共用主仓库的 bank");
  const wtRoot = join(work, "wt");
  mkdirSync(wtRoot, { recursive: true });
  const mainRepo = makeRepo(wtRoot, "main-repo", { remoteUrl: "https://example.com/t/main-repo.git" });
  makeRepo(wtRoot, "feature-branch", { worktreeOf: mainRepo });

  const wtCfg = join(work, "wt-cfg", "c.json");
  const wtState = join(work, "wt-cfg", ".s.json");
  seedEnabled(wtCfg);
  // maxDepth 1 覆盖 wtRoot 的直接子目录
  syncOnce(
    { ...settings, roots: [wtRoot], maxDepth: 1, configPath: wtCfg, statePath: wtState },
    log
  );
  const wtWritten = JSON.parse(readFileSync(wtCfg, "utf8"));
  check("主仓库进映射", wtWritten.mapPathToBank[mainRepo], "git::main-repo");
  // worktree 目录**应当**也进映射，且指向与主仓库**相同**的 bank —— 这样无论
  // 在哪个 worktree 里工作，拿到的都是主仓库的记忆。断言"两者相等"而非
  // "worktree 不存在"，后者会把正确行为误判为失败。
  check(
    "worktree 与主仓库解析到同一个 bank",
    wtWritten.mapPathToBank[join(wtRoot, "feature-branch")],
    wtWritten.mapPathToBank[mainRepo]
  );

  // ── 场景 7：dryRun 不写盘 ─────────────────────────────────────────
  console.log("\n场景 7：dryRun 不落盘");
  const dryCfg = join(work, "dry", "c.json");
  const dryState = join(work, "dry", ".s.json");
  seedEnabled(dryCfg);
  const s7 = syncOnce(
    { ...settings, dryRun: true, configPath: dryCfg, statePath: dryState, roots: [scans] },
    log
  );
  check("dryRun 被标记", s7.skipped, "dry-run");
  check("dryRun 未写盘", s7.written, false);
  // 配置文件本就存在（seedEnabled 种下了开关），故断言"未被改动"
  // 而非"不存在"：内容应仍无 mapPathToBank。
  check(
    "dryRun 未改动配置（无 mapPathToBank）",
    "mapPathToBank" in JSON.parse(readFileSync(dryCfg, "utf8")),
    false
  );

  // ── 场景 8：配置损坏时不覆盖 ──────────────────────────────────────
  console.log("\n场景 8：配置文件损坏时绝不覆盖");
  const badCfg = join(work, "bad", "c.json");
  mkdirSync(join(work, "bad"), { recursive: true });
  // 损坏内容里也带开关，确保拦截原因是"解析失败"而非"未启用"
  const badContent = '{ "enableBankRouter": true, this is not json';
  writeFileSync(badCfg, badContent);
  const s8 = syncOnce(
    { ...settings, configPath: badCfg, statePath: join(work, "bad", ".s.json") },
    log
  );
  check("损坏配置被跳过", s8.skipped, "config-unparsable");
  check("损坏内容原样保留", readFileSync(badCfg, "utf8"), badContent);

  // ── 场景 9：apply 不抛异常（失败开放）────────────────────────────
  console.log("\n场景 9：apply 失败开放");
  let threw = null;
  try {
    apply(
      { logger: makeLogger(), inject: () => {}, on: () => {} },
      { enabled: true, roots: ["/definitely/does/not/exist/xyz"], configPath: join(work, "nope.json"), statePath: join(work, "nope.state.json") }
    );
  } catch (e) {
    threw = String(e);
  }
  check("不存在的根目录不抛异常", threw, null);

  let threw2 = null;
  try {
    apply(null, null);
  } catch (e) {
    threw2 = String(e);
  }
  check("ctx 为 null 也不抛异常", threw2, null);

  // ctx 缺少 inject 方法（极简组合）时也必须安全
  let threw3 = null;
  try {
    apply({ logger: makeLogger() }, { enabled: true, roots: [], configPath: join(work, "n2.json"), statePath: join(work, "n2.s.json") });
  } catch (e) {
    threw3 = String(e);
  }
  check("ctx 缺少 inject 方法也不抛异常", threw3, null);

  // ── 场景 10：skip 目录不被扫描 ────────────────────────────────────
  console.log("\n场景 10：跳过 node_modules 等目录");
  const skipRoot = join(work, "skip");
  const nmRepo = join(skipRoot, "node_modules", "hidden-repo");
  makeRepo(skipRoot, "visible-repo", { remoteUrl: "https://example.com/v/visible-repo.git" });
  mkdirSync(join(skipRoot, "node_modules"), { recursive: true });
  makeRepo(join(skipRoot, "node_modules"), "hidden-repo", {
    remoteUrl: "https://example.com/h/hidden-repo.git",
  });
  const skipCfg = join(work, "skip-cfg", "c.json");
  seedEnabled(skipCfg);
  syncOnce(
    { ...settings, roots: [skipRoot], maxDepth: 3, configPath: skipCfg, statePath: join(work, "skip-cfg", ".s.json") },
    log
  );
  const skipWritten = JSON.parse(readFileSync(skipCfg, "utf8"));
  check("可见仓库被收录", join(skipRoot, "visible-repo") in skipWritten.mapPathToBank, true);
  check("node_modules 内的仓库被跳过", nmRepo in skipWritten.mapPathToBank, false);

  // ── 场景 11：.hindsight.json 优先级链 ⭐ 本次新增的核心功能 ─────────
  console.log("\n场景 11：.hindsight.json 显式 bankId 与优先级");
  const pRoot = join(work, "prio");
  mkdirSync(pRoot, { recursive: true });

  // (a) git 仓库 + 工作区内 .hindsight.json → 显式值胜出
  const explicitRepo = makeRepo(pRoot, "explicit-repo", {
    remoteUrl: "https://example.com/x/explicit-repo.git",
  });
  writeFileSync(
    join(explicitRepo, ".hindsight.json"),
    JSON.stringify({ bankId: "custom::explicit-wins" })
  );

  // (b) git 仓库，无覆盖文件 → 走 git::<远程名>
  makeRepo(pRoot, "plain-repo", { remoteUrl: "https://example.com/x/plain-repo.git" });

  // (c) 非 git 目录 → workspace::<目录名>
  mkdirSync(join(pRoot, "plain-dir"), { recursive: true });

  // (d) 非 git 目录 + .hindsight.json → 显式值胜出
  const explicitDir = join(pRoot, "explicit-dir");
  mkdirSync(explicitDir, { recursive: true });
  writeFileSync(join(explicitDir, ".hindsight.json"), JSON.stringify({ bank: "custom::dir-wins" }));

  const pCfg = join(work, "prio-cfg", "c.json");
  const pUserWs = join(work, "prio-cfg", "userws");
  seedEnabled(pCfg);
  const pSettings = {
    ...settings,
    roots: [pRoot],
    maxDepth: 2,
    routeNonGit: true, // 本场景要验证非 git 分支
    configPath: pCfg,
    statePath: join(work, "prio-cfg", ".s.json"),
    userWorkspaceDir: pUserWs,
  };
  syncOnce(pSettings, log);
  const prio = JSON.parse(readFileSync(pCfg, "utf8")).mapPathToBank;

  check("① git 仓库 + .hindsight.json → 显式值胜出", prio[explicitRepo], "custom::explicit-wins");
  check("② git 仓库无覆盖 → git::<远程名>", prio[join(pRoot, "plain-repo")], "git::plain-repo");
  check("③ 非 git 目录 → workspace::<目录名>", prio[join(pRoot, "plain-dir")], "workspace::plain-dir");
  check("④ 非 git 目录 + .hindsight.json → 显式值胜出", prio[explicitDir], "custom::dir-wins");

  // ── 场景 12：用户级配置优先于仓库内配置 ⭐ 安全承诺 ────────────────
  console.log("\n场景 12：用户级配置覆盖仓库内配置（安全承诺）");
  // 仓库说用自己的 bank……
  writeFileSync(
    join(explicitRepo, ".hindsight.json"),
    JSON.stringify({ bankId: "repo::wants-this" })
  );
  // ……但用户在 ~/.hindsight/workspaces/<目录名>.json 里写了自己的
  mkdirSync(pUserWs, { recursive: true });
  writeFileSync(
    join(pUserWs, "explicit-repo.json"),
    JSON.stringify({ bankId: "user::overrides-repo" })
  );

  syncOnce(pSettings, log);
  const prio2 = JSON.parse(readFileSync(pCfg, "utf8")).mapPathToBank;
  check(
    "用户级配置胜出（仓库无法自行决定 bank）",
    prio2[explicitRepo],
    "user::overrides-repo"
  );

  // ── 场景 13：allowRepoConfig=false 时忽略仓库内配置 ────────────────
  console.log("\n场景 13：allowRepoConfig=false 关闭仓库内配置");
  rmSync(join(pUserWs, "explicit-repo.json"), { force: true }); // 撤掉用户级，暴露仓库级
  const pCfg3 = join(work, "prio-cfg3", "c.json");
  seedEnabled(pCfg3);
  syncOnce(
    { ...pSettings, allowRepoConfig: false, configPath: pCfg3, statePath: join(work, "prio-cfg3", ".s.json") },
    log
  );
  const prio3 = JSON.parse(readFileSync(pCfg3, "utf8")).mapPathToBank;
  check(
    "关闭后仓库内 .hindsight.json 被忽略，回落到 git::",
    prio3[explicitRepo],
    "git::explicit-repo"
  );

  // ── 场景 14：routeNonGit=false 时非 git 目录不生成映射 ─────────────
  console.log("\n场景 14：routeNonGit=false 不接管非 git 目录");
  const pCfg4 = join(work, "prio-cfg4", "c.json");
  seedEnabled(pCfg4);
  syncOnce(
    { ...pSettings, routeNonGit: false, configPath: pCfg4, statePath: join(work, "prio-cfg4", ".s.json") },
    log
  );
  const prio4 = JSON.parse(readFileSync(pCfg4, "utf8")).mapPathToBank;
  check("非 git 目录不生成映射", join(pRoot, "plain-dir") in prio4, false);
  check("但 git 仓库仍正常", prio4[join(pRoot, "plain-repo")], "git::plain-repo");
  check("显式配置仍生效（非 git + .hindsight.json）", prio4[explicitDir], "custom::dir-wins");
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`\n${"─".repeat(52)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
