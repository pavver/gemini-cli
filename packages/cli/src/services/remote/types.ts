/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Explicit types for the Remote API protocol.
 * These are "Simple Types" as per EVENTBUS_TOPICS_SPEC.md.
 */

// --- State Payloads ---

export interface QuotaState {
  remaining?: number;
  limit?: number;
  resetTime?: string;
}

export interface MemoryState {
  fileCount: number;
}

export interface McpServersState {
  servers: string[];
}

export interface AgentInfo {
  name: string;
  displayName?: string;
  description: string;
  kind: 'local' | 'remote';
}

export interface AgentsState {
  agents: AgentInfo[];
}

export interface ModelState {
  model: string;
}

export interface SessionIdState {
  id: string;
}

export interface ConsentRequestState {
  prompt: string;
}

export interface EditorState {
  editor?: string;
}

// --- Event Payloads ---

export interface ChatStreamEvent {
  chunk: string;
  isStderr: boolean;
}

export interface ConsoleLogEvent {
  type: 'log' | 'warn' | 'error' | 'debug' | 'info';
  content: string;
}

export interface FeedbackEvent {
  severity: 'info' | 'warning' | 'error';
  message: string;
}

export interface HookStartEvent {
  hookName: string;
  eventName: string;
  index?: number;
  total?: number;
}

export interface HookEndEvent {
  hookName: string;
  eventName: string;
  success: boolean;
}

export interface McpProgressEvent {
  server: string;
  progress: number;
  total?: number;
  message?: string;
}

export interface RetryAttemptEvent {
  attempt: number;
  maxAttempts: number;
  model: string;
}

export interface OauthMessageEvent {
  message: string;
}

export interface SlashConflict {
  name: string;
  renamedTo: string;
}

export interface SlashConflictsEvent {
  conflicts: SlashConflict[];
}

export interface RamUsageState {
  rss: number;
  heapTotal: number;
  heapUsed: number;
}
