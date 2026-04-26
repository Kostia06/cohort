import type { AIGatewayClient, AnthropicStreamEvent, NonStreamMessageRequest, NonStreamMessageResult, StreamMessageRequest } from '../../src/types';

export function scriptedStream(
  scripts: AnthropicStreamEvent[][],
  callResults: NonStreamMessageResult[] = []
): AIGatewayClient & { calls: StreamMessageRequest[]; nonStreamCalls: NonStreamMessageRequest[] } {
  let nextStream = 0;
  let nextCall = 0;
  const streamCalls: StreamMessageRequest[] = [];
  const nonStreamCalls: NonStreamMessageRequest[] = [];
  return {
    async *streamMessage(req: StreamMessageRequest) {
      streamCalls.push(req);
      const script = scripts[nextStream++];
      if (!script) throw new Error('scriptedStream: no more scripts');
      for (const ev of script) {
        if (req.signal.aborted) throw new DOMException('aborted', 'AbortError');
        yield ev;
      }
    },
    async call(req: NonStreamMessageRequest) {
      nonStreamCalls.push(req);
      const result = callResults[nextCall++];
      if (!result) throw new Error('scriptedStream: no more callResults');
      if (req.signal.aborted) throw new DOMException('aborted', 'AbortError');
      return result;
    },
    get calls() { return streamCalls; },
    get nonStreamCalls() { return nonStreamCalls; }
  };
}
