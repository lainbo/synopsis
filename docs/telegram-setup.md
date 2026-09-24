# Telegram 私聊设置

项目只允许本人和 Bot 的私聊。回调同时检查 webhook secret、`chat.type=private`、目标 chat ID、点击者 ID 和消息映射。群聊、频道和其他用户不能查看邮件或执行删除。

## Bot 与本人 ID

1. 在 Telegram 的官方 BotFather 创建 Bot，安全保存 token。
2. 使用自己的账号打开 Bot 私聊，发送 `/start`。Bot 无法主动向从未联系过它的用户发起私聊。
3. 首次设置且尚未注册 webhook 时，可通过 Bot API `getUpdates` 读取这条 `/start` 的 `message.chat.id`。只保留这一正整数，作为 `TG_CHAT_ID`；本人私聊下它应与 `message.from.id` 相同。已经有 webhook 时保留已有 ID，不要为查 ID 删除运行中的 webhook。
4. 随机生成 `TG_WEBHOOK_SECRET`，使用字母、数字、`_`、`-`，并写入同名 Cloudflare Secret。
5. 使用 `pnpm exec wrangler secret put` 保存 `TG_BOT_TOKEN` 和 `TG_CHAT_ID`。本地运行时另行填写 `.dev.vars`。

以下命令仅用于自己的首次设置。先将 Bot token 填入私有 `.dev.vars`，命令不会输出 token 或完整更新：

```bash
node --env-file=.dev.vars --input-type=module <<'JS'
try {
  const token = process.env.TG_BOT_TOKEN;
  if (!token) throw new Error();
  const r = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
  const data = await r.json();
  if (!data.ok) throw new Error();
  const ids = [...new Set(data.result.filter(x => x.message?.chat?.type === 'private')
    .map(x => x.message.chat.id))];
  console.log('请识别你刚发送 /start 的私聊 ID：', ids);
} catch { console.error('读取失败，请检查 Bot token 以及是否已有 webhook。'); process.exitCode = 1; }
JS
```

## 注册 webhook

部署 Worker 后，将下面占位域名替换成实际 HTTPS 地址。`.dev.vars` 中的 `TG_WEBHOOK_SECRET` 必须与生产 Secret 一致。此命令会把当前 Bot 的 webhook 改到该地址，不会删除待处理更新。

```bash
node --env-file=.dev.vars --input-type=module <<'JS'
try {
  const token = process.env.TG_BOT_TOKEN;
  const secret = process.env.TG_WEBHOOK_SECRET;
  if (!token || !secret) throw new Error();
  const r = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      url: 'https://YOUR_WORKER_HOST/telegram/webhook',
      secret_token: secret,
      allowed_updates: ['callback_query']
    })
  });
  const data = await r.json();
  if (!data.ok) throw new Error();
  console.log('webhook 设置成功');
} catch { console.error('设置失败，请检查私有配置及 Worker 地址。'); process.exitCode = 1; }
JS
```

Telegram 会携带 `X-Telegram-Bot-Api-Secret-Token` 请求头。缺少或不匹配返回 401。详见 [Bot API setWebhook](https://core.telegram.org/bots/api#setwebhook)。

## 按钮行为

长摘要在发送或编辑时会裁剪，保留截断说明及完整隐私路由提示。原文查看也会截断长正文，完整邮件请在备份邮箱中查看。

- 查看原文：在摘要消息上点「原文」，当前消息改为可读正文；长邮件会截断，完整原件看 Gmail。
- 返回摘要：出现在原文视图上。用当前 AI 配置重新生成，只改这条 Telegram 消息，不更新 KV 缓存；可能产生额外 API 费用。重新生成依赖尚未过期的正文缓存和消息映射。
- 删邮件+消息：仅在 Gmail 主备份成功时出现。先将 Gmail 副本移入垃圾箱，再删除 Telegram 消息。走 Cloudflare / Resend 兜底时没有这个按钮，也不会清理兜底邮箱里的副本。Gmail 出错保留消息，Telegram 删除失败保留映射以便重试。缓存有效期 7 天，Telegram 自身的删除时限也会限制操作。

Bot 私聊属于 Telegram 云端聊天；正文预览和验证码会进入 Telegram。详见 [隐私说明](privacy.md)。
