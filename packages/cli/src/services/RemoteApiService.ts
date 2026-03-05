/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { WebSocketServer, type WebSocket } from 'ws';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import {
  type HistoryItem,
  StreamingState,
  type ThoughtSummary,
} from '../ui/types.js';
import {
  debugLogger,
  type ApprovalMode,
  type AnsiOutput,
  ShellExecutionService,
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
  PENDING_HISTORY_ITEM = 'PENDING_HISTORY_ITEM',
  SUBSCRIBE_PTY = 'SUBSCRIBE_PTY',
  UNSUBSCRIBE_PTY = 'UNSUBSCRIBE_PTY',
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
  fileDiff?: string;
  fileName?: string;
  ptyId?: number;
}

export interface RemoteHistoryItem {
  id: number;
  type: string;
  text?: string;
  role?: string;
  thought?: ThoughtSummary;
  tools?: RemoteToolCall[];
  contextModel?: string;
}

export interface RemoteSuggestion {
  label: string;
  value: string;
  description?: string;
  type: 'command' | 'file' | 'symbol';
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

export interface RemoteOutgoingMessage {
  type: RemoteMessageType;
  payload: unknown;
  session_id?: string;
}

/** Messages received by CLI from Web Client */
export type RemoteIncomingMessage =
  | { type: RemoteMessageType.SEND_PROMPT; payload: { text: string } }
  | {
      type: RemoteMessageType.CONFIRMATION_RESPONSE;
      payload: { id: number; confirmed: boolean; choice?: string };
    }
  | { type: RemoteMessageType.STOP_GENERATION }
  | {
      type: RemoteMessageType.SHELL_INPUT;
      payload: { text: string; ptyId?: number };
    }
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
  | { type: RemoteMessageType.UNSUBSCRIBE; payload: { topic: string } }
  | {
      type: RemoteMessageType.SUBSCRIBE_PTY;
      payload: { ptyId: number; fromStart?: boolean };
    }
  | { type: RemoteMessageType.UNSUBSCRIBE_PTY; payload: { ptyId: number } };

interface PtyChunk {
  id: number;
  content: string;
}

export class RemoteApiService extends EventEmitter {
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  private clientVersions = new Map<WebSocket, number>();
  private subscriptions = new Map<WebSocket, Set<string>>();
  private ptyBuffers = new Map<number, PtyChunk[]>();
  private ptyNextIds = new Map<number, number>();
  private clientCursors = new Map<WebSocket, Map<number, number>>();
  private readonly MAX_BUFFER_SIZE = 1000;
  private sessionId: string | undefined;

  constructor(private port: number = 8080) {
    super();
  }

  setSessionId(id: string) {
    this.sessionId = id;
  }

  start() {
    // 1. Capture all output globally and assign sequence IDs
    ShellExecutionService.subscribeAll((pid, event) => {
      if (event.type === 'data' && event.incremental) {
        this.addChunkToBuffer(pid, event.incremental);
        this.broadcastToSubscribers(pid);
      }
    });

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

      ws.on('message', (data) => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          const message = JSON.parse(
            data.toString(),
          ) as unknown as RemoteIncomingMessage;
          this.handleIncomingMessage(ws, message);
        } catch (error) {
          debugLogger.log(`Failed to handle message: ${String(error)}`);
        }
      });

