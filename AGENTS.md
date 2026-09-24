# Synopsis

本项目是部署在 Cloudflare Workers 上的个人域名邮件处理中枢：邮件进入域名后，原始邮件必须可靠备份到 Gmail；Gmail 失败时走 Cloudflare Email Sending / Resend 兜底；Telegram 负责即时摘要和告警；Telegram 或 AI 摘要失败不能影响原始邮件备份。

## 先读哪份文档

维护文档采用渐进式披露：`AGENTS.md` 只放入口和边界，`CLAUDE.md` 通过 `@AGENTS.md` 引用；实际内容统一放在 `docs/ai-maintenance/`。

| 你要做什么 | 优先阅读 |
|------------|----------|
| 快速接手项目全貌 | [docs/ai-maintenance/README.md](docs/ai-maintenance/README.md) |
| 理解目标、技术栈和使用范围 | [docs/ai-maintenance/project-overview.md](docs/ai-maintenance/project-overview.md) |
| 理解入口、模块、数据流和 KV key | [docs/ai-maintenance/architecture.md](docs/ai-maintenance/architecture.md) |
| 调整变量、Secrets、绑定或部署配置 | [docs/ai-maintenance/configuration-and-secrets.md](docs/ai-maintenance/configuration-and-secrets.md) |
| 本地运行、生产运维、告警处理 | [docs/ai-maintenance/operations.md](docs/ai-maintenance/operations.md) |
| 修改代码前确认不破坏可靠性约束 | [docs/ai-maintenance/maintenance-guide.md](docs/ai-maintenance/maintenance-guide.md) |
| 理解设计依据和可靠性边界 | [docs/ai-maintenance/design-decisions.md](docs/ai-maintenance/design-decisions.md) |

## 部署与公开文件

- `wrangler.example.jsonc` 和 `.dev.vars.example` 为公开模板；实际 `wrangler.jsonc`、`.dev.vars` 不提交。
- 提交前凭据检查使用 `pnpm check:public --staged`，发布前使用 `pnpm check:public --ref <提交>`；不带参数时只检查工作区。
- 三种摘要模式由 `SUMMARY_PROVIDER` 选择，配置见维护文档。
- 更新与回滚见 [运维文档](docs/ai-maintenance/operations.md)，数据去向见 [隐私说明](docs/privacy.md)，账号设置见 [Gmail OAuth](docs/gmail-oauth-setup.md) 和 [Telegram](docs/telegram-setup.md)。
- `pnpm verify:config` 只读；`pnpm run deploy` 可调整本机 OpenRouter reasoning 配置。自动部署需本机主动开启。

## 快速事实

- 语言与运行时：TypeScript + Cloudflare Workers。
- 包管理器：`pnpm`，锁文件是 `pnpm-lock.yaml`。
- 入口：`src/index.ts` 暴露 `fetch`、`email`、`scheduled`。
- HTTP 路由：`src/router.ts`，由 Hono 提供 `/health` 和 Telegram webhook；原文只在本人 Bot 私聊中查看。
- 邮件入口：`src/handlers/email.ts`。
- 定时补偿入口：`src/handlers/scheduled.ts` -> `src/services/cron-monitor.ts`。
- 核心状态：Cloudflare KV，主要 key 前缀见架构文档。
- 使用范围：单个 Gmail 授权账号和本人 Telegram 私聊，后续改动由实际需求或生产问题驱动。

## 维护硬边界

- 不要硬编码 Gmail、Telegram、OpenRouter、Gemini、Resend、Cloudflare token 或任何账号凭据。
- 修改故障处理、重试、补偿、幂等逻辑前，先建立证据链；复杂逻辑优先查设计说明，必要时查对应 Git 历史。
- Workers runtime 不使用 Node.js built-ins；外部调用用 native `fetch` 和 Web API。
- Gmail 备份是最高优先级；AI 摘要或 Telegram 失败不得阻断或回滚 Gmail / fallback 备份。
- 新增或修改功能时，必须同步更新相关维护文档；如果文档目录或入口关系变化，也要更新本文件的索引。
- 文档、代码注释、PR 和提交说明围绕最终交付编写，直接说明当前行为、必要的设计原因和实际限制。验证结论须注明对应版本、验证范围及可查依据。
- 文档中需要表达流程图、状态流转、判断路径时，必须使用 Mermaid 代码块，不要用空格缩进模拟图。
- 换行符只使用 LF。

## 维护依据

可靠性改动先核对现有设计和实际实现：

- [设计依据与可靠性边界](docs/ai-maintenance/design-decisions.md)：关键实现原因、验证方法和已知限制。
- Git 历史：现有代码和文档无法解释特殊行为时，用 `git log --oneline --all -- <path>` 和 `git show <commit>` 追溯相关改动。
