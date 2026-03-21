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

export interface LoadingPhraseState {
  phrase: string | null;
}

export interface LoadingElapsedState {
  elapsed: number;
}

export interface RecentFeedbacksState {
  feedbacks: FeedbackEvent[];
}

export interface AgentsState {
  agents: Array<{
    name: string;
    displayName?: string;
    description?: string;
    kind: 'local' | 'remote';
  }>;
}

export interface RamRssState {
  rss: number;
}

export interface RamHeapTotalState {
  heapTotal: number;
}

export interface RamHeapUsedState {
  heapUsed: number;
}

export interface GitBranchState {
  branch: string | null;
}

export interface TokensInputState {
  input: number;
}

export interface TokensOutputState {
  output: number;
}

export interface TokensCachedState {
  cached: number;
}

export interface TokensTotalState {
  total: number;
}

export interface TokensLimitState {
  limit: number;
}

export interface ModelQuota {
  percentage: number;
  resetSeconds?: number;
}

export interface ModelStats {
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReads: number;
  quota?: ModelQuota;
}

export interface ProjectInfoState {
  name: string;
  path: string;
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

export interface TransientMessageEvent {
  message: string;
  type: 'warning' | 'hint';
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

export interface StatsGetAction {
  action: 'stats:get';
  correlationId: string;
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
  | StatsGetAction
  | ConfirmReplyAction
  | AskUserReplyAction;

// --- Response Payloads (Server -> Client) ---

export interface StatsFullResponse {
  type: 'response:stats:full';
  correlationId: string;
  models: ModelStats[];
  summary: {
    sessionId: string;
    authMethod: string;
    userEmail?: string;
    tier?: string;
    toolCalls: {
      total: number;
      success: number;
      fail: number;
    };
    successRate: number;
    wallTimeSeconds: number;
    agentActiveSeconds: number;
    apiTimeSeconds: number;
    toolTimeSeconds: number;
  };
}

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
 * - state:system:loading_phrase
 * - state:system:loading_elapsed
 * - state:system:ram:rss
 * - state:system:ram:heap_total
 * - state:system:ram:heap_used
 * - state:system:agents
 * - state:system:git_branch
 * - state:system:tokens:input
 * - state:system:tokens:output
 * - state:system:tokens:cached
 * - state:system:tokens:total
 * - state:system:project_info
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
 * - event:system:transient_message
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
