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
  type McpProgressPayload,
  type AgentsDiscoveredPayload,
  type SlashCommandConflictsPayload,
  type QuotaChangedPayload,
  type EditorSelectedPayload,
  type ThoughtPayload,
  type CoreEvents,
  type Config,
} from '@google/gemini-cli-core';
import { appEvents, AppEvent } from '../../utils/events.js';
import type {
  AgentsState,
  ChatStreamEvent,
  ChatThoughtEvent,
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
  SessionStatus,
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
 * Adapter to translate internal CoreEvents into Remote API topics.
 * Performs explicit mapping to stable "Simple Types" to ensure protocol stability.
 * Implements state-diffing to minimize traffic.
 */
export class RemoteEventAdapter {
  private readonly stateCache = new Map<string, string>();
  private onEmitCallback?: (message: RemoteEventMessage) => void;
  private readonly unsubscribeFunctions: Array<() => void> = [];
  private activeHooksCount = 0;
  private isGenerating = false;
  private readonly sessionChangedListener: (newId: string) => void;

  constructor(
    private readonly coreEvents: CoreEventEmitter,
    private readonly config: Config,
    private geminiSessionId?: string,
  ) {
    this.setupSubscriptions();
    if (this.geminiSessionId) {
      this.handleState('state:session:id', {
        id: this.geminiSessionId,
      } as SessionIdState);
    }

    this.updateStatus();

    // Listen to session changes from the UI (e.g., /resume)
    this.sessionChangedListener = (newId) => {
      // 1. Clear state cache to prevent leaking state between sessions
      this.stateCache.clear();

      this.geminiSessionId = newId;
      this.handleState('state:session:id', {
        id: newId,
      } as SessionIdState);

      // 2. Re-emit initial status
      this.activeHooksCount = 0;
      this.isGenerating = false;
      this.updateStatus();

      // 3. Re-emit initial states for the new session
      this.emitInitialStates();
    };
    appEvents.on(AppEvent.SessionChanged, this.sessionChangedListener);
  }

  private updateStatus(): void {
    let status: SessionStatus = 'idle';
    if (this.activeHooksCount > 0) {
      status = 'busy';
    } else if (this.isGenerating) {
      status = 'generating';
    }
    this.handleState('state:session:status', { status });
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
    // Also emit all current states to the newly connected callback
    this.emitInitialStates();
  }

  /**
   * Zeros out state and fetches current values from config/core.
   */
  emitInitialStates(): void {
    // 1. Model
    const model = this.config.getModel();
    if (model) {
      this.handleState('state:session:model', { model } as ModelState);
    }

    // 2. RAM Usage
    this.emitRamUsage();

    // 3. MCP Servers
    const mcpClientManager = this.config.getMcpClientManager();
    if (mcpClientManager) {
      const mcpServers = mcpClientManager.getMcpServers();
      if (mcpServers) {
        this.handleState('state:system:mcp:servers', {
          servers: Object.keys(mcpServers),
        } as McpServersState);
      }
    }

    // 4. Agents
    const agents = this.config.getAgentRegistry().getAllDefinitions();
    this.handleState('state:system:agents', {
      agents: agents.map((a) => ({
        name: a.name,
        displayName: a.displayName,
        description: a.description,
        kind: a.kind,
      })),
    } as AgentsState);
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
    this.unsubscribeFunctions.push(() => {
      // @ts-expect-error - EventEmitter generic types are complex
      this.coreEvents.off(event, handler);
    });
  }

  /**
   * Subscribes to all relevant core events and maps them to stable protocol types.
   */
  private setupSubscriptions(): void {
    // --- 1. STATE Topics (Stateful) ---

    this.subscribe(CoreEvent.QuotaChanged, (p: QuotaChangedPayload) => {
      const payload: QuotaState = {
        remaining: p.remaining ?? 0,
        limit: p.limit ?? 0,
        resetTime: p.resetTime,
      };
      this.handleState('state:system:quota', payload);
    });

    this.subscribe(CoreEvent.MemoryChanged, (p: MemoryChangedPayload) => {
      const payload: MemoryState = { fileCount: p.fileCount };
      this.handleState('state:system:memory', payload);
    });

    this.subscribe(CoreEvent.McpClientUpdate, (servers: unknown) => {
      let serverKeys: string[] = [];
      if (servers instanceof Map) {
        serverKeys = Array.from(servers.keys()).map((k) => String(k));
      } else if (this.isObject(servers)) {
        serverKeys = Object.keys(servers);
      }
      const payload: McpServersState = {
        servers: serverKeys,
      };
      this.handleState('state:system:mcp:servers', payload);
    });

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

    this.subscribe(CoreEvent.EditorSelected, (p: EditorSelectedPayload) => {
      const payload: EditorState = { editor: p.editor };
      this.handleState('state:session:editor', payload);
    });

    // --- 2. EVENT Topics (Transient) ---

    this.subscribe(CoreEvent.Output, (p: OutputPayload) => {
      this.isGenerating = true;
      this.updateStatus();

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

    this.subscribe(CoreEvent.Thought, (p: ThoughtPayload) => {
      const payload: ChatThoughtEvent = {
        subject: p.thought.subject,
        description: p.thought.description,
      };
      this.emit('event:chat:thought', payload);
    });

    this.subscribe(CoreEvent.Finished, () => {
      this.isGenerating = false;
      this.updateStatus();
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
      this.activeHooksCount++;
      this.isGenerating = false;
      this.updateStatus();

      const payload: HookStartEvent = {
        hookName: p.hookName,
        eventName: p.eventName,
        index: p.hookIndex,
        total: p.totalHooks,
      };
      this.emit('event:system:hook:start', payload);
    });

    this.subscribe(CoreEvent.HookEnd, (p: HookEndPayload) => {
      this.activeHooksCount = Math.max(0, this.activeHooksCount - 1);
      this.updateStatus();

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
        message: p.message || '',
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
        const payload: SlashConflictsEvent = {
          conflicts: p.conflicts.map((c: unknown) => {
            if (typeof c === 'string') return c;
            if (this.isObject(c)) {
              const name = c['name'];
              if (typeof name === 'string') return name;
            }
            return String(c);
          }),
        };
        this.emit('event:system:slash_conflicts', payload);
      },
    );

    this.subscribe(CoreEvent.ExternalEditorClosed, () =>
      this.emit('event:system:editor_closed', {}),
    );
  }

  /**
   * Public interface to emit state changes via this adapter.
   * Useful for topics managed by other services (like confirmations).
   */
  emitState(topic: string, payload: unknown): void {
    this.handleState(topic, payload);
  }

  /**
   * Handles stateful topics by comparing with cache.
   */
  private handleState(topic: string, payload: unknown): void {
    if (payload === null) {
      this.stateCache.delete(topic);
      this.emit(topic, null);
      return;
    }
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
   * Returns the cached state for a topic.
   */
  getState(topic: string): unknown | undefined {
    const serialized = this.stateCache.get(topic);
    return serialized ? JSON.parse(serialized) : undefined;
  }

  private isObject(val: unknown): val is Record<string, unknown> {
    return typeof val === 'object' && val !== null;
  }

  /**
   * Clean up listeners.
   */
  dispose(): void {
    for (const unsubscribe of this.unsubscribeFunctions) {
      unsubscribe();
    }
    this.unsubscribeFunctions.length = 0;
    appEvents.off(AppEvent.SessionChanged, this.sessionChangedListener);
  }
}
