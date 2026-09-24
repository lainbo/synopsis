# 配置、绑定与 Secrets

## 填写顺序

| 分组 | 必须填写的内容 | 可以先不填的内容 |
|---|---|---|
| 基础必填 | Gmail 的 3 项授权信息、Telegram 的 3 项配置、`MAIL_KV` 绑定 | — |
| AI 三选一 | 所选模式的模型和 API key；`SUMMARY_PROVIDER` 默认 `openai`，其他模式需显式指定 | 另外两家的全部变量；使用官方接口时的 Base URL |
| 邮件兜底 | 使用哪种兜底，就补齐该服务及共用收件地址的配置 | 暂未使用的兜底服务；正式收信建议至少配好一种 |
| 共用可选项 | 无 | 提示词、Gmail 用户标识、解析大小、重试次数等均有默认行为 |

例如选 Gemini，只需在基础配置之外设置 `SUMMARY_PROVIDER=gemini`、`GEMINI_MODEL` 和 `GEMINI_API_KEY`。`GEMINI_BASE_URL` 默认使用 Google 官方地址，OpenAI 和 OpenRouter 的配置均可省略。

## 文件分工

- `wrangler.example.jsonc`：公开模板，AI 模式按供应商分组，可选参数和发信兜底绑定以注释提供。
- `wrangler.jsonc`：本机私有配置，被 Git 忽略；保存 Worker 名称、KV ID 和发信绑定，`vars` 保存模式、模型、基础地址及可选参数。不要在其中填写 API key。
- `.dev.vars.example`：公开的本地密钥模板；复制为被忽略的 `.dev.vars` 后，填写基础必填组，只取消所选 AI 密钥及所需兜底配置的注释。
- Cloudflare Secrets：生产密钥，使用 `pnpm exec wrangler secret put 名称` 交互写入。

下文的账号信息、API key、webhook 密钥和兜底邮箱地址，本地放 `.dev.vars`，生产用 Secret 保存。其他变量放在 `wrangler.jsonc` 的 `vars` 中，绑定放在对应的顶层配置项中。`.dev.vars` 不会自动成为生产 Secrets。

维护中可按任务需要读取、使用真实配置；日志、文档、提交和回复只保留脱敏结果。不要把凭据放进 URL、命令行参数或公开示例。私有配置需自行安全备份。

## 基础必填

Gmail 原件备份和 Telegram 通知、按钮所需的账号配置共 6 项：

| 变量 | 填写内容 |
|---|---|
| `GMAIL_CLIENT_ID` | 自己的 Google OAuth 客户端 ID |
| `GMAIL_CLIENT_SECRET` | 同一个 OAuth 客户端的密钥 |
| `GMAIL_REFRESH_TOKEN` | Gmail 授权账号的 refresh token |
| `TG_BOT_TOKEN` | Telegram Bot 密钥 |
| `TG_CHAT_ID` | 本人私聊 ID，必须是正整数字符串；不支持群组，先向 Bot 发送 `/start` |
| `TG_WEBHOOK_SECRET` | 自行生成随机字符串，使用字母、数字、下划线或短横线；注册 webhook 时将同一个值作为 `secret_token` |

`MAIL_KV` 也是必填绑定，在 `wrangler.jsonc` 的 `kv_namespaces` 中填写 namespace ID 和本地开发使用的 preview ID。它保存处理状态、正文缓存、Telegram 映射、Cron 防重入标记和告警去重记录。

Gmail 授权过程见 [Gmail 设置](../gmail-oauth-setup.md)，Bot 设置见 [Telegram 设置](../telegram-setup.md)。

## 三种摘要模式

**只配置其中一种。** `SUMMARY_PROVIDER` 取 `openai`（默认）、`openrouter` 或 `gemini`。代码按该变量选择实现，接口域名不会改变模式。模型没有默认值，必须填写；API key 只需准备当前模式对应的一项。

