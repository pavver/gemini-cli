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
          | 'validation';
        options?: string[];
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
  | { type: RemoteMessageType.SESSION_STATE_REQUEST; payload: Record<string, never> };

export class RemoteApiService extends EventEmitter {
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();

  constructor(private port: number = 8080) {
    super();
  }

  start() {
    this.wss = new WebSocketServer({ port: this.port });
    debugLogger.log(
      `Remote API Server started on ws://localhost:${this.port}/remote`,
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
        debugLogger.log('Remote client disconnected');
      });
    });
  }

  stop() {
    this.wss?.close();
    this.clients.clear();
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
        this.emit('resize_terminal', message.payload.cols, message.payload.rows);
        break;
      case RemoteMessageType.SEARCH_REQUEST:
        this.emit('search_request', message.payload.query, message.payload.type);
        break;
      case RemoteMessageType.AUTH_SUBMIT:
        this.emit(
          'auth_submit',
          message.payload.method,
          message.payload.apiKey,
        );
        break;
      case RemoteMessageType.SESSION_STATE_REQUEST:
        this.emit('session_state_request');
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
