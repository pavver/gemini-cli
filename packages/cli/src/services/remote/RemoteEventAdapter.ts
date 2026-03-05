/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type CoreEventEmitter,
  CoreEvent,
  type UserFeedbackPayload,
  type ModelChangedPayload,
  type ConsoleLogPayload,
  type OutputPayload,
  type MemoryChangedPayload,
  type HookStartPayload,
  type HookEndPayload,
  type RetryAttemptPayload,
  type ConsentRequestPayload,
  type McpProgressPayload,
  type AgentsDiscoveredPayload,
  type SlashCommandConflictsPayload,
  type QuotaChangedPayload,
  type EditorSelectedPayload,
  type CoreEvents,
  type McpClient,
} from '@google/gemini-cli-core';
import type {
  AgentsState,
  ChatStreamEvent,
  ConsentRequestState,
  ConsoleLogEvent,
  EditorState,
  FeedbackEvent,
  HookEndEvent,
  HookStartEvent,
  McpProgressEvent,
  McpServersState,
  MemoryState,
  ModelState,
  OauthMessageEvent,
  QuotaState,
  RamUsageState,
  RetryAttemptEvent,
  SessionIdState,
  SlashConflictsEvent,
} from './types.js';

/**
 * Interface for outgoing Remote API messages.
 */
export interface RemoteEventMessage {
  topic: string;
  payload: unknown;
}

/**
 * Union of all possible event handlers to maintain type safety when storing them.
 */
type AnyEventHandler = {
  [K in keyof CoreEvents]: {
    event: K;
    handler: (...args: CoreEvents[K]) => void;
  };
}[keyof CoreEvents];

/**
 * Adapter to translate internal CoreEvents into Remote API topics.
 * Performs explicit mapping to stable "Simple Types" to ensure protocol stability.
 * Implements state-diffing to minimize traffic.
 */
export class RemoteEventAdapter {
  private readonly stateCache = new Map<string, string>();
  private onEmitCallback?: (message: RemoteEventMessage) => void;
  private readonly handlers: AnyEventHandler[] = [];

  constructor(
    private readonly coreEvents: CoreEventEmitter,
    private readonly geminiSessionId?: string,
  ) {
    this.setupSubscriptions();
    if (this.geminiSessionId) {
      this.handleState('state:session:id', {
        id: this.geminiSessionId,
      } as SessionIdState);
    }
  }

  /**
   * Sets the callback for outgoing messages.
   */
  onEmit(callback: (message: RemoteEventMessage) => void): void {
    this.onEmitCallback = callback;
    // Immediately emit geminiSessionId if we have it and callback is just set
    if (this.geminiSessionId) {
      this.emit('state:session:id', {
        id: this.geminiSessionId,
      } as SessionIdState);
    }
  }

  /**
   * Explicitly emits current RAM usage.
   */
  emitRamUsage(): void {
    const usage = process.memoryUsage();
    const payload: RamUsageState = {
      rss: usage.rss,
      heapTotal: usage.heapTotal,
      heapUsed: usage.heapUsed,
    };
    this.handleState('state:system:ramUsage', payload);
  }

  /**
   * Type-safe internal helper to subscribe and track handlers.
   */
  private subscribe<K extends keyof CoreEvents>(
    event: K,
    handler: (...args: CoreEvents[K]) => void,
  ): void {
    // @ts-expect-error - EventEmitter generic types are complex to match exactly in a generic method
    this.coreEvents.on(event, handler);
    // Explicitly casting to the union type which is safe because it's derived from CoreEvents
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    this.handlers.push({ event, handler } as unknown as AnyEventHandler);
  }

