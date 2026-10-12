# Changelog

本文件记录每个版本的**用户可见变化**与**为什么这样做**。格式参考
[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## 0.1.0 — 首个版本：优先级链、双开关、双前缀

### 为什么需要这个插件

`@vectorize-io/hindsight-coding-agents` 的 bank 名来自模板 `coding-agent::{gitProject}`，
而 `{gitProject}` 的解析逻辑（上游 `core/bank.ts` 的 `resolveProjectRoot`）是：

```ts
if (basename(commonDir) === ".git") return { root: dirname(commonDir) };
// {gitProject} = basename(root)
```

**它只读磁盘上的目录名，从不读 `remote.origin.url`。** 后果是同一个仓库因各人
`git clone` 得到的目录名不同而分叉成多个互不相通的 bank，且**完全静默**：

```
你:   git clone <url> → payments-app      → coding-agent::payments-app
同事: git clone <url> → mobile-client   → coding-agent::mobile-client
```

两者都"正常工作"，记忆却永不交汇。上游把这种静默分叉视为最严重的失败模式
（见其 `git-layout.ts` 注释与 issue #3950），但防护只覆盖 linked worktree，
没覆盖"同一仓库、不同本地目录名"。

### 新增

- **优先级链**（严格顺序，首个命中者胜出）：
  1. `~/.hindsight/workspaces/<目录名>.json` 的 `bankId` —— 用户级，最高优先
  2. `<工作区>/.hindsight.json` 的 `bankId` —— 仓库级（可关闭）
  3. git 仓库 → `git::<远程仓库名>`
  4. git 仓库但无 `origin` → 不生成映射，交回 hindsight 默认
  5. 非 git 目录 → `workspace::<目录名>`（`routeNonGit` 控制）

  显式配置 ①② 无论是否 git 仓库都优先，是"我知道得比你多"的逃生舱。

- **双开关**：`~/.hindsight/coding-agent.json` 的 `enableBankRouter`（用户级
  **必须显式写 true**）+ `cordis.patch.yml` 的 `enabled`（部署级）。任一为假
  彻底不动配置 —— 本插件会改写你的配置文件，这个动作应当由你主动授权。

- **双前缀**：`git::`（团队共享）与 `workspace::`（个人记忆）。把身份来源写进
  名字里，一眼区分"团队知识"与"个人记忆"，不再与 hindsight 默认的
  `coding-agent::` 混在同一命名空间。

- **`.hindsight.json` 支持**：接受 `bankId` 或 `bank` 两种字段写法。
  **用户级目录始终优先于仓库级** —— 仓库想改你的 bank，你在用户级写一条即可推翻。

- **CJK 与 URL 编码支持**：`bankNameFromRemote()` 先 `decodeURIComponent` 再做字符
  清理，白名单用 Unicode 属性 `[\p{L}\p{N}_.-]`。中文仓库名原样保留；
  `my%20repo.git` → `my-repo`（若不先解码会变成 `my-20repo`）。

### 设计取舍（明确记录代价）

- **绝不 spawn git**。上游 `git-layout.ts` 记录了删除 spawn 实现的原因：
  `git rev-parse` 带 1000ms 预算，机器繁忙时会超时、进程压力下会 `EAGAIN`，
  两种失败都被映射为 `null` —— 与"不是仓库"无法区分，于是把 worktree 分叉进
  自己的 bank（#3950）。本插件直接读 `.git/config`：无子进程、无超时、
  不会因负载失败。

- **仓库级配置触碰了上游明确反对的模式**。上游文档原话："There is no per-repo
  opt-in file, for the same reason there is no repo-carried config at all: a cloned
  repository must not be able to turn memory on."本插件保留它是为团队随仓库统一
  bank 命名的便利，但用**用户级目录始终优先**兜底，并提供 `allowRepoConfig: false`
  供完全不接受该风险时关闭。

- **只处理 git 仓库的子树**。非 git 目录只接管**根目录的直接子目录**，不递归为
  任意深度的目录建映射 —— 否则会产出大量无意义的 bank。

### 测试

- 42 项断言，全程在临时目录运行，**绝不触碰 `~/.hindsight/`**。
  覆盖开关闸门、优先级链逐条验证、用户级覆盖仓库级、降级行为、URL 编码与 CJK、
  worktree、合并安全（用户条目存活 / 我方条目按需清理 / 用户改写后不再删除）、
  失败开放、`dryRun` 不落盘、配置损坏时不覆盖。
