# 运维

## 常用命令

```bash
pnpm typecheck
pnpm dev
pnpm verify:config
pnpm run deploy
```

本项目使用 `pnpm`。安装或更新依赖前先确认 `pnpm-lock.yaml`，不要混用 npm/yarn/bun lockfile。

依赖版本由 lockfile 固定，`pnpm-workspace.yaml` 仅允许 esbuild、workerd 安装脚本。新增依赖时检查来源和所需构建脚本。

`pnpm verify:config` 只检查、不写文件；OpenRouter reasoning 配置需要调整时会报错退出。`pnpm run deploy` 先检查摘要配置；只有 `SUMMARY_PROVIDER=openrouter` 会查询模型能力并自动调整本机私有 `wrangler.jsonc` 的 reasoning 配置。仅在配置需要调整时重写整个文件，原有 JSONC 注释会丢掉，部署前先备份；配置已匹配时保留原文件。通用模式检查模型、地址和额外 JSON 参数，Gemini 检查模型和地址。随后类型检查并部署。

## 自动部署

自动部署默认关闭。需要本机提交后自动部署时执行：

```bash
pnpm hooks:enable
```

该命令只修改当前仓库的本地 Git 设置。启用后 pre-commit 使用 `pnpm check:public --staged` 检查实际暂存内容，并对工作区执行类型检查，post-commit 部署；私人配置不加入提交。已有其他 Git hooks 时，需要合并设置。

`pnpm hooks:disable` 关闭提交后部署。临时跳过用 `SKIP_DEPLOY=1 git commit ...`，`--no-verify` 不跳过 post-commit。提交成功而部署失败时，修复后手动执行 `pnpm run deploy`。

发布前使用 `pnpm check:public --ref <提交>` 检查准备发布的快照，CI 也检查提交快照。工作区预检查使用不带参数的 `pnpm check:public`。

## 更新部署与回滚

1. 更新前记录当前 Worker 版本 ID，备份本机 `wrangler.jsonc`；本地运行所需的 `.dev.vars` 另行安全保存。
2. 更新代码并执行 `pnpm install --frozen-lockfile`。继续使用原部署时，保留 Cloudflare 账号、Worker 名称、KV ID、Secrets、发件绑定和 webhook 地址。
3. 执行 `pnpm typecheck` 和 `pnpm build`，确认通过后执行 `pnpm run deploy`；部署命令会检查摘要配置，并在 OpenRouter 模式下完成所需的 reasoning 调整。
4. 访问 `/health` 确认 HTTP 入口有响应，再通过实际收信确认 Gmail 原件与附件、Telegram 摘要和按钮行为。`/health` 不能验证 KV、发信绑定或外部账号，真实兜底效果也不能由本地模拟代替。

需要回退时执行：

```bash
pnpm exec wrangler rollback <目标版本ID>
```

同时按目标版本恢复本机配置。Worker 回滚不会回滚 KV 数据；缓存和消息映射仍按各自期限保存。为同一个 Worker 保留一个明确的部署来源，避免不同目录的自动部署相互覆盖。

## 本地开发

启动 Worker：

```bash
pnpm dev
```

健康检查：

```bash
curl http://localhost:8787/health
```

修改代码后执行：

```bash
pnpm typecheck
git diff --check
```

文档改动至少跑：

```bash
git diff --check
```

## 实际运行观察规则

通过实际邮件和脱敏状态观察运行结果：

- 不记录 raw MIME、正文、HTML、附件内容、完整 provider response、截图里的 secret 或完整 KV 值。
- 只记录时间、事件名、provider 类别、安全 response id、状态字段名、布尔值、计数和脱敏原因码。
- 生产中的破坏性故障注入需要用户明确授权，并准备回滚方式。

## 告警语义

