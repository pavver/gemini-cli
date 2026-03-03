/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { WebSocketServer, type WebSocket } from 'ws';
import { EventEmitter } from 'node:events';
import {
  type HistoryItem,
  StreamingState,
  type ThoughtSummary,
} from '../ui/types.js';
import {
  debugLogger,
  type ApprovalMode,
  type AnsiOutput,
} from '@google/gemini-cli-core';

export enum RemoteMessageType {
  SESSION_INIT = 'SESSION_INIT',
  HISTORY_UPDATE = 'HISTORY_UPDATE',
  THOUGHT_STREAM = 'THOUGHT_STREAM',
  CONFIRMATION_REQUEST = 'CONFIRMATION_REQUEST',
  STREAMING_STATE = 'STREAMING_STATE',
  SEND_PROMPT = 'SEND_PROMPT',
  CONFIRMATION_RESPONSE = 'CONFIRMATION_RESPONSE',
  STOP_GENERATION = 'STOP_GENERATION',
  SHELL_INPUT = 'SHELL_INPUT',
  SHELL_OUTPUT = 'SHELL_OUTPUT',
  STATUS_UPDATE = 'STATUS_UPDATE',
  TOAST = 'TOAST',
  SEARCH_REQUEST = 'SEARCH_REQUEST',
  SEARCH_RESPONSE = 'SEARCH_RESPONSE',
  AUTH_UPDATE = 'AUTH_STATE_UPDATE',
  RESIZE_TERMINAL = 'RESIZE_TERMINAL',
  AUTH_SUBMIT = 'AUTH_SUBMIT',
  SESSION_STATE_REQUEST = 'SESSION_STATE_REQUEST',
  HISTORY_REQUEST = 'HISTORY_REQUEST',
  HISTORY_RESPONSE = 'HISTORY_RESPONSE',
  OPEN_DIFF = 'OPEN_DIFF',
  DIFF_RESPONSE = 'DIFF_RESPONSE',
  SET_CONFIG = 'SET_CONFIG',
  EXECUTE_COMMAND = 'EXECUTE_COMMAND',
  CLEAR_HISTORY = 'CLEAR_HISTORY',
  RESET_SESSION = 'RESET_SESSION',
  SUBSCRIBE = 'SUBSCRIBE',
  UNSUBSCRIBE = 'UNSUBSCRIBE',
}

/** Stable API types to decouple from internal CLI implementation */
export type RemoteStreamingState =
  | 'idle'
  | 'responding'
  | 'waiting_for_confirmation';

export interface RemoteToolCall {
  callId: string;
  name: string;
  args: string;
  status: string;
  description?: string;
  result?: string;
}

export interface RemoteHistoryItem {
  id: number;
  type: string;
  text?: string;
  role?: 'user' | 'model' | 'system';
  tools?: RemoteToolCall[];
  thought?: { summary: string };
  model?: string;
}

export interface RemoteSuggestion {
  label: string;
  value: string;
  description?: string;
  type: 'file' | 'folder' | 'command';
}

export interface SystemStatus {
  model: string | undefined;
  ramUsage: string;
  contextTokens: number;
  geminiMdFileCount: number;
  skillsCount: number;
  mcpServers: Array<{ name: string; status: string }>;
  cwd: string;
  gitBranch: string | null;
  platform: string;
  activePtyId: number | null;
}

/** Mappers to convert internal types to stable API types */
export function mapStreamingState(
  internal: StreamingState,
): RemoteStreamingState {
  switch (internal) {
    case StreamingState.Responding:
      return 'responding';
    case StreamingState.WaitingForConfirmation:
      return 'waiting_for_confirmation';
    default:
      return 'idle';
  }
}

export function mapHistoryItem(item: HistoryItem): RemoteHistoryItem {
  const remote: RemoteHistoryItem = {
    id: item.id,
    type: item.type,
  };

  // Explicit mapping based on item type to ensure type safety
  switch (item.type) {
    case 'user':
    case 'model':
    case 'gemini':
    case 'gemini_content':
    case 'info':
    case 'error':
    case 'warning':
      if ('text' in item) remote.text = item.text;
      if ('role' in item && typeof item.role === 'string') {
        const role = item.role;
        if (role === 'user' || role === 'model' || role === 'system') {
          remote.role = role;
        }
      }
      if ('model' in item) remote.model = item.model;
      break;

    case 'thinking':
      if ('thought' in item && item.thought) {
        remote.thought = {
          summary: item.thought.subject || item.thought.description,
        };
      }
      break;

    case 'tool_group':
      if ('tools' in item && item.tools) {
        remote.tools = item.tools.map((t) => ({
          callId: t.callId,
          name: t.name,
          args: typeof t.args === 'string' ? t.args : JSON.stringify(t.args),
          status: String(t.status),
          description: t.description,
          result:
            typeof t.resultDisplay === 'string'
              ? t.resultDisplay
              : JSON.stringify(t.resultDisplay),
        }));
      }
      break;

    default:
      break;
  }

  return remote;
}

