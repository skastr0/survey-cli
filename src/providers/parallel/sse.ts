export const parseServerSentEvents = (text: string) => {
  const frames: unknown[] = []
  const chunks = text
    .replace(/\r\n/g, "\n")
    .split("\n\n")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)

  for (const chunk of chunks) {
    const dataLines = chunk
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())

    const data = dataLines.length > 0 ? dataLines.join("\n") : chunk

    if (data === "[DONE]") {
      continue
    }

    try {
      frames.push(JSON.parse(data))
    } catch {
      frames.push({ type: "raw", data })
    }
  }

  return frames
}
