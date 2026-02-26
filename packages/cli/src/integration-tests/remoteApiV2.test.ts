/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  RemoteApiService,
  RemoteMessageType,
} from '../services/RemoteApiService.js';
import { WebSocket } from 'ws';
import { ApprovalMode } from '@google/gemini-cli-core';
import { StreamingState, type HistoryItem } from '../ui/types.js';

describe('RemoteApiService Protocol v2 Integration', () => {
  let service: RemoteApiService;
  const PORT = 9001;

  beforeEach(() => {
    service = new RemoteApiService(PORT);
    service.start();

    // Mock the logic that would normally be in useRemoteApi hook
    service.on('session_state_request', (ws: WebSocket) => {
      service.sendToClient(ws, {
        type: RemoteMessageType.SESSION_INIT,
        payload: {
          apiVersion: 1,
          sessionId: 'test-session',
          history: [],
          config: { model: 'test-model', approvalMode: ApprovalMode.DEFAULT },
          streamingState: StreamingState.Idle,
          activePtyId: null,
          shellHistory: null,
          status: {
            model: 'test-model',
            ramUsage: '0 MB',
            contextTokens: 0,
            geminiMdFileCount: 0,
            skillsCount: 0,
            mcpServers: [],
            cwd: '/test/path',
            gitBranch: 'main',
            platform: 'linux',
          },
          commands: [],
          authState: 'authenticated',
        },
      });
    });
  });

  afterEach(() => {
    service.stop();
  });

  const connectClient = async (): Promise<WebSocket> => {
    const ws = new WebSocket(`ws://localhost:${PORT}/remote`);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Connection timeout')),
        2000,
      );
      ws.on('open', () => {
        clearTimeout(timeout);
        resolve(ws);
      });
      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  };

  it('should include new status fields in SESSION_INIT after handshake', async () => {
    const ws = await connectClient();
    const messagePromise = new Promise<Record<string, unknown>>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (msg['type'] === RemoteMessageType.SESSION_INIT) resolve(msg);
      });
    });

    ws.send(
      JSON.stringify({
        type: RemoteMessageType.SESSION_STATE_REQUEST,
        payload: { apiVersion: 1 },
      }),
    );

    const msg = await messagePromise;
     
    const payload = msg['payload'] as Record<string, unknown>;
     
    const status = payload['status'] as Record<string, unknown>;
    expect(status['cwd']).toBe('/test/path');
    expect(status['gitBranch']).toBe('main');
    expect(payload['apiVersion']).toBe(1);
    ws.close();
  });

  it('should emit search_request event with query and type', async () => {
    const ws = await connectClient();
    const spy = vi.fn();
    service.on('search_request', spy);

    ws.send(
      JSON.stringify({
        type: RemoteMessageType.SEARCH_REQUEST,
        payload: { query: 'test-query', type: 'at' },
      }),
    );

    await vi.waitFor(
      () => expect(spy).toHaveBeenCalledWith('test-query', 'at'),
      { timeout: 1000 },
    );
    ws.close();
  });

  it('should emit auth_submit event with method and apiKey', async () => {
    const ws = await connectClient();
    const spy = vi.fn();
    service.on('auth_submit', spy);

    ws.send(
      JSON.stringify({
        type: RemoteMessageType.AUTH_SUBMIT,
        payload: { method: 'api_key', apiKey: 'test-key-123' },
      }),
    );

    await vi.waitFor(
      () => expect(spy).toHaveBeenCalledWith('api_key', 'test-key-123'),
      { timeout: 1000 },
    );
    ws.close();
  });

  it('should emit resize_terminal event with cols and rows', async () => {
    const ws = await connectClient();
    const spy = vi.fn();
    service.on('resize_terminal', spy);

    ws.send(
      JSON.stringify({
        type: RemoteMessageType.RESIZE_TERMINAL,
        payload: { cols: 120, rows: 40 },
      }),
    );

    await vi.waitFor(() => expect(spy).toHaveBeenCalledWith(120, 40), {
      timeout: 1000,
    });
    ws.close();
  });

  it('should emit session_state_request event', async () => {
    const ws = await connectClient();
    const spy = vi.fn();
    service.on('session_state_request', spy);

    ws.send(
      JSON.stringify({
        type: RemoteMessageType.SESSION_STATE_REQUEST,
        payload: { apiVersion: 1 },
      }),
    );

    await vi.waitFor(() => expect(spy).toHaveBeenCalled(), { timeout: 1000 });
    ws.close();
  });

  it('should emit history_request event with offset and limit', async () => {
    const ws = await connectClient();
    const spy = vi.fn();
    service.on('history_request', spy);

    ws.send(
      JSON.stringify({
        type: RemoteMessageType.HISTORY_REQUEST,
        payload: { offset: 50, limit: 20 },
      }),
    );

    await vi.waitFor(() => expect(spy).toHaveBeenCalledWith(50, 20), {
      timeout: 1000,
    });
    ws.close();
  });

  it('should broadcast HISTORY_RESPONSE correctly', async () => {
    const ws = await connectClient();
    const messagePromise = new Promise<Record<string, unknown>>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (msg['type'] === RemoteMessageType.HISTORY_RESPONSE) resolve(msg);
      });
    });

    service.broadcast({
      type: RemoteMessageType.HISTORY_RESPONSE,
      payload: {
         
        items: [
          { id: 1, type: 'user', text: 'hello' } as unknown as HistoryItem,
        ],
        offset: 0,
        limit: 1,
        total: 100,
      },
    });

    const msg = await messagePromise;
     
    const payload = msg['payload'] as Record<string, unknown>;
    expect(payload['total']).toBe(100);
    ws.close();
  });

  it('should reject malformed messages silently (security validation)', async () => {
    const ws = await connectClient();
    const promptSpy = vi.fn();
    service.on('send_prompt', promptSpy);

    ws.send(JSON.stringify({ type: RemoteMessageType.SEND_PROMPT }));
    ws.send(
      JSON.stringify({
        type: RemoteMessageType.HISTORY_REQUEST,
        payload: { offset: 'not-a-number' },
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(promptSpy).not.toHaveBeenCalled();
    ws.close();
  });

  it('should emit stop_generation event', async () => {
    const ws = await connectClient();
    const spy = vi.fn();
    service.on('stop_generation', spy);

    ws.send(JSON.stringify({ type: RemoteMessageType.STOP_GENERATION }));

    await vi.waitFor(() => expect(spy).toHaveBeenCalled(), { timeout: 1000 });
    ws.close();
  });
});