| 信号 | 含义 | 响应 |
|------|------|------|
| `Gmail 备份异常（已兜底）` | Gmail 主备份失败，但 Cloudflare Email Sending 或 Resend 已接受带原件附件的发送请求 | 检查 Gmail auth/API，同时确认兜底邮件实际投递结果 |
| `backup_state_save_failed` 日志 | 供应商已确认成功时，KV 保存失败不会触发另一家备份；通知阶段会再次保存成功结果。全部供应商失败时也可能出现此日志 | 对照同一处理 ID 的 `*_backup_done` / `*_backup_failed` 日志判断实际备份结果，检查 KV 是否持续异常 |
| `邮件备份彻底失败，Cloudflare 将重试投递` | Gmail、Cloudflare Email Sending、Resend 全失败 | 最高优先级，检查三条备份链和 Email Routing retry |
| `Gmail 授权失效` | refresh token 或 Gmail API 授权异常 | 重新授权并更新 Cloudflare Secret，不记录 secret 值 |
| `summary_placeholder` | AI 摘要失败，但 Telegram 发送了占位通知 | 先确认原件备份，再看 Telegram 文案中的 sanitized reason/detail、`processing:<id>.summary_error` 和 `summary_error_detail` |
| `openai_config_invalid` / `openrouter_config_invalid` / `gemini_config_invalid` | 当前摘要模式的配置缺失或无效，未发起摘要请求 | 检查对应的模型、密钥和基础地址；通用模式还需检查 `OPENAI_EXTRA_BODY` |
| `AI 摘要已切换备用模型` | OpenRouter 主模型出现可切换错误后，备用模型生成摘要成功，通知流程发送模型切换告警 | 检查 OpenRouter 主模型和 ZDR/非 ZDR 路由状态 |
| `openrouter_http_403` | OpenRouter 拒绝摘要请求；如果 `summary_privacy_downgraded=true`，表示 ZDR 降级后仍失败 | 检查 API key 权限、模型访问权限、余额/额度、OpenRouter provider 路由；短暂抖动可通过 `返回摘要` 重新生成 |
| `openrouter_http_429` / `openrouter_http_5xx` | OpenRouter 按当前模型和 ZDR 配置执行重试后仍失败，请求次数见 [配置说明](configuration-and-secrets.md#openrouter-专用模式) | 看 OpenRouter 状态、模型供应商状态和是否持续限流；短暂抖动通常会在摘要重试或 `返回摘要` 时恢复 |
| `gemini_http_401` / `gemini_http_403` | Gemini 拒绝摘要请求 | 检查 `GEMINI_API_KEY`、模型名和 API 权限；不要在日志里回显 key |
| `gemini_http_429` / `gemini_http_5xx` | Gemini 在代码级最多 3 次尝试后仍失败 | 看 Gemini API 状态和是否持续限流；短暂抖动通常会在摘要重试或 `返回摘要` 时恢复 |
| `openai_timeout` / `openrouter_timeout` / `gemini_timeout` | 单次请求超过 12 秒，包括响应正文迟迟未完成 | 检查供应商及代理响应时间；客户端按现有重试规则处理，失败提示可通过「返回摘要」重新生成 |
| `openai_blocked` / `openrouter_blocked` / `gemini_blocked` | 供应商拒绝生成摘要；当前摘要调用立即结束，原件备份不受影响 | Telegram 显示拒绝生成提示，可通过「原文」查看邮件正文；OpenRouter 不因此切换备用模型或放宽 ZDR 限制 |

## Cron 和补偿

Cron 默认每 5 分钟触发。`runScheduledMaintenance()` 会：

- 用 `cron:lock` 降低重复执行概率；KV 标记不提供严格互斥。
- 每个获得锁的 tick 都跑 Telegram/告警补偿。
- 每轮结束释放锁；补偿异常时记录日志并释放锁。

`TELEGRAM_RETRY_LIMIT` 设置 Cron 判断是否继续补偿的尝试次数上限，默认 3。各类任务的计数范围不同：

| 任务 | 计数范围 | 达到上限且仍未完成时 |
|---|---|---|
| 邮件摘要通知 | 入站通知失败和后续 Cron 处理共用 `telegram_attempts`；默认首次失败记为 1，后续最多再补偿 2 次 | 尝试发送最终失败告警 |
| Gmail 兜底、全部备份失败告警 | 入站告警和 Cron 补偿共用各自的 `*_alert_attempts` | 尝试发送最终失败告警 |
| Gmail 授权失效告警 | `gmail:auth_alert.attempts` 记录 Cron 尝试次数 | 停止 Cron 补偿 |

邮件摘要通知只处理 `backup_done=true` 且 `telegram_done=false` 的状态。占位通知成功送达后也会标记完成；用户可通过“返回摘要”再次生成。备份告警按各自的完成状态补偿。

最终失败告警发送成功后写入有效期 7 天的去重记录；发送或记录失败时，后续 Cron 可能再次尝试。入站处理中的备份告警尝试上限固定为 3，`TELEGRAM_RETRY_LIMIT` 控制 Cron 阶段。

## 生产问题排查顺序

1. 先确认原件是否到达 Gmail 或 fallback provider。
2. 再看 `processing:<id>` 的 `backup_done`、`backup_provider`、`backup_error_chain`。
3. 看 Telegram 是否 `telegram_done=true`；如果 false，检查 `telegram_stage`、`telegram_attempts`、`telegram_next_retry_at`。
4. 看是否有 `fallback_alert_done=false`、`critical_backup_alert_done=false` 或 `gmail:auth_alert.done=false` 等待 Cron。
5. 如果 Worker 没有收到邮件，在 Cloudflare 控制台检查 Email Routing 活动记录与路由规则。

## 相关文档

验证方法和可靠性边界见 [设计说明](design-decisions.md)，数据去向见 [隐私说明](../privacy.md)。实际 Worker/KV/代理配置保存在被忽略的本机文件，Secrets 在 Cloudflare。应用日志只记录安全错误类型、原因码和状态，不输出完整错误消息或邮件地址/主题。