  /**
   * Subscribes to all relevant core events and maps them to stable protocol types.
   */
  private setupSubscriptions(): void {
    // --- 1. STATE Topics (Stateful) ---

    this.subscribe(CoreEvent.QuotaChanged, (p: QuotaChangedPayload) => {
      const payload: QuotaState = {
        remaining: p.remaining,
        limit: p.limit,
        resetTime: p.resetTime,
      };
      this.handleState('state:system:quota', payload);
    });

    this.subscribe(CoreEvent.MemoryChanged, (p: MemoryChangedPayload) => {
      const payload: MemoryState = { fileCount: p.fileCount };
      this.handleState('state:system:memory', payload);
    });

    this.subscribe(
      CoreEvent.McpClientUpdate,
      (servers: Map<string, McpClient>) => {
        const payload: McpServersState = {
          servers: Array.from(servers.keys()),
        };
        this.handleState('state:system:mcp:servers', payload);
      },
    );

    this.subscribe(CoreEvent.AgentsDiscovered, (p: AgentsDiscoveredPayload) => {
      const payload: AgentsState = {
        agents: p.agents.map((a) => ({
          name: a.name,
          displayName: a.displayName,
          description: a.description,
          kind: a.kind,
        })),
      };
      this.handleState('state:system:agents', payload);
    });

    this.subscribe(CoreEvent.AgentsRefreshed, () =>
      this.emit('state:system:agents:refresh', {}),
    );

    this.subscribe(CoreEvent.ModelChanged, (p: ModelChangedPayload) => {
      const payload: ModelState = { model: p.model };
      this.handleState('state:session:model', payload);
    });

    this.subscribe(CoreEvent.SettingsChanged, () =>
      this.emit('state:session:settings', { changed: true }),
    );

    this.subscribe(CoreEvent.AdminSettingsChanged, () =>
      this.emit('state:session:adminSettings', { changed: true }),
    );

    this.subscribe(CoreEvent.EditorSelected, (p: EditorSelectedPayload) => {
      const payload: EditorState = { editor: p.editor };
      this.handleState('state:session:editor', payload);
    });

    this.subscribe(CoreEvent.ConsentRequest, (p: ConsentRequestPayload) => {
      const payload: ConsentRequestState = { prompt: p.prompt };
      this.handleState('state:confirm:active:request', payload);
    });

    // --- 2. EVENT Topics (Transient) ---

    this.subscribe(CoreEvent.Output, (p: OutputPayload) => {
      const content =
        typeof p.chunk === 'string'
          ? p.chunk
          : Buffer.from(p.chunk).toString(p.encoding || 'utf8');
      const payload: ChatStreamEvent = {
        chunk: content,
        isStderr: p.isStderr,
      };
      this.emit('event:chat:stream', payload);
    });

    this.subscribe(CoreEvent.ConsoleLog, (p: ConsoleLogPayload) => {
      const payload: ConsoleLogEvent = { type: p.type, content: p.content };
      this.emit('event:system:console', payload);
    });

    this.subscribe(CoreEvent.UserFeedback, (p: UserFeedbackPayload) => {
      const payload: FeedbackEvent = {
        severity: p.severity,
        message: p.message,
      };
      this.emit('event:system:feedback', payload);
    });

    this.subscribe(CoreEvent.HookStart, (p: HookStartPayload) => {
      const payload: HookStartEvent = {
        hookName: p.hookName,
        eventName: p.eventName,
        index: p.hookIndex,
        total: p.totalHooks,
      };
      this.emit('event:system:hook:start', payload);
    });

    this.subscribe(CoreEvent.HookEnd, (p: HookEndPayload) => {
      const payload: HookEndEvent = {
        hookName: p.hookName,
        eventName: p.eventName,
        success: p.success,
      };
      this.emit('event:system:hook:end', payload);
    });

    this.subscribe(CoreEvent.McpProgress, (p: McpProgressPayload) => {
      const payload: McpProgressEvent = {
        server: p.serverName,
        message: p.message,
        progress: p.progress,
        total: p.total,
      };
      this.emit('event:system:mcp:progress', payload);
    });

    this.subscribe(CoreEvent.RetryAttempt, (p: RetryAttemptPayload) => {
      const payload: RetryAttemptEvent = {
        attempt: p.attempt,
        maxAttempts: p.maxAttempts,
        model: p.model,
      };
      this.emit('event:system:retry', payload);
    });

    this.subscribe(CoreEvent.OauthDisplayMessage, (message: string) => {
      const payload: OauthMessageEvent = { message };
      this.emit('event:auth:oauth_message', payload);
    });

    this.subscribe(CoreEvent.RequestEditorSelection, () =>
      this.emit('event:editor:request_selection', {}),
    );

    this.subscribe(
      CoreEvent.SlashCommandConflicts,
      (p: SlashCommandConflictsPayload) => {
        const payload: SlashConflictsEvent = { conflicts: p.conflicts };
        this.emit('event:system:slash_conflicts', payload);
      },
    );

    this.subscribe(CoreEvent.ExternalEditorClosed, () =>
      this.emit('event:system:editor_closed', {}),
    );
  }

  /**
   * Handles stateful topics by comparing with cache.
   */
  private handleState(topic: string, payload: unknown): void {
    const serialized = JSON.stringify(payload);
    if (this.stateCache.get(topic) === serialized) {
      return;
    }
    this.stateCache.set(topic, serialized);
    this.emit(topic, payload);
  }

  /**
   * Emits the transposed event via callback.
   */
  private emit(topic: string, payload: unknown): void {
    if (this.onEmitCallback) {
      this.onEmitCallback({ topic, payload });
    }
  }

  /**
   * Clean up listeners.
   */
  dispose(): void {
    for (const h of this.handlers) {
      this.coreEvents.off(h.event, h.handler);
    }
    this.handlers.length = 0;
  }
}
