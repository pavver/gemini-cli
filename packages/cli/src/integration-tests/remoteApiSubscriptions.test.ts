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
import { StreamingState } from '../ui/types.js';

describe('RemoteApiService Subscriptions & Pagination', () => {
  let service: RemoteApiService;
  const PORT = 9005;

  beforeEach(() => {
    service = new RemoteApiService(PORT);
    service.start();
  });

  afterEach(() => {
    service.stop();
  });

  const connectClient = async (): Promise<WebSocket> => {
    const ws = new WebSocket(`ws://localhost:${PORT}/remote`);
    return new Promise((resolve) => {
      ws.on('open', () => resolve(ws));
    });
  };

  it('should only receive shell output if subscribed to specific pid', async () => {
    const ws = await connectClient();
    const pid = 123;
    const otherPid = 456;

    const messages: Array<Record<string, unknown>> = [];
    ws.on('message', (data) => {
      messages.push(JSON.parse(data.toString()) as Record<string, unknown>);
    });

    // Send shell output for pid 123 (should NOT receive yet, not subscribed)
    service.broadcastShellOutput(pid, 'data 1');

    // Subscribe to pid 123
    ws.send(
      JSON.stringify({
        type: RemoteMessageType.SUBSCRIBE,
        payload: { topic: `shell:${pid}` },
      }),
    );

    // Wait a bit for subscription to process
    await new Promise((r) => setTimeout(r, 50));

    // Send shell output for pid 123 and 456
    service.broadcastShellOutput(pid, 'data 2');
    service.broadcastShellOutput(otherPid, 'data from other');

    // Wait for messages
    await new Promise((r) => setTimeout(r, 100));

    expect(
      messages.some((m) => {
        const p = m['payload'] as Record<string, unknown> | undefined;
        return p?.['chunk'] === 'data 1';
      }),
    ).toBe(false);

    expect(
      messages.some((m) => {
        const p = m['payload'] as Record<string, unknown> | undefined;
        return p?.['chunk'] === 'data 2';
      }),
    ).toBe(true);

    expect(
      messages.some((m) => {
        const p = m['payload'] as Record<string, unknown> | undefined;
        return p?.['chunk'] === 'data from other';
      }),
    ).toBe(false);

    ws.close();
  });

  it('should allow unsubscribing from topics', async () => {
    const ws = await connectClient();

    const messages: Array<Record<string, unknown>> = [];
    ws.on('message', (data) => {
      messages.push(JSON.parse(data.toString()) as Record<string, unknown>);
    });

    // Status is a default subscription
    service.broadcastStreamingState(StreamingState.Responding);

    // Unsubscribe from status
    ws.send(
      JSON.stringify({
        type: RemoteMessageType.UNSUBSCRIBE,
        payload: { topic: 'status' },
      }),
    );

    await new Promise((r) => setTimeout(r, 50));

    service.broadcastStreamingState(StreamingState.Idle);

    await new Promise((r) => setTimeout(r, 100));

    expect(
      messages.some((m) => {
        const p = m['payload'] as Record<string, unknown> | undefined;
        return p?.['state'] === StreamingState.Responding;
      }),
    ).toBe(true);

    expect(
      messages.some((m) => {
        const p = m['payload'] as Record<string, unknown> | undefined;
        return p?.['state'] === StreamingState.Idle;
      }),
    ).toBe(false);

    ws.close();
  });
});
