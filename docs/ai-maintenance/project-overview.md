# 项目全貌

## 项目目标

Synopsis 为个人域名邮件提供 Gmail 原件备份和 Telegram 通知。邮件先尝试写入 Gmail，失败后依次尝试 Cloudflare Email Sending 和 Resend；AI 摘要或 Telegram 失败不得影响已经完成的备份。

项目支持三种摘要模式、本人 Bot 私聊和可选的本机自动部署。仓库提供示例配置，账号信息由部署者自行填写，生产密钥保存在 Cloudflare Secrets。

## 技术栈

| 组件 | 用途 |
|---|---|
| TypeScript、Cloudflare Workers | 邮件处理与 HTTP、定时任务入口 |
| Cloudflare Email Routing | 接收域名邮件并交给 Worker |
| Cloudflare KV | 处理状态、可读正文、消息映射与告警去重记录 |
| Gmail API | `users.messages.insert` 保存原始 MIME，`trash` 将副本移入垃圾箱 |
| Cloudflare Email Sending、Resend | 发送带 `original.eml` 的兜底邮件 |
| Telegram Bot API | 摘要、正文查看、邮件操作和告警 |
| OpenAI 兼容接口、OpenRouter、Gemini | 按 `SUMMARY_PROVIDER` 选择一种服务生成摘要 |
| Hono | HTTP 路由 |
| postal-mime、html-to-text | 解析 MIME，将 HTML 转换成可读正文 |

入口与调用关系见 [架构文档](architecture.md)，设计原因和可靠性边界见 [设计说明](design-decisions.md)。

## 使用范围

当前面向单个 Gmail 授权账号和本人 Telegram 私聊。原文在 Bot 中以内联消息显示，完整排版与附件保存在备份邮箱。正文缓存和消息映射默认保存 7 天。

Telegram 通知在后台即时尝试，Cron 扫描 KV 状态进行补偿。恢复能力受已保存状态和缓存限制，KV 不提供严格互斥或“恰好一次”保证。

详细限制见 [隐私与使用限制](../privacy.md)。
