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
  type MessageRecord,
  type ToolCallRecord,
  type TokensSummary,
  type ThoughtSummary,
  type GeminiClient,
  type Config,
  type ToolConfirmationOutcome,
} from '@google/gemini-cli-core';
import {
  type RemoteAction,
  isRemoteAction,
  type SubscribeAction,
  type UnsubscribeAction,
  type ChatSendAction,
  type ConfirmReplyAction,
  type AskUserReplyAction,
  type ChatGetHistoryPageAction,
  type SettingsGetAction,
  type SettingsSetAction,
  type RemoteMessageRecord,
  type RemoteToolCallRecord,
  type RemoteThoughtSummary,
  type RemoteTokensSummary,
  type RemotePart,
  type RemoteSettingDefinition,
  type SettingsListResponse,
  type SettingsSetResponse,
} from './types.js';
import { RemoteEventAdapter } from './RemoteEventAdapter.js';
import { appEvents, AppEvent } from '../../utils/events.js';
import {
  getFlattenedSchema,
  getEffectiveValue,
  isInSettingsScope,
  getDefaultValue,
  parseEditedValue,
} from '../../utils/settingsUtils.js';
import { SettingScope, type LoadedSettings } from '../../config/settings.js';

interface RemoteSession {
  id: string;
  ws: WebSocket;
  ip: string;
  authenticated: boolean;
  subscriptions: Set<string>;
}

interface PendingConfirmation {
  correlationId: string;
  prompt: string;
  callback?: (confirmed: boolean) => void;
  type: 'consent' | 'bus';
  messageBusType?: MessageBusType;
}

/**
 * RemoteApiService provides a WebSocket interface for remote interaction with Gemini CLI.
 */
