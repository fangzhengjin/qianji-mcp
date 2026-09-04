## qianji-mcp

qianji-mcp 是一个可自行部署的钱迹 MCP Server，它通过钱迹私有 HTTP API 同步账本数据，让支持 Streamable HTTP 的 MCP Client 查询和管理账单。

- 查询账本、资产、借入或借出详情、分类、标签、用户、账单和固定统计报表
- 管理普通收支、转账、信用卡还款、退款与报销
- 使用 Bearer PAT 认证，并隔离不同钱迹账号的数据
- 默认使用 SQLite，也可连接 PostgreSQL 或 MySQL

> [!WARNING]
> 本项目依赖钱迹私有 API，接口可能随钱迹客户端升级而变化。

## 快速导航

- [快速开始](#快速开始)
- [配置](#配置)
- [MCP 工具](#mcp-工具)
- [使用要点](#使用要点)
- [安全须知](#安全须知)

## 快速开始

### 1. 生成超级管理员 PAT

服务启动时必须提供一枚超级管理员 PAT：

```bash
bun -e "import { randomBytes } from 'node:crypto'; console.log('mt_pat_' + randomBytes(32).toString('hex'))"
```

请立即保存输出结果，服务不会自动显示或找回这枚 PAT。

### 2. 启动容器

```bash
docker run --rm --name qianji-mcp \
  -p 3000:3000 \
  -v qianji-mcp-data:/data \
  -e QIANJI_MCP_ADMIN_PAT='mt_pat_...' \
  -e QIANJI_MCP_PUBLIC_URL='http://127.0.0.1:3000' \
  ghcr.io/fangzhengjin/qianji-mcp:latest
```

容器监听 `0.0.0.0:3000`，SQLite 数据库保存在 `/data/qianji.db`。

远程部署时，将 `QIANJI_MCP_PUBLIC_URL` 改为 MCP Client 实际访问的基础地址，例如 `https://mcp.example.com`。

绑定页面也必须通过该公开地址访问。`POST /connect` 优先校验 `Origin`，缺失时校验 `Referer` 是否与该公开地址同源，同时拒绝 `Sec-Fetch-Site` 标记的跨站请求；反向代理应保留这些来源头，无来源头的客户端仍须提供有效的一次性 `ticket`。

镜像同时提供以下标签：

```text
ghcr.io/fangzhengjin/qianji-mcp:latest
ghcr.io/fangzhengjin/qianji-mcp:<7-character-commit-id>
```

### 3. 连接 MCP Client

MCP 地址为：

```text
http://127.0.0.1:3000/mcp
```

请求必须携带 PAT：

```http
Authorization: Bearer mt_pat_...
```

MCP Client 必须支持配置自定义 `Authorization` Header。

首次调用业务工具时，支持 URL Elicitation 的 Client 会返回钱迹账号连接链接，链接只关联当前 PAT，10 分钟内有效，绑定成功后立即失效，请在有效期内打开并登录。

连接提示会同时提供可点击的 Markdown 链接和下一行完整原始 URL，如果微信等内置浏览器拦截链接，可复制原始 URL 到系统浏览器访问。

首次连接时填写钱迹账号和密码，未解绑的后续重新登录只填写密码，页面会显示不可编辑的脱敏账号。服务端保存原登录账号并拒绝切换到其他钱迹 UID。无需再次填写 PAT。一次性 `ticket` 位于 URL query，后端在返回页面前校验其有效性，页面读取后会立即从地址栏移除。部署时不应在访问日志中记录 query 参数。

服务生成的 PAT、`ticket` 和 `nextCursor` 正文只包含连续的小写十六进制字符，固定开头前缀中的分隔符不受此限制，避免移动端复制时在正文中断开选区。

密码会在浏览器内转换为 UTF-8 小写 MD5，Bun 服务不会收到明文密码。

绑定完成后重新调用原工具，钱迹登录状态失效时，工具会再次要求连接。

### 4. 开始使用

- 需要按账本、资产、分类、标签或成员筛选，或者写入时缺少可信 ID，才调用对应查询工具获取，不得猜测或构造 ID
- 使用 `list_bills` 批量盘点、查重或只读对账，需要完整筛选范围时继续翻页到 `nextCursor=null`，批量判断转账方向时直接读取摘要的 `fromId` 和 `targetId`，需要资产名称时只调用一次 `list_assets` 建立 ID 映射
- 列表字段无歧义时不要逐条调用 `get_bill`，只有重复或近似候选、关系冲突、摘要缺失字段或用户要求完整记录时才读取单笔详情，写入成功后直接使用写入工具返回的完整账单
- 钱迹在其他设备发生变化后，调用 `refresh_cache` 获取最新数据
- 创建、修改、退款、报销和删除操作会直接写入钱迹，请先确认参数

## 配置

| 环境变量 | 必填 | 默认值 | 说明 |
|---|---:|---|---|
| `QIANJI_MCP_ADMIN_PAT` | 是 | 无 | 超级管理员 PAT，必须以 `mt_pat_` 开头，后接至少 32 个随机字符 |
| `QIANJI_MCP_PUBLIC_URL` | 否 | `http://<host>:<port>` | MCP Client 实际访问的基础地址，只能包含协议、主机和可选端口 |
| `QIANJI_MCP_HOST` | 否 | `127.0.0.1` | HTTP 监听地址，Docker 镜像默认为 `0.0.0.0` |
| `QIANJI_MCP_PORT` | 否 | `3000` | HTTP 监听端口 |
| `QIANJI_MCP_DATABASE_PATH` | 否 | `data/qianji.db` | SQLite 文件路径，Docker 镜像默认为 `/data/qianji.db` |
| `QIANJI_MCP_DATABASE_URL` | 否 | 无 | PostgreSQL 或 MySQL 连接 URL，设置后不使用 SQLite |
| `QIANJI_MCP_API_SERVER` | 否 | `https://api.qianjiapp.com` | 钱迹 API 基础地址，只能包含 HTTP(S) 协议和主机 |
| `QIANJI_MCP_DEBUG_LOG_PATH` | 否 | 关闭 | 钱迹上游请求日志的 JSONL 文件路径，可能包含未脱敏的个人资料和账单，仅限短时排查，详见[调试日志说明](#debug-logs) |

<details>
<summary>数据库与钱迹 API 线路</summary>

### 数据库

不设置 `QIANJI_MCP_DATABASE_URL` 时使用 SQLite，无需额外服务。外部数据库支持：

```text
postgres://user:password@host/database
postgresql://user:password@host/database
mysql://user:password@host/database
```

MySQL 最低版本为 8.0.16。

服务启动时会连接并初始化数据库，连接失败会终止启动，不会自动回退到 SQLite，也不会在数据库之间搬运已有数据。

无论使用哪种数据库，当前都只应运行一个 qianji-mcp 实例，SQLite 文件不能由多个实例共享。

### 钱迹 API 线路

可配置的钱迹官方线路包括：

```text
https://api.qianjiapp.com
https://qianji.xxoojoke.com
https://qianjiga.litangkj.com
```

服务不会自动切换线路。

</details>

## MCP 工具

| 使用场景 | 工具 |
|---|---|
| 账号登录与解绑 | `connect_qianji`、`disconnect_qianji` |
| 查询基础数据 | `list_books`、`list_book_members`、`list_assets`、`list_categories`、`list_tags`、`get_user_info` |
| 查询借入或借出详情 | `list_debt_accounts` |
| 查询、统计与刷新账单 | `list_bills`、`get_bill`、`get_bill_statistics`、`refresh_cache` |
| 查询预算使用情况 | `get_budget` |
| 普通收支或待报销支出批量创建与修改 | `create_bills`、`update_bills` |
| 删除普通收支、待报销支出、转账或还款 | `delete_bills` |
| 转账与信用卡还款 | `create_transfer`、`update_transfer` |
| 退款 | `create_refund`、`update_refund`、`delete_refund` |
| 报销 | `reimburse_bills`、`delete_reimbursement`、`cancel_reimbursements` |
| PAT 管理，仅超级管理员 | `list_pats`、`create_pat`、`delete_pat` |

### 调用时需要注意

- 钱迹业务 ID 始终使用十进制字符串，包括 `"-1"` 等特殊值
- `list_bills` 不筛选时传空对象 `{}`，默认每页 20 条，最多 100 条
- `list_books` 和 `list_assets` 可用 `nameKeyword` 按不区分大小写的名称字面子串缩小范围，`list_assets` 默认不返回余额和信用额度，只有明确需要余额或额度时才传 `includeBalances: true`
- 借入或借出详情使用钱迹独立接口 `list_debt_accounts`，`list_assets` 可能包含 type 5 债务记录基础资产条目，但不能替代详细信息，也不要自行聚合两类响应
- `list_bills.remarkKeyword` 按不区分大小写的备注字面子串筛选
- 请求下一页时只传上一页的 `nextCursor`，不要重复传筛选条件或 `limit`
- `bookId: "-1"` 只表示钱迹默认账本，`categoryId` 不接受 `"-1"`
- `create_bills`、`update_bills`和 `delete_bills` 即使只操作一笔也使用单项列表，级联删除在对应 `deletions[]` 项中显式设置 `cascadeRelatedBills: true`
- 批量写入只部分成功时，错误会按输入序号列出逐项结果，成功项已经写入，不得重试

`money`、`fee` 和 `discount` 均使用币种主单位，不使用分、美分等最小货币单位。

| 输入 | 实际含义 |
|---|---:|
| `CNY 8100` | 8100 元 |
| `USD 63` | 63 美元 |
| `JPY 500` | 500 日元 |

- 普通支出：`money` 对应 APP 主金额输入框，只支持 `discount`，实际扣款为 `money - discount`，收入不支持手续费或优惠
- 转账或信用卡还款：`money` 对应 APP 主金额输入框，`fee` 和 `discount` 不能同时大于 0，手续费包含在 `money` 中，优惠从实际转出金额扣减
- 跨币种写入会使用账号已开启的多币种配置，`get_user_info.baseCurrency` 是当前本位币，账单 `currencyConversion` 是写入时的历史换算，不会按当前价格重算
- 业务金额必须大于 0、不超过 `9,999,999,999.99` 且最多两位小数，手续费和优惠不能大于 `money`
- 账号需要迁移新版报销时，首次 `reimburse_bills` 会明确提示迁移影响，向用户说明“迁移后旧版本将不能继续使用报销”并取得明确同意后，使用相同业务参数并将 `confirmReimbursementUpgrade` 设为 `true` 重试，服务器只会在钱迹明确要求时迁移并重试一次，不会为已升级账号主动迁移

## 使用要点

### 数据同步

- 首次查询账单时，服务会自动同步钱迹数据
- 后续查询优先读取本地缓存，跨设备修改后可调用 `refresh_cache`
- 写操作会在远端成功后同步确认

> [!IMPORTANT]
> 写后确认失败不表示远端已经回滚，请按错误提示调用 `refresh_cache`，使本地缓存与远端状态重新一致。

### 写入额度

| 用户状态 | 单次最多使用标签 | 每日成功写入次数 |
|---|---:|---:|
| 有效 VIP | 8 个 | 不限 |
| 非 VIP 或过期 VIP | 1 个 | 15 次 |

每日额度按 `Asia/Shanghai` 自然日和钱迹 UID 计算，同一 UID 的多枚 PAT 共享额度，批量报销和关联删除分别按一次调用计数。

## 安全须知

> [!CAUTION]
> PAT 在数据库中明文保存，完整 Token 仅在创建时返回一次，数据库、备份、PAT 创建结果和相关模型会话都必须按凭据管理。

- `QIANJI_MCP_ADMIN_PAT` 对应唯一的超级管理员，也可以绑定钱迹账号
- 普通 PAT 由 `create_pat` 创建，默认有效期为 90 天，也可以设为永不过期
- 钱迹账号连接链接使用 10 分钟有效的一次性凭证，绑定成功后，同一 PAT 尚未使用的连接链接也会失效
- `connect_qianji` 可主动获取首次登录或同账号重新登录链接，`disconnect_qianji` 需确认后解绑当前 PAT，账号无其他 PAT 使用时会删除其全部本地缓存、账单和同步状态，但不会删除钱迹云端数据
- 服务端保存原登录账号用于后续只输入密码的重新登录，该字段不进入 MCP 输出或日志，并随最后一个 PAT 解绑产生的账号删除一起清理
- 删除 PAT 会立即撤销认证，关联账号不再被其他 PAT 使用时还会删除其全部本地数据，但不会清除备份或会话中的历史内容
- 不要在日志、工单或聊天记录中公开完整 PAT

> [!WARNING]
> 公网部署必须通过 Nginx 等反向代理提供 HTTPS，HTTP 会暴露可重放的 PAT 和钱迹密码 MD5，只适合受信网络。

<a id="debug-logs"></a>
<details>
<summary>调试日志注意事项</summary>

启用 `QIANJI_MCP_DEBUG_LOG_PATH` 后：

- 会记录钱迹请求地址、表单请求体、HTTP 状态和响应体
- 名称包含 `token` 的表单字段和 JSON 字段会替换为 `[REDACTED]`，JSON 对象与数组会递归处理
- 登录接口的请求体和响应体会整体替换为 `[REDACTED]`
- 其他接口中的 `uid`、个人资料、资产、账单金额和备注等不会脱敏，非 JSON 内容会保留原文，不能将日志视为已全面脱敏的数据

调试日志只应短时开启，不要直接上传到公开工单或聊天。服务会将日志文件权限设为仅所有者可读写，但不负责日志轮转；请自行设置轮转和保留期限，排查结束后取消 `QIANJI_MCP_DEBUG_LOG_PATH` 并重启服务，再清理日志及其副本。

</details>

## 开发者信息

服务器级 MCP 使用流程维护在 [`src/server-instructions.md`](src/server-instructions.md)，修改后会同时用于旧版 `initialize` 和新版 `server/discover` 响应。

<details>
<summary>从源码运行</summary>

需要 Bun 1.3.14 或更高版本：

```bash
bun install --frozen-lockfile
QIANJI_MCP_ADMIN_PAT='mt_pat_...' bun run start
```

默认监听 `127.0.0.1:3000`，SQLite 数据库保存在 `data/qianji.db`。

```bash
bun run dev
bun run typecheck
bun test
```

</details>

### 项目结构

源码保持扁平的 `src/` 结构，领域文件使用 `<领域>-<职责>.ts` 命名，通用且职责单一的模块使用简短名称。

<details>
<summary>展开目录结构与文件说明</summary>

```text
.
├── src/
│   ├── auth.ts                  # Bearer PAT 认证、账号绑定身份和管理员权限校验
│   ├── bill-rules.ts            # 账单输入类型、ID 规范化、金额及退款关系等纯业务规则
│   ├── bind-page.ts             # 钱迹账号绑定页面及浏览器端密码摘要计算
│   ├── data-store.ts            # 数据存储契约、共享数据类型及默认 SQLite 实现
│   ├── errors.ts                # 跨 HTTP 和 MCP 边界使用的稳定应用错误
│   ├── http-server.ts           # HTTP 配置、路由、服务启动和优雅停机入口
│   ├── ids.ts                   # 钱迹业务 ID 和哨兵值的公共校验规则
│   ├── mcp-server.ts            # MCP Server 创建、业务工具及 PAT 管理工具注册
│   ├── qianji-client.ts         # 钱迹私有 HTTP API、签名、协议序列化和响应规范化
│   ├── qianji-mappers.ts        # 钱迹原始数据与 MCP 公开 DTO 之间的转换
│   ├── qianji-service.ts        # 账号、缓存、同步、配额及账单写入流程编排
│   ├── server-instructions.md   # 新旧 MCP 协议共用的服务器级使用说明
│   ├── server-store.ts          # PostgreSQL 和 MySQL 数据存储实现
│   ├── sqlite-schema.ts         # 默认 SQLite 数据库 Schema
│   └── text-assets.d.ts         # Markdown 文本资源的 TypeScript 类型声明
├── test/
│   ├── auth-data-store.test.ts  # PAT、账号绑定、SQLite 迁移和数据隔离测试
│   ├── context.ts               # Bun 测试包装器及逆序执行的资源清理机制
│   ├── mcp-http.test.ts         # MCP 协议、HTTP 路由、Schema 和连接流程集成测试
│   ├── qianji-client.test.ts    # 钱迹签名、序列化、接口请求和响应规范化测试
│   ├── qianji-service.test.ts   # 缓存、同步、配额及各类账单业务流程测试
│   └── server-store.test.ts     # PostgreSQL 和 MySQL 存储契约集成测试
├── .dockerignore                # Docker 构建上下文排除规则
├── .gitignore                   # Git 忽略规则
├── Dockerfile                   # 容器镜像构建和服务启动配置
├── bun.lock                     # Bun 依赖锁定文件
├── package.json                 # 项目元数据、依赖和开发命令
├── tsconfig.json                # TypeScript 严格类型检查配置
├── LICENSE                      # MIT 许可证
└── README.md                    # 使用说明和项目结构文档
```

</details>

## 许可证

[MIT](LICENSE)
