/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  RemoteApiService,
  RemoteMessageType,
} from '../services/RemoteApiService.js';
import { WebSocket } from 'ws';

describe('RemoteApiService Integration', () => {
  let service: RemoteApiService;
  const PORT = 8999;

  beforeEach(() => {
    service = new RemoteApiService(PORT);
    service.start();
  });

  afterEach(() => {
    service.stop();
  });

  it('should allow a client to connect and receive SESSION_INIT', async () => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);

    const messagePromise = new Promise<unknown>((resolve) => {
      ws.on('message', (data) => {
        resolve(JSON.parse(data.toString()));
      });
    });

    service.on('client_connected', (clientWs) => {
      service.sendToClient(clientWs, {
        type: RemoteMessageType.SESSION_INIT,
        payload: { sessionId: 'test-session', history: [] },
      });
    });

    const message = await messagePromise;
    const isSessionInit = (
      msg: unknown,
    ): msg is { type: string; payload: { sessionId: string } } => {
      if (typeof msg !== 'object' || msg === null) return false;
      if (!('type' in msg) || typeof msg.type !== 'string') return false;
      if (
        !('payload' in msg) ||
        typeof msg.payload !== 'object' ||
        msg.payload === null
      )
        return false;
      const payload = msg.payload;
      return 'sessionId' in payload && typeof payload.sessionId === 'string';
    };
    if (isSessionInit(message)) {
      expect(message.type).toBe(RemoteMessageType.SESSION_INIT);
      expect(message.payload.sessionId).toBe('test-session');
    } else {
      throw new Error('Message is not a valid SESSION_INIT');
    }

    ws.close();
  });

  it('should emit send_prompt event when client sends SEND_PROMPT', async () => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);

    await new Promise((resolve) => ws.on('open', resolve));

    const promptPromise = new Promise<string>((resolve) => {
      service.on('send_prompt', (text) => {
        resolve(text);
      });
    });

    ws.send(
      JSON.stringify({
        type: RemoteMessageType.SEND_PROMPT,
        payload: { text: 'Hello from Web' },
      }),
    );

    const promptText = await promptPromise;
    expect(promptText).toBe('Hello from Web');

    ws.close();
  });
});
