import type { ToolDef, ToolRegistry } from '../types';
import { getUserProfileTool } from '../tools/get-user-profile';

export function buildToolRegistry(): ToolRegistry {
  const tools: ToolDef[] = [
    getUserProfileTool
  ];
  return new Map(tools.map((t) => [t.name, t]));
}
