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
  type GeminiClient,
  type Config,
  type Question,
} from '@google/gemini-cli-core';
import {
  type RemoteAction,
  isRemoteAction,
  type SubscribeAction,
  type UnsubscribeAction,
  type RemoteSession,
  type RemoteToolCallRecord,
} from './types.js';
import { RemoteEventAdapter } from './RemoteEventAdapter.js';
import { appEvents, AppEvent } from '../../utils/events.js';
import { type LoadedSettings } from '../../config/settings.js';
import { ProtocolMapper } from './ProtocolMapper.js';
import { ConfirmationManager } from './ConfirmationManager.js';
import { ActionHandler } from './ActionHandler.js';
import { DeltaTracker } from './utils/DeltaTracker.js';

/**
 * RemoteApiService provides a WebSocket interface for remote interaction with Gemini CLI.
 */
export class RemoteApiService {
  private wss: WebSocketServer | undefined;
  private readonly sessions = new Map<string, RemoteSession>();
  private readonly lockedIps = new Set<string>();
  private readonly eventAdapter: RemoteEventAdapter;
  private readonly confirmationManager: ConfirmationManager;
  private readonly actionHandler: ActionHandler;
  private readonly messageBusCache = new Map<string, unknown>();
  private readonly processedConfirmationIds = new Set<string>();
  private readonly toolDeltaTracker = new DeltaTracker<RemoteToolCallRecord>();

