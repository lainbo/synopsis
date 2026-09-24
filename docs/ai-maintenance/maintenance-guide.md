# 维护指南

## 修改前先确认任务类型

仓库文件换行符只使用 LF。

| 任务 | 先看 |
|------|------|
| 改邮件接收、解析、幂等 | `src/handlers/email.ts`、`processing-id.ts`、`processing-state.ts`、`mime-parser.ts` |
| 改 Gmail 或备份兜底 | `backup-orchestrator.ts`、`gmail-auth.ts`、`gmail-backup.ts`、`cloudflare-email-fallback.ts`、`resend-fallback.ts` |
| 改摘要或 Telegram 通知 | `notification-orchestrator.ts`、`email-summary.ts`、`openai-summary.ts`、`openrouter-summary.ts`、`gemini-summary.ts`、`telegram.ts`、`email-cache.ts` |
| 改 Telegram 按钮 | `telegram-callback.ts`、`telegram.ts`、`email-cache.ts`、`gmail-backup.ts` |
| 改 Cron 补偿 | `cron-monitor.ts`、`telegram-compensation.ts`、`processing-state.ts`、`reliability-alerts.ts` |
| 改配置 | `src/types.ts`、`config.ts`、`wrangler.example.jsonc`（本机实际配置为被忽略的 `wrangler.jsonc`）、`docs/gmail-oauth-setup.md` |

## 不变量清单

修改代码时必须保护这些行为：