| `SUMMARY_PROVIDER` | 必填模型（`vars`） | 必填密钥（本地 `.dev.vars` / 生产 Secret） | 可选地址变量及默认值 |
|---|---|---|---|
| `openai` | `OPENAI_MODEL` | `OPENAI_API_KEY` | `OPENAI_BASE_URL=https://api.openai.com/v1` |
| `openrouter` | `OPENROUTER_MODEL` | `OPENROUTER_API_KEY` | `OPENROUTER_BASE_URL=https://openrouter.ai/api/v1` |
| `gemini` | `GEMINI_MODEL` | `GEMINI_API_KEY` | `GEMINI_BASE_URL=https://generativelanguage.googleapis.com/v1beta` |

基础地址可省略或留空，使用上表中的官方默认值。使用其他 OpenAI 兼容服务或代理时，需填写对应服务的基础地址。地址必须使用 HTTPS，不包含账号密码、查询参数或 fragment；末尾 `/` 会自动去掉。填写基础路径即可，不要填完整方法路径。代理也能看到请求内容和密钥，应由使用者自行选择可信服务。

缺少当前模式的模型或密钥，或填写的基础地址不合法时，三种模式都返回对应的 `*_config_invalid`，不发起摘要请求；Telegram 占位通知提示检查对应的模型、密钥和基础地址，原件备份不受影响。

### 通用 OpenAI 兼容模式

最少在 `vars` 中配置以下内容，并写入 `OPENAI_API_KEY`：

```json
{
  "SUMMARY_PROVIDER": "openai",
  "OPENAI_MODEL": "YOUR_MODEL_ID"
}
```

`OPENAI_BASE_URL` 可省略，默认使用 OpenAI 官方地址。认证使用 `OPENAI_API_KEY` Bearer，请求路径追加 `/chat/completions`。

`OPENAI_EXTRA_BODY` 可省略，默认不传扩展参数。填写时使用 JSON 对象字符串，例如 `"{\"max_completion_tokens\":1024}"`。不能覆盖程序管理的 `model`、`messages` 和 `stream`；使用单条 user 消息和非流式请求。`temperature`、token 上限等可选参数由使用者按模型的接口文档填写。

例如通过通用模式访问 OpenRouter，允许填写：

```json
{
  "SUMMARY_PROVIDER": "openai",
  "OPENAI_BASE_URL": "https://openrouter.ai/api/v1",
  "OPENAI_MODEL": "YOUR_OPENROUTER_MODEL_ID",
  "OPENAI_EXTRA_BODY": "{\"provider\":{\"zdr\":true},\"reasoning\":{\"effort\":\"minimal\",\"exclude\":true}}"
}
```

此时密钥使用 `OPENAI_API_KEY`。请求始终使用 `OPENAI_MODEL` 指定的模型，额外参数原样发送，重试沿用相同的 ZDR 和 reasoning 设置。配置检查校验模型名、基础地址和额外 JSON 参数。

缺少模型或密钥，或填写的基础地址、`OPENAI_EXTRA_BODY` 不合法时返回配置错误。`OPENAI_EXTRA_BODY` 可留空。响应读取 `choices[0].message.content`；空内容、格式异常、输出截断均视为失败。HTTP 错误只报告状态码，防止供应商错误正文泄露输入内容。

`finish_reason=content_filter` 或非空 `message.refusal` 视为供应商拒绝生成，返回 `openai_blocked` 并结束本次摘要调用；响应中的残留文字不作为成功摘要。

