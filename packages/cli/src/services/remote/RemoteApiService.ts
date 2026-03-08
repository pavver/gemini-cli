/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  debugLogger,
  type CoreEventEmitter,
  type MessageBus,
  MessageBusType,
  CoreEvent,
  type ConsentRequestPayload,
} from '@google/gemini-cli-core';
import {
  type RemoteAction,
  isRemoteAction,
  type SubscribeAction,
  type UnsubscribeAction,
  type ChatSendAction,
  type ConfirmReplyAction,
  type AskUserReplyAction,
} from './types.js';
import { RemoteEventAdapter } from './RemoteEventAdapter.js';
import { appEvents, AppEvent } from '../../utils/events.js';

interface RemoteSession {
  id: string;
  ws: WebSocket;
  ip: string;
  authenticated: boolean;
  subscriptions: Set<string>;
}

/**
 * RemoteApiService provides a WebSocket interface for remote interaction with Gemini CLI.
 */
export class RemoteApiService {
  private wss: WebSocketServer | undefined;
  private readonly sessions = new Map<string, RemoteSession>();
  private readonly lockedIps = new Set<string>();
  private readonly eventAdapter: RemoteEventAdapter;
  private readonly consentCallbacks = new Map<
    string,
    (confirmed: boolean) => void
  >();
  private readonly consentListener: (p: ConsentRequestPayload) => void;

  constructor(
    private readonly port: number,
    private readonly remoteToken: string | undefined,
    private readonly coreEvents: CoreEventEmitter,
    private readonly messageBus: MessageBus,
    geminiSessionId?: string,
  ) {
    this.eventAdapter = new RemoteEventAdapter(coreEvents, geminiSessionId);
    this.eventAdapter.onEmit((message) => {
      this.broadcastToSubscribers(message.topic, message.payload);
    });

    // 1. Synchronize MessageBus events (Tools, AskUser, etc.)
    this.relayMessageBus();

    // 2. Synchronize ConsentRequests (Folder trust, etc.)
    this.consentListener = (p: ConsentRequestPayload) => {
      const correlationId = randomUUID();
      const originalOnConfirm = p.onConfirm;

      // Wrap the callback to notify WebSocket clients when it's resolved (e.g., via TUI)
      p.onConfirm = (confirmed: boolean) => {
        this.consentCallbacks.delete(correlationId);
        this.broadcastToSubscribers('event:confirm:active:resolved', {
          correlationId,
          confirmed,
        });
        originalOnConfirm(confirmed);
      };

      this.consentCallbacks.set(correlationId, p.onConfirm);
      this.broadcastToSubscribers('state:confirm:active:request', {
        prompt: p.prompt,
        correlationId,
      });
    };
    this.coreEvents.on(CoreEvent.ConsentRequest, this.consentListener);

    // 3. Synchronize Local User Messages (Terminal -> WebSocket)
    appEvents.on(AppEvent.LocalPrompt, (text) => {
      this.broadcastToSubscribers('event:chat:user_message', { text });
    });
  }

  private relayMessageBus(): void {
    const typesToRelay = [
      MessageBusType.TOOL_CONFIRMATION_REQUEST,
      MessageBusType.TOOL_CONFIRMATION_RESPONSE,
      MessageBusType.ASK_USER_REQUEST,
      MessageBusType.ASK_USER_RESPONSE,
      MessageBusType.TOOL_CALLS_UPDATE,
    ];

    typesToRelay.forEach((type) => {
      this.messageBus.subscribe(type, (msg) => {
        // Map MessageBus types to Remote API event topics
        const topic = `event:bus:${type}`;
        this.broadcastToSubscribers(topic, msg);
      });
    });
  }

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

        if (!session || !session.authenticated) {
          if (isRemoteAction(message) && message.action === 'auth') {
            await this.handleAuth(ws, ip, message, authTimeout).then((s) => {
              session = s;
            });
          }
          return;
        }

