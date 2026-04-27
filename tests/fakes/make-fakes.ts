import type { AnthropicStreamEvent, NonStreamMessageResult, RuntimeDeps, ToolDef, ToolRegistry } from '../../src/types';
import { scriptedStream } from './scripted-stream';

export interface FakeOptions {
  db: D1Database;
  scripts?: AnthropicStreamEvent[][];
  callResults?: NonStreamMessageResult[];
  tools?: ToolDef[];
  now?: number;
}

export function makeFakes(opts: FakeOptions): RuntimeDeps & {
  ai: ReturnType<typeof scriptedStream>;
} {
  const ai = scriptedStream(opts.scripts ?? [], opts.callResults ?? []);
  const tools: ToolRegistry = new Map((opts.tools ?? []).map((t) => [t.name, t]));
  const fixedNow = opts.now ?? 1_700_000_000_000;
  return {
    db: opts.db,
    ai,
    tools,
    clock: () => fixedNow
  };
}
