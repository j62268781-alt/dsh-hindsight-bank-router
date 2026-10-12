# 在 DeepSeek Harness 上部署 Hindsight 记忆系统

从零到「DSH 拥有跨会话的长期项目记忆」的完整教程。

**面向**：要在内网自建 Hindsight 服务端、并让 DSH 接上它的部署者。

**读完你会得到**：

- 一套自托管的 Hindsight 服务（PostgreSQL + pgroonga，中文可用）
- DSH 原生插件接线（不依赖 MCP，直接绑定生命周期事件）
- **按远程仓库名**分配记忆库（解决"同事 clone 同一仓库却各自为政"）
- 每条记忆标注来源（谁写的、哪个仓库）

**目录**

- [架构总览](#架构总览)
- [第一部分：部署服务端](#第一部分部署服务端)
- [第二部分：接线 DSH 插件](#第二部分接线-dsh-插件)
- [第三部分：安装 bank 路由插件](#第三部分安装-bank-路由插件)
- [第四部分：设置 userId](#第四部分设置-userid)
- [第五部分：验证](#第五部分验证)
- [常见问题](#常见问题)
- [附录](#附录)

---

## 架构总览

```
┌─────────────────┐
│  DSH 桌面版      │
│  （多工作区）    │
└────────┬────────┘
         │ ① hindsight-coding-agents 插件
         │    自动 retain / recall / reflect
         │
         │ ② dsh-hindsight-bank-router 插件
         │    决定每个工作区用哪个 bank
         ↓
┌─────────────────────────────────────┐
│  Hindsight 服务端（自托管）          │
│  ┌───────────────┐  ┌─────────────┐ │
│  │ Control Plane │  │ API :8888   │ │
│  │ （Web UI）    │  │ + MCP 端点  │ │
│  └───────────────┘  └──────┬──────┘ │
│                            ↓         │
│                   PostgreSQL 17      │
│                   pgvector + pgroonga│
└─────────────────────────────────────┘
         ↑
    反向代理（可选）
    http://<host>/hindsight/
```

**三个组件各自的职责**：

| 组件 | 作用 | 谁提供 |
|---|---|---|
| **Hindsight 服务端** | 存记忆、抽取事实、固化观察 | 你部署 |
| **hindsight-coding-agents** | DSH 与服务的桥梁，自动记忆 | 上游 |
| **dsh-hindsight-bank-router** | 决定"这份记忆属于哪个仓库" | 本仓库 |

---

## 第一部分：部署服务端

### 1.1 前置条件

| 项 | 要求 |
|---|---|
| Docker + Compose | 任意近期版本 |
| 内存 | 建议 ≥ 4 GB（app 2 GB + db 512 MB + 本地模型约 3.5 GB） |
| LLM API key | **必需** —— 事实抽取要靠 LLM |

⚠️ **关于 LLM key**：Hindsight 的 embedding 与 rerank 模型跑在本地（不需要 key），
但**事实抽取、固化、reflect 都需要调用 LLM**。没有 key 服务能启动，但记忆功能不工作。

### 1.2 为什么用 pgroonga 而不是 pg_search

上游提供多个文本检索后端。本教程选 **pgroonga**，原因：

- **中文开箱可用**（基于 Groonga + TokenBigram，不需要额外分词器配置）
- **避开 ParadeDB `pg_search` 的一个缺陷**：并发查询时 bitmap 流被重复领取，
  报 `InternalServerError: bitmap intersection stream (consumer 0, segment xxx) claimed twice`，
  导致 consolidation 任务反复失败、知识页永远为空
  （上游 issue [#6403](https://github.com/paradedb/paradedb/issues/6403)，仍未修复）

如果你只用英文，`native` 后端也可以，但中文场景建议照本教程走。

### 1.3 `Dockerfile.db`

```dockerfile
# PostgreSQL 17 + pgvector + pgroonga
FROM groonga/pgroonga:4.0.8-debian-17

# 基础镜像已自带 pgroonga、Groonga 库、PostgreSQL 17、PGDG 源。
# 只需补装 pgvector（Hindsight 的向量检索依赖它）。
RUN apt-get update && apt-get install -y --no-install-recommends \
    postgresql-17-pgvector \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*
```

> 若锁定版本号（如 `postgresql-17-pgvector=0.8.6-1.pgdg13+1`）报
> "Version ... was not found"，说明 PGDG 仓库已滚动，去掉 `=版本号` 即可。

### 1.4 `docker-compose.yaml`

```yaml
name: hindsight

services:
  db:
    build:
      context: .
      dockerfile: Dockerfile.db
    image: hindsight-db:17
    container_name: hindsight-db
    restart: always
    environment:
      POSTGRES_USER: ${HINDSIGHT_DB_USER:-hindsight_user}
      POSTGRES_PASSWORD: ${HINDSIGHT_DB_PASSWORD:?请在 .env 设置}
      POSTGRES_DB: ${HINDSIGHT_DB_NAME:-hindsight_db}
    volumes:
      - pg_data:/var/lib/postgresql/data
    networks: [hindsight-net]
    mem_limit: 512m

  hindsight:
    image: ghcr.io/vectorize-io/hindsight:latest
    container_name: hindsight-app
    restart: unless-stopped
    expose:
      - "8888"    # API + MCP
      - "9999"    # Control Plane（Web UI）
    environment:
      # ── LLM ──────────────────────────────────────────────
      - HINDSIGHT_API_LLM_PROVIDER=${HINDSIGHT_API_LLM_PROVIDER:-openai}
      - HINDSIGHT_API_LLM_MODEL=${HINDSIGHT_API_LLM_MODEL:?请在 .env 设置}
      - HINDSIGHT_API_LLM_API_KEY=${HINDSIGHT_API_LLM_API_KEY:?请在 .env 设置}
      - HINDSIGHT_API_LLM_BASE_URL=${HINDSIGHT_API_LLM_BASE_URL:-}

      # ── 超时（实测：默认 120s 对长文档抽取偏紧）──────────
      - HINDSIGHT_API_LLM_TIMEOUT=300
      - HINDSIGHT_API_LLM_CONNECT_TIMEOUT=30
      - HINDSIGHT_API_LLM_MAX_RETRIES=4
      # reflect 是【多步工具循环】，不是单次调用。
      # 生成一个知识页可能触发 10+ 次 LLM 调用，默认 300s 不够。
      - HINDSIGHT_API_REFLECT_WALL_TIMEOUT=900
      - HINDSIGHT_API_MENTAL_MODEL_REFRESH_LLM_TIMEOUT=600

      # ── 推理强度（OpenAI 兼容 provider 生效）─────────────
      # 抽取与固化只需结构化输出，关掉思考可显著降延迟与 token。
      # ⚠️ 很多"flash"型号默认开思维链，关掉这一项收益最大。
      - HINDSIGHT_API_RETAIN_LLM_REASONING_EFFORT=none
      - HINDSIGHT_API_CONSOLIDATION_LLM_REASONING_EFFORT=none
      - HINDSIGHT_API_REFLECT_LLM_REASONING_EFFORT=low

      # ── 结构化输出强制校验 ────────────────────────────────
      # 关思考后模型自我纠错空间变小，非法 JSON 会 wedge 流水线。
      - HINDSIGHT_API_LLM_STRICT_SCHEMA=true
      - HINDSIGHT_API_CONSOLIDATION_MAX_COMPLETION_TOKENS=16384

      # ── 并发 ──────────────────────────────────────────────
      - HINDSIGHT_API_LLM_MAX_CONCURRENT=8
      - HINDSIGHT_API_WORKER_MAX_SLOTS=6
      - HINDSIGHT_API_CONSOLIDATION_LLM_PARALLELISM=2
      - HINDSIGHT_API_CONSOLIDATION_MAX_MEMORIES_PER_ROUND=200

      # ── 文本检索：pgroonga ────────────────────────────────
      - HINDSIGHT_API_VECTOR_EXTENSION=pgvector
      - HINDSIGHT_API_TEXT_SEARCH_EXTENSION=pgroonga

      # ── 后台任务标识（务必固定，否则重启后遗留任务成孤儿）──
      - HINDSIGHT_API_WORKER_ID=hindsight-app

      - HINDSIGHT_API_DATABASE_URL=postgresql://${HINDSIGHT_DB_USER:-hindsight_user}:${HINDSIGHT_DB_PASSWORD}@db:5432/${HINDSIGHT_DB_NAME:-hindsight_db}
    depends_on: [db]
    networks: [hindsight-net]
    mem_limit: 4g

networks:
  hindsight-net:
    driver: bridge

volumes:
  pg_data:
```

### 1.5 `.env`

```bash
HINDSIGHT_DB_USER=hindsight_user
HINDSIGHT_DB_PASSWORD=<换成强随机串>
HINDSIGHT_DB_NAME=hindsight_db

# 示例：DeepSeek（OpenAI 兼容）
HINDSIGHT_API_LLM_PROVIDER=openai
HINDSIGHT_API_LLM_BASE_URL=https://api.deepseek.com/v1
HINDSIGHT_API_LLM_API_KEY=sk-xxxxxxxxxxxx
HINDSIGHT_API_LLM_MODEL=deepseek-chat
```

> ⚠️ `deepseek-chat` 是**非思考别名**，比 `deepseek-v4-flash` 快且便宜
> —— 后者在 API 层面默认开思维链（按 reasoner 处理）。

### 1.6 启动

```bash
docker compose up -d
docker compose logs -f hindsight | head -40
```

**首次启动**会自动：建库 → `CREATE EXTENSION vector` → `CREATE EXTENSION pgroonga`
→ 转换 schema（删 tsvector 列、建 pgroonga 索引）。无需手工执行 SQL。

### 1.7 反向代理（可选）

若要通过域名/端口统一入口访问，在 nginx 里加：

```nginx
location /hindsight/ {
    proxy_pass http://hindsight-app:8888/;
    proxy_set_header Host $host;
    proxy_read_timeout 900s;    # reflect 可能跑很久
}
```

⚠️ **注意 `proxy_read_timeout`** —— 默认 60s 会让知识页生成超时。
本教程的 `REFLECT_WALL_TIMEOUT=900` 要求代理也给足时间。

> 如果你**同时**要暴露 Control Plane（Web UI，端口 9999），
> 它是独立的 Next.js 应用，需要单独的 location 或端口映射。

**验证服务端**：

```bash
curl http://<你的地址>/hindsight/health
# {"status":"healthy","database":"connected",...}
```

---

## 第二部分：接线 DSH 插件

### 2.1 安装

```bash
dsh plugin --profile desktop add @vectorize-io/hindsight-coding-agents
```

### 2.2 写配置文件

**路径**：`~/.hindsight/coding-agent.json`（所有 harness 共用这一个文件）

```json
{
  "apiUrl": "http://<你的地址>/hindsight",
  "serverMode": "self-hosted",
  "reflectTimeoutMs": 45000
}
```

**三个字段的要点**：

| 字段 | 说明 |
|---|---|
| `apiUrl` | **填到代理前缀为止**。填 `.../hindsight`，插件自己拼 `/v1/...` |
| `serverMode` | 自托管必须写 `self-hosted` |
| `reflectTimeoutMs` | 默认 20000；慢模型下会超时降级为"无记忆会话" |

⚠️ **不要填 MCP 地址**。`.../mcp/<bank>` 是给 MCP 客户端用的（JSON-RPC），
插件走的是 REST。填错会导致所有调用失败。

### 2.3 重启 DSH

⚠️ **插件配置只在工作区加载时读一次**，改完必须重启 DSH。

验证：

```
hindsight_diagnose
```

看 `api_url` 是否指向你的服务、`bank_id` 是否合理。

---

## 第三部分：安装 bank 路由插件

### 3.1 为什么需要它

上游插件的 bank 名取自模板 `coding-agent::{gitProject}`，而 `{gitProject}` 的解析逻辑
（上游 `core/bank.ts` 的 `resolveProjectRoot`）是：

```ts
if (basename(commonDir) === ".git") return { root: dirname(commonDir) };
// {gitProject} = basename(root)
```

**它只读磁盘上的目录名，从不读 `remote.origin.url`。** 后果：

```
你:   git clone <url> → payments-app    → coding-agent::payments-app
同事: git clone <url> → mobile-client   → coding-agent::mobile-client
```

两者都"正常工作"，**记忆却永不交汇，且完全静默**——没有任何日志提示。

`dsh-hindsight-bank-router` 把身份锚定到**远程仓库名**：

```
你:   ~/work/payments-app  → git::mobile-client
同事: ~/work/mobile-client → git::mobile-client    ← 同一个库
```

### 3.2 安装

```bash
dsh plugin --profile desktop add @j62268781-alt/dsh-hindsight-bank-router
```

它会自动挂到 profile 的 bundle 链上，位置在上游插件之前。

### 3.3 配置

在 DSH profile 的 `cordis.patch.yml`（`~/.dsh/profiles/<name>/cordis.patch.yml`）里：

```yaml
- insert:
    - id: dsh-hindsight-bank-router
      name: '@j62268781-alt/dsh-hindsight-bank-router'
      config:
        enabled: true
        roots:
          - ~/work          # 扫描这些根目录
        maxDepth: 2
        gitPrefix: 'git::'
        workspacePrefix: 'workspace::'
        routeNonGit: true
```

### 3.4 开启路由（两把锁）

⚠️ **路由默认关闭**，需要**两个开关同时为真**：

| 位置 | 字段 |
|---|---|
| `~/.hindsight/coding-agent.json` | `"enableBankRouter": true` |
| `cordis.patch.yml` 的 config | `enabled: true` |

用户级开关**必须显式写 `true`**（不是缺省即开）——因为它会改写你的配置文件，
这个动作应当由你主动授权。

### 3.5 优先级链

插件为每个工作区决定 bank 名，**严格按此顺序**：

```
① ~/.hindsight/workspaces/<目录名>.json 的 bankId   ← 用户自己控制，最高优先
② <工作区>/.hindsight.json 的 bankId                ← 仓库自带（可关）
③ git 仓库 → git::<远程仓库名>                      ← 团队共享
④ git 仓库但无 origin → 不生成映射，交回默认
⑤ 非 git 目录 → workspace::<目录名>                 ← 个人记忆
```

**显式配置 ①② 无论是否 git 仓库都优先**，是"我知道得比你多"的逃生舱。

### 3.6 安全保证

这个插件会写你的配置文件，所以约束是它的核心：

| 保证 | 实现 |
|---|---|
| **绝不覆盖你手写的映射** | sidecar 状态文件记录"我管理过哪些路径" |
| **无变化不写盘** | 合并结果与现状相同则完全不动文件 |
| **失败开放** | 任何异常只记日志，绝不阻断 DSH 启动 |
| **原子写入** | 临时文件 + `rename`，权限 `0600` |
| **配置损坏时不动它** | JSON 解析失败 → 跳过并告警 |
| **不 spawn git** | 直接读 `.git/config`，无子进程、无超时 |

### 3.7 关于仓库内 `.hindsight.json` 的安全权衡

上游文档**明确反对**仓库携带配置：

> There is no per-repo opt-in file, for the same reason there is no repo-carried
> config at all: **a cloned repository must not be able to turn memory on.**

理由是克隆下来的仓库不应能决定你的记忆行为。本插件保留它是为团队统一命名的便利，
但**用户级目录始终优先** —— 仓库想改你的 bank，你在用户级写一条即可推翻。

完全不接受该风险时：`allowRepoConfig: false`。

---

## 第四部分：设置 userId

### 4.1 它有什么用

设了之后，每条记忆会带上 `user:<你的名字>` 标签：

| 用途 | 说明 |
|---|---|
| 在控制台过滤"我写的" | 按 `user:alice` 筛选 |
| 排查"这条谁写的" | metadata 里有 `author` |
| **不用于 bank 隔离** | 隔离靠 `git::<仓库名>`，保持团队共享 |

⚠️ **不要把 `{user}` 放进 `bankIdTemplate`** —— 那会按人拆分 bank，
毁掉团队共享，与本教程目标相反。

### 4.2 配置

在 `~/.hindsight/coding-agent.json` 加：

```json
{
  "retainTags": ["user:{user}"],
  "retainMetadata": { "author": "{user}" }
}
```

### 4.3 ⚠️ 关键：环境变量必须注入到 launchd

`{user}` **只从 `$HINDSIGHT_USER_ID` 读取**（源码：
`user: () => process.env.HINDSIGHT_USER_ID || "anonymous"`），
**没有配置文件途径**。

**而 DSH 桌面版是从 Finder/Dock 启动的 GUI 应用，由 launchd 拉起，不读 `~/.zshrc`。**

写入 `.zshrc` 对 DSH **无效** —— 症状是插件诊断里 `"user_id_configured": false`。

**正确做法**：用 LaunchAgent 在登录时注入。

创建 `~/Library/LaunchAgents/com.example.hindsight-env.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.example.hindsight-env</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/sh</string>
        <string>-c</string>
        <string>launchctl setenv HINDSIGHT_USER_ID alice</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>LaunchOnlyOnce</key>
    <true/>
</dict>
</plist>
```

加载并**立即生效**（不用等下次登录）：

```bash
launchctl load ~/Library/LaunchAgents/com.example.hindsight-env.plist
launchctl setenv HINDSIGHT_USER_ID alice
launchctl getenv HINDSIGHT_USER_ID      # 应输出 alice
```

⚠️ **必须重启 DSH** —— 环境变量要被进程读到。

### 4.4 验证

重启后：

```
hindsight_diagnose
```

看 `"user_id_configured": true`。

⚠️ **已写入的历史记忆补不上标签**，只对新记忆生效。

---

## 第五部分：验证

### 5.1 服务端

```bash
curl http://<你的地址>/hindsight/health
# {"status":"healthy","database":"connected",...}
```

### 5.2 扩展是否正确安装

```bash
docker exec hindsight-db psql -U hindsight_user -d hindsight_db \
  -c "SELECT extname, extversion FROM pg_extension ORDER BY extname;"
```

应看到 `vector` 与 `pgroonga`。

### 5.3 插件接线

```
hindsight_diagnose
```

| 字段 | 期望 |
|---|---|
| `api_url` | 指向你的服务 |
| `bank_id` | 形如 `git::<仓库名>` 或 `workspace::<目录名>` |
| `user_id_configured` | `true`（若设了 userId） |

### 5.4 记忆是否真正流转

```bash
curl -s http://<你的地址>/hindsight/v1/default/banks
```

应列出你的 bank。**在真实 git 仓库里开一次会话**，然后：

```
hindsight_sync_status
```

### 5.5 后台流水线是否健康

⚠️ 这一项容易被忽略，但**记忆质量的瓶颈通常在这里**。

```bash
curl -s http://<你的地址>/hindsight/v1/default/banks/<你的bank>/stats
```

| 字段 | 期望 |
|---|---|
| `pending_consolidation` | 持续下降（不是长期不动） |
| `failed_consolidation` | **0** |
| `total_observations` | 持续增长 |

若 `failed_consolidation` 增长，查操作日志：

```bash
curl -s "http://<你的地址>/hindsight/v1/default/banks/<你的bank>/operations?limit=20"
```

**知识页生成的前提**：固化流水线通畅。官方原话是
"Mental model refreshes only run on the final round" —— 固化卡住，知识页永远是空的。

---

## 常见问题

### Q1：`hindsight_diagnose` 报 401

检查 `apiUrl` 是否指向正确的服务端根路径。若服务端配了鉴权
（`HINDSIGHT_API_TENANT_API_KEY`），需要在配置里加 `apiToken`。

### Q2：能配上但记忆不流转

按顺序查：

1. `hindsight_sync_status` —— `synced` 是否 true
2. 服务端 `/health` —— database 是否 connected
3. **服务端 LLM key 是否有效** —— 事实抽取要调 LLM，余额不足会 402
4. `stats` 的 `failed_consolidation`

### Q3：`pending_consolidation` 长期不动

这是**最值得警惕的症状**。查 operations 的错误信息：

- `bitmap intersection stream ... claimed twice` → pg_search 缺陷，换 pgroonga（见 1.2）
- `Task exceeded the ... wall-clock limit` → 调大 `REFLECT_WALL_TIMEOUT`
- `Fact extraction failed: ... APITimeoutError` → 调大 `LLM_TIMEOUT`，
  或换更快的模型、关掉思考（`REASONING_EFFORT=none`）

### Q4：知识页一直是空的

上游文档明确：**心智模型刷新只在最后一轮跑**。所以先确认
`pending_consolidation` 能归零、`total_observations` 在增长。

另外：**非 git 目录没有提交历史可播种**，知识页合成会明显更慢。

### Q5：同事看不到我的记忆

检查两边的 **bank 名是否相同**：

```
hindsight_diagnose    # 看 bank_id
```

若不同，说明本地目录名不同而远程仓库名相同 —— 正是 bank-router 要解决的问题，
确认它已启用（见 3.4 的两把锁）。

### Q6：改了配置不生效

**插件配置只在工作区加载时读一次 → 必须重启 DSH。**

服务端的环境变量同理，且**必须用 `docker compose up -d` 重建容器**，
`docker compose restart` 不会重读 `.env`。

### Q7：会话开始时等很久

`reflect` 会跑多步工具循环（实测 10+ 次 LLM 调用）。若嫌慢，把注入源改成纯检索：

```json
{ "autoInject": "pages" }
```

或先积累数据（知识页从 0 开始，需要固化流水线产出足够的 observations）。

### Q8：LLM 成本的量级

以自建 + DeepSeek 为例，个人使用**每月通常是个位数人民币量级**。
两个降低成本的开关：

- `RETAIN_LLM_REASONING_EFFORT=none`（关思考，收益最大）
- `autoInject: "pages"`（省掉每会话一次 reflect）

---

## 附录

### A. 三个操作的分工

| 操作 | 干什么 | 谁触发 | 存东西吗 |
|---|---|---|---|
| **retain** | **写入** —— 抽成事实存进去 | 自动（会话中） | ✅ 只有它存 |
| **recall** | **检索** —— 捞出记忆原文 | 按需 | ❌ 只读 |
| **reflect** | **推理** —— 捞出来 + 现算答案 | 按需 | ❌ 只读 |

**"积累"是 retain + 后台 consolidation 干的**，与 reflect 无关。
关掉自动 reflect 不会损失任何积累。

### B. 环境变量速查

| 变量 | 作用 | 建议值 |
|---|---|---|
| `HINDSIGHT_API_LLM_TIMEOUT` | 单次 LLM 调用上限 | `300` |
| `HINDSIGHT_API_REFLECT_WALL_TIMEOUT` | 整个 reflect 的墙钟上限 | `900` |
| `HINDSIGHT_API_RETAIN_LLM_REASONING_EFFORT` | 抽取时的思考强度 | `none` |
| `HINDSIGHT_API_LLM_STRICT_SCHEMA` | 强制合法 JSON | `true` |
| `HINDSIGHT_API_TEXT_SEARCH_EXTENSION` | 文本检索后端 | `pgroonga` |
| `HINDSIGHT_API_WORKER_ID` | 后台任务标识 | 固定值 |

### C. 相关资源

- [Hindsight 官方文档](https://hindsight.vectorize.io)
- [编码插件文档](https://hindsight.vectorize.io/sdks/integrations/coding-agents)
- [bank 身份为何不能用目录名（issue #3950）](https://github.com/vectorize-io/hindsight/issues/3950)
- [pg_search bitmap 缺陷（issue #6403）](https://github.com/paradedb/paradedb/issues/6403)
- [dsh-hindsight-bank-router](https://github.com/j62268781-alt/dsh-hindsight-bank-router)

### D. 本教程的经验来源

文中带具体数值的建议（超时 300s/900s、关思考、pgroonga）都来自实测排查，
不是照抄文档：

| 症状 | 根因 | 对策 |
|---|---|---|
| retain 79% 调用逼近 120s 超时 | 模型默认开思维链 | `REASONING_EFFORT=none` |
| consolidation 反复失败重试 11 次 | pg_search bitmap 缺陷 | 换 pgroonga |
| 知识页恒为 0 | 固化流水线卡死 | 同上 |
| `refresh_mental_model` 超时 | reflect 是多步循环 | `REFLECT_WALL_TIMEOUT=900` |
| `user_id_configured: false` | GUI 应用不读 `.zshrc` | 用 LaunchAgent |
