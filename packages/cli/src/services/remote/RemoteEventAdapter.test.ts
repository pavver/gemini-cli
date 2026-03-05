/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { CoreEventEmitter, CoreEvent } from '@google/gemini-cli-core';
import type { AgentDefinition } from '@google/gemini-cli-core';
import { RemoteEventAdapter } from './RemoteEventAdapter.js';
import type {
  AgentsState,
  ChatStreamEvent,
  McpServersState,
  ModelState,
  SessionIdState,
} from './types.js';

describe('RemoteEventAdapter', () => {
  let coreEvents: CoreEventEmitter;
  let adapter: RemoteEventAdapter;
  let emitSpy: Mock;

  beforeEach(() => {
    coreEvents = new CoreEventEmitter();
    adapter = new RemoteEventAdapter(coreEvents);
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

  it('should map CoreEvent.AgentsDiscovered to simplified agent list', () => {
    const mockAgents: AgentDefinition[] = [
      {
        name: 'agent1',
        displayName: 'Agent 1',
        description: 'Desc 1',
        kind: 'local',
        inputConfig: { inputSchema: {} },
        promptConfig: { systemPrompt: '...' },
        modelConfig: { model: '...' },
        runConfig: {},
      },
    ];
    coreEvents.emitAgentsDiscovered(mockAgents);
    const expected: AgentsState = {
      agents: [
        {
          name: 'agent1',
          displayName: 'Agent 1',
          description: 'Desc 1',
          kind: 'local',
        },
      ],
    };
    expect(emitSpy).toHaveBeenCalledWith({
      topic: 'state:system:agents',
      payload: expected,
    });
  });

  it('should emit state:session:id if geminiSessionId provided', () => {
    const sessionAdapter = new RemoteEventAdapter(coreEvents, 'gemini-123');
    const spy = vi.fn();
    sessionAdapter.onEmit(spy);
    const expected: SessionIdState = { id: 'gemini-123' };
    expect(spy).toHaveBeenCalledWith({
      topic: 'state:session:id',
      payload: expected,
    });
  });

  it('should implement state-diffing (not emitting same payload twice)', () => {
    coreEvents.emitModelChanged('model-a');
    coreEvents.emitModelChanged('model-a');
    expect(emitSpy).toHaveBeenCalledTimes(1);
  });

  it('should map CoreEvent.McpClientUpdate to list of server names', () => {
    const mockServers = new Map();
    mockServers.set('server1', {});
    mockServers.set('server2', {});

    coreEvents.emit(CoreEvent.McpClientUpdate, mockServers);

    const expected: McpServersState = { servers: ['server1', 'server2'] };
    expect(emitSpy).toHaveBeenCalledWith({
      topic: 'state:system:mcp:servers',
      payload: expected,
    });
  });
});
