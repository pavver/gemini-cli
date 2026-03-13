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

  const service = new RemoteApiService(
    8100,
    'test-token',
    mockCoreEvents,
    mockMessageBus,
    mockGeminiClient as any,
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
      tokens: { input: 10, output: 20, cached: 0, total: 30 },
    };

    // @ts-expect-error - accessing private method for testing
    const mapped = service.mapMessage(rawMessage);

    expect(mapped.id).toBe('msg-1');
    expect(mapped.type).toBe('gemini');
    expect(mapped.content).toHaveLength(3);
    expect(mapped.content[0]).toEqual({ text: 'Hello' });
    expect(mapped.content[1]).toEqual({
      functionCall: {
        name: 'get_weather',
        args: { location: 'Kyiv' },
      },
    });
    expect(mapped.content[2]).toEqual({
      inlineData: {
        mimeType: 'image/png',
        data: 'base64data',
      },
    });
    expect(mapped.tokens?.total).toBe(30);
    expect(mapped.model).toBe('gemini-2.0-flash');
  });

  it('should handle nested objects in function arguments safely', () => {
    const rawMessage: MessageRecord = {
      id: 'msg-2',
      timestamp: '2026-03-09T10:05:00Z',
      type: 'gemini',
      content: [
        {
          functionCall: {
            name: 'complex_tool',
            args: {
              config: {
                enabled: true,
                layers: [1, 2, { id: 'top' }],
              },
            },
          },
        },
      ],
    };

    // @ts-expect-error - accessing private method for testing
    const mapped = service.mapMessage(rawMessage);
    const fc = (mapped.content[0] as any).functionCall;

    expect(fc.args.config.enabled).toBe(true);
    expect(fc.args.config.layers[2].id).toBe('top');
  });
});
