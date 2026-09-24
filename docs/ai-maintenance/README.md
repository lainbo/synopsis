# 维护文档

本目录集中说明项目架构、配置、运维方式和实现约束。首次部署从根目录 [README](../../README.md) 开始，修改实现时按任务选择下列文档。

| 文档 | 适合场景 |
|---|---|
| [项目全貌](project-overview.md) | 了解目标、技术栈和使用范围 |
| [架构与代码地图](architecture.md) | 查入口、调用关系、数据流和 KV 状态 |
| [配置与 Secrets](configuration-and-secrets.md) | 调整模型、绑定、账号和部署配置 |
| [运维](operations.md) | 本地运行、更新、回滚及告警排查 |
| [维护指南](maintenance-guide.md) | 修改备份、重试、补偿或访问控制 |
| [设计依据与可靠性边界](design-decisions.md) | 理解关键实现的原因、验证方法和已知限制 |

## 查阅实现依据

修改可靠性逻辑前，阅读设计说明和对应代码。现有文档无法解释特殊行为时，再使用 `git log --oneline --all -- <path>` 和 `git show <commit>` 查阅相关历史。

## 配置与数据保护

真实配置和凭据仅按当前任务需要读取、使用，不输出秘密值。文档、日志和排障记录只保留脱敏后的必要信息，不复制邮件正文、原始 MIME 或完整供应商响应。

账号设置见 [Gmail OAuth](../gmail-oauth-setup.md) 和 [Telegram](../telegram-setup.md)，数据去向和保存期限见 [隐私说明](../privacy.md)。