        if (isRemoteAction(message)) {
          await this.handleAction(session, message);
        }
      } catch (e) {
        debugLogger.error(`Error processing message from ${ip}: ${e}`);
      }
    });

    ws.on('close', () => {
      if (session) {
        debugLogger.log(
          `Client session ${session.id} closed connection from ${ip}`,
        );
      }
    });

    ws.on('error', (err) => {
      debugLogger.error(`WebSocket error from ${ip}: ${err.message}`);
    });
  }

  private async handleAuth(
    ws: WebSocket,
    ip: string,
    message: Extract<RemoteAction, { action: 'auth' }>,
    authTimeout: NodeJS.Timeout,
  ): Promise<RemoteSession | undefined> {
    if (message.version !== 1) {
      this.rejectClient(ws, ip, 'Unsupported protocol version. Expected: 1');
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
    let session: RemoteSession;

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
        subscriptions: new Set<string>(),
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

    return session;
  }

  private async handleAction(
    session: RemoteSession,
    message: RemoteAction,
  ): Promise<void> {
    switch (message.action) {
      case 'system:subscribe':
        this.handleSubscribe(session, message);
        break;
      case 'system:unsubscribe':
        this.handleUnsubscribe(session, message);
        break;
      case 'chat:send':
        this.handleChatSend(message);
        break;
      case 'chat:stop':
        this.handleChatStop();
        break;
      case 'confirm:reply':
        this.handleConfirmReply(message);
        break;
      case 'confirm:ask_user:reply':
        this.handleAskUserReply(message);
        break;
      default: {
        const { action } = message as { action: string };
        debugLogger.warn(`Unknown action: ${action}`);
        break;
      }
    }
  }

  private handleSubscribe(session: RemoteSession, action: SubscribeAction) {
    action.topics.forEach((topic) => session.subscriptions.add(topic));
    // Immediately send current state for newly subscribed state topics
    action.topics.forEach((topic) => {
      if (topic.startsWith('state:')) {
        const cached = this.eventAdapter.getState(topic);
        if (cached) {
          session.ws.send(JSON.stringify({ topic, payload: cached }));
        }
      }
    });
  }

  private handleUnsubscribe(session: RemoteSession, action: UnsubscribeAction) {
    action.topics.forEach((topic) => session.subscriptions.delete(topic));
  }

  private handleChatSend(action: ChatSendAction) {
    appEvents.emit(AppEvent.RemotePrompt, action.text);
  }

  private handleChatStop() {
    appEvents.emit(AppEvent.RemoteCancel);
  }

  private handleConfirmReply(action: ConfirmReplyAction) {
    // Check if it's a ConsentRequest callback
    const consentCallback = this.consentCallbacks.get(action.correlationId);
    if (consentCallback) {
      consentCallback(action.confirmed);
      this.consentCallbacks.delete(action.correlationId);
      return;
    }

    // Otherwise, it's a ToolConfirmation through MessageBus
    void this.messageBus.publish({
      type: MessageBusType.TOOL_CONFIRMATION_RESPONSE,
      correlationId: action.correlationId,
      confirmed: action.confirmed,
      outcome: action.outcome,
    });
  }

  private handleAskUserReply(action: AskUserReplyAction) {
    void this.messageBus.publish({
      type: MessageBusType.ASK_USER_RESPONSE,
      correlationId: action.correlationId,
      answers: action.answers,
      cancelled: action.cancelled,
    });
  }

  private broadcastToSubscribers(topic: string, payload: unknown): void {
    const message = JSON.stringify({ topic, payload });
    this.sessions.forEach((session) => {
      if (session.authenticated && session.subscriptions.has(topic)) {
        if (session.ws.readyState === session.ws.OPEN) {
          session.ws.send(message);
        }
      }
    });
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
      this.eventAdapter.dispose();
      this.consentCallbacks.clear();
      this.coreEvents.off(CoreEvent.ConsentRequest, this.consentListener);
      // We don't have an easy way to unsubscribe from appEvents without storing each callback,
      // but for Remote API lifecycle it's usually once per app run.
      debugLogger.log('Remote API server stopped');
    }
  }
}