/** Messages sent from CLI to Web Client */
export type RemoteOutgoingMessage =
  | {
      type: RemoteMessageType.SESSION_INIT;
      payload: {
        apiVersion: number;
        sessionId: string;
        history: RemoteHistoryItem[];
        config: { model: string | undefined; approvalMode: string };
        streamingState: RemoteStreamingState;
        activePtyId: number | null;
        shellHistory: AnsiOutput | null;
        status: SystemStatus;
        commands: Array<{ name: string; description: string }>;
        authState: string;
      };
    }
  | {
      type: RemoteMessageType.HISTORY_UPDATE;
      payload: { item: RemoteHistoryItem };
    }
  | {
      type: RemoteMessageType.THOUGHT_STREAM;
      payload: { thought: ThoughtSummary; isComplete: boolean };
    }
  | {
      type: RemoteMessageType.STREAMING_STATE;
      payload: { state: RemoteStreamingState };
    }
  | {
      type: RemoteMessageType.CONFIRMATION_REQUEST;
      payload: {
        id: number;
        prompt: string;
        type:
          | 'tool_approval'
          | 'command_approval'
          | 'extension_update'
          | 'file_permissions'
          | 'loop_detection'
          | 'quota'
          | 'validation'
          | 'auth_consent';
        options?: string[] | Array<{ label: string; value: string }>;
      };
    }
  | {
      type: RemoteMessageType.SHELL_OUTPUT;
      payload: { chunk: string | AnsiOutput };
    }
  | {
      type: RemoteMessageType.STATUS_UPDATE;
      payload: SystemStatus;
    }
  | {
      type: RemoteMessageType.TOAST;
      payload: {
        id: number;
        message: string;
        severity: 'info' | 'warning' | 'error';
      };
    }
  | {
      type: RemoteMessageType.SEARCH_RESPONSE;
      payload: { query: string; suggestions: RemoteSuggestion[] };
    }
  | {
      type: RemoteMessageType.AUTH_UPDATE;
      payload: { state: string; error: string | null };
    }
  | {
      type: RemoteMessageType.HISTORY_RESPONSE;
      payload: {
        items: HistoryItem[];
        offset: number;
        limit: number;
        total: number;
      };
    }
  | {
      type: RemoteMessageType.OPEN_DIFF;
      payload: { filePath: string; newContent: string };
    };

/** Messages received by CLI from Web Client */
export type RemoteIncomingMessage =
  | { type: RemoteMessageType.SEND_PROMPT; payload: { text: string } }
  | {
      type: RemoteMessageType.CONFIRMATION_RESPONSE;
      payload: { id: number; confirmed: boolean; choice?: string };
    }
  | { type: RemoteMessageType.STOP_GENERATION }
  | { type: RemoteMessageType.SHELL_INPUT; payload: { text: string } }
  | {
      type: RemoteMessageType.RESIZE_TERMINAL;
      payload: { cols: number; rows: number };
    }
  | {
      type: RemoteMessageType.SEARCH_REQUEST;
      payload: { query: string; type: 'at' | 'slash' };
    }
  | {
      type: RemoteMessageType.AUTH_SUBMIT;
      payload: { method?: string; apiKey?: string };
    }
  | {
      type: RemoteMessageType.SESSION_STATE_REQUEST;
      payload: { apiVersion?: number };
    }
  | {
      type: RemoteMessageType.HISTORY_REQUEST;
      payload: { offset: number; limit: number };
    }
  | {
      type: RemoteMessageType.DIFF_RESPONSE;
      payload: { filePath: string; accepted: boolean; content?: string };
    }
  | {
      type: RemoteMessageType.SET_CONFIG;
      payload: { approvalMode?: ApprovalMode };
    }
  | { type: RemoteMessageType.EXECUTE_COMMAND; payload: { command: string } }
  | { type: RemoteMessageType.CLEAR_HISTORY }
  | { type: RemoteMessageType.RESET_SESSION }
  | { type: RemoteMessageType.SUBSCRIBE; payload: { topic: string } }
  | { type: RemoteMessageType.UNSUBSCRIBE; payload: { topic: string } };

