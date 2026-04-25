import type { AIGatewayClient, AnthropicStreamEvent, StreamMessageRequest } from '../../src/types';

export function scriptedStream(scripts: AnthropicStreamEvent[][]): AIGatewayClient & { calls: StreamMessageRequest[] } {
  let nextCall = 0;
  const calls: StreamMessageRequest[] = [];
  return {
    async *streamMessage(req: StreamMessageRequest) {
      calls.push(req);
      const script = scripts[nextCall++];
      if (!script) throw new Error('scriptedStream: no more scripts');
      for (const ev of script) {
        if (req.signal.aborted) throw new DOMException('aborted', 'AbortError');
        yield ev;
      }
    },
    get calls() { return calls; }
  } as any;
}
