/**
 * Reads a streamed Anthropic Messages reply (server-sent events). Each piece of text is handed to `onText` as it arrives, so
 * the first sentence can be spoken while the model is still writing the second one (fast.ts). Returns the stop reason and
 * the token usage the API reports. Tested in test/stream.test.ts.
 */
export type StreamUsage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
type StreamEvent = {
  type: string;
  delta?: { type?: string; text?: string; stop_reason?: string };
  message?: { usage?: StreamUsage };
  usage?: StreamUsage;
  error?: { message?: string };
};

export async function readStream(chunks: AsyncIterable<Uint8Array>, onText: (delta: string) => void): Promise<{ stopReason?: string; usage: StreamUsage }> {
  const usage: StreamUsage = {};
  let stopReason: string | undefined;
  const dec = new TextDecoder();
  let buf = "";
  const line = (l: string) => {
    if (!l.startsWith("data:")) return;
    const ev = JSON.parse(l.slice(5)) as StreamEvent;
    if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") onText(ev.delta.text ?? "");
    else if (ev.type === "message_start") Object.assign(usage, ev.message?.usage);
    else if (ev.type === "message_delta") { stopReason = ev.delta?.stop_reason ?? stopReason; Object.assign(usage, ev.usage); }
    else if (ev.type === "error") throw new Error(`Anthropic stream: ${ev.error?.message ?? "error"}`);
  };
  for await (const chunk of chunks) {
    buf += dec.decode(chunk, { stream: true });
    // An event can be split across chunks: only whole lines are parsed.
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      line(buf.slice(0, nl).trimEnd());
      buf = buf.slice(nl + 1);
    }
  }
  if (buf.trim()) line(buf.trim());
  return { stopReason, usage };
}