export class RemoteApiService extends EventEmitter {
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  private clientVersions = new Map<WebSocket, number>();
  private subscriptions = new Map<WebSocket, Set<string>>();

  constructor(private port: number = 8080) {
    super();
  }

  start() {
    this.wss = new WebSocketServer({
      port: this.port,
      host: '127.0.0.1',
      path: '/remote',
    });
    debugLogger.log(
      `Remote API Server started on ws://127.0.0.1:${this.port}/remote`,
    );

    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      // Default subscriptions for every new client
      this.subscriptions.set(
        ws,
        new Set(['status', 'toasts', 'auth', 'history', 'confirmations']),
      );
      debugLogger.log('Remote client connected');

      this.emit('client_connected', ws);

      ws.on('message', (data) => {
        try {
          const parsed: unknown = JSON.parse(data.toString());
          if (this.isRemoteIncomingMessage(parsed)) {
            this.handleIncomingMessage(ws, parsed);
          }
        } catch (e) {
          debugLogger.log(`Error parsing remote message: ${String(e)}`);
        }
      });

      ws.on('close', () => {
        this.clients.delete(ws);
        this.clientVersions.delete(ws);
        this.subscriptions.delete(ws);
        debugLogger.log('Remote client disconnected');
      });
    });
  }

  stop() {
    this.wss?.close();
    this.clients.clear();
    this.clientVersions.clear();
    this.subscriptions.clear();
  }

  getClientVersion(ws: WebSocket): number {
    return this.clientVersions.get(ws) || 1;
  }

  private handleIncomingMessage(
    ws: WebSocket,
    message: RemoteIncomingMessage,
  ): void {
    switch (message.type) {
      case RemoteMessageType.SUBSCRIBE:
        this.subscriptions.get(ws)?.add(message.payload.topic);
        break;
      case RemoteMessageType.UNSUBSCRIBE:
        this.subscriptions.get(ws)?.delete(message.payload.topic);
        break;
      case RemoteMessageType.SEND_PROMPT:
        this.emit('send_prompt', message.payload.text);
        break;
      case RemoteMessageType.CONFIRMATION_RESPONSE:
        this.emit(
          'confirmation_response',
          message.payload.id,
          message.payload.confirmed,
          message.payload.choice,
        );
        break;
      case RemoteMessageType.STOP_GENERATION:
        this.emit('stop_generation');
        break;
      case RemoteMessageType.SHELL_INPUT:
        this.emit('shell_input', message.payload.text);
        break;
      case RemoteMessageType.RESIZE_TERMINAL:
        this.emit(
          'resize_terminal',
          message.payload.cols,
          message.payload.rows,
        );
        break;
      case RemoteMessageType.SEARCH_REQUEST:
        this.emit(
          'search_request',
          message.payload.query,
          message.payload.type,
        );
        break;
      case RemoteMessageType.AUTH_SUBMIT:
        this.emit(
          'auth_submit',
          message.payload.method,
          message.payload.apiKey,
        );
        break;
      case RemoteMessageType.SESSION_STATE_REQUEST:
        if (message.payload.apiVersion) {
          this.clientVersions.set(ws, message.payload.apiVersion);
        }
        this.emit('session_state_request', ws);
        break;
      case RemoteMessageType.HISTORY_REQUEST:
        this.emit(
          'history_request',
          message.payload.offset,
          message.payload.limit,
        );
        break;
      case RemoteMessageType.DIFF_RESPONSE:
        this.emit(
          'diff_response',
          message.payload.filePath,
          message.payload.accepted,
          message.payload.content,
        );
        break;
      case RemoteMessageType.SET_CONFIG:
        this.emit('set_config', message.payload.approvalMode);
        break;
      case RemoteMessageType.EXECUTE_COMMAND:
        this.emit('execute_command', message.payload.command);
        break;
      case RemoteMessageType.CLEAR_HISTORY:
        this.emit('clear_history');
        break;
      case RemoteMessageType.RESET_SESSION:
        this.emit('reset_session');
        break;
      default:
        break;
    }
  }

  private isRemoteIncomingMessage(
    message: unknown,
  ): message is RemoteIncomingMessage {
    if (
      typeof message !== 'object' ||
      message === null ||
      !('type' in message)
    ) {
      return false;
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const msg = message as { type: RemoteMessageType; payload?: unknown };
    const type = msg.type;
    const payload = msg.payload;

    const isRecord = (val: unknown): val is Record<string, unknown> =>
      typeof val === 'object' && val !== null;

    if (
      type === RemoteMessageType.SUBSCRIBE ||
      type === RemoteMessageType.UNSUBSCRIBE
    ) {
      return isRecord(payload) && typeof payload['topic'] === 'string';
    }

    if (type === RemoteMessageType.SEND_PROMPT) {
      return isRecord(payload) && typeof payload['text'] === 'string';
    }

    if (type === RemoteMessageType.CONFIRMATION_RESPONSE) {
      if (!isRecord(payload)) return false;
      return (
        typeof payload['id'] === 'number' &&
        typeof payload['confirmed'] === 'boolean'
      );
    }

    if (type === RemoteMessageType.SHELL_INPUT) {
      return isRecord(payload) && typeof payload['text'] === 'string';
    }

    if (type === RemoteMessageType.RESIZE_TERMINAL) {
      if (!isRecord(payload)) return false;
      return (
        typeof payload['cols'] === 'number' &&
        typeof payload['rows'] === 'number'
      );
    }

    if (type === RemoteMessageType.SEARCH_REQUEST) {
      if (!isRecord(payload)) return false;
      return (
        typeof payload['query'] === 'string' &&
        (payload['type'] === 'at' || payload['type'] === 'slash')
      );
    }

    if (
      type === RemoteMessageType.AUTH_SUBMIT ||
      type === RemoteMessageType.SESSION_STATE_REQUEST ||
      type === RemoteMessageType.HISTORY_REQUEST ||
      type === RemoteMessageType.DIFF_RESPONSE ||
      type === RemoteMessageType.SET_CONFIG ||
      type === RemoteMessageType.EXECUTE_COMMAND
    ) {
      return typeof payload === 'object' && payload !== null;
    }

    return (
      type === RemoteMessageType.STOP_GENERATION ||
      type === RemoteMessageType.CLEAR_HISTORY ||
      type === RemoteMessageType.RESET_SESSION
    );
  }

  broadcast(message: RemoteOutgoingMessage) {
    const data = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === client.OPEN) {
        client.send(data);
      }
    }
  }

  publish(topic: string, message: RemoteOutgoingMessage) {
    const data = JSON.stringify(message);
    for (const client of this.clients) {
      const subs = this.subscriptions.get(client);
      if (
        client.readyState === client.OPEN &&
        (subs?.has(topic) || topic === 'all')
      ) {
        client.send(data);
      }
    }
  }

  sendToClient(ws: WebSocket, message: RemoteOutgoingMessage) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  // Helper methods to publish to specific topics using stable API types
  broadcastHistoryUpdate(item: HistoryItem) {
    this.publish('history', {
      type: RemoteMessageType.HISTORY_UPDATE,
      payload: { item: mapHistoryItem(item) },
    });
  }

  broadcastStreamingState(state: StreamingState) {
    this.publish('status', {
      type: RemoteMessageType.STREAMING_STATE,
      payload: { state: mapStreamingState(state) },
    });
  }

  broadcastThought(thought: ThoughtSummary, isComplete: boolean = false) {
    this.publish('thoughts', {
      type: RemoteMessageType.THOUGHT_STREAM,
      payload: { thought, isComplete },
    });
  }

  broadcastShellOutput(pid: number, chunk: string | AnsiOutput) {
    this.publish(`shell:${pid}`, {
      type: RemoteMessageType.SHELL_OUTPUT,
      payload: { chunk },
    });
  }

  broadcastStatus(status: SystemStatus) {
    this.publish('status', {
      type: RemoteMessageType.STATUS_UPDATE,
      payload: status,
    });
  }

  broadcastToast(message: string, severity: 'info' | 'warning' | 'error') {
    this.publish('toasts', {
      type: RemoteMessageType.TOAST,
      payload: { id: Date.now(), message, severity },
    });
  }
}