- Gmail/fallback 备份链路不能被 Telegram、摘要供应商、正文缓存、msgmap 写入失败阻断。
- `state.backup_done=true` 时，重试不能重复写 Gmail 或 fallback；但未完成的 Telegram/alert 仍可补偿。
- 全部备份 provider 失败时，要记录 `backup_error_chain`，尝试 critical alert，然后抛错触发 Cloudflare retry。
- Gmail 主备份失败但 fallback 成功时，不能抛错触发整封邮件重试；应记录 fallback 状态并发送/补偿告警。
- 供应商发送的 `try/catch` 只包含发送调用；备份成功后的 KV 保存失败不能触发下一家供应商。成功结果保留在当前处理状态中，后续通知写入会再次保存该结果。
- 处理状态、邮件缓存和消息映射写入通过 `putKvValue` 处理 429：等待 1 秒后重试一次，其他错误直接交给调用方。摘要与 Telegram 结果合并写入处理状态。
- Gmail insert 走 `/upload/.../messages?uploadType=multipart`（multipart/related，JSON metadata + `message/rfc822` 原始字节），不把整封原件放进 JSON 的 `raw` 字段，以免体积明显变大。
- Cloudflare Email Sending / Resend fallback 必须附带 `original.eml`（原始 MIME）附件；解析被跳过或失败时占位正文不算备份，附件才是。CF binding 附件 `content` 传 `ArrayBuffer`，Resend 传 base64 字符串。Resend 整封邮件上限为 40 MB，包含正文和 Base64 编码后的附件，见 [Resend 附件限制](https://resend.com/docs/dashboard/emails/attachments#attachment-limitations)。Cloudflare Email Sending 整封邮件普通发送上限为 5 MiB，向已验证目标地址发送时为 25 MiB，见 [Email Service limits](https://developers.cloudflare.com/email-service/platform/limits/)；`BACKUP_EMAIL_TO` 应配置为已验证目标才能用到 25 MiB。入站 Email Routing 上限为 25 MiB；原件作为附件重新封装后的兜底邮件仍须满足发送大小限制。
- `handleEmail` 首次状态写入必须初始化 `telegram_done: false`、`telegram_email_id` 和 `telegram_next_retry_at`（telegram_done 已为 true 除外）。备份完成后先保存正文缓存，再进入 `waitUntil`；Cron 需要正文与缓存 ID 才能恢复摘要。正文准备失败时通知入口再尝试一次，不能使原件备份重试。
- Cron 仅为已完成备份的邮件补偿摘要通知；缓存没有摘要时重新生成，已有摘要时优先复用，并恢复缓存中的摘要结果。备份失败告警按各自状态补偿。摘要失败占位提示应准确反映备份状态。
- Telegram 失败不在当前 email handler 内循环重试；只记录状态和 `telegram_next_retry_at`。
- Telegram callback 必须校验 `TG_WEBHOOK_SECRET`、私聊类型、本人 chat id 和点击者 id。
- 原文经本人 Telegram 私聊 callback 内联提供，读取正文或操作 Gmail 前须校验消息映射归属。

## 并发限制

KV 最终一致，以下操作不能提供严格的唯一性或互斥保证：

- `mergeProcessingState` 使用非原子的读改写；email handler、后台通知和 Cron 并发更新同一个 key 时可能丢失更新或产生重复处理、通知。
- `cron:lock` 使用 get 判空后 put，作用是降低重复执行概率；并发 Cron 仍可能同时通过检查。去重记录和 attempts 上限可以限制重复操作，但不构成严格的“恰好一次”保证。

## 修改可靠性逻辑前

备份顺序、状态保存和通知补偿承担具体的可靠性要求。修改前先阅读 [设计说明](design-decisions.md)，并对照当前代码、实际行为或脱敏日志。现有代码和设计说明无法解释特殊行为时，再查阅相关文件的 Git 历史。

建议流程：

1. 用 `rg` 或语义搜索定位相关代码和调用链。
2. 从实现、复现结果或脱敏日志中取得证据。
3. 现有代码和设计说明无法解释特殊行为时，查阅相关文件的 Git 历史。
4. 做最小范围修改。
5. 跑 `pnpm typecheck` 和 `git diff --check`，部署后从实际使用中观察结果。

重点核对：

- `backup-orchestrator.ts` 的 provider 顺序、throw 条件、alert 记录。
- `src/handlers/email.ts` 中通过 `ctx.waitUntil` 执行通知的隔离语义。
- `telegram-compensation.ts` 的 retry cap、final alert dedupe、mapping repair。
- `telegram-callback.ts` 的本人私聊校验、消息映射归属、删除和 Gmail trash 行为。

## 常见改动建议

### 新增环境变量

1. 更新 `src/types.ts`。
2. 如果必填，用 `getRequiredEnv` 保持缺失配置时的明确失败行为。
3. 如果可选，定义默认值或显式降级行为。
4. 更新 [configuration-and-secrets.md](configuration-and-secrets.md)。
5. 不要在文档里写真实值。

### 新增外部 API 调用

1. 必须 try/catch 或返回结构化失败 reason。
2. reason 应 sanitized，适合日志和 Telegram 告警；Telegram 摘要失败文案统一走 `summary-error-text.ts`。
3. 失败不能泄露 token、完整 response、邮件正文或 raw MIME。
4. 如果调用在非核心链路，不得影响 Gmail/fallback 备份。
5. 新增或改变第三方 API 用法时，先确认项目实际版本，再查对应官方文档或 Context7。

### 修改 Telegram 消息或按钮

1. 按钮通过 `callback_data` 传递 `view_raw`、`back_summary` 或 `trash_gmail`，回调根据消息 ID 查找 KV 映射。
2. Telegram 消息正文统一走 `sendMessage` / `editMessageText` 且带 `parse_mode: "HTML"`：发送层逐行转义 `< > &`，把验证码行的单反引号码值转换成 `<code>` 供 Telegram 一键复制，其余文本原样保留（含 `\n\n` 空行，保证段落间可读）；callback 提示使用 `answerCallbackQuery.text`。
   发送和编辑统一通过 `renderHtmlMessage` 限长：在 HTML 转义前按 UTF-16 长度保守控制到 4096，按字素边界裁剪，预留截断说明和 `PRIVACY_ROUTE_NOTICE`。缓存保留完整摘要，补发时同样限长。
3. `返回摘要` callback 用缓存的可读正文即时请求当前配置的摘要供应商，只更新当前 Telegram 消息，不写回 KV；失败时显示包含脱敏原因的摘要失败提示，备份结果保持有效。
4. 删除操作成功时，callback 通知统一显示 `✅ 已删除`。涉及告警文案的改动须同步运维文档。
5. 「🗑 删邮件+消息」仅在 Gmail 主备份成功、消息映射含 `gmailMessageId` 时出现。先查询 Gmail 邮件状态，404 或已有 `TRASH` 标签时视为 Gmail 处理完成，否则调用 trash；随后删除 Telegram 消息。Gmail 失败保留消息和 KV，并用 `show_alert: true` 提示重试。Telegram 删除失败保留 KV，使用默认非弹窗通知提示重试或手动删除；Bot API 的 48 小时删除限制仍适用。两边处理完成后清理 KV。

### 修改 AI 摘要

1. `summary-prompt.ts` 是用户可见的输出契约，改动时同步更新相关维护文档，并在实际邮件摘要中观察结果。
   默认和自定义模板统一替换 `{{MAIL_TO}}`、`{{EMAIL_TEXT}}`；自定义模板没有正文占位符时，自动追加收件人和邮件正文。占位符替换使用函数，按字面值插入正文，不把 `$&` 等字符解释为替换指令，也不再次替换邮件内容中的占位符。
2. 邮件要求点击链接验证邮箱或账户、且未提供实际码值时，使用非验证码模板概括需要执行的动作。
3. 验证码模板A依次输出收件人、验证码和摘要。只有实际码值两侧允许使用单反引号 inline code，发送层会转换成 HTML `<code>`（配合 `parse_mode: HTML`），供 Telegram 渲染为可点击复制的等宽文字；“未识别”不要包成 inline code，也不要使用代码块或其他 markdown。
4. 邮件出现退订/取消订阅/Unsubscribe 等同义提示时，摘要可在模板B最后一行追加退订提醒，但仍不输出 URL。
5. 三种模式的请求参数、重试上限和部署检查规则见 [配置说明](configuration-and-secrets.md#三种摘要模式)。OpenRouter 的备用模型切换和 ZDR 降级各自会开始新一轮请求；修改时须核对整个摘要调用的请求次数。
6. 三个客户端的单次 12 秒超时覆盖响应头和响应正文读取；超时取消应返回对应的 `*_timeout`。ZDR 放宽限制后的提示在首次通知、补发与返回摘要中保持一致。

## 提交前检查

公开文件检查脚本支持工作区、`--staged` 暂存区和 `--ref <提交>` 快照。提交前 hook 必须检查暂存区 Git 对象；发布前检查实际导出的提交。不得用工作区读取结果代替暂存区或提交内容。

代码改动推荐：

```bash
pnpm typecheck
git diff --check
```

只改文档至少：

```bash
git diff --check
```
