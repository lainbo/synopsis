// 按 UTF-16 长度计数，裁剪位置保留完整字素（含组合表情）。
export function truncateAtGraphemeBoundary(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;

  let end = 0;

  for (const { index, segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
    const next = index + segment.length;
    if (next > maxLength) break;
    end = next;
  }

  return text.slice(0, end);
}
