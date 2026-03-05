/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { RemoteApiService } from './RemoteApiService.js';
import { debugLogger } from '@google/gemini-cli-core';

vi.mock('@google/gemini-cli-core', () => ({
  debugLogger: {
    log: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

interface AuthResponse {
  type: string;
  sessionId: string;
  version: number;
  reconnected: boolean;
  message?: string;
}

describe('RemoteApiService', () => {
  const PORT = 8123; // Use a different port for testing
  const TOKEN = 'test-token';
  let service: RemoteApiService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new RemoteApiService(PORT, TOKEN);
  });

  afterEach(async () => {
    service.stop();
    // Give some time for sockets to close
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  it('starts the server on 127.0.0.1', async () => {
    await service.start();
    expect(debugLogger.log).toHaveBeenCalledWith(
      expect.stringContaining(`listening on 127.0.0.1:${PORT}`),
    );
  });

  it('authenticates successfully with correct token and version', async () => {
    await service.start();
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);

    await new Promise((resolve) => ws.on('open', resolve));

    const messages: AuthResponse[] = [];
    ws.on('message', (data) => {
       
      messages.push(JSON.parse(data.toString()) as AuthResponse);
    });

    ws.send(
      JSON.stringify({
        action: 'auth',
        version: 1,
        token: TOKEN,
      }),
    );

    await vi.waitFor(
      () => {
        expect(messages.some((m) => m.type === 'auth_ok')).toBe(true);
      },
      { timeout: 2000 },
    );

    const authOk = messages.find((m) => m.type === 'auth_ok');
    expect(authOk?.sessionId).toBeDefined();

    ws.close();
  });

  it('rejects authentication with invalid token', async () => {
    await service.start();
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);

    await new Promise((resolve) => ws.on('open', resolve));

    const messages: AuthResponse[] = [];
    ws.on('message', (data) => {
       
      messages.push(JSON.parse(data.toString()) as AuthResponse);
    });

    ws.send(
      JSON.stringify({
        action: 'auth',
        version: 1,
        token: 'wrong-token',
      }),
    );

    // Expect error. Server has a 5s delay, so use a larger timeout for the test
    await vi.waitFor(
      () => {
        expect(
          messages.some(
            (m) => m.type === 'error' && m.message === 'Invalid token',
          ),
        ).toBe(true);
      },
      { timeout: 10000 },
    );

    ws.close();
  }, 12000);

  it('reconnects to an existing session', async () => {
    await service.start();

    // First connection
    const ws1 = new WebSocket(`ws://127.0.0.1:${PORT}`);
    await new Promise((resolve) => ws1.on('open', resolve));

    let sessionId = '';
    ws1.on('message', (data) => {
       
      const msg = JSON.parse(data.toString()) as AuthResponse;
      if (msg.type === 'auth_ok') sessionId = msg.sessionId;
    });

    ws1.send(JSON.stringify({ action: 'auth', version: 1, token: TOKEN }));
    await vi.waitFor(() => expect(sessionId).not.toBe(''), { timeout: 2000 });

    // Second connection with same sessionId
    const ws2 = new WebSocket(`ws://127.0.0.1:${PORT}`);
    await new Promise((resolve) => ws2.on('open', resolve));

    const messages2: AuthResponse[] = [];
    ws2.on('message', (data) => {
       
      messages2.push(JSON.parse(data.toString()) as AuthResponse);
    });

    ws2.send(
      JSON.stringify({
        action: 'auth',
        version: 1,
        token: TOKEN,
        sessionId,
      }),
    );

    await vi.waitFor(
      () => {
        const authOk = messages2.find((m) => m.type === 'auth_ok');
        expect(authOk).toBeDefined();
        expect(authOk?.sessionId).toBe(sessionId);
        expect(authOk?.reconnected).toBe(true);
      },
      { timeout: 2000 },
    );

    ws1.close();
    ws2.close();
  });
});
