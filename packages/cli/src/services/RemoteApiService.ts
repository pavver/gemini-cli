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
import { debugLogger } from '@google/gemini-cli-core';

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

export interface RemoteMessage {
  type: RemoteMessageType;
  payload?: Record<string, unknown>;
}

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
          this.handleIncomingMessage(ws, parsed);
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

  private handleIncomingMessage(_ws: WebSocket, message: unknown): void {
    if (!this.isRemoteMessage(message)) {
      return;
    }

    const { type, payload } = message;

    if (type === RemoteMessageType.SEND_PROMPT) {
      if (payload && typeof payload['text'] === 'string') {
        this.emit('send_prompt', payload['text']);
      }
    } else if (type === RemoteMessageType.CONFIRMATION_RESPONSE) {
      if (
        payload &&
        typeof payload['id'] === 'number' &&
        typeof payload['confirmed'] === 'boolean'
      ) {
        this.emit('confirmation_response', payload['id'], payload['confirmed']);
      }
    } else if (type === RemoteMessageType.STOP_GENERATION) {
      this.emit('stop_generation');
    } else {
      debugLogger.log(`Unknown remote message type: ${String(type)}`);
    }
  }

  private isRemoteMessage(
    message: unknown,
  ): message is { type: RemoteMessageType; payload?: Record<string, unknown> } {
    if (typeof message !== 'object' || message === null) {
      return false;
    }

    const hasType = 'type' in message && typeof message.type === 'string';
    if (!hasType) {
      return false;
    }

    const type = message.type;
    const validTypes: string[] = Object.values(RemoteMessageType);
    let isValidType = false;
    for (const v of validTypes) {
      if (v === type) {
        isValidType = true;
        break;
      }
    }

    if (!isValidType) {
      return false;
    }

    if ('payload' in message) {
      const payload = message.payload;
      if (typeof payload !== 'object' || payload === null) {
        return false;
      }
    }

    return true;
  }

  broadcast(message: RemoteMessage) {
    const data = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === client.OPEN) {
        client.send(data);
      }
    }
  }

  sendToClient(ws: WebSocket, message: RemoteMessage) {
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
