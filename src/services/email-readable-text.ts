import { compile } from "html-to-text";
import type { ParsedEmailForProcessing } from "./mime-parser";

const convertHtmlToText = compile({
  wordwrap: false,
  selectors: [
    { selector: "a", options: { ignoreHref: true } },
    { selector: "img", format: "skip" },
    { selector: "script", format: "skip" },
    { selector: "style", format: "skip" },
    { selector: "p", options: { leadingLineBreaks: 1, trailingLineBreaks: 1 } },
    { selector: "div", options: { leadingLineBreaks: 1, trailingLineBreaks: 1 } },
    { selector: "h1", options: { uppercase: false } },
    { selector: "h2", options: { uppercase: false } },
    { selector: "h3", options: { uppercase: false } },
    { selector: "h4", options: { uppercase: false } },
    { selector: "h5", options: { uppercase: false } },
    { selector: "h6", options: { uppercase: false } }
  ]
});

export function buildReadableEmailBody(parsed: ParsedEmailForProcessing): string {
  const text = parsed.text.trim();

  if (text) {
    return normalizeWhitespace(text);
  }

  return htmlToReadableText(parsed.html);
}

export function buildSummaryInputText(parsed: ParsedEmailForProcessing): string {
  const lines = [
    parsed.from ? `发件人: ${parsed.from}` : null,
    parsed.to.length > 0 ? `收件人: ${parsed.to.join(", ")}` : null,
    parsed.subject ? `主题: ${parsed.subject}` : null,
    parsed.date ? `时间: ${parsed.date}` : null
  ].filter((line): line is string => Boolean(line));

  const body = buildReadableEmailBody(parsed);

  return [...lines, body ? `正文:\n${body}` : null]
    .filter((line): line is string => Boolean(line))
    .join("\n\n");
}

function htmlToReadableText(html: string): string {
  if (!html.trim()) {
    return "";
  }

  return normalizeWhitespace(convertHtmlToText(html));
}

function normalizeWhitespace(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v\u00A0]+/g, " ")
    .replace(/\n[ \t\u00A0]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
