import type { ToolDef, ToolRegistry } from '../types';
import { getUserProfileTool } from '../tools/get-user-profile';
import { getReadinessTool } from '../tools/get-readiness';
import { getRecentMealsTool } from '../tools/get-recent-meals';
import { noteDislikeTool } from '../tools/note-dislike';
import { logMealTool } from '../tools/log-meal';
import { proposeWorkoutTool } from '../tools/propose-workout';
import { computeAcwrTool } from '../tools/compute-acwr';
import { searchGroceriesTool } from '../tools/search-groceries';
import { searchResearchTool } from '../tools/search-research';

export function buildToolRegistry(): ToolRegistry {
  const tools: ToolDef[] = [
    getUserProfileTool,
    getReadinessTool,
    getRecentMealsTool,
    noteDislikeTool,
    logMealTool,
    proposeWorkoutTool,
    computeAcwrTool,
    searchGroceriesTool,
    searchResearchTool
  ];
  return new Map(tools.map((t) => [t.name, t]));
}