export class RemoteApiService {
  private wss: WebSocketServer | undefined;
  private readonly sessions = new Map<string, RemoteSession>();
  private readonly lockedIps = new Set<string>();
  private readonly eventAdapter: RemoteEventAdapter;
  private readonly pendingConfirmations: PendingConfirmation[] = [];
  private readonly messageBusCache = new Map<string, unknown>();
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
  ) {
    this.eventAdapter = new RemoteEventAdapter(
      coreEvents,
      config,
      geminiSessionId,
    );
    this.eventAdapter.onEmit((message) => {
      this.broadcastToSubscribers(message.topic, message.payload);
    });

    // 1. Synchronize MessageBus events (Tools, AskUser, etc.)
    this.relayMessageBus();

    // 2. Synchronize ConsentRequests (Folder trust, etc.)
    this.consentListener = (p: ConsentRequestPayload) => {
      const correlationId = randomUUID();
      const originalOnConfirm = p.onConfirm;

      const wrappedOnConfirm = (confirmed: boolean) => {
        this.resolveConfirmation(correlationId, confirmed);
        originalOnConfirm(confirmed);
      };

      this.enqueueConfirmation({
        correlationId,
        prompt: p.prompt,
        callback: wrappedOnConfirm,
        type: 'consent',
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
      this.pendingConfirmations.length = 0;
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
    if (!recordingService) {
      return;
    }
    const conversation = recordingService.getConversation();
    if (conversation && conversation.messages.length > 0) {
      const lastId = conversation.messages[conversation.messages.length - 1].id;
      this.eventAdapter.emitState('state:chat:last_message_id', { id: lastId });
    } else {
      this.eventAdapter.emitState('state:chat:last_message_id', null);
    }
  }

  private enqueueConfirmation(conf: PendingConfirmation): void {
    this.pendingConfirmations.push(conf);
    if (this.pendingConfirmations.length === 1) {
      this.broadcastActiveConfirmation();
    }
  }

  private resolveConfirmation(correlationId: string, confirmed: boolean): void {
    const index = this.pendingConfirmations.findIndex(
      (c) => c.correlationId === correlationId,
    );
    if (index === -1) return;

    const isCurrent = index === 0;
    this.pendingConfirmations.splice(index, 1);

    this.broadcastToSubscribers('event:confirm:active:resolved', {
      correlationId,
      confirmed,
    });

    if (isCurrent) {
      this.broadcastActiveConfirmation();
    }
  }

  private broadcastActiveConfirmation(): void {
    const current = this.pendingConfirmations[0];
    if (current) {
      this.eventAdapter.emitState('state:confirm:active:request', {
        prompt: current.prompt,
        correlationId: current.correlationId,
      });
    } else {
      // Clear the active request state if no more pending
      this.eventAdapter.emitState('state:confirm:active:request', null);
    }
  }

  private relayMessageBus(): void {
    // Tool confirmation requests need to be queued
    this.messageBus.subscribe(
      MessageBusType.TOOL_CONFIRMATION_REQUEST,
      (msg: unknown) => {
        if (this.isObject(msg)) {
          this.enqueueConfirmation({
            correlationId: String(msg['correlationId'] || ''),
            prompt: String(msg['prompt'] || ''),
            type: 'bus',
            messageBusType: MessageBusType.TOOL_CONFIRMATION_REQUEST,
          });
        }
      },
    );

    // Responses (even local ones) should resolve the queue
    this.messageBus.subscribe(
      MessageBusType.TOOL_CONFIRMATION_RESPONSE,
      (msg: unknown) => {
        if (this.isObject(msg)) {
          this.resolveConfirmation(
            String(msg['correlationId'] || ''),
            Boolean(msg['confirmed']),
          );
        }
      },
    );

    // Other MessageBus events can be relayed directly and cached if needed
    const otherTypes = [
      MessageBusType.ASK_USER_REQUEST,
      MessageBusType.ASK_USER_RESPONSE,
      MessageBusType.TOOL_CALLS_UPDATE,
    ];

    otherTypes.forEach((type) => {
      this.messageBus.subscribe(type, (msg: unknown) => {
        const topic = `event:bus:${type}`;
        this.messageBusCache.set(topic, msg);
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

    // Start RAM usage updates
    this.ramUpdateTimer = setInterval(() => {
      this.eventAdapter.emitRamUsage();
    }, 30000);

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

    // Token is valid - process session
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

    // Immediate response on success
    ws.send(
      JSON.stringify({
        type: 'auth_ok',
        sessionId,
        version: 1,
      }),
    );

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
        this.handleChatSend(message);
        break;
      case 'chat:stop':
        this.handleChatStop();
        break;
      case 'chat:get_history_page':
        this.handleChatGetHistoryPage(session, message);
        break;
      case 'settings:get':
        this.handleSettingsGet(session, message);
        break;
      case 'settings:set':
        this.handleSettingsSet(session, message);
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
    // Immediately send current state for newly subscribed state topics or cached bus topics
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

  private handleChatSend(action: ChatSendAction) {
    appEvents.emit(AppEvent.RemotePrompt, action.text);
    this.updateLastMessageId();
  }

  private handleChatStop() {
    appEvents.emit(AppEvent.RemoteCancel);
  }

  private handleChatGetHistoryPage(
    session: RemoteSession,
    action: ChatGetHistoryPageAction,
  ) {
    const recordingService = this.geminiClient.getChatRecordingService();
    if (!recordingService) {
      session.ws.send(
        JSON.stringify({
          type: 'response:chat:history',
          correlationId: action.correlationId,
          messages: [],
          total: 0,
        }),
      );
      return;
    }
    const conversation = recordingService.getConversation();
    if (!conversation) {
      session.ws.send(
        JSON.stringify({
          type: 'response:chat:history',
          correlationId: action.correlationId,
          messages: [],
          total: 0,
        }),
      );
      return;
    }

    const allMessages = conversation.messages;
    const total = allMessages.length;
    let slicedMessages: MessageRecord[] = [];

    if (action.sort === 'asc') {
      slicedMessages = allMessages.slice(
        action.offset,
        action.offset + action.limit,
      );
    } else {
      const end = Math.max(0, total - action.offset);
      const start = Math.max(0, end - action.limit);
      slicedMessages = allMessages.slice(start, end).reverse();
    }

    const messages = slicedMessages.map((m) => this.mapMessage(m));

    session.ws.send(
      JSON.stringify({
        type: 'response:chat:history',
        correlationId: action.correlationId,
        messages,
        total,
      }),
    );
  }

  private handleSettingsGet(session: RemoteSession, action: SettingsGetAction) {
    const schema = getFlattenedSchema();
    const mergedSettings = this.loadedSettings.merged;
    const userSettings = this.loadedSettings.user.settings;

    const remoteSettings: RemoteSettingDefinition[] = Object.keys(schema)
      .filter((key) => schema[key].showInDialog !== false)
      .map((key) => {
        const def = schema[key];
        return {
          id: key,
          label: def.label,
          description: def.description,
          type: def.type as RemoteSettingDefinition['type'],
          value: getEffectiveValue(key, mergedSettings),
          default: getDefaultValue(key),
          isChanged: isInSettingsScope(key, userSettings),
          options: def.options
            ? def.options.map((o) => ({ label: o.label, value: o.value }))
            : undefined,
          requiresRestart: def.requiresRestart,
          category: def.category,
        };
      });

    const response: SettingsListResponse = {
      type: 'response:settings:list',
      correlationId: action.correlationId,
      settings: remoteSettings,
    };

    session.ws.send(JSON.stringify(response));
  }

  private handleSettingsSet(session: RemoteSession, action: SettingsSetAction) {
    const schema = getFlattenedSchema();
    const def = schema[action.id];

    if (!def) {
      const response: SettingsSetResponse = {
        type: 'response:settings:set',
        correlationId: action.correlationId,
        success: false,
        error: `Setting ${action.id} not found`,
      };
      session.ws.send(JSON.stringify(response));
      return;
    }

    try {
      // We assume User scope for remote changes for now
      // Value might need parsing if it comes as string from some clients
      let valueToSet = action.value;
      if (typeof valueToSet === 'string' && def.type !== 'string') {
        const parsed = parseEditedValue(def.type, valueToSet);
        if (parsed !== null) {
          valueToSet = parsed;
        }
      }

      this.loadedSettings.setValue(SettingScope.User, action.id, valueToSet);

      // If client provided a hash, make sure we use it so they can recognize their change.
      // emitSettingsHash will update the 'state:session:settings:hash' topic for everyone.
      if (action.settingsHash) {
        this.eventAdapter.emitSettingsHash(action.settingsHash);
      }

      const response: SettingsSetResponse = {
        type: 'response:settings:set',
        correlationId: action.correlationId,
        success: true,
        settingsHash: action.settingsHash,
      };
      session.ws.send(JSON.stringify(response));
    } catch (e) {
      const response: SettingsSetResponse = {
        type: 'response:settings:set',
        correlationId: action.correlationId,
        success: false,
        settingsHash: action.settingsHash,
        error: e instanceof Error ? e.message : String(e),
      };
      session.ws.send(JSON.stringify(response));
    }
  }

  private mapMessage(msg: MessageRecord): RemoteMessageRecord {
    const remoteMsg: RemoteMessageRecord = {
      id: msg.id,
      timestamp: msg.timestamp,
      type: msg.type,
      content: this.mapContent(msg.content),
    };

    if (msg.displayContent) {
      remoteMsg.displayContent = this.mapContent(msg.displayContent);
    }

    if (msg.type === 'gemini') {
      if (msg.toolCalls) {
        remoteMsg.toolCalls = msg.toolCalls.map((tc) => this.mapToolCall(tc));
      }
      if (msg.thoughts) {
        remoteMsg.thoughts = msg.thoughts.map((t) =>
          this.mapThought(t as ThoughtSummary & { timestamp: string }),
        );
      }
      remoteMsg.tokens = this.mapTokens(msg.tokens);
      remoteMsg.model = msg.model;
    }

    return remoteMsg;
  }

  private mapContent(content: unknown): RemotePart[] {
    if (typeof content === 'string') {
      return [{ text: content }];
    }
    if (Array.isArray(content)) {
      const result: RemotePart[] = [];
      for (const item of content) {
        result.push(this.mapPart(item));
      }
      return result;
    }
    return [this.mapPart(content)];
  }

  private isObject(val: unknown): val is Record<string, unknown> {
    return typeof val === 'object' && val !== null;
  }

  private mapPart(part: unknown): RemotePart {
    if (typeof part === 'string') {
      return { text: part };
    }

    if (this.isObject(part)) {
      const text = part['text'];
      if (typeof text === 'string') {
        return { text };
      }

      const fc = part['functionCall'];
      if (this.isObject(fc)) {
        const name = fc['name'];
        return {
          functionCall: {
            name: typeof name === 'string' ? name : '',
            args: this.mapSafeRecord(fc['args']),
          },
        };
      }

      const fr = part['functionResponse'];
      if (this.isObject(fr)) {
        const name = fr['name'];
        return {
          functionResponse: {
            name: typeof name === 'string' ? name : '',
            response: this.mapSafeRecord(fr['response']),
          },
        };
      }

      const id = part['inlineData'];
      if (this.isObject(id)) {
        const mimeType = id['mimeType'];
        const data = id['data'];
        return {
          inlineData: {
            mimeType: typeof mimeType === 'string' ? mimeType : '',
            data: typeof data === 'string' ? data : '',
          },
        };
      }

      const fd = part['fileData'];
      if (this.isObject(fd)) {
        const mimeType = fd['mimeType'];
        const fileUri = fd['fileUri'];
        return {
          fileData: {
            mimeType: typeof mimeType === 'string' ? mimeType : '',
            fileUri: typeof fileUri === 'string' ? fileUri : '',
          },
        };
      }

      const ec = part['executableCode'];
      if (this.isObject(ec)) {
        const language = ec['language'];
        const code = ec['code'];
        return {
          executableCode: {
            language: typeof language === 'string' ? language : '',
            code: typeof code === 'string' ? code : '',
          },
        };
      }

      const cer = part['codeExecutionResult'];
      if (this.isObject(cer)) {
        const outcome = cer['outcome'];
        const output = cer['output'];
        return {
          codeExecutionResult: {
            outcome: typeof outcome === 'string' ? outcome : '',
            output: typeof output === 'string' ? output : '',
          },
        };
      }
    }

    return { text: '[Unknown Part Type]' };
  }

  private mapSafeRecord(source: unknown): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    if (this.isObject(source)) {
      for (const [key, value] of Object.entries(source)) {
        if (
          typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'boolean' ||
          value === null
        ) {
          result[key] = value;
        } else if (Array.isArray(value)) {
          const arr: unknown[] = [];
          for (const item of value) {
            arr.push(this.isObject(item) ? this.mapSafeRecord(item) : item);
          }
          result[key] = arr;
        } else if (this.isObject(value)) {
          result[key] = this.mapSafeRecord(value);
        }
      }
    }
    return result;
  }

  private mapToolCall(tc: ToolCallRecord): RemoteToolCallRecord {
    return {
      id: tc.id,
      name: tc.name,
      args: this.mapSafeRecord(tc.args),
      result: tc.result ? this.mapContent(tc.result) : undefined,
      status: String(tc.status),
      timestamp: tc.timestamp,
      displayName: tc.displayName,
      description: tc.description,
    };
  }

  private mapThought(
    t: ThoughtSummary & { timestamp: string },
  ): RemoteThoughtSummary {
    return {
      subject: t.subject,
      summary: t.description,
      timestamp: t.timestamp,
    };
  }

  private mapTokens(
    tokens: TokensSummary | null | undefined,
  ): RemoteTokensSummary | null {
    if (!tokens) {
      return null;
    }
    const result: RemoteTokensSummary = {
      input: tokens.input,
      output: tokens.output,
      cached: tokens.cached,
      thoughts: tokens.thoughts,
      tool: tokens.tool,
      total: tokens.total,
    };
    return result;
  }

  private handleConfirmReply(action: ConfirmReplyAction) {
    const index = this.pendingConfirmations.findIndex(
      (c) => c.correlationId === action.correlationId,
    );
    if (index === -1) return;

    const conf = this.pendingConfirmations[index];

    if (conf.type === 'consent' && conf.callback) {
      conf.callback(action.confirmed);
    } else if (conf.type === 'bus') {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      const outcome = action.outcome as ToolConfirmationOutcome | undefined;
      void this.messageBus.publish({
        type: MessageBusType.TOOL_CONFIRMATION_RESPONSE,
        correlationId: action.correlationId,
        confirmed: action.confirmed,
        outcome,
      });
    }
  }

  private handleAskUserReply(action: AskUserReplyAction) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const answers = action.answers as { [key: string]: string };
    void this.messageBus.publish({
      type: MessageBusType.ASK_USER_RESPONSE,
      correlationId: action.correlationId,
      answers,
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
    if (this.ramUpdateTimer) {
      clearInterval(this.ramUpdateTimer);
    }
    if (this.wss) {
      this.wss.close();
      this.sessions.forEach((s) => s.ws.terminate());
      this.sessions.clear();
      this.lockedIps.clear();
      this.eventAdapter.dispose();
      this.pendingConfirmations.length = 0;

      // Cleanup listeners
      this.coreEvents.off(CoreEvent.ConsentRequest, this.consentListener);
      this.coreEvents.off(CoreEvent.Output, this.outputListener);
      appEvents.off(AppEvent.LocalPrompt, this.localPromptListener);
      appEvents.off(AppEvent.SessionChanged, this.sessionChangedListener);

      debugLogger.log('Remote API server stopped');
    }
  }
}
