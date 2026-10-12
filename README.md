<div align="center">

# dsh-hindsight-bank-router

**把 Hindsight 编码插件的 bank 身份锚定到「远程仓库名」而不是「本地目录名」——让同一仓库的每个克隆都共享同一个记忆库**

[![DSH](https://img.shields.io/badge/DSH-0.2.0--rc.2%20实测-4c6ef5)](#)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![tests](https://img.shields.io/badge/npm%20test-42%20passed-2ea043)](#自测)
[![runtime deps](https://img.shields.io/badge/运行时依赖-0-8a8f99)](#它怎么做)
[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/j62268781-alt/dsh-hindsight-bank-router)

</div>

---

`@vectorize-io/hindsight-coding-agents` 给每个仓库一份长期记忆，但 bank 名取自**本地目录名**：同一个仓库因各人 `git clone` 得到不同目录名而分叉成互不相通的记忆库，**且完全静默**。本插件喂给它一份动态生成的 `mapPathToBank`，把身份锚定到远程仓库名。

- 🎯 **锚定远程仓库名**：`payments-app`（本地名）与 `mobile-client`（远程名）都解析到 `git::mobile-client`，团队记忆真正汇合
- 🪜 **声明式优先级链**：用户级工作区文件 → 仓库内 `.hindsight.json` → git 远程名 → 目录名；显式配置永远最高优先
- 🔐 **两把锁才生效**：用户级 `enableBankRouter` **必须显式写 true**，加上部署级开关。任一为假就彻底不动你的配置
- 🛡️ **绝不覆盖你手写的映射**：sidecar 状态文件记录"我管理过哪些路径"，删除时只动自己写的那些
- 🚫 **不 spawn git**：直接读 `.git/config` —— 无子进程、无超时、不会因机器负载失败（上游为此删过一版 spawn 实现，见 [#3950](https://github.com/vectorize-io/hindsight/issues/3950)）
- 🈶 **中文仓库名可用**：先 `decodeURIComponent` 再清理，`中文仓库.git` → `git::中文仓库`（顺序反了会变 `-E4-B8-AD` 乱码）
- 🧯 **失败开放**：任何异常只记日志，绝不阻断 DSH 启动或会话

**目录**：[它解决什么问题](#它解决什么问题) · [安装](#安装) · [配置](#配置) · [路由规则](#路由规则优先级链) · [安全承诺](#安全承诺) · [已知限制](#已知限制) · [更多文档](#更多文档) · [License](#license)

## 它解决什么问题

`@vectorize-io/hindsight-coding-agents` 的 bank 名来自模板 `coding-agent::{gitProject}`，而 `{gitProject}` 的解析逻辑（源码 `core/bank.ts` 的 `resolveProjectRoot`）是：

```ts
if (basename(commonDir) === ".git") return { root: dirname(commonDir) };
// {gitProject} = basename(root)
```

**它只读磁盘上的目录名，从不读 `remote.origin.url`。** 后果是同一个仓库因各人 `git clone` 得到的目录名不同而分叉：

```
你:   git clone <url> → payments-app      → coding-agent::payments-app
同事: git clone <url> → mobile-client   → coding-agent::mobile-client
```

两者都"正常工作"，**记忆却永不交汇，且完全静默**——没有任何日志提示你出了问题。

上游把这种静默分叉视为最严重的失败模式（见 `git-layout.ts` 注释与 issue #3950），但它的防护只覆盖了 linked worktree，没覆盖"同一仓库、不同本地目录名"。

## 它怎么做

不动 hindsight 插件本身，只喂给它一份**动态生成的 `mapPathToBank`**：

```
DSH 启动
  └─ 本插件 apply()
       ├─ 扫描配置的根目录，找 .git
       ├─ 直接解析 .git/config 的 remote.origin.url   ← 绝不 spawn git
       ├─ 由远程 URL 推导 bank 名：git::<repo>
       └─ 安全合并进 ~/.hindsight/coding-agent.json 的 mapPathToBank
            ↓
hindsight 插件首次会话时惰性解析 bank → 读到的就是正确的映射
```

**可行性依据**（hindsight 源码）：`readRaw()` 每次调用都 `readFileSync` 重新读文件、**没有缓存**，而 `workspaceFor(root)` 是**首次会话才构建**的。所以只要在同一个进程的加载期写入，就一定先于它的读取。

### 为什么不 spawn git

上游 `git-layout.ts` 明确记录了删除 spawn 实现的原因：`git rev-parse` 带 1000ms 预算，机器繁忙时会超时、进程压力下会 `EAGAIN`，两种失败都被映射为 `null` —— 与"不是仓库"无法区分，于是把 worktree 分叉进自己的 bank（#3950）。

直接读 `.git/config` 是纯文件读取：**无子进程、无超时、不会因负载失败**。

## 路由规则：优先级链

插件为每个工作区决定 bank 名，**严格按以下顺序**，第一个命中者胜出：

```
① <用户目录>/workspaces/<目录名>.json 的 bankId   ← 用户自己控制，最高优先
② <工作区>/.hindsight.json 的 bankId              ← 仓库自带（可关闭）
③ git 仓库 → git::<远程仓库名>                    ← 锚定客观身份，团队共享
④ git 仓库但无 origin                             ← 不生成映射，交回默认
⑤ 非 git 目录 → workspace::<目录名>               ← 个人记忆（可关闭）
```

**注意 ①② 与 ③⑤ 的关系**：显式配置（①②）**无论是否 git 仓库都优先**——它是"我知道得比你多"的逃生舱。

### 总览图

```
扫描根目录
  ├─ 有 .hindsight.json？ → 用它的 bankId（①②）
  ├─ 是 git 仓库？        → 读 remote.origin.url
  │     ├─ 有 origin → git::<远程名>        ✅ 锚定远端
  │     └─ 无 origin → 不写映射              ⚠️ 交回默认
  └─ 非 git 目录？        → workspace::<目录名>  （routeNonGit 控制）
```

### ① 开关：两把锁

路由默认**关闭**，需要**两个开关同时为真**：

| 位置 | 字段 | 作用 |
|---|---|---|
| `~/.hindsight/coding-agent.json` | `"enableBankRouter": true` | **用户级总闸** |
| `cordis.patch.yml` 的 config | `enabled: true` | 部署级开关（DSH profile 控制） |

**任一为假就彻底不动你的配置。** 用户级开关必须**显式写 true**（不是"缺省即开"），因为它是会改写你配置文件的动作，应当由你主动授权。

### ② 显式指定：`.hindsight.json`

在**两处**查找，**用户级优先**：

| 位置 | 谁控制 | 优先级 |
|---|---|---|
| `~/.hindsight/workspaces/<目录名>.json` | **你** | 高 |
| `<工作区>/.hindsight.json` | 仓库 | 低 |

两种字段写法都接受：

```jsonc
{ "bankId": "custom::my-bank" }   // 推荐
{ "bank":   "custom::my-bank" }   // 兼容 hindsight 的 banks.<id>.bank 用词
```

**为什么用户级优先**：上游明确反对仓库携带配置——

> There is no per-repo opt-in file, for the same reason there is no repo-carried config at all: **a cloned repository must not be able to turn memory on.**

理由是一个克隆下来的仓库不应能决定你的记忆行为。本插件保留仓库级配置是为团队随仓库统一 bank 命名的便利，但**用户级永远压过它**：仓库想改你的 bank，你在用户级写一条就能推翻。

完全不接受该风险时，在 `cordis.patch.yml` 设 `allowRepoConfig: false` 关闭仓库级查找。

### ③ Git 仓库 → 锚定远程仓库名

**判定**：目录下存在 `.git`（**目录或文件都算**——后者是 linked worktree / submodule）。

**推导链**：

```
.git 存在
  ↓ resolveCommonGitDir()   ← worktree 感知，只读文件、不 spawn git
  ↓ 读 <commonDir>/config
  ↓ remoteUrlFromConfig()   ← 只认 [remote "origin"] 段的 url
  ↓ bankNameFromRemote(url, "git::")
  ↓
写入 mapPathToBank[仓库路径] = "git::<仓库名>"
```

**URL → bank 名的完整规则**（取 URL 的**最后一段路径**，而非本地目录名）：

| 输入 URL | 处理 | bank 名 |
|---|---|---|
| `https://host/a/b/**mobile-client**.git` | 末段去 `.git` | `git::mobile-client` |
| `git@github.com:org/**repo**.git` | scp 风格先拆出 path | `git::repo` |
| `ssh://git@host/a/**repo**` | 取 URL pathname | `git::repo` |
| `https://host/a/**my%20repo**.git` | **先解码**再把空格转 `-` | `git::my-repo` |
| `https://host/a/**中文仓库**.git` | 解码后 CJK 原样保留 | `git::中文仓库` |

⚠️ **解码顺序很重要**：`new URL()` 会把空格转成 `%20`、把中文转成 `%E4%B8%AD…`，因此实现**必须先用 `decodeURIComponent` 解码，再做字符清理**。若顺序反了，`my repo` 会变成 `my-20repo`、中文仓库名会变成 `-E4-B8-AD…` 乱码。

字符白名单用 Unicode 属性 `[\p{L}\p{N}_.-]`（而非 `\w`），中文/日文/韩文仓库名因此能原样保留。空仓库名或清理后为空的情况返回 `null`（不生成映射）。

**实例**（本机实测）：

```
~/work/payments-app       → git::mobile-client   ← 锚定成功
~/work/web-console  → git::web-console
~/work/flutter      → git::flutter
```

注意第一条：本地目录叫 `payments-app`，但远程仓库名是 `mobile-client`，**插件取的是后者**。

**特殊处理**：

- **linked worktree** —— `.git` 是文件（内容 `gitdir: …/worktrees/<name>`）时，读其 `commondir` 回溯到**主仓库**。结果：worktree 与主仓库映射到**同一个 bank**，在哪个分支工作都共享记忆。
- **无 `origin` 远程地址** —— **不生成映射**，只记一条 debug 日志（`无 origin 远程地址 —— 保持默认 bank 命名`）。没有远程地址就无法推导稳定身份，此时**交回 hindsight 默认逻辑**（用目录名），而不是猜一个。这符合上游"宁可跳过也不猜"的原则。

### ④ 非 Git 目录 → workspace::<目录名>

**默认接管**（`routeNonGit: true`）：为根目录的**直接子目录**写 `workspace::<目录名>`。

```
~/Documents/Qoder  →  workspace::Qoder
```

**为什么接管而不是放任**：hindsight 默认会给它 `coding-agent::Qoder`，与团队共享的 `git::*` 混在同一命名空间里，**无法一眼区分"这是个人记忆还是团队知识"**。用独立前缀把它们分开。

**只处理根目录的直接子目录**，不递归为任意深度的目录建映射——否则会产出大量无意义的 bank。

**关掉它**（`routeNonGit: false`）：不生成映射，让这些目录走 hindsight 默认的 `coding-agent::<目录名>`。

### ⑤ 为什么这样分工

| | git 仓库 | 非 git 目录 |
|---|---|---|
| 身份锚点 | **远程 URL**（客观、人人一致） | 目录名（主观、因人而异） |
| 团队共享 | ✅ **有意义**（同事 clone 同一仓库） | ❌ 无意义（个人工作区） |
| bank 前缀 | `git::` | `workspace::` |
| 归谁管 | 锚定远端，修正分叉 | 显式接管，命名空间隔离 |

**核心判断**：git 仓库有"客观身份"可锚定（修掉静默分叉）；非 git 目录没有，所以用独立前缀**明确标记为个人记忆**，而不是假装它有团队身份。

### ⑥ 一条边界情况

**递归扫描时发现仓库就停止向下**（`return`）：

```
~/Documents/
  ├── my-monorepo/          ← 有 .git，建映射后停止递归
  │     └── packages/a/     ← 不再深入（即使它自己也是 git 仓库）
  └── other/                ← 继续扫描
```

**理由**：仓库内嵌套仓库极罕见，且会把扫描成本放大。

### ⚠️ 已知边界：非 git 目录的 bank 名仍是目录名

这意味着**不同人机器上的同名目录会撞到同一个 bank**（若都连同一台服务器）：

```
你的 Mac:  ~/Documents/output  →  coding-agent::output
同事 Mac:  ~/Documents/output  →  coding-agent::output   ← 撞车
```

**本插件不处理这种情况**（它只认 git 仓库）。需要时用 `mapPathToBank` 手工映射——插件**绝不碰你手写的条目**（见下方安全承诺）。

## 安全承诺

这个插件会写你的配置文件，所以约束是它的核心：

| 承诺 | 实现 |
|---|---|
| **绝不覆盖用户手工写的映射** | sidecar state 文件记录"我管理过哪些路径"；删除时只有值仍等于我当初写的值才动手 |
| **无变化不写盘** | 合并结果与现状相同则完全不动文件，避免 mtime 抖动触发文件监视 |
| **失败开放** | 任何异常只记日志，绝不阻断 DSH 启动或会话 |
| **原子写入** | 临时文件 + `rename`，权限 `0600` |
| **配置损坏时不动它** | 配置文件存在但 JSON 解析失败 → 跳过并告警，绝不覆盖 |
| **无身份的仓库不碰** | 找不到 `origin` 远程地址的仓库**不生成映射**，保持 hindsight 的默认回退 |
| **非 git 目录不碰** | 扫描时只为 git 仓库生成映射；其余目录一律不介入 |

配置文件里**除 `mapPathToBank` 之外的字段原样保留**（`apiUrl`、`serverMode` 等）。

## 安装

### 前置：先装 Hindsight 编码插件

本插件是它的补充，单独装没有意义：

```bash
npx @vectorize-io/hindsight-coding-agents install dsh
```

或按上游文档用 `dsh plugin` 安装 `@vectorize-io/hindsight-coding-agents`。

### 命令行

```bash
# npm 包（不用编译）
dsh plugin --profile desktop add @j62268781-alt/dsh-hindsight-bank-router
```

装好后 `cordis.patch.yml` 的 `dsh.bundle.patch` 会自动把本插件挂到 profile 的
bundle 链上，**位置在 hindsight 插件之前**（先写映射、后解析 bank）。

### 从源码（开发）

```bash
git clone https://github.com/j62268781-alt/dsh-hindsight-bank-router.git
dsh plugin --profile desktop add link:$PWD/dsh-hindsight-bank-router
```

改完 `package.json` 或 `cordis.patch.yml` 后重载：

```bash
dsh plugin --profile desktop install
```

### 装配顺序说明

本插件声明为 **bundle 层**，而 hindsight 插件也在 bundle 链上。顺序并不严格
必要，但把本插件排在前面让意图更明确：

```
DSH 启动
  └─ bundle 链依次加载
       ├─ dsh-hindsight-bank-router   ← 先写入 mapPathToBank
       └─ hindsight-coding-agents     ← 首次会话时惰性读取
```

**为什么顺序其实不严格**：hindsight 的 `readRaw()` 每次调用都 `readFileSync`
重新读文件、**没有缓存**，而它的 `workspaceFor(root)` 是**首次会话才构建**的。
所以只要在同一个进程的加载期写入，就一定先于它的读取。

## 配置

在 `cordis.patch.yml` 的 `config` 里：

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | **部署级**总开关（DSH profile 控制） |
| `dryRun` | `false` | 只预览不写盘 |
| `roots` | `[]` | 扫描根目录，支持 `~` 展开 |
| `maxDepth` | `3` | git 子树的递归深度；非 git 的**直接子目录**总是会被纳入 |
| `gitPrefix` | `"git::"` | git 仓库的 bank 前缀 |
| `workspacePrefix` | `"workspace::"` | 非 git 目录的 bank 前缀 |
| `routeNonGit` | `true` | 是否接管非 git 目录（`false` = 交给 hindsight 默认） |
| `allowRepoConfig` | `true` | 是否读取工作区内的 `.hindsight.json` |
| `userWorkspaceDir` | `~/.hindsight/workspaces` | 用户级工作区配置目录（**优先级高于仓库内配置**） |
| `configPath` | `~/.hindsight/coding-agent.json` | 目标配置文件 |
| `statePath` | `~/.hindsight/.bank-router-state.json` | 我方状态文件 |

### 用户级总闸

在 `~/.hindsight/coding-agent.json` 里：

```jsonc
{
  "apiUrl": "http://sz-00575123-01/hindsight",
  "serverMode": "self-hosted",
  "enableBankRouter": true          // ← 必须显式写 true 才启用
}
```

**为什么不做成"缺省即开"**：本插件会改写你的配置文件，这个动作应当由你主动授权，而不是装上就默认生效。

## 自测

```bash
node test-harness.mjs
```

**42 项断言**，全程在临时目录运行，**绝不触碰 `~/.hindsight/`**。覆盖：

- **开关闸门**（`enableBankRouter` 未设 true 时彻底不动配置）
- **优先级链**（用户级 → 仓库级 → `git::` → `workspace::`，逐条验证）
- **用户级覆盖仓库级**（安全承诺：仓库无法自行决定 bank）
- `allowRepoConfig: false` / `routeNonGit: false` 的降级行为
- 远程 URL 推导（HTTPS / scp 风格 / 嵌套路径 / 无 `.git` 后缀）
- **URL 编码与 CJK**（`my%20repo` → `my-repo`、中文仓库名原样保留）
- 扫描发现（worktree、无 origin 仓库、深度限制、`node_modules` 跳过）
- **合并安全**（用户条目存活、我方条目按需清理、用户改写后不再删除）
- 失败开放（不存在的根、`ctx` 为 null、缺少 `inject` 方法）
- `dryRun` 不落盘、配置损坏时不覆盖

## 已知限制

1. **启动后新建/克隆的仓库，首次会话可能不生效。** 本插件在 `agent/session-start` 会补扫一次，但如果该 workspace root 已被 hindsight 缓存，本次不生效、**下次启动 DSH 时生效**。这是有意的取舍：宁可延迟一次，也不去改动 hindsight 的内部缓存。

2. **bank 改名会"丢"旧记忆。** 改名前已积累的记忆在旧 bank 名下（例如 `coding-agent::payments-app`、`team::mobile-client`），不会自动迁移。需要时用 `hindsight-admin export-bank` / `import-bank`。

3. **仓库级 `.hindsight.json` 的安全权衡。** 上游明确反对仓库携带配置（"a cloned repository must not be able to turn memory on"）。本插件保留它是为团队统一命名的便利，并用**用户级目录始终优先**来兜底。完全不接受时设 `allowRepoConfig: false`。

4. **约定仍需团队统一。** 本插件让 bank 名**由远程仓库名唯一决定**（客观事实，所有人一致），但如果团队成员用不同的 fork 或镜像地址，仍会分叉——此时用 `.hindsight.json` 显式指定。

5. **非 git 目录的 bank 名仍是目录名。** 本插件用 `workspace::<目录名>` 接管它们，但不同人机器上的同名目录（如 `output`、`Qoder`）**若都连同一台 Hindsight 服务器会撞到同一个 bank**。多人共用服务器时，用 `~/.hindsight/workspaces/<目录名>.json` 显式指定区分。

## 更多文档

- [CHANGELOG.md](CHANGELOG.md) — 每个版本的用户可见变化，以及**为什么这样做**
- [docs/PUBLISHING.md](docs/PUBLISHING.md) — 发包到 npm 与上架插件市场的完整流程（维护者）
- 上游背景：[Hindsight 编码插件文档](https://hindsight.vectorize.io/sdks/integrations/coding-agents) ·
  [bank 身份为何不能用目录名（issue #3950）](https://github.com/vectorize-io/hindsight/issues/3950)

## License

[MIT](LICENSE)

