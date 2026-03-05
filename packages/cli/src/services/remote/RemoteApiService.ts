/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { debugLogger } from '@google/gemini-cli-core';

interface RemoteSession {
  id: string;
  ws: WebSocket;
  ip: string;
  authenticated: boolean;
}

interface AuthMessage {
  action: string;
  version?: number;
  token?: string;
  sessionId?: string;
}

function isAuthMessage(msg: unknown): msg is AuthMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'action' in msg &&
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    (msg as AuthMessage).action === 'auth'
  );
}

/**
 * RemoteApiService provides a WebSocket interface for remote interaction with Gemini CLI.
 */
export class RemoteApiService {
  private wss: WebSocketServer | undefined;
  private readonly sessions = new Map<string, RemoteSession>();
  private readonly lockedIps = new Set<string>();

  constructor(
    private readonly port: number,
    private readonly remoteToken?: string,
  ) {}

  /**
   * Starts the WebSocket server.
   */
  async start(): Promise<void> {
    this.wss = new WebSocketServer({
      port: this.port,
      host: '127.0.0.1',
    });

    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      this.handleConnection(ws, req);
    });

    debugLogger.log(`Remote API server listening on 127.0.0.1:${this.port}`);
  }

  /**
   * Handles a new client connection.
   */
  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const ip = req.socket.remoteAddress || 'unknown';

    if (this.lockedIps.has(ip)) {
      debugLogger.warn(`Ignoring connection request from locked IP: ${ip}`);
      ws.terminate();
      return;
    }

    this.clients.add(ws);

    // Initial message
    ws.send(
      JSON.stringify({
        type: 'status',
        message: 'Connected. Awaiting authentication...',
      }),
    );

    let session: RemoteSession | undefined;

    // Disconnect if not authenticated within 10 seconds
    const authTimeout = setTimeout(() => {
      if (!session || !session.authenticated) {
        this.rejectClient(ws, ip, 'Authentication timeout');
      }
    }, 10000);

    ws.on('message', async (data) => {
      try {
        const message: unknown = JSON.parse(data.toString());

        if (isAuthMessage(message)) {
          if (message.version !== 1) {
            this.rejectClient(
              ws,
              ip,
              'Unsupported protocol version. Expected: 1',
            );
            return;
          }

          if (this.remoteToken && message.token !== this.remoteToken) {
            clearTimeout(authTimeout);
            await this.handleAuthFailure(ws, ip);
            return;
          }

          // Token is valid - process session
          clearTimeout(authTimeout);

          let sessionId = message.sessionId;
          let isReconnection = false;

          if (sessionId && this.sessions.has(sessionId)) {
            // Reconnect to existing session
            session = this.sessions.get(sessionId)!;
            // Terminate old socket if it's still open
            if (session.ws !== ws) {
              session.ws.terminate();
              session.ws = ws;
            }
            isReconnection = true;
          } else {
            // Create new session
            sessionId = sessionId || randomUUID();
            session = {
              id: sessionId,
              ws,
              ip,
              authenticated: true,
            };
            this.sessions.set(sessionId, session);
          }

          // Immediate response on success
          ws.send(
            JSON.stringify({
              type: 'auth_ok',
              sessionId,
              version: 1,
              reconnected: isReconnection,
            }),
          );

          debugLogger.log(
            `Client from ${ip} authenticated. Session: ${sessionId} (${isReconnection ? 'reconnected' : 'new'})`,
          );
        }
      } catch (_e) {
        // Ignore invalid JSON
      }
    });

    ws.on('close', () => {
      if (session) {
        debugLogger.log(
          `Client session ${session.id} closed connection from ${ip}`,
        );
      }
      this.clients.delete(ws);
    });

    ws.on('error', (err) => {
      debugLogger.error(`WebSocket error from ${ip}: ${err.message}`);
      this.clients.delete(ws);
    });
  }

  private get clients(): Set<WebSocket> {
    // Helper to keep track of raw connections before they become sessions
    const allClients = new Set<WebSocket>();
    this.sessions.forEach((s) => allClients.add(s.ws));
    return allClients;
  }

  private rejectClient(ws: WebSocket, ip: string, message: string): void {
    ws.send(JSON.stringify({ type: 'error', message }));
    ws.terminate();
    debugLogger.warn(`Rejected client ${ip}: ${message}`);
  }

  private async handleAuthFailure(ws: WebSocket, ip: string): Promise<void> {
    debugLogger.warn(`Invalid token from ${ip}. Locking IP for 5 seconds.`);
    this.lockedIps.add(ip);

    await new Promise((resolve) => setTimeout(resolve, 5000));

    ws.send(JSON.stringify({ type: 'error', message: 'Invalid token' }));
    ws.terminate();

    this.lockedIps.delete(ip);
    debugLogger.log(`Unlocked IP: ${ip}`);
  }

  /**
   * Stops the WebSocket server.
   */
  stop(): void {
    if (this.wss) {
      this.wss.close();
      this.sessions.forEach((s) => s.ws.terminate());
      this.sessions.clear();
      this.lockedIps.clear();
      debugLogger.log('Remote API server stopped');
    }
  }
}
