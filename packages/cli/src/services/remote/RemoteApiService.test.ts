/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { WebSocket } from 'ws';
import {
  type CoreEventEmitter,
  type MessageBus,
  type ChatRecordingService,
} from '@google/gemini-cli-core';
import { RemoteApiService } from './RemoteApiService.js';

describe('RemoteApiService', () => {
  const PORT = 8101;
  const TOKEN = 'test-token';

  let service: RemoteApiService;
  let mockCoreEvents: Partial<CoreEventEmitter>;
  let mockMessageBus: Partial<MessageBus>;
  let mockChatRecordingService: Partial<ChatRecordingService>;

  beforeEach(() => {
    const coreEmitter = new EventEmitter();
    mockCoreEvents = {
      on: coreEmitter.on.bind(coreEmitter) as any,
      off: coreEmitter.off.bind(coreEmitter) as any,
      emit: coreEmitter.emit.bind(coreEmitter) as any,
    };

    const busEmitter = new EventEmitter();
    mockMessageBus = {
      publish: vi.fn(async (msg: { type: string }) => {
        busEmitter.emit(msg.type, msg);
      }) as any,
      subscribe: vi.fn((type: string, handler: (msg: unknown) => void) => {
        busEmitter.on(type, handler);
      }) as any,
      unsubscribe: vi.fn((type: string, handler: (msg: unknown) => void) => {
        busEmitter.off(type, handler);
      }) as any,
    };

    mockChatRecordingService = {
      getConversation: vi.fn(() => ({
        messages: [
          { id: '1', timestamp: 'ts', type: 'user', content: 'Msg 1' },
        ],
      })) as any,
    };

    const mockGeminiClient = {
      getChatRecordingService: vi.fn(() => mockChatRecordingService),
    };

    service = new RemoteApiService(
      PORT,
      TOKEN,
      mockCoreEvents as unknown as CoreEventEmitter,
      mockMessageBus as unknown as MessageBus,
      mockGeminiClient as any,
    );
  });

  afterEach(async () => {
    service.stop();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  async function connectAndAuth(): Promise<{
    ws: WebSocket;
    messages: any[];
  }> {
    await service.start();
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const messages: any[] = [];

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Connection timeout')),
        2000,
      );

      ws.on('open', () => {
        ws.send(JSON.stringify({ action: 'auth', token: TOKEN, version: 1 }));
      });

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        messages.push(msg);
        if (msg.type === 'auth_ok') {
          clearTimeout(timeout);
          resolve({ ws, messages });
        }
      });

      ws.on('error', reject);
    });
  }

  it('should authenticate with valid token', async () => {
    const { messages } = await connectAndAuth();
    expect(messages.some((m) => m.type === 'auth_ok')).toBe(true);
  });

  it('should reject invalid token', async () => {
    await service.start();
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);

    return new Promise((resolve) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({ action: 'auth', token: 'wrong', version: 1 }));
      });

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'error') {
          resolve(true);
        }
      });
    });
  });

  it('should handle subscriptions', async () => {
    const { ws } = await connectAndAuth();

    ws.send(
      JSON.stringify({
        action: 'system:subscribe',
        topics: ['state:session:status'],
      }),
    );

    return new Promise((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.topic === 'state:session:status') {
          resolve(true);
        }
      });
    });
  });
});