      ws.on('close', () => {
        this.clients.delete(ws);
        this.clientVersions.delete(ws);
        this.subscriptions.delete(ws);
        this.clientCursors.delete(ws);
        debugLogger.log('Remote client disconnected');
      });
    });
  }

  stop() {
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
    for (const client of this.clients) {
      client.terminate();
    }
    this.clients.clear();
  }

  private addChunkToBuffer(pid: number, content: string) {
    const nextId = this.ptyNextIds.get(pid) || 0;
    let buffer = this.ptyBuffers.get(pid);
    if (!buffer) {
      buffer = [];
      this.ptyBuffers.set(pid, buffer);
    }

    buffer.push({ id: nextId, content });
    this.ptyNextIds.set(pid, nextId + 1);

    if (buffer.length > this.MAX_BUFFER_SIZE) {
      buffer.shift();
    }
  }

  private broadcastToSubscribers(pid: number) {
    for (const client of this.clients) {
      const subs = this.subscriptions.get(client);
      if (client.readyState === client.OPEN && subs?.has(`shell:${pid}`)) {
        this.flushPtyToClient(client, pid);
      }
    }
  }

  private flushPtyToClient(ws: WebSocket, pid: number) {
    const buffer = this.ptyBuffers.get(pid);
    if (!buffer || buffer.length === 0) return;

    let cursors = this.clientCursors.get(ws);
    if (!cursors) {
      cursors = new Map<number, number>();
      this.clientCursors.set(ws, cursors);
    }

    // Default to -1 so that chunk 0 is the first one sent
    const lastSentId = cursors.has(pid) ? cursors.get(pid)! : -1;
    let newLastId = lastSentId;

    for (const chunk of buffer) {
      if (chunk.id > lastSentId) {
        this.sendToClient(ws, {
          type: RemoteMessageType.SHELL_OUTPUT,
          payload: { chunk: chunk.content, ptyId: pid },
        });
        newLastId = chunk.id;
      }
    }

    cursors.set(pid, newLastId);
  }

  getClientVersion(ws: WebSocket): number {
    return this.clientVersions.get(ws) || 1;
  }

  private handleIncomingMessage(
    ws: WebSocket,
    message: RemoteIncomingMessage,
  ): void {
    switch (message.type) {
      case RemoteMessageType.SUBSCRIBE: {
        const topic = message.payload.topic;
        const subSet = this.subscriptions.get(ws);
        if (!subSet) break;
        subSet.add(topic);
        break;
      }
      case RemoteMessageType.UNSUBSCRIBE:
        this.subscriptions.get(ws)?.delete(message.payload.topic);
        break;
      case RemoteMessageType.SUBSCRIBE_PTY: {
        const { ptyId, fromStart } = message.payload;
        const subSet = this.subscriptions.get(ws);
        if (!subSet) break;

        subSet.add(`shell:${ptyId}`);

        // If fromStart is not explicitly false, we reset the cursor to -1 (start from beginning)
        if (fromStart !== false) {
          let cursors = this.clientCursors.get(ws);
          if (!cursors) {
            cursors = new Map<number, number>();
            this.clientCursors.set(ws, cursors);
          }
          cursors.set(ptyId, -1);
        }

        this.flushPtyToClient(ws, ptyId);
        break;
      }
      case RemoteMessageType.UNSUBSCRIBE_PTY: {
        const { ptyId } = message.payload;
        this.subscriptions.get(ws)?.delete(`shell:${ptyId}`);
        break;
      }
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
        this.emit('shell_input', message.payload.text, message.payload.ptyId);
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
        this.emit('set_config', message.payload);
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

  broadcast(message: RemoteOutgoingMessage) {
    this.publish('all', message);
  }

  publish(topic: string, message: RemoteOutgoingMessage) {
    const data = JSON.stringify({
      ...message,
      session_id: this.sessionId,
    });
    for (const client of this.clients) {
      const subs = this.subscriptions.get(client);
      if (
        client.readyState === client.OPEN &&
        (subs?.has(topic) || topic === 'all' || topic.startsWith('shell:'))
      ) {
        client.send(data);
      }
    }
  }

  sendToClient(ws: WebSocket, message: RemoteOutgoingMessage) {
    if (ws.readyState === ws.OPEN) {
      ws.send(
        JSON.stringify({
          ...message,
          session_id: this.sessionId,
        }),
      );
    }
  }

  // Helper methods to publish to specific topics using stable API types
  private writeLog(message: string) {
    try {
      const logPath = path.join(process.cwd(), 'remote_debug.log');
      const timestamp = new Date().toISOString();
      fs.appendFileSync(logPath, `[${timestamp}] ${message}\n`);
    } catch (_e) {
      // Ignore logging errors
    }
  }

  broadcastHistoryUpdate(item: HistoryItem) {
    const mapped = mapHistoryItem(item);
    this.writeLog(
      `Broadcasting history update. Type: ${mapped.type}, tools: ${mapped.tools?.map((t) => `${t.name} (ptyId: ${t.ptyId})`).join(', ') || 'none'}`,
    );
    this.publish('history', {
      type: RemoteMessageType.HISTORY_UPDATE,
      payload: { item: mapped },
    });
  }

  broadcastThought(thought: ThoughtSummary, isComplete: boolean = false) {
    this.publish('thoughts', {
      type: RemoteMessageType.THOUGHT_STREAM,
      payload: { thought, isComplete },
    });
  }

  broadcastShellOutput(pid: number, chunk: string | AnsiOutput) {
    // Compatibility method for tests.
    // In real operation, ShellExecutionService.subscribeAll handles this.
    if (typeof chunk === 'string') {
      this.addChunkToBuffer(pid, chunk);
      this.broadcastToSubscribers(pid);
    }
  }

  broadcastStatus(status: SystemStatus) {
    this.publish('status', {
      type: RemoteMessageType.STATUS_UPDATE,
      payload: status,
    });
  }

  broadcastStreamingState(state: StreamingState) {
    this.publish('status', {
      type: RemoteMessageType.STREAMING_STATE,
      payload: { state: mapStreamingState(state) },
    });
  }

  broadcastPendingHistoryItem(item: HistoryItem | null) {
    this.publish('history', {
      type: RemoteMessageType.PENDING_HISTORY_ITEM,
      payload: { item: item ? mapHistoryItem(item) : null },
    });
  }

  broadcastToast(message: string, severity: 'info' | 'warning' | 'error') {
    this.publish('toasts', {
      type: RemoteMessageType.TOAST,
      payload: { id: Date.now(), message, severity },
    });
  }
}

export function mapStreamingState(state: StreamingState): RemoteStreamingState {
  switch (state) {
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

  const isRecord = (val: unknown): val is Record<string, unknown> =>
    typeof val === 'object' && val !== null;

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
        remote.role = role;
      }
      if ('contextModel' in item && typeof item.contextModel === 'string') {
        remote.contextModel = item.contextModel;
      }
      break;

    case 'thinking':
      if ('thought' in item) remote.thought = item.thought;
      break;

    case 'tool_group':
      if ('tools' in item && item.tools) {
        remote.tools = item.tools.map((t) => {
          const remoteTool: RemoteToolCall = {
            callId: t.callId,
            name: t.name,
            args: typeof t.args === 'string' ? t.args : JSON.stringify(t.args),
            status: String(t.status),
            description: t.description,
            result:
              typeof t.resultDisplay === 'string'
                ? t.resultDisplay
                : JSON.stringify(t.resultDisplay),
            ptyId: t.ptyId,
          };

          const rd = t.resultDisplay;
          if (isRecord(rd) && 'fileDiff' in rd && 'fileName' in rd) {
            const fileDiff = rd['fileDiff'];
            const fileName = rd['fileName'];
            if (typeof fileDiff === 'string' && typeof fileName === 'string') {
              remoteTool.fileDiff = fileDiff;
              remoteTool.fileName = fileName;
            }
          }

          return remoteTool;
        });
      }
      break;

    default:
      break;
  }

  return remote;
}
