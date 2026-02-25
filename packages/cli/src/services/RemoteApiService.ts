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
import { debugLogger, type ApprovalMode } from '@google/gemini-cli-core';

export enum RemoteMessageType {
  SESSION_INIT = 'SESSION_INIT',
  HISTORY_UPDATE = 'HISTORY_UPDATE',
  THOUGHT_STREAM = 'THOUGHT_STREAM',
  CONFIRMATION_REQUEST = 'CONFIRMATION_REQUEST',
  STREAMING_STATE = 'STREAMING_STATE',
  SEND_PROMPT = 'SEND_PROMPT',
  CONFIRMATION_RESPONSE = 'CONFIRMATION_RESPONSE',
  STOP_GENERATION = 'STOP_GENERATION',
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
      payload: { id: number; prompt: string; type: string };
    };

/** Messages received by CLI from Web Client */
export type RemoteIncomingMessage =
  | { type: RemoteMessageType.SEND_PROMPT; payload: { text: string } }
  | {
      type: RemoteMessageType.CONFIRMATION_RESPONSE;
      payload: { id: number; confirmed: boolean };
    }
  | { type: RemoteMessageType.STOP_GENERATION };

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
        );
        break;
      case RemoteMessageType.STOP_GENERATION:
        this.emit('stop_generation');
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

    const m = message as { type: unknown; payload?: unknown };

    if (m.type === RemoteMessageType.SEND_PROMPT) {
      return (
        typeof m.payload === 'object' &&
        m.payload !== null &&
        'text' in m.payload &&
        typeof (m.payload as { text: unknown }).text === 'string'
      );
    }

    if (m.type === RemoteMessageType.CONFIRMATION_RESPONSE) {
      return (
        typeof m.payload === 'object' &&
        m.payload !== null &&
        'id' in m.payload &&
        'confirmed' in m.payload &&
        typeof (m.payload as { id: unknown }).id === 'number' &&
        typeof (m.payload as { confirmed: unknown }).confirmed === 'boolean'
      );
    }

    if (m.type === RemoteMessageType.STOP_GENERATION) {
      return true;
    }

    return false;
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
}
