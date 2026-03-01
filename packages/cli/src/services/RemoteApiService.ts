/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { WebSocketServer, type WebSocket } from 'ws';
import { EventEmitter } from 'node:events';
import type {
  HistoryItem,
  StreamingState,
  ThoughtSummary,
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
}

export interface RemoteCommand {
  name: string;
  description: string;
}

/** Messages sent from CLI to Web Client */
export type RemoteOutgoingMessage =
  | {
      type: RemoteMessageType.SESSION_INIT;
      payload: {
        apiVersion: number;
        sessionId: string;
        history: HistoryItem[];
        config: { model: string | undefined; approvalMode: ApprovalMode };
        streamingState: StreamingState;
        activePtyId: number | null;
        shellHistory: AnsiOutput | null;
        status: SystemStatus;
        commands: RemoteCommand[];
        authState: string;
      };
    }
  | { type: RemoteMessageType.HISTORY_UPDATE; payload: { item: HistoryItem } }
  | {
      type: RemoteMessageType.THOUGHT_STREAM;
      payload: { thought: ThoughtSummary; isComplete: boolean };
    }
  | {
      type: RemoteMessageType.STREAMING_STATE;
      payload: { state: StreamingState };
    }
  | {
      type: RemoteMessageType.CONFIRMATION_REQUEST;
      payload: {
        id: number;
        prompt: string;
        type:
          | 'tool_approval'
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
      payload: { message: string; severity: 'info' | 'warning' | 'error' };
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
  | { type: RemoteMessageType.RESET_SESSION };

export class RemoteApiService extends EventEmitter {
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  private clientVersions = new Map<WebSocket, number>();

  constructor(private port: number = 8080) {
    super();
  }

  start() {
    this.wss = new WebSocketServer({
      port: this.port,
      // For security reasons, we strictly listen on 127.0.0.1. 
      // This prevents accidental exposure to the network, which would be a 
      // major security risk since the current Remote API protocol doesn't 
      // implement authentication. Users requiring remote access must use a 
      // secure proxy or relay layer that provides authentication and encryption.
      host: '127.0.0.1',
      path: '/remote',
    });
    debugLogger.log(
      `Remote API Server started on ws://127.0.0.1:${this.port}/remote`,
    );

    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
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
        debugLogger.log('Remote client disconnected');
      });
    });
  }

  stop() {
    this.wss?.close();
    this.clients.clear();
    this.clientVersions.clear();
  }

  getClientVersion(ws: WebSocket): number {
    return this.clientVersions.get(ws) || 1;
  }

  private handleIncomingMessage(
    _ws: WebSocket,
    message: RemoteIncomingMessage,
  ): void {
    switch (message.type) {
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
          this.clientVersions.set(_ws, message.payload.apiVersion);
        }
        this.emit('session_state_request', _ws);
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
        // Discriminated union ensures we cover all cases, but linter wants a default
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

    const type = (message as { type: unknown }).type;

    if (type === RemoteMessageType.SEND_PROMPT) {
      if (
        !('payload' in message) ||
        typeof message.payload !== 'object' ||
        message.payload === null
      ) {
        return false;
      }
      const payload = message.payload;
      return 'text' in payload && typeof payload.text === 'string';
    }

    if (type === RemoteMessageType.CONFIRMATION_RESPONSE) {
      if (
        !('payload' in message) ||
        typeof message.payload !== 'object' ||
        message.payload === null
      ) {
        return false;
      }
      const payload = message.payload;
      return (
        'id' in payload &&
        'confirmed' in payload &&
        typeof payload.id === 'number' &&
        typeof payload.confirmed === 'boolean' &&
        (!('choice' in payload) || typeof payload.choice === 'string')
      );
    }

    if (type === RemoteMessageType.SHELL_INPUT) {
      if (
        !('payload' in message) ||
        typeof message.payload !== 'object' ||
        message.payload === null
      ) {
        return false;
      }
      const payload = message.payload;
      return 'text' in payload && typeof payload.text === 'string';
    }

    if (type === RemoteMessageType.RESIZE_TERMINAL) {
      if (
        !('payload' in message) ||
        typeof message.payload !== 'object' ||
        message.payload === null
      ) {
        return false;
      }
      const payload = message.payload;
      return (
        'cols' in payload &&
        typeof payload.cols === 'number' &&
        'rows' in payload &&
        typeof payload.rows === 'number'
      );
    }

    if (type === RemoteMessageType.SEARCH_REQUEST) {
      if (
        !('payload' in message) ||
        typeof message.payload !== 'object' ||
        message.payload === null
      ) {
        return false;
      }
      const payload = message.payload;
      return (
        'query' in payload &&
        typeof payload.query === 'string' &&
        'type' in payload &&
        (payload.type === 'at' || payload.type === 'slash')
      );
    }

    if (type === RemoteMessageType.AUTH_SUBMIT) {
      if (
        !('payload' in message) ||
        typeof message.payload !== 'object' ||
        message.payload === null
      ) {
        return false;
      }
      const payload = message.payload;
      return (
        (!('method' in payload) || typeof payload.method === 'string') &&
        (!('apiKey' in payload) || typeof payload.apiKey === 'string')
      );
    }

    if (type === RemoteMessageType.SESSION_STATE_REQUEST) {
      if (
        !('payload' in message) ||
        typeof message.payload !== 'object' ||
        message.payload === null
      ) {
        return false;
      }
      const payload = message.payload as { apiVersion?: unknown };
      return (
        !('apiVersion' in payload) || typeof payload.apiVersion === 'number'
      );
    }

    if (type === RemoteMessageType.HISTORY_REQUEST) {
      if (
        !('payload' in message) ||
        typeof message.payload !== 'object' ||
        message.payload === null
      ) {
        return false;
      }
      const payload = message.payload;
      return (
        'offset' in payload &&
        typeof payload.offset === 'number' &&
        'limit' in payload &&
        typeof payload.limit === 'number'
      );
    }

    if (type === RemoteMessageType.DIFF_RESPONSE) {
      if (
        !('payload' in message) ||
        typeof message.payload !== 'object' ||
        message.payload === null
      ) {
        return false;
      }
      const payload = message.payload as {
        filePath?: unknown;
        accepted?: unknown;
        content?: unknown;
      };
      return (
        typeof payload.filePath === 'string' &&
        typeof payload.accepted === 'boolean' &&
        (!('content' in payload) || typeof payload.content === 'string')
      );
    }

    if (type === RemoteMessageType.SET_CONFIG) {
      if (
        !('payload' in message) ||
        typeof message.payload !== 'object' ||
        message.payload === null
      ) {
        return false;
      }
      return true; // Simple check for now
    }

    if (type === RemoteMessageType.EXECUTE_COMMAND) {
      if (
        !('payload' in message) ||
        typeof message.payload !== 'object' ||
        message.payload === null
      ) {
        return false;
      }
      const payload = message.payload;
      return 'command' in payload && typeof payload.command === 'string';
    }

    if (
      type === RemoteMessageType.CLEAR_HISTORY ||
      type === RemoteMessageType.RESET_SESSION
    ) {
      return true;
    }

    return type === RemoteMessageType.STOP_GENERATION;
  }

  broadcast(message: RemoteOutgoingMessage) {
    const data = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === client.OPEN) {
        client.send(data);
      }
    }
  }

  sendToClient(ws: WebSocket, message: RemoteOutgoingMessage) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  // Helper methods to broadcast specific updates
  broadcastHistoryUpdate(item: HistoryItem) {
    this.broadcast({
      type: RemoteMessageType.HISTORY_UPDATE,
      payload: { item },
    });
  }

  broadcastStreamingState(state: StreamingState) {
    this.broadcast({
      type: RemoteMessageType.STREAMING_STATE,
      payload: { state },
    });
  }

  broadcastThought(thought: ThoughtSummary, isComplete: boolean = false) {
    this.broadcast({
      type: RemoteMessageType.THOUGHT_STREAM,
      payload: { thought, isComplete },
    });
  }

  broadcastShellOutput(chunk: string | AnsiOutput) {
    this.broadcast({
      type: RemoteMessageType.SHELL_OUTPUT,
      payload: { chunk },
    });
  }
}
