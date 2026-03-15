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

export type SessionStatus = 'idle' | 'busy' | 'thinking' | 'generating';

export interface SessionIdState {
  id: string;
}

export interface ModelState {
  model: string;
}

export interface MemoryState {
  fileCount: number;
}

export interface QuotaState {
  remaining: number;
  limit: number;
  resetTime?: string;
}

export interface McpServersState {
  servers: string[];
}

export interface AgentsState {
  agents: Array<{
    name: string;
    displayName?: string;
    description?: string;
    kind: 'local' | 'remote';
  }>;
}

export interface RamUsageState {
  rss: number;
  heapTotal: number;
  heapUsed: number;
}

export interface EditorState {
  editor?: string;
}

export interface SettingsHashState {
  hash: string;
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
  message: string;
  progress?: number;
  total?: number;
}

export interface RetryAttemptEvent {
  attempt: number;
  maxAttempts: number;
  model?: string;
}

export interface OauthMessageEvent {
  message: string;
}

export interface SlashConflictsEvent {
  conflicts: string[];
}

// --- Action Payloads (Client -> Server) ---

export interface AuthAction {
  action: 'auth';
  token: string;
  version: number;
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

export interface SettingsGetAction {
  action: 'settings:get';
  correlationId: string;
}

export interface SettingsSetAction {
  action: 'settings:set';
  correlationId: string;
  id: string;
  value: unknown;
  settingsHash?: string;
}

export interface ConfirmReplyAction {
  action: 'confirm:reply';
  correlationId: string;
  confirmed: boolean;
  outcome?: string;
}

export interface AskUserReplyAction {
  action: 'confirm:ask_user:reply';
  correlationId: string;
  answers: Record<string, string | string[] | boolean>;
  cancelled?: boolean;
}

export type RemoteAction =
  | AuthAction
  | SubscribeAction
  | UnsubscribeAction
  | ChatSendAction
  | ChatStopAction
  | ChatGetHistoryPageAction
  | SettingsGetAction
  | SettingsSetAction
  | ConfirmReplyAction
  | AskUserReplyAction;

// --- Response Payloads (Server -> Client) ---

export interface RemoteSettingDefinition {
  id: string;
  label: string;
  description?: string;
  type: 'boolean' | 'string' | 'number' | 'enum' | 'array' | 'object';
  value: unknown;
  default: unknown;
  isChanged: boolean;
  options?: Array<{ label: string; value: unknown }>;
  requiresRestart: boolean;
  category: string;
}

export interface SettingsListResponse {
  type: 'response:settings:list';
  correlationId: string;
  settings: RemoteSettingDefinition[];
}

export interface SettingsSetResponse {
  type: 'response:settings:set';
  correlationId: string;
  success: boolean;
  settingsHash?: string;
  error?: string;
}

// --- History Structures ---

export interface RemotePart {
  text?: string;
  functionCall?: {
    name: string;
    args: Record<string, unknown>;
  };
  functionResponse?: {
    name: string;
    response: Record<string, unknown>;
  };
  inlineData?: {
    mimeType: string;
    data: string;
  };
  fileData?: {
    mimeType: string;
    fileUri: string;
  };
  executableCode?: {
    language: string;
    code: string;
  };
  codeExecutionResult?: {
    outcome: string;
    output: string;
  };
}

export interface RemoteThoughtSummary {
  subject: string;
  summary: string;
  timestamp: string;
}

export interface RemoteTokensSummary {
  input: number;
  output: number;
  cached: number;
  thoughts?: number;
  tool?: number;
  total: number;
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

/**
 * Valid Remote API topics.
 *
 * State Topics (re-emitted on subscription):
 * - state:system:quota
 * - state:system:memory
 * - state:system:mcp:servers
 * - state:system:agents
 * - state:system:ramUsage
 * - state:session:status
 * - state:session:model
 * - state:session:id
 * - state:session:editor
 * - state:chat:last_message_id
 * - state:confirm:active:request
 *
 * Event Topics (broadcast only):
 * - event:chat:stream
 * - event:chat:thought
 * - event:chat:user_message (for local user messages)
 * - event:system:console
 * - event:system:feedback
 * - event:system:hook:start
 * - event:system:hook:end
 * - event:system:mcp:progress
 * - event:confirm:active:resolved (for ConsentRequests)
 * - event:bus:tool-calls-update
 * - event:bus:ask-user-request
 * - event:bus:ask-user-response
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