  private readonly consentListener: (p: ConsentRequestPayload) => void;
  private readonly localPromptListener: (text: string) => void;
  private readonly sessionChangedListener: () => void;
  private readonly outputListener: () => void;
  private ramUpdateTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly port: number,
    private readonly remoteToken: string | undefined,
    private readonly coreEvents: CoreEventEmitter,
    private readonly messageBus: MessageBus,
    private readonly geminiClient: GeminiClient,
    config: Config,
    private readonly loadedSettings: LoadedSettings,
    geminiSessionId?: string,
    initialWarnings?: string[],
  ) {
    this.eventAdapter = new RemoteEventAdapter(
      coreEvents,
      config,
      geminiSessionId,
      initialWarnings?.map((w) => ({ severity: 'info', message: w })),
    );

    this.eventAdapter.onEmit((message) => {
      this.broadcastToSubscribers(message.topic, message.payload);
    });

    this.confirmationManager = new ConfirmationManager(
      this.messageBus,
      (payload) =>
        this.eventAdapter.emitState('state:confirm:active:request', payload),
      (topic, payload) => this.broadcastToSubscribers(topic, payload),
    );

    this.actionHandler = new ActionHandler(
      this.geminiClient,
      this.loadedSettings,
      this.eventAdapter,
      () => this.updateLastMessageId(),
    );

    // 1. Synchronize MessageBus events (Tools, AskUser, etc.)
    this.relayMessageBus();

    // 2. Synchronize ConsentRequests (Folder trust, etc.)
    this.consentListener = (p: ConsentRequestPayload) => {
      const correlationId = randomUUID();
      const wrappedOnConfirm = (outcome: string) => {
        p.onConfirm(outcome === 'yes' || outcome === 'proceed_once');
      };

      this.confirmationManager.enqueue({
        correlationId,
        type: 'consent',
        prompt: p.prompt,
        options: [
          { value: 'yes', variant: 'success' },
          { value: 'no', variant: 'danger' },
        ],
        callback: wrappedOnConfirm,
      });
    };
    this.coreEvents.on(CoreEvent.ConsentRequest, this.consentListener);

    // 3. Synchronize Local User Messages (Terminal -> WebSocket)
    this.localPromptListener = (text: string) => {
      this.broadcastToSubscribers('event:chat:user_message', { text });
      this.updateLastMessageId();
    };
    appEvents.on(AppEvent.LocalPrompt, this.localPromptListener);

    // 4. Handle session changes
    this.sessionChangedListener = () => {
      this.messageBusCache.clear();
      this.processedConfirmationIds.clear();
      this.toolDeltaTracker.clear();
      this.confirmationManager.clear();
      this.updateLastMessageId();
    };
    appEvents.on(AppEvent.SessionChanged, this.sessionChangedListener);

    // 5. Update last message ID on output
    this.outputListener = () => {
      this.updateLastMessageId();
    };
    this.coreEvents.on(CoreEvent.Output, this.outputListener);

    // Initial state update
    this.updateLastMessageId();
  }

  private updateLastMessageId(): void {
    const recordingService = this.geminiClient.getChatRecordingService();
    if (!recordingService) return;

    const conversation = recordingService.getConversation();
    if (conversation && conversation.messages.length > 0) {
      const lastId = conversation.messages[conversation.messages.length - 1].id;
      this.eventAdapter.emitState('state:chat:last_message_id', { id: lastId });
    } else {
      this.eventAdapter.emitState('state:chat:last_message_id', null);
    }
  }

  /**
   * Manually emits an event to all subscribers.
   */
  emitEvent(topic: string, payload: unknown): void {
    this.broadcastToSubscribers(topic, payload);
  }

  /**
   * Manually emits a state change to all subscribers.
   */
  emitState(topic: string, payload: unknown): void {
    this.eventAdapter.emitState(topic, payload);
  }

  private relayMessageBus(): void {
    // ASK_USER integration into unified queue
    this.messageBus.subscribe(
      MessageBusType.ASK_USER_REQUEST,
      (msg: unknown) => {
        if (ProtocolMapper.isObject(msg) && Array.isArray(msg['questions'])) {
          const correlationId = String(msg['correlationId'] || '');
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          const questions = msg['questions'] as Question[];

          this.confirmationManager.setActiveAskUserSession({
            correlationId,
            questions,
            currentIndex: 0,
            answers: {},
          });

          const q = questions[0];
          const options: Array<{
            value: string;
            variant?:
              | 'primary'
              | 'secondary'
              | 'danger'
              | 'success'
              | 'warning';
          }> = [];

          if (q.type === 'choice' && q.options) {
            q.options.forEach((o) => {
              options.push({ value: o.label });
            });
          } else if (q.type === 'yesno') {
            options.push({ value: 'yes', variant: 'success' });
            options.push({ value: 'no', variant: 'danger' });
          }

          this.confirmationManager.enqueue({
            correlationId,
            type: 'ask_user',
            prompt: q.question,
            header: q.header,
            questionIndex: 0,
            totalQuestions: questions.length,
            options,
            hasInput: q.type === 'text',
            inputPlaceholder: q.placeholder,
          });
        }
      },
    );

    this.messageBus.subscribe(
      MessageBusType.ASK_USER_RESPONSE,
      (msg: unknown) => {
        const topic = `event:bus:${MessageBusType.ASK_USER_RESPONSE}`;
        this.messageBusCache.set(topic, msg);
        if (ProtocolMapper.hasCorrelationId(msg)) {
          this.confirmationManager.resolveExternally(msg.correlationId);
        }
        this.broadcastToSubscribers(topic, msg);
      },
    );

    this.messageBus.subscribe(
      MessageBusType.TOOL_CONFIRMATION_RESPONSE,
      (msg: unknown) => {
        if (ProtocolMapper.hasCorrelationId(msg)) {
          this.confirmationManager.resolveExternally(msg.correlationId);
        }
      },
    );

    this.messageBus.subscribe(
      MessageBusType.TOOL_CALLS_UPDATE,
      (msg: unknown) => {
        const topic = `event:bus:${MessageBusType.TOOL_CALLS_UPDATE}`;
        if (ProtocolMapper.isToolCallsUpdate(msg)) {
          // Check for tools awaiting approval and enqueue them
          msg.toolCalls.forEach((tcUnknown) => {
            if (!ProtocolMapper.isObject(tcUnknown)) return;
            const tc = tcUnknown as Record<string, unknown>;

            const correlationId = tc['correlationId'];
            if (typeof correlationId !== 'string') return;

            if (
              tc['status'] === 'awaiting_approval' &&
              ProtocolMapper.isSerializableConfirmationDetails(
                tc['confirmationDetails'],
              ) &&
              !this.processedConfirmationIds.has(correlationId)
            ) {
              const details = tc['confirmationDetails'];

              // Extract or generate prompt
              let prompt = '';
              const request = tc['request'];
              if (details.type === 'info' && details.prompt) {
                prompt = details.prompt;
              } else if (
                request &&
                ProtocolMapper.isObject(request) &&
                request['name']
              ) {
                prompt = `Allow tool call: ${String(request['name'])}?`;
              }

              this.processedConfirmationIds.add(correlationId);
              this.confirmationManager.enqueue({
                correlationId,
                type: 'tool',
                prompt,
                header: details.title,
                details: ProtocolMapper.mapConfirmationDetails(details),
                options: details.options || [],
              });
            } else if (
              tc['status'] &&
              ['success', 'error', 'cancelled'].includes(
                String(tc['status']),
              ) &&
              this.processedConfirmationIds.has(correlationId)
            ) {
              // Clean up once finished to keep the set small
              this.processedConfirmationIds.delete(correlationId);
            }
          });

          // 2. Map to safe message and check for changes
          const deltas: Array<Partial<RemoteToolCallRecord>> = [];

          msg.toolCalls.forEach((tc) => {
            const fullMapped = ProtocolMapper.mapToolCallFromCore(tc);
            const delta = this.toolDeltaTracker.getDelta(fullMapped);
            if (delta) {
              deltas.push(delta);
            }
          });

          if (deltas.length > 0) {
            const safeMsg = {
              type: 'tool-calls-update',
              toolCalls: deltas,
            };
            this.messageBusCache.set(topic, safeMsg);
            this.broadcastToSubscribers(topic, safeMsg);
          }
        }
      },
    );
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

    this.ramUpdateTimer = setInterval(() => {
      this.eventAdapter.emitRamUsage();
    }, 30000);

    const message = `Remote API server listening on 127.0.0.1:${this.port}`;
    debugLogger.log(message);

    setTimeout(() => {
      this.coreEvents.emit(CoreEvent.UserFeedback, {
        severity: 'info',
        message,
      });
    }, 1000);
  }

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const ip = req.socket.remoteAddress || 'unknown';

    if (this.lockedIps.has(ip)) {
      debugLogger.warn(`Ignoring connection request from locked IP: ${ip}`);
      ws.terminate();
      return;
    }

    ws.send(
      JSON.stringify({
        type: 'status',
        message: 'Connected. Awaiting authentication...',
      }),
    );

    let session: RemoteSession | undefined;

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
        this.sessions.delete(session.id);
        debugLogger.log(
          `Client session ${session.id} closed and removed from ${ip}`,
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

    clearTimeout(authTimeout);

    const sessionId = randomUUID();
    const session: RemoteSession = {
      id: sessionId,
      ws,
      ip,
      authenticated: true,
      subscriptions: new Set<string>(),
    };
    this.sessions.set(sessionId, session);

    ws.send(JSON.stringify({ type: 'auth_ok', sessionId, version: 1 }));
    debugLogger.log(
      `Client from ${ip} authenticated. New session created: ${sessionId}`,
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
        this.actionHandler.handleChatSend(message, (t, p) =>
          this.broadcastToSubscribers(t, p),
        );
        break;
      case 'chat:stop':
        this.actionHandler.handleChatStop();
        break;
      case 'chat:get_history_page':
        this.actionHandler.handleChatGetHistoryPage(session, message);
        break;
      case 'settings:get':
        this.actionHandler.handleSettingsGet(session, message);
        break;
      case 'settings:set':
        this.actionHandler.handleSettingsSet(session, message);
        break;
      case 'confirm:reply':
        await this.confirmationManager.handleReply(message);
        break;
      case 'stats:get':
        await this.actionHandler.handleStatsGet(session, message);
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
    action.topics.forEach((topic) => {
      if (topic.startsWith('state:')) {
        const cached = this.eventAdapter.getState(topic);
        if (cached) {
          session.ws.send(JSON.stringify({ topic, payload: cached }));
        }
      } else if (topic.startsWith('event:bus:')) {
        const cached = this.messageBusCache.get(topic);
        if (cached) {
          session.ws.send(JSON.stringify({ topic, payload: cached }));
        }
      }
    });
  }

  private handleUnsubscribe(session: RemoteSession, action: UnsubscribeAction) {
    action.topics.forEach((topic) => session.subscriptions.delete(topic));
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

  stop(): void {
    if (this.ramUpdateTimer) clearInterval(this.ramUpdateTimer);
    this.eventAdapter.dispose();
    if (this.wss) {
      this.wss.close();
      this.sessions.forEach((s) => s.ws.terminate());
      this.sessions.clear();
      this.lockedIps.clear();
      this.confirmationManager.clear();
      this.coreEvents.off(CoreEvent.ConsentRequest, this.consentListener);
      this.coreEvents.off(CoreEvent.Output, this.outputListener);
      appEvents.off(AppEvent.LocalPrompt, this.localPromptListener);
      appEvents.off(AppEvent.SessionChanged, this.sessionChangedListener);
      debugLogger.log('Remote API server stopped');
    }
  }
}
