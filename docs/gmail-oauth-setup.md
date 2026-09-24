# Gmail OAuth 与备份设置

Gmail 主备份写入 OAuth 授权的账号，默认使用 `me`。兜底收件地址由 `BACKUP_EMAIL_TO` 单独配置。项目使用个人用户授权，不提供 OAuth 网页。

## 获取长期授权

1. 在 [Google Cloud Console](https://console.cloud.google.com/) 创建或选择你自己的项目，启用 Gmail API。
2. 在 Google Auth Platform 配置应用名称、联系邮箱和受众。个人 Gmail 通常选择 External。准备长期使用时切到 Production；External + Testing 状态下，本项目所需权限得到的 refresh token 通常在 7 天后过期。发布状态不等于通过 Google 验证，按账号提示完成必要设置。参见 [Google 授权和过期规则](https://developers.google.com/identity/protocols/oauth2#expiration)。
3. 创建 Web application 类型的 OAuth client。为下面的 Playground 流程添加授权重定向 URI：`https://developers.google.com/oauthplayground`。
4. 打开 [Google OAuth Playground](https://developers.google.com/oauthplayground/)，点设置，勾选 **Use your own OAuth credentials**，填写刚创建的 client ID 和 client secret。设置 Access type 为 Offline，必要时强制 Consent。
5. 在 Step 1 请求以下两个 scope，点击 Authorize APIs，选择实际接收 Gmail 备份的账号并授权。

```text
https://www.googleapis.com/auth/gmail.insert
https://www.googleapis.com/auth/gmail.modify
```

6. 在 Step 2 点击 Exchange authorization code for tokens，保存 `refresh_token`。若只拿到 access token，检查是否使用自己的客户端和 Offline；必要时重新同意授权。不要把短期 access token 当作 refresh token。
7. 写入 Cloudflare Secrets：

```bash
pnpm exec wrangler secret put GMAIL_CLIENT_ID
pnpm exec wrangler secret put GMAIL_CLIENT_SECRET
pnpm exec wrangler secret put GMAIL_REFRESH_TOKEN
```

三个值必须属于同一客户端及授权流程。不要共享 Playground 会话、授权响应截图或含凭据的请求链接。Worker 在运行时刷新 access token，只缓存在内存中。

`gmail.insert` 用于写入 MIME 原件，`gmail.modify` 用于查询状态及移入垃圾箱。撤销授权、修改某些账号设置或触发 Google 令牌规则后，可能需要重新授权。出现 Gmail 授权失效告警时，更新对应 Secret 后观察下一封邮件。

## Cloudflare Email Sending

按 [Cloudflare Email Service 文档](https://developers.cloudflare.com/email-service/) 开通发送功能并验证域名。将发件地址写入私有配置的 `send_email.allowed_sender_addresses`，同一地址作为 `CF_EMAIL_FROM` Secret。将能独立收到邮件的地址作为 `BACKUP_EMAIL_TO`，避免把兜底邮件又路由回本 Worker。

Gmail 失败后先尝试该发送绑定，邮件附带原始 MIME 文件 `original.eml`。供应商接受发送即记录备份完成，并发送或补偿兜底告警；“接受发送”不等于已经确认最终投递。

## Resend

在 Resend 验证发件域名，创建密钥，将 `RESEND_API_KEY` 和 `RESEND_FROM` 写入 Secrets。它在 Gmail 和 Cloudflare Email Sending 都失败时使用，同样附带 `original.eml`。

三家都失败时记录失败原因、尝试发送严重告警并抛错，让 Email Routing 重试。兜底链需分别具备可用账号、域名验证及发送配额。
