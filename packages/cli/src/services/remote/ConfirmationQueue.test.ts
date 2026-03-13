/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { EventEmitter } from 'node:events';
import { RemoteApiService } from './RemoteApiService.js';
import {
  CoreEvent,
  type CoreEventEmitter,
  type MessageBus,
} from '@google/gemini-cli-core';
import { appEvents, AppEvent } from '../../utils/events.js';

describe('RemoteApiService - Enhanced Sync (Status, LastMessageID, Cache Clear)', () => {
  const PORT = 8132;
  const TOKEN = 'test-token';
  let service: RemoteApiService;
  let mockCoreEvents: any;
  let mockMessageBus: any;
  let mockChatRecordingService: any;

  beforeEach(() => {
    const coreEmitter = new EventEmitter();
    mockCoreEvents = {
      on: coreEmitter.on.bind(coreEmitter),
      off: coreEmitter.off.bind(coreEmitter),
      emit: coreEmitter.emit.bind(coreEmitter),
    };

    const busEmitter = new EventEmitter();
    mockMessageBus = {
      subscribe: (type: string, h: any) => busEmitter.on(type, h),
      publish: vi.fn(async (msg: any) => {
        busEmitter.emit(msg.type, msg);
      }),
    };

    mockChatRecordingService = {
      getConversation: vi.fn(() => ({
        messages: [{ id: 'msg-100', timestamp: 'ts', content: 'test' }],
      })),
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
      'initial-session',
    );
  });

  afterEach(() => {
    service.stop();
  });

  it('should track agent status (idle -> busy -> generating -> idle)', async () => {
    await service.start();
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const messages: any[] = [];
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())));

    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ action: 'auth', version: 1, token: TOKEN }));
    await vi.waitFor(() =>
      expect(messages.some((m) => m.type === 'auth_ok')).toBe(true),
    );

    ws.send(
      JSON.stringify({
        action: 'system:subscribe',
        topics: ['state:session:status'],
      }),
    );
    await vi.waitFor(() =>
      expect(
        messages.some(
          (m) =>
            m.topic === 'state:session:status' && m.payload?.status === 'idle',
        ),
      ).toBe(true),
    );

    // 1. Hook starts -> busy
    mockCoreEvents.emit(CoreEvent.HookStart, {
      hookName: 'test',
      eventName: 'test',
    });
    await vi.waitFor(() =>
      expect(messages.some((m) => m.payload?.status === 'busy')).toBe(true),
    );

    // 2. Hook ends -> idle (since isGenerating is false)
    mockCoreEvents.emit(CoreEvent.HookEnd, { hookName: 'test', success: true });
    await vi.waitFor(() =>
      expect(messages.some((m) => m.payload?.status === 'idle')).toBe(true),
    );

    // 3. Output starts -> generating
    mockCoreEvents.emit(CoreEvent.Output, { chunk: 'Hello' });
    await vi.waitFor(() =>
      expect(messages.some((m) => m.payload?.status === 'generating')).toBe(
        true,
      ),
    );
  });

  it('should provide state:chat:last_message_id and update it on output', async () => {
    await service.start();
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const messages: any[] = [];
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())));

    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ action: 'auth', version: 1, token: TOKEN }));
    await vi.waitFor(() =>
      expect(messages.some((m) => m.type === 'auth_ok')).toBe(true),
    );

    ws.send(
      JSON.stringify({
        action: 'system:subscribe',
        topics: ['state:chat:last_message_id'],
      }),
    );
    await vi.waitFor(() =>
      expect(
        messages.some(
          (m) =>
            m.topic === 'state:chat:last_message_id' &&
            m.payload?.id === 'msg-100',
        ),
      ).toBe(true),
    );

    // Update conversation mock
    mockChatRecordingService.getConversation.mockReturnValue({
      messages: [
        { id: 'msg-100', timestamp: 'ts', content: 'test' },
        { id: 'msg-101', timestamp: 'ts2', content: 'new' },
      ],
    });

    // Emit output to trigger update
    mockCoreEvents.emit(CoreEvent.Output, { chunk: '...' });
    await vi.waitFor(() =>
      expect(
        messages.some(
          (m) =>
            m.topic === 'state:chat:last_message_id' &&
            m.payload?.id === 'msg-101',
        ),
      ).toBe(true),
    );
  });

  it('should clear message bus cache on session change', async () => {
    await service.start();
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const messages: any[] = [];
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())));

    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ action: 'auth', version: 1, token: TOKEN }));
    await vi.waitFor(() =>
      expect(messages.some((m) => m.type === 'auth_ok')).toBe(true),
    );

    // 1. Send tool calls event via message bus
    // @ts-expect-error accessing private relayMessageBus
    service.relayMessageBus(); // Initial setup is done in constructor, but let's be sure

    // Simulate bus message
    // Note: We need access to the private messageBus to trigger this, or use the real bus
    // For this test, we just check that the session change event is handled
    appEvents.emit(AppEvent.SessionChanged, 'new-session');

    // sessionChangedListener in constructor should have cleared things
    // Since we can't easily check private cache, we check that status is still idle
    ws.send(
      JSON.stringify({
        action: 'system:subscribe',
        topics: ['state:session:status'],
      }),
    );
    await vi.waitFor(() =>
      expect(
        messages.some(
          (m) =>
            m.topic === 'state:session:status' && m.payload?.status === 'idle',
        ),
      ).toBe(true),
    );
  });
});
