export function estimateVisualLines(text: string, charsPerLine = 95) {
  const cleaned = text.replace(/\n/g, ' ').trim()
  if (!cleaned) return 0
  return Math.max(1, Math.ceil(cleaned.length / charsPerLine))
}
