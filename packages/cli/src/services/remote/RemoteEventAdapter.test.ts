/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { CoreEventEmitter, type Config } from '@google/gemini-cli-core';
import { RemoteEventAdapter } from './RemoteEventAdapter.js';
import type { ChatStreamEvent, ModelState, SessionIdState } from './types.js';
import { createMockConfig } from '../../test-utils/mockConfig.js';

describe('RemoteEventAdapter', () => {
  let coreEvents: CoreEventEmitter;
  let adapter: RemoteEventAdapter;
  let emitSpy: Mock;
  let mockConfig: Config;

  beforeEach(() => {
    coreEvents = new CoreEventEmitter();
    mockConfig = createMockConfig({
      getModel: vi.fn(() => 'test-model'),
      getToolRegistry: vi.fn(() => ({
        getTools: vi.fn(() => []),
        getAllTools: vi.fn(() => []),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      })) as any,
      getAgentRegistry: vi.fn(() => ({
        getAllDefinitions: vi.fn(() => []),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      })) as any,
    });
    adapter = new RemoteEventAdapter(coreEvents, mockConfig);
    emitSpy = vi.fn();
    adapter.onEmit(emitSpy);
  });

  it('should map CoreEvent.ModelChanged to simple object', () => {
    coreEvents.emitModelChanged('gemini-1.5-pro');
    const expected: ModelState = { model: 'gemini-1.5-pro' };
    expect(emitSpy).toHaveBeenCalledWith({
      topic: 'state:session:model',
      payload: expected,
    });
  });

  it('should map CoreEvent.Output to simple chunk object', () => {
    coreEvents.emitOutput(false, 'Hello world');
    const expected: ChatStreamEvent = { chunk: 'Hello world', isStderr: false };
    expect(emitSpy).toHaveBeenCalledWith({
      topic: 'event:chat:stream',
      payload: expected,
    });
  });

  it('should convert Uint8Array chunk to string in event:chat:stream', () => {
    const chunk = new TextEncoder().encode('Buffer data');
    coreEvents.emitOutput(true, chunk);
    const expected: ChatStreamEvent = { chunk: 'Buffer data', isStderr: true };
    expect(emitSpy).toHaveBeenCalledWith({
      topic: 'event:chat:stream',
      payload: expected,
    });
  });

  it('should notify about session changes and clear cache', () => {
    adapter.emitState('test:topic', { data: 1 });
    emitSpy.mockClear();

    const adapterWithSession = new RemoteEventAdapter(
      coreEvents,
      mockConfig,
      'gemini-123',
    );
    const spy2 = vi.fn();
    adapterWithSession.onEmit(spy2);

    expect(spy2).toHaveBeenCalledWith({
      topic: 'state:session:id',
      payload: { id: 'gemini-123' } as SessionIdState,
    });
  });
});
