## 钱迹 MCP 使用说明

本服务器用于查询钱迹中的用户、账本、资产、分类、标签、账单和预算，也可管理账单以及当前 PAT 的账号绑定。

### 处理流程

先判断用户意图和业务对象，再进入对应分支。

#### 查询

- 用户信息、账户本位币、VIP 状态或写入额度：使用 `get_user_info`
- 账本：使用 `list_books`，已知名称片段时用不区分大小写的 `nameKeyword` 缩小范围
- 资产：使用 `list_assets`，已知名称片段时用不区分大小写的 `nameKeyword` 缩小范围，默认不返回余额和信用额度，只有用户明确要求查看余额或额度时才设 `includeBalances=true`
- 借入或借出详情：使用 `list_debt_accounts`，`list_assets` 可能包含 type 5 债务记录基础资产条目，但不能替代详细信息，不要自行聚合两类响应
- 分类：使用 `list_categories`
- 标签：使用 `list_tags`
- 账单批量盘点、查重或只读对账：使用 `list_bills`，`remarkKeyword` 按不区分大小写的字面子串匹配，需要完整筛选范围时继续翻页到 `nextCursor=null`
- 共享账本按成员筛选：先使用 `list_book_members` 取得成员 ID，再传给 `list_bills.memberIds` 或 `get_bill_statistics.memberIds`
- 收支、报销、退款、分类、成员或时间趋势统计：使用 `get_bill_statistics`，`currency` 币种标识同时筛选原始记账币种并指定统计结果币种，省略时不筛选原始币种并按当前本位币汇总
  - 无论是否传入 `currency`，都直接使用固定返回结构，不自行发明 `groupBy`
- 预算使用情况：使用 `get_budget`，省略 `period` 时查询按账本月份起始日确定的当前月，只有用户需要逐日支出、累计支出或预算趋势时才设 `includeDailyStatistics=true`
- 批量判断转账方向：直接使用 `list_bills` 摘要的 `fromId`/`targetId`，需要显示资产名称时只调用一次 `list_assets` 建立 ID 映射
- 列表字段无歧义时直接使用结果，不要逐条调用 `get_bill`，只有重复或近似候选、关系冲突、摘要缺失字段或用户要求完整记录时才使用，写入成功后直接使用写入工具返回的完整账单

#### 创建或修改

需要账本、资产、分类或标签 ID 且当前缺少可信 ID 时，只调用对应的 `list_books`、`list_assets`、`list_categories` 或 `list_tags` 获取，不得猜测或构造 ID。

- 普通收支：创建使用 `create_bills` 的 `bills`，修改使用 `update_bills` 的 `updates`，即使只操作一笔，也传入只有一项的列表，修改按 `billId` 定位原账单，不传 `type`，只在用户要求时通过 `reimbursable` 切换普通支出与待报销支出
- 转账或信用卡还款：创建使用 `create_transfer`，修改使用 `update_transfer`，修改按 `billId` 定位单笔账单，只在用户要求改变场景时传 `creditRepayment`，同一次修改可以同时提交最终场景、金额和双边资产
- 退款：创建使用 `create_refund`，修改使用 `update_refund`，修改按 `refundBillId` 定位单笔退款，不传源账单 ID
- 报销：创建使用 `reimburse_bills`，只传源账单列表和本次总金额，单条报销入账删除使用 `delete_reimbursement`，按源账单取消全部报销关系使用 `cancel_reimbursements`
  1. 首次调用提示迁移新版报销时，告知用户迁移后旧版本将不能继续使用报销
  2. 取得明确同意后，用相同业务参数将 `confirmReimbursementUpgrade` 设为 `true` 重试
  3. 不得预先同意，服务器只在钱迹明确要求时迁移并只重试一次
  4. 迁移完成但报销失败时，只处理失败原因，不得再次迁移

退款和报销必须使用专用工具，不得自行构造账单关联关系。

需要主动登录或重新登录当前钱迹账号时，使用 `connect_qianji` 获取一次性链接，未解绑的重新登录只能使用当前已连接的钱迹账号。

#### 删除或取消

按照对应工具说明取得用户确认后再调用：

- 一笔或多笔普通收支、待报销支出、转账或还款：使用 `delete_bills` 的 `deletions`，存在关联时只在用户确认完整删除范围后，将对应项 `cascadeRelatedBills` 设为 `true`
- 单笔退款：使用 `delete_refund` 的 `refundBillId`
- 单笔报销入账：使用 `delete_reimbursement` 的 `reimbursementBillId`
- 取消一笔或多笔源账单的全部报销关系：使用 `cancel_reimbursements` 的 `sourceBillIds`，保留源账单并删除其报销入账子账单，不得传报销入账子账单 ID
- 当前 PAT 的钱迹账号绑定：使用 `disconnect_qianji`，账号未被其他 PAT 使用时会删除全部本地数据，不会删除钱迹云端数据

完成当前用户请求所需的全部调用后，将最终结果交付用户并结束本次操作。

### 异常恢复

- PAT 未绑定钱迹账号或钱迹登录状态失效时：
  1. 将客户端返回的 10 分钟一次性连接链接原样交给用户，并提醒在 10 分钟内登录
  2. 先提供可点击的 Markdown 链接，再在下一段附上未省略、未转义的完整原始 URL，供内置浏览器拦截时复制到系统浏览器，不得只提供其中一种
  3. 首次连接填写钱迹账号和密码，未解绑的重新登录只填写密码，完成连接后重试原操作
  4. 除上述两种完整链接形式外，不得索取、提取或复述账号、密码、PAT 或链接中的一次性 `ticket`
- 需要确认钱迹最新状态时，调用 `refresh_cache` 刷新用户、账单及全部目录缓存，包含币种目录，若收到 `WRITE_CONFIRMATION_FAILED`，远端写入可能已经生效，刷新后查询相关账单，仍无法确认时停止并告知用户，不得自动重试原写入
- 批量写入收到 `WRITE_PARTIAL` 时，按错误中的输入序号确认每一项结果，成功项已经写入，不得重试，只处理冲突或未确认项

### 数据约定

- 账单、账本、分类和资产 ID 使用 Java `long` 正数范围内的十进制字符串，`"-1"` 和 `"0"` 只能在具体字段明确允许时使用
- 标签和成员 ID 使用对应查询返回的原始字符串，不得按数值 ID 猜测或改写
- 金额使用币种主单位，不使用分、美分等最小货币单位
- `money`、`fee` 和 `discount` 的业务含义以工具字段说明为准，输入结构约束以 Schema 为准
- 服务端自动换算时，汇率按 HALF_UP 保留 10 位，换算金额按 HALF_EVEN 保留 2 位
- 跨币种账单使用 `get_user_info.baseCurrency` 解释本位币，读取历史账单时使用 `currencyConversion` 的保存值，不用当前汇率重算
