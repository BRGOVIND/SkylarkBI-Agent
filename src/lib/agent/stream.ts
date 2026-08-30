/**
 * Newline-delimited JSON reader for the chat stream.
 *
 * A network chunk is not a message. A single agent event can arrive split
 * across two chunks, several events can arrive in one, and a chunk can end
 * exactly on the newline. This buffers whatever is incomplete and only yields
 * whole messages.
 *
 * Splitting on newlines is safe because every message is `JSON.stringify`d,
 * which escapes real newlines inside string values as `\n` — so the only literal
 * newlines on the wire are the delimiters.
 */

export interface NdjsonReader<T = Record<string, unknown>> {
  /** Feed a chunk; returns whichever messages are now complete. */
  push(chunk: string): T[];
  /**
   * Call once the stream ends. Recovers a final message that arrived without
   * its trailing newline, which would otherwise be silently lost.
   */
  flush(): T[];
}

export function parseNdjson<T = Record<string, unknown>>(): NdjsonReader<T> {
  let buffer = '';

  const decode = (line: string, out: T[]) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      // One corrupt line must not take down the rest of the stream.
    }
  };

  return {
    push(chunk) {
      buffer += chunk;
      const parts = buffer.split('\n');
      // The last element is whatever came after the final newline — possibly a
      // partial message, so it stays buffered.
      buffer = parts.pop() ?? '';
      const out: T[] = [];
      for (const line of parts) decode(line, out);
      return out;
    },

    flush() {
      const out: T[] = [];
      decode(buffer, out);
      buffer = '';
      return out;
    },
  };
}