超时、网络错误、408/409/425/429、5xx 和无效摘要最多尝试 3 次；单次超时 12 秒，覆盖正文读取；`Retry-After` 最多等待 2 秒。参考 [Chat Completions](https://developers.openai.com/api/reference/typescript/resources/chat/subresources/completions/methods/create)。

### OpenRouter 专用模式

最少在 `vars` 中配置以下内容，并写入 `OPENROUTER_API_KEY`：

```json
{
  "SUMMARY_PROVIDER": "openrouter",
  "OPENROUTER_MODEL": "YOUR_OPENROUTER_MODEL_ID"
}
```

以下均为可选项：

| 变量 | 不填写时的行为 |
|---|---|
| `OPENROUTER_BASE_URL` | 使用 `https://openrouter.ai/api/v1` |
| `OPENROUTER_FALLBACK_MODEL` | 只使用主模型，不切换备用模型 |
| `OPENROUTER_ZDR` | 不主动要求 ZDR 路由；设为 `true` 或 `1` 时开启下述隐私路由行为 |
| `OPENROUTER_REASONING_EFFORT` | 由部署命令按模型能力维护，支持时默认 `minimal` |
| `OPENROUTER_REASONING_EXCLUDE` | 由部署命令按模型能力维护，启用 reasoning 时默认 `true` |

认证使用 `OPENROUTER_API_KEY` Bearer，请求路径追加 `/chat/completions`。缺少模型或密钥，或填写的基础地址不合法时返回配置错误。每次请求发送单个 `model`、`max_tokens=500`、`temperature=0.2`。

配置备用模型后，主模型遇到网络、超时、403/408/409/425/429、5xx、路由不可用、无效响应、空摘要或截断等可切换错误时，下一次请求切备用模型。普通的 401/402 状态错误直接结束请求。通知生成流程会将实际响应模型写入 `summary_model`，并在备用模型生成摘要且通知完成后尝试发送模型切换告警。

`finish_reason=content_filter` 或非空 `message.refusal` 返回 `openrouter_blocked`，结束本次摘要调用，不重试、切换备用模型或放宽 ZDR 限制；响应中的残留文字不作为成功摘要。

`OPENROUTER_ZDR=true` 或 `1` 时优先要求供应商不保留请求数据。主模型遇到 ZDR 路由不可用或 403 时，先切换到已配置的备用模型；未配置备用模型时，在主模型上放宽 ZDR 限制。备用模型遇到相同的路由错误时，在备用模型上放宽限制。Telegram 会显示隐私路由提示，首次通知、Cron 补发及“返回摘要”都适用；通知流程用 `summary_privacy_downgraded` 记录这一行为。账号级限制仍可能继续强制 ZDR，实际数据保留规则取决于最终路由。详见 [OpenRouter 路由设置](https://openrouter.ai/docs/guides/routing/provider-selection)。

同一模型、同一 ZDR 设置下，每轮最多尝试 3 次，包含首次请求。配置备用模型时，主模型在首次可切换错误后结束该轮；备用模型和 ZDR 降级分别开始新一轮。ZDR 路由不可用或 403 会立即结束当前 ZDR 轮次，其他瞬时错误按该轮上限重试。整个摘要调用可能达到以下请求次数：

| ZDR 设置 | 单个模型 | 配置备用模型 |
|---|---|---|
| 关闭 | 最多 3 次 | 最多 4 次 |
| 开启且触发 ZDR 降级 | 最多 6 次 | 最多 7 次 |

这些是请求次数上限，实际次数取决于错误序列。单次超时 12 秒，覆盖响应头和正文读取；`Retry-After` 最多等待 2 秒。整个调用还受 Worker 执行时间限制。

`pnpm verify:config` 只检查配置和查询模型能力；reasoning 配置需要调整时会报错退出，不写文件。`pnpm run deploy` 会在上传前自动调整本机 `wrangler.jsonc`：主备模型都声明支持 `reasoning` 时，保留已配置 effort（未填默认 `minimal`），exclude 默认 `true`；任一模型不支持时移除两项。仅在配置需要调整时重写整个文件，原有 JSONC 注释会丢掉，部署前先备份；配置已匹配时保留原文件。模型列表代表可用能力，并不保证每条供应商路线支持同样参数。模型不存在会停止部署。模型列表默认访问官方地址，可用本机环境变量 `OPENROUTER_MODELS_URL` 覆盖。

请求使用 `reasoning: { effort, exclude }`。模型能力检查访问公开模型列表；错误详情会脱敏、截断后用于 Telegram/KV 排障。

### Gemini 原生模式

最少在 `vars` 中配置以下内容，并写入 `GEMINI_API_KEY`：

```json
{
  "SUMMARY_PROVIDER": "gemini",
  "GEMINI_MODEL": "YOUR_GEMINI_MODEL_ID"
}
```

`GEMINI_BASE_URL` 可省略，默认使用 `https://generativelanguage.googleapis.com/v1beta`；仅使用代理等自定义入口时需要填写。无需配置 OpenAI 或 OpenRouter 的模型、密钥和基础地址。

认证使用 `x-goog-api-key` 请求头，请求路径追加 `/models/{model}:generateContent`。请求发送 `contents[].parts[].text` 和 `generationConfig.maxOutputTokens=2048`；Gemini 3 使用 `thinkingLevel=low`，Gemini 2.5 使用 `thinkingBudget=0`。响应跳过 `thought: true` 的内容，`MAX_TOKENS` 视为截断失败。

提示词被拦截，或响应包含 `SAFETY`、`RECITATION` 等已识别的拒绝原因时，返回 `gemini_blocked` 并结束本次摘要调用；响应中的残留文字不作为成功摘要。

该模式使用 Gemini 配置；缺少模型或密钥，或填写的基础地址不合法时返回配置错误。瞬时错误最多尝试 3 次，单次超时 12 秒包含正文读取，`Retry-After` 最多 2 秒。部署时检查模型名和基础地址，模型的实际可用性需要真实调用确认。

## 邮件兜底：按需配置

Gmail 主备份成功时不会读取这些配置；Gmail 失败后依次尝试 Cloudflare Email Sending、Resend。两种兜底可以分别配置，正式收信建议至少配好一种。

| 使用场景 | 该场景必填 | 配置位置与要求 |
|---|---|---|
| 任一种邮件兜底 | `BACKUP_EMAIL_TO` | 本地 `.dev.vars` / 生产 Secret；能独立收信，避免再次路由回本 Worker |
| Cloudflare Email Sending | `CF_EMAIL_FROM` | 本地 `.dev.vars` / 生产 Secret；已验证的 Cloudflare 发件地址 |
| Cloudflare Email Sending | `EMAIL` 绑定 | 取消 `wrangler.jsonc` 中 `send_email` 的注释；`allowed_sender_addresses` 包含 `CF_EMAIL_FROM` 使用的地址 |
| Resend | `RESEND_API_KEY` | 本地 `.dev.vars` / 生产 Secret；Resend API 密钥 |
| Resend | `RESEND_FROM` | 本地 `.dev.vars` / 生产 Secret；Resend 已验证的发件地址 |

这些变量和绑定没有默认值。未配置的兜底在执行到该步骤时会失败，并继续尝试下一家；全部备份失败时会记录失败、尝试 Telegram 告警并让邮件处理报错。两种都未配置时，原件备份完全依赖 Gmail。发信账号设置见 [Gmail 与兜底设置](../gmail-oauth-setup.md)。

## 共用配置

**以下全部可选，一般无需填写。** 需要调整时加入 `wrangler.jsonc` 的 `vars`。

| 变量 | 省略时的默认值或行为 | 用途 |
|---|---|---|
| `GMAIL_USER_ID` | `me` | 原始 MIME 写入 OAuth 授权账号 |
| `SUMMARY_PROMPT` | 内置中文摘要提示词 | 自定义模板支持 `{{MAIL_TO}}`、`{{EMAIL_TEXT}}`，没放正文占位符时自动追加正文 |
| `MAX_PARSE_BYTES` | `10485760`（10 MiB） | 只限制 MIME 解析，不限制原始邮件读取和备份 |
| `ENVIRONMENT` | `development`；示例设为 `production` | 仅为健康检查环境标识 |
| `CRON_LOCK_TTL_SECONDS` | `240` 秒 | KV 防重入标记有效期 |
| `TELEGRAM_RETRY_LIMIT` | `3` | Cron 补偿采用的尝试次数上限，计数范围见 [运维说明](operations.md#cron-和补偿) |

## 维护约束

配置检查使用 `jsonc-parser` 读取 JSONC。部署命令按所选模式检查配置，并在 OpenRouter 模式下维护本机 reasoning 参数。`TG_WEBHOOK_SECRET`、私聊类型、目标 chat ID、点击者 ID 及消息映射须同时匹配，才允许查看正文或操作 Gmail。

`back_summary` 使用当前配置重新生成摘要，只更新当前 Telegram 消息，不写回 KV 缓存；摘要失败不能影响原件备份。数据去向及缓存期限见 [隐私说明](../privacy.md)。
