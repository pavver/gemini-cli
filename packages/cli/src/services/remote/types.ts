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

import { ToolConfirmationOutcome } from '@google/gemini-cli-core';

export { ToolConfirmationOutcome };

export interface RamUsageState {
  rss: number;
  heapTotal: number;
  heapUsed: number;
}

// --- Actions (Incoming from Client) ---

export type RemoteAction =
  | AuthAction
  | SubscribeAction
  | UnsubscribeAction
  | ChatSendAction
  | ChatStopAction
  | ConfirmReplyAction
  | AskUserReplyAction;

export interface AuthAction {
  action: 'auth';
  version: number;
  token?: string;
  sessionId?: string;
}

export interface SubscribeAction {
  action: 'system:subscribe';
  topics: string[];
}

export interface UnsubscribeAction {
  action: 'system:unsubscribe';
  topics: string[];
}

export interface ChatSendAction {
  action: 'chat:send';
  text: string;
}

export interface ChatStopAction {
  action: 'chat:stop';
}

/**
 * For standard tool confirmations (ToolConfirmationResponse)
 * and UI consent requests (ConsentRequest).
 */
export interface ConfirmReplyAction {
  action: 'confirm:reply';
  correlationId: string;
  confirmed: boolean;
  outcome?: ToolConfirmationOutcome;
}

/**
 * For complex multi-question confirmations (AskUserResponse).
 */
export interface AskUserReplyAction {
  action: 'confirm:ask_user:reply';
  correlationId: string;
  answers: { [questionIndex: string]: string };
  cancelled?: boolean;
}

/**
 * Event topics used by the Remote API.
 * This list is for documentation and internal reference.
 *
 * Bus events (relay from MessageBus):
 * - event:bus:tool-confirmation-request
 * - event:bus:tool-confirmation-response
 * - event:bus:ask-user-request
 * - event:bus:ask-user-response
 * - event:bus:tool-calls-update
 *
 * UI Sync events:
 * - event:confirm:active:resolved (for ConsentRequests)
 * - event:chat:user_message (for terminal user input)
 */

// --- Internal Helper Types ---

export function isRemoteAction(msg: unknown): msg is RemoteAction {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'action' in msg &&
    typeof (msg as Record<string, unknown>).action === 'string'
  );
}
