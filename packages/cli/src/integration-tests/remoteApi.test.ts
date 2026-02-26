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
    const ws = new WebSocket(`ws://localhost:${PORT}/remote`);

    const messagePromise = new Promise<Record<string, unknown>>((resolve) => {
      ws.on('message', (data) => {
        resolve(JSON.parse(data.toString()) as Record<string, unknown>);
      });
    });

    await new Promise((resolve) => ws.on('open', resolve));

    // Handshake
    ws.send(
      JSON.stringify({
        type: RemoteMessageType.SESSION_STATE_REQUEST,
        payload: { apiVersion: 1 },
      }),
    );

    const message = await messagePromise;
    expect(message['type']).toBe(RemoteMessageType.SESSION_INIT);
    const payload = message['payload'] as Record<string, unknown>;
    expect(payload['apiVersion']).toBe(1);

    ws.close();
  });

  it('should emit send_prompt event when client sends SEND_PROMPT', async () => {
    const ws = new WebSocket(`ws://localhost:${PORT}/remote`);

    await new Promise((resolve) => ws.on('open', resolve));

    const promptPromise = new Promise<string>((resolve) => {
      service.on('send_prompt', (text: string) => {
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
