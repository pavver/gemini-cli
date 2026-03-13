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

export type SessionStatus = 'idle' | 'busy' | 'thinking' | 'generating';

export interface SessionStatusState {
  status: SessionStatus;
}

export interface LastMessageIdState {
  id: string;
}

// --- Event Payloads ---

export interface ChatStreamEvent {
  chunk: string;
  isStderr: boolean;
}

export interface ChatThoughtEvent {
  subject: string;
  description: string;
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
  | ChatGetHistoryPageAction
  | ConfirmReplyAction
  | AskUserReplyAction;

export interface AuthAction {
  action: 'auth';
  version: number;
  token?: string;
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

export interface ChatGetHistoryPageAction {
  action: 'chat:get_history_page';
  correlationId: string;
  limit: number;
  offset: number;
  sort: 'asc' | 'desc';
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

// --- Content Types (Decoupled from Google GenAI SDK) ---

export interface RemoteTextPart {
  text: string;
}

export interface RemoteInlineDataPart {
  inlineData: {
    mimeType: string;
    data: string;
  };
}

export interface RemoteFunctionCallPart {
  functionCall: {
    name: string;
    args: Record<string, unknown>;
  };
}

export interface RemoteFunctionResponsePart {
  functionResponse: {
    name: string;
    response: Record<string, unknown>;
  };
}

export interface RemoteFileDataPart {
  fileData: {
    mimeType: string;
    fileUri: string;
  };
}

export interface RemoteExecutableCodePart {
  executableCode: {
    language: string;
    code: string;
  };
}

export interface RemoteCodeExecutionResultPart {
  codeExecutionResult: {
    outcome: string;
    output: string;
  };
}

export type RemotePart =
  | RemoteTextPart
  | RemoteInlineDataPart
  | RemoteFunctionCallPart
  | RemoteFunctionResponsePart
  | RemoteFileDataPart
  | RemoteExecutableCodePart
  | RemoteCodeExecutionResultPart;

// --- Responses (Outgoing, RPC-style) ---

export interface RemoteTokensSummary {
  input: number;
  output: number;
  cached: number;
  thoughts?: number;
  tool?: number;
  total: number;
}

export interface RemoteThoughtSummary {
  subject: string;
  summary: string;
  timestamp: string;
}

export interface RemoteToolCallRecord {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: RemotePart[];
  status: string;
  timestamp: string;
  displayName?: string;
  description?: string;
}

export interface RemoteMessageRecord {
  id: string;
  timestamp: string;
  type: 'user' | 'gemini' | 'info' | 'error' | 'warning';
  content: RemotePart[];
  displayContent?: RemotePart[];
  toolCalls?: RemoteToolCallRecord[];
  thoughts?: RemoteThoughtSummary[];
  tokens?: RemoteTokensSummary | null;
  model?: string;
}

export interface HistoryResponse {
  type: 'response:chat:history';
  correlationId: string;
  messages: RemoteMessageRecord[];
  total: number;
}

// --- Internal Helper Types ---

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
  if (typeof msg !== 'object' || msg === null) {
    return false;
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const action = (msg as Record<string, unknown>)['action'];
  return typeof action === 'string';
}
