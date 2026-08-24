/** Renderer-safe orchestration state. No executable paths, prompts, credentials or environment values. */

export const AGENT_PROVIDERS = ['chatgpt', 'claude-code', 'hermes'] as const;
export type AgentProvider = (typeof AGENT_PROVIDERS)[number];

export type GoalStatus = 'active' | 'completed' | 'cancelled';
export type GoalTaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface GoalTask {
  id: string;
  title: string;
  acceptance: string;
  status: GoalTaskStatus;
  provider: AgentProvider | null;
  /** Opaque app-owned process or worker id. Never a credential. */
  runId: string | null;
  result: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface Goal {
  id: string;
  title: string;
  objective: string;
  status: GoalStatus;
  tasks: GoalTask[];
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface GoalsState {
  goals: Goal[];
}

