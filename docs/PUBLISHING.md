# 发包与上架（维护者）

从零到「别人能在 DSH 插件市场里搜到并装上」的完整流程。
面向**维护者**；普通用户只需要看 [README 的安装一节](../README.md#安装)。

- npm 包名：`@j62268781-alt/dsh-hindsight-bank-router`（**scoped**，归账号独占）
- GitHub 仓库：<https://github.com/j62268781-alt/dsh-hindsight-bank-router>（仓库名不带 scope）
- 市场目录：<https://github.com/awesome-dsh-plugin/awesome-dsh-plugin>

---

## 0. 一次性准备

| 事项 | 说明 |
|---|---|
| 仓库公开 | 市场 CI 直接拉 `raw.githubusercontent.com` 上的 `package.json`，私有仓库一律过不了 |
| 仓库 ≥ 1 天 | CI 有仓库年龄检查，新建的仓库当天提 PR 会被拒 |
| GitHub topic `dsh-plugin` | 仓库 About 里加上，收录的硬要求 |
| npm 账号 | `npm login`；账号名必须与 scope `@j62268781-alt` 一致（或拥有同名组织），否则 `npm publish` 报 E403 |
| `dsh.bundle` 清单 | 根 `package.json` 里的 `dsh.bundle.patch` + 根目录 `cordis.patch.yml` —— **只声明 `dsh.client` 是市场最常见的拒收原因** |

---

## 1. 发版检查

```bash
npm run verify     # node --check + 42 项断言
```

CI（`.github/workflows/ci.yml`）在 Node 20 / 22 / 24 三个版本上跑同一套门禁，
外加**清单校验**与**「测试未污染真实 HOME」**两条本项目特有的断言。

---

## 2. 发到 npm

### 2.1 首次发布（必须手动一次）

可信发布（OIDC）只能给**已经存在于 npm 上**的包配置，所以第一次必须手动：

```bash
npm login
npm publish --access public
```

发布后用 granular access token 作为回退通道（可选）：

```bash
gh secret set NPM_TOKEN --repo j62268781-alt/dsh-hindsight-bank-router
```

### 2.2 之后每个版本（自动）

```bash
# 1) 改版本号 + 写 CHANGELOG
npm version 0.1.1 --no-git-tag-version
# 2) 提交
git commit -am "chore: release v0.1.1"
git tag v0.1.1
git push origin master --tags
# 3) 在 GitHub 上按这个 tag 发一个 Release（Publish release）
```

Release 一旦发布，`publish.yml` 自动：跑门禁 → `npm publish --access public`
→ 把打包好的 tarball 附到该 Release。

### 2.3 在 npmjs.com 配置可信发布（推荐，配一次即可）

包页面 → Settings → Trusted Publisher → GitHub Actions，填：

| 字段 | 值 |
|---|---|
| Organization or user | `j62268781-alt` |
| Repository | `dsh-hindsight-bank-router` |
| Workflow filename | `publish.yml` |
| Environment | （留空） |

配好之后**不需要任何 secret**，OIDC 直接换发短期凭据。

### 2.4 手动兜底

Actions → publish → Run workflow → 勾 `dry_run` 可只打包不发布，用来验证
`files` 清单是否漏文件：

```bash
npm pack --dry-run
```

---

## 3. 上架 DSH 插件市场

### 3.1 准备条目文件

把 [`market-entry.yml`](market-entry.yml) 原样复制到市场仓库：

```
data/plugins/j62268781-alt__dsh-hindsight-bank-router.yml
```

文件名规则 `<owner>__<repo>.yml`。校验器只认 `url` / `name` / `category` /
`description` / `tarball` 五个键，**多写会被拒**。

### 3.2 提 PR

```bash
gh repo fork awesome-dsh-plugin/awesome-dsh-plugin --clone
cd awesome-dsh-plugin
cp /path/to/market-entry.yml data/plugins/j62268781-alt__dsh-hindsight-bank-router.yml
git checkout -b add-dsh-hindsight-bank-router
git commit -am "Add j62268781-alt/dsh-hindsight-bank-router"
gh pr create --title "Add dsh-hindsight-bank-router" --body "Anchors Hindsight memory banks to the remote repository name."
```

### 3.3 生效时间

PR 合并后由市场 CI 重建索引，通常几分钟内可搜到。

---

## 4. 本机（开发）安装

插件在 `desktop` profile 里以 `link:` 方式引用本仓库：

```bash
dsh plugin --profile desktop add link:$PWD
```

改完 `package.json` / `cordis.patch.yml` 后需重载：

```bash
dsh plugin --profile desktop install
```

---

## 5. 每次发版的清单

- [ ] `npm run verify` 全绿
- [ ] `CHANGELOG.md` 写了**用户可见变化**与**为什么**
- [ ] `package.json` 版本号已提升
- [ ] `git tag` 与版本号一致（`v0.1.1` ↔ `0.1.1`）
- [ ] GitHub Release 已发布（触发自动发包）
- [ ] 若改了 `cordis.patch.yml` 的挂载行，同步检查 `market-entry.yml` 的描述
