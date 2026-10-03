import type { ParsedEmailForProcessing } from "./mime-parser";

const DEFAULT_TEXT =
  "原邮件没有可用的纯文本内容，完整原件见附件 original.eml。";

export function buildFallbackEmailContent(parsed: ParsedEmailForProcessing): {
  subject: string;
  text: string;
  html?: string;
} {
  return {
    subject: parsed.subject || "(无主题)",
    text: parsed.text || DEFAULT_TEXT,
    html: parsed.html || undefined
  };
}
