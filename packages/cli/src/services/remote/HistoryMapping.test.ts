/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi } from 'vitest';
import { RemoteApiService } from './RemoteApiService.js';
import {
  type CoreEventEmitter,
  type MessageBus,
  type ChatRecordingService,
  type MessageRecord,
} from '@google/gemini-cli-core';

describe('RemoteApiService History Mapping', () => {
  const mockCoreEvents = {
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as CoreEventEmitter;
  const mockMessageBus = {
    subscribe: vi.fn(),
    publish: vi.fn(),
  } as unknown as MessageBus;
  const mockChatRecordingService = {
    getConversation: vi.fn(),
  } as unknown as ChatRecordingService;

  const mockGeminiClient = {
    getChatRecordingService: vi.fn(() => mockChatRecordingService),
  };

  const mockConfig = {
    getModel: vi.fn(() => 'test-model'),
    getToolRegistry: vi.fn(() => ({
      getMcpClients: vi.fn(() => new Map()),
    })),
    getAgentRegistry: vi.fn(() => ({
      getAllDefinitions: vi.fn(() => []),
    })),
  };

  const mockLoadedSettings = {
    merged: {},
    user: { settings: {} },
  };

  const service = new RemoteApiService(
    8100,
    'test-token',
    mockCoreEvents,
    mockMessageBus,
    mockGeminiClient as any,
    mockConfig as any,
    mockLoadedSettings as any,
    'test-session-id',
  );

  it('should map complex message content to stable RemoteParts', () => {
    const rawMessage: MessageRecord = {
      id: 'msg-1',
      timestamp: '2026-03-09T10:00:00Z',
      type: 'gemini',
      content: [
        { text: 'Hello' },
        {
          functionCall: {
            name: 'get_weather',
            args: { location: 'Kyiv' },
          },
        },
        {
          inlineData: {
            mimeType: 'image/png',
            data: 'base64data',
          },
        },
      ],
      model: 'gemini-2.0-flash',
      tokens: { input: 10, output: 20, total: 30, cached: 0 },
    };

    // @ts-expect-error - accessing private mapMessage
    const mapped = service.mapMessage(rawMessage);

    expect(mapped.id).toBe('msg-1');
    expect(mapped.content).toHaveLength(3);
    expect(mapped.content[0].text).toBe('Hello');
    expect(mapped.content[1].functionCall?.name).toBe('get_weather');
    expect(mapped.content[2].inlineData?.mimeType).toBe('image/png');
    expect(mapped.model).toBe('gemini-2.0-flash');
    expect(mapped.tokens?.total).toBe(30);
  });

  it('should handle tool calls and thoughts in mapping', () => {
    const rawMessage: MessageRecord = {
      id: 'msg-2',
      timestamp: '2026-03-09T10:05:00Z',
      type: 'gemini',
      content: [],
      toolCalls: [
        {
          id: 'call-1',
          name: 'calc',
          args: { a: 1 },
          status: 'validating' as any, // Use valid status
          timestamp: 'ts',
        },
      ],
      thoughts: [
        {
          subject: 'Thinking',
          description: 'Deep thoughts',
          timestamp: 'ts',
        } as any,
      ],
    };

    // @ts-expect-error - accessing private mapMessage
    const mapped = service.mapMessage(rawMessage);

    expect(mapped.toolCalls).toHaveLength(1);
    expect(mapped.toolCalls?.[0].name).toBe('calc');
    expect(mapped.thoughts).toHaveLength(1);
    expect(mapped.thoughts?.[0].subject).toBe('Thinking');
    expect(mapped.thoughts?.[0].summary).toBe('Deep thoughts');
  });
});
