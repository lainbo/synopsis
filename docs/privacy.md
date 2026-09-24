# 隐私与使用限制

## 邮件数据去向

| 服务 | 接收的数据与用途 |
|---|---|
| Cloudflare Email Routing / Workers | 完整原始邮件，在 Worker 内解析和处理 |
| Gmail | 原始 MIME 和附件，保存在 OAuth 授权账号 |
| Cloudflare Email Sending / Resend | 兜底时发送邮件及 `original.eml` 原始附件到 `BACKUP_EMAIL_TO` |
| 所选 AI 服务及自定义代理 | 可读正文、收发件信息、主题和日期等摘要输入；可能包含验证码和其他敏感信息 |
| Telegram | 摘要、验证码、告警；点击原文按钮后会显示可读正文及邮件头信息 |
| Cloudflare KV | 处理状态、邮件元信息、可读正文、摘要、Telegram 与 Gmail 消息映射 |

代理能够接触发往它的 API key 和邮件内容。通用模式的额外参数按使用者配置发送；数据保留规则由实际供应商、账号和路由设置决定。OpenRouter 专用模式的 ZDR 重试及提示见 [配置说明](ai-maintenance/configuration-and-secrets.md#openrouter-专用模式)。

## 保存期限与删除

- `processing:<id>`：每次写入后 24 小时过期，包含处理状态及邮件元信息；补偿仍在更新时会续期。
- `email:<uuid>`、`msgmap:<messageId>`：默认 7 天；更新时可能重新计算 TTL。
- 告警状态和去重记录使用各自期限，详见 [KV 保存期限](ai-maintenance/architecture.md#kv-key-约定)。
- Gmail 和 Telegram 的数据按各自服务及用户操作保留。删除 Telegram 消息不会自动删除所有供应商记录。
- “删邮件+消息”只在 Gmail 主备份成功时出现，将 Gmail 副本移入垃圾箱并删除 Telegram 消息，成功后清理对应正文缓存和映射；不会清除处理状态、兜底邮件、日志或 AI 服务端记录。走 Cloudflare / Resend 兜底时没有这个按钮。

## 日志与配置

应用默认日志保留处理 ID、事件名、阶段、状态码和计数，不输出邮件主题、收发件地址、正文或原始错误消息。OpenRouter/Gemini 的错误详情会脱敏、截断后用于 Telegram 和 KV；正则脱敏无法保证识别供应商返回的所有敏感片段，导出记录前仍需人工检查。

Wrangler 部署输出可能显示本机 vars、绑定 ID 和发件地址，Cloudflare 平台也有自己的日志。分享终端输出前检查；不要上传 `.wrangler`、私有配置或部署备份目录。

`.gitignore` 保护当前文件，不能抹除已经提交的历史。`pnpm check:public` 检查工作区，`--staged` 检查暂存区实际内容，`--ref <提交>` 检查该提交快照；提交前 hook 使用暂存区模式，CI 使用提交快照模式。这些检查覆盖常见凭据格式及私人文件名，仍需人工审查。

## 当前限制

- 面向个人单账号使用，Telegram 只支持本人私聊。
- 原始邮件先完整读入内存；`MAX_PARSE_BYTES` 只控制解析。极大邮件仍受 Worker 内存、执行时间和供应商附件限制约束。
- AI 输入目前没有按模型上下文自动截断；长邮件可能生成失败，原件备份继续保留。成功生成的长摘要在 Telegram 发送和编辑时裁剪，预留截断说明及完整隐私提示；KV 中保存完整摘要。
- 单次摘要请求有超时，整个备份链和通知链仍受平台时间限制。Cron 恢复依赖已成功写入 KV 的状态与缓存。
- KV 最终一致，状态合并和 Cron 标记不提供严格互斥；并发时可能丢失更新或产生重复处理/通知。当前实现不提供严格的“恰好一次”保证。
- 邮件到达 Worker 前的拒收或路由问题，需要在 Cloudflare 控制台排查。
- `/health` 只说明 HTTP 入口正在响应，不能验证 KV、发信绑定或外部账号。

维护要求与故障处理见 [维护指南](ai-maintenance/maintenance-guide.md) 和 [运维文档](ai-maintenance/operations.md)。
