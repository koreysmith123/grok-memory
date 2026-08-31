export const LEVELS = ["concrete", "abstract", "meta"] as const;
export type MemoryLevel = (typeof LEVELS)[number];
export type ScopeType = "bot" | "project" | "conversation";

export interface ThreeLevels {
  concrete: string;
  abstract: string;
  meta: string;
}

export interface MemoryDraft {
  trigger: ThreeLevels;
  body: ThreeLevels;
  importance: number;
  scopeType: ScopeType;
  scopeKey: string;
  sourceGenerationId: string;
}

export interface MemoryChain {
  id: string;
  triggerSetId?: string;
  trigger: ThreeLevels;
  triggerCount?: number;
  mergeCount?: number;
  body: ThreeLevels;
  importance: number;
  usefulness: number;
  scopeType: ScopeType;
  scopeKey: string;
  updatedAt: Date;
}

export interface Identity {
  ownerId: string;
  botId: string;
  conversationId: string;
  projectId?: string;
  resolution: "explicit" | "metadata" | "workspace" | "binding" | "conversation-fallback";
}

export interface SearchHit {
  id: string;
  level: MemoryLevel;
  trigger: string;
  body: string;
  scopeType: ScopeType;
  scopeKey: string;
  vectorScore: number;
  lexicalScore: number;
  importance: number;
  usefulness: number;
  updatedAt: Date;
  finalScore: number;
  chain: MemoryChain;
}

export interface HookEvent {
  hook_event_name?: string;
  prompt?: string;
  text?: string;
  conversation_id?: string;
  generation_id?: string;
  model?: string;
  model_id?: string;
  workspace_roots?: string[];
  cwd?: string;
  bot_id?: string;
  agent_id?: string;
  [key: string]: unknown;
}

export type ConsolidationOperation =
  | { operation: "create"; memory: MemoryDraft }
  | { operation: "update" | "merge" | "supersede" | "reinforce"; targetId: string; memory?: MemoryDraft; reason: string }
  | { operation: "none"; reason: string };

export interface TurnRecord {
  identity: Identity;
  generationId: string;
  userText: string;
  assistantText: string;
  model?: string;
  chapter?: {
    summary: string;
    resolution: string;
    turns: Array<{ userText: string; assistantText: string }>;
    notes: Array<{ id: string; content: string; createdAt: string }>;
  };
}

export interface BrainstormThought {
  thought: string;
  concrete: string;
  abstract: string;
  meta: string;
}

export interface TimelineEntry {
  kind: "turn" | "note" | "event" | "memory";
  createdAt: string;
  generationId?: string;
  summary: string;
  details?: Record<string, unknown>;
}

export interface Logger {
  log(level: "debug" | "info" | "warn" | "error", event: string, fields?: Record<string, unknown>): void;
}
