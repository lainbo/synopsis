# 贡献指南

使用 Node.js 22+ 和 `package.json` 指定的 pnpm。先阅读 [维护入口](docs/ai-maintenance/README.md)，涉及备份、重试或状态合并时阅读 [设计依据与可靠性边界](docs/ai-maintenance/design-decisions.md)。

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm check:public
git diff --check
```

暂存代码后，运行 `pnpm check:public --staged` 检查实际准备提交的内容；CI 用 `pnpm check:public --ref HEAD` 检查当前提交快照。工作区检查不会替代这两项检查。

`build` 使用公开示例配置，不需要生产密钥。只有实际运行才复制模板填写个人配置；安装依赖不会开启自动部署。

提交应说明具体问题、行为变化及验证结果。AI 或 Telegram 失败不能破坏已完成的原件备份；外部调用使用 Workers 的 fetch/Web API。改配置和功能时同步相关文档，换行使用 LF。

不提交真实邮件、账号 ID、个人代理地址、凭据或生产日志。问题复现使用虚构数据；安全漏洞按 [SECURITY.md](SECURITY.md) 私下报告。不得在公共 Issue 贴真实配置。
