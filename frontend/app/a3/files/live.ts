/* live.ts — POST + Server-Sent Events over fetch.
   EventSource cannot POST, so the stream is read by hand.
   Calls onEvent(name, data) for every SSE block:
   session | a1 | a2 | crawl_event | a3 | done | error */

export async function streamVerify(
  url: string,
  sentence: string,
  onEvent: (name: string, data: unknown) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ sentence }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');

    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);

      let name = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) continue; // heartbeat comment
        if (line.startsWith('event:')) name = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (!data.length) continue;
      try {
        onEvent(name, JSON.parse(data.join('\n')));
      } catch {
        /* ignore a malformed block */
      }
    }
  }
}
