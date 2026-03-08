/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  vi,
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  type Mock,
} from 'vitest';
import { WebSocket } from 'ws';
import { EventEmitter } from 'node:events';
import { RemoteApiService } from './RemoteApiService.js';
import {
  MessageBusType,
  CoreEvent,
  ToolConfirmationOutcome,
  type ConsentRequestPayload,
  type CoreEventEmitter,
  type MessageBus,
} from '@google/gemini-cli-core';
import { appEvents, AppEvent } from '../../utils/events.js';

vi.mock('@google/gemini-cli-core', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@google/gemini-cli-core')>();
  return {
    ...original,
    debugLogger: {
      log: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    },
  };
});

interface BaseRemoteMessage {
  type?: string;
  topic?: string;
  payload?: Record<string, unknown>;
}

interface AuthOkMessage extends BaseRemoteMessage {
  type: 'auth_ok';
  sessionId: string;
  version: number;
  reconnected: boolean;
}

interface EventMessage extends BaseRemoteMessage {
  topic: string;
  payload: Record<string, unknown>;
}

type RemoteMessage = AuthOkMessage | EventMessage | BaseRemoteMessage;

describe('RemoteApiService - Full API Synchronization', () => {
  const PORT = 8131;
  const TOKEN = 'test-token';
  let service: RemoteApiService;

  let mockCoreEvents: {
    on: Mock;
    off: Mock;
    emitConsentRequest: Mock;
    drainBacklogs: Mock;
    _trigger: (event: string, payload: ConsentRequestPayload) => void;
  };

  let mockMessageBus: {
    publish: Mock;
    subscribe: Mock;
    unsubscribe: Mock;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    const listeners: Record<string, (payload: ConsentRequestPayload) => void> =
      {};
    mockCoreEvents = {
      on: vi.fn(
        (event: string, handler: (payload: ConsentRequestPayload) => void) => {
          listeners[event] = handler;
        },
      ),
      off: vi.fn(),
      emitConsentRequest: vi.fn(),
      drainBacklogs: vi.fn(),
      _trigger: (event: string, payload: ConsentRequestPayload) => {
        if (listeners[event]) {
          listeners[event](payload);
        }
      },
    };

    const busEmitter = new EventEmitter();
    mockMessageBus = {
      publish: vi.fn(async (msg: { type: string }) => {
        busEmitter.emit(msg.type, msg);
      }),
      subscribe: vi.fn((type: string, handler: (msg: unknown) => void) => {
        busEmitter.on(type, handler);
      }),
      unsubscribe: vi.fn((type: string, handler: (msg: unknown) => void) => {
        busEmitter.off(type, handler);
      }),
    };

    service = new RemoteApiService(
      PORT,
      TOKEN,
      mockCoreEvents as unknown as CoreEventEmitter,
      mockMessageBus as unknown as MessageBus,
    );
  });

  afterEach(async () => {
    service.stop();
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  async function connectAndAuth(): Promise<{
    ws: WebSocket;
    messages: RemoteMessage[];
  }> {
    await service.start();
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const messages: RemoteMessage[] = [];
    ws.on('message', (data) => {
      messages.push(JSON.parse(data.toString()) as RemoteMessage);
    });

    await new Promise((resolve) => ws.on('open', resolve));
    ws.send(JSON.stringify({ action: 'auth', version: 1, token: TOKEN }));
    await vi.waitFor(() =>
      expect(messages.some((m) => m.type === 'auth_ok')).toBe(true),
    );
    await new Promise((r) => setTimeout(r, 50));
    return { ws, messages };
  }

  it('handles chat:send and chat:stop actions', async () => {
    const { ws } = await connectAndAuth();
    const promptSpy = vi.fn();
    const cancelSpy = vi.fn();
    appEvents.on(AppEvent.RemotePrompt, promptSpy);
    appEvents.on(AppEvent.RemoteCancel, cancelSpy);

    ws.send(JSON.stringify({ action: 'chat:send', text: 'Remote message' }));
    await vi.waitFor(() =>
      expect(promptSpy).toHaveBeenCalledWith('Remote message'),
    );

    ws.send(JSON.stringify({ action: 'chat:stop' }));
    await vi.waitFor(() => expect(cancelSpy).toHaveBeenCalled());

    appEvents.off(AppEvent.RemotePrompt, promptSpy);
    appEvents.off(AppEvent.RemoteCancel, cancelSpy);
    ws.close();
  });

  it('relays MessageBus events to subscribers', async () => {
    const { ws, messages } = await connectAndAuth();
    ws.send(
      JSON.stringify({
        action: 'system:subscribe',
        topics: ['event:bus:tool-confirmation-request'],
      }),
    );
    await new Promise((r) => setTimeout(r, 50));

    const testRequest = {
      type: MessageBusType.TOOL_CONFIRMATION_REQUEST,
      correlationId: 'bus-123',
      toolCall: { name: 'ls', args: {} },
    };

    const handler = mockMessageBus.subscribe.mock.calls.find(
      (call: [string, (msg: unknown) => void]) =>
        call[0] === MessageBusType.TOOL_CONFIRMATION_REQUEST,
    )?.[1] as (msg: unknown) => void;
    if (handler) {
      handler(testRequest);
    }

    await vi.waitFor(() =>
      expect(
        messages.some(
          (m) =>
            m.topic === 'event:bus:tool-confirmation-request' &&
            m.payload?.correlationId === 'bus-123',
        ),
      ).toBe(true),
    );
    ws.close();
  });

  it('synchronizes local terminal messages to WebSocket', async () => {
    const { ws, messages } = await connectAndAuth();
    ws.send(
      JSON.stringify({
        action: 'system:subscribe',
        topics: ['event:chat:user_message'],
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    appEvents.emit(AppEvent.LocalPrompt, 'Message from TUI');
    await vi.waitFor(() =>
      expect(
        messages.some(
          (m) =>
            m.topic === 'event:chat:user_message' &&
            m.payload?.text === 'Message from TUI',
        ),
      ).toBe(true),
    );
    ws.close();
  });

  it('handles ConsentRequest (Terminal -> Web resolution)', async () => {
    const { ws, messages } = await connectAndAuth();
    ws.send(
      JSON.stringify({
        action: 'system:subscribe',
        topics: [
          'state:confirm:active:request',
          'event:confirm:active:resolved',
        ],
      }),
    );
    await new Promise((r) => setTimeout(r, 50));

    const originalOnConfirm = vi.fn();
    const consentRequest: ConsentRequestPayload = {
      prompt: 'Trust?',
      onConfirm: originalOnConfirm,
    };

    mockCoreEvents._trigger(CoreEvent.ConsentRequest, consentRequest);

    await vi.waitFor(() =>
      expect(
        messages.some((m) => m.topic === 'state:confirm:active:request'),
      ).toBe(true),
    );
    const correlationId = messages.find(
      (m) => m.topic === 'state:confirm:active:request',
    )?.payload?.correlationId as string;

    consentRequest.onConfirm(true);

    await vi.waitFor(() =>
      expect(
        messages.some(
          (m) =>
            m.topic === 'event:confirm:active:resolved' &&
            m.payload?.correlationId === correlationId &&
            m.payload?.confirmed === true,
        ),
      ).toBe(true),
    );
    expect(originalOnConfirm).toHaveBeenCalledWith(true);
    ws.close();
  });

  it('handles ConsentRequest (Web -> Terminal resolution)', async () => {
    const { ws, messages } = await connectAndAuth();
    ws.send(
      JSON.stringify({
        action: 'system:subscribe',
        topics: ['state:confirm:active:request'],
      }),
    );
    await new Promise((r) => setTimeout(r, 50));

    const originalOnConfirm = vi.fn();
    const consentRequest: ConsentRequestPayload = {
      prompt: 'Trust?',
      onConfirm: originalOnConfirm,
    };

    mockCoreEvents._trigger(CoreEvent.ConsentRequest, consentRequest);

    await vi.waitFor(() =>
      expect(
        messages.some((m) => m.topic === 'state:confirm:active:request'),
      ).toBe(true),
    );
    const correlationId = messages.find(
      (m) => m.topic === 'state:confirm:active:request',
    )?.payload?.correlationId as string;

    ws.send(
      JSON.stringify({
        action: 'confirm:reply',
        correlationId,
        confirmed: true,
      }),
    );

    await vi.waitFor(() =>
      expect(originalOnConfirm).toHaveBeenCalledWith(true),
    );
    ws.close();
  });

  it('supports complex tool outcomes in confirm:reply', async () => {
    const { ws } = await connectAndAuth();
    ws.send(
      JSON.stringify({
        action: 'confirm:reply',
        correlationId: 'outcome-123',
        confirmed: true,
        outcome: ToolConfirmationOutcome.ProceedAlways,
      }),
    );
    await vi.waitFor(() =>
      expect(mockMessageBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          correlationId: 'outcome-123',
          outcome: ToolConfirmationOutcome.ProceedAlways,
        }),
      ),
    );
    ws.close();
  });
});
