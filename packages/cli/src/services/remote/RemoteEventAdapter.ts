/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import {
  type CoreEventEmitter,
  CoreEvent,
  debugLogger,
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
  uiTelemetryService,
  spawnAsync,
  tokenLimit,
  isActiveModel,
  getDisplayString,
  AuthType,
  UserAccountManager,
} from '@google/gemini-cli-core';

import { computeSessionStats } from '../../ui/utils/computeStats.js';

import {
  appEvents,
  AppEvent,
  type LoadingUpdatePayload,
} from '../../utils/events.js';
import type {
  AgentsState,
  ChatStreamEvent,
  ChatThoughtEvent,
  ConsoleLogEvent,
  EditorState,
  FeedbackEvent,
  GitBranchState,
  HookEndEvent,
  HookStartEvent,
  LoadingElapsedState,
  LoadingPhraseState,
  McpProgressEvent,
  McpServersState,
  MemoryState,
  ModelState,
  OauthMessageEvent,
  ProjectInfoState,
  QuotaState,
  RamHeapTotalState,
  RamHeapUsedState,
  RamRssState,
  RecentFeedbacksState,
  RetryAttemptEvent,
  SessionIdState,
  SessionStatus,
  SettingsHashState,
  SlashConflictsEvent,
  StatsFullResponse,
  ModelStats,
  TokensLimitState,
  TokensTotalState,
  TransientMessageEvent,
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
  private readonly recentFeedbacks: FeedbackEvent[] = [];
  private onEmitCallback?: (message: RemoteEventMessage) => void;
  private readonly unsubscribeFunctions: Array<() => void> = [];
  private activeHooksCount = 0;
  private isGenerating = false;
  private readonly startTime: number = Date.now();
  private readonly projectRoot: string;
  private gitWatcher?: fs.FSWatcher;
  private readonly sessionChangedListener: (newId: string) => void;
  private readonly transientMessageListener: (payload: {
    message: string;
    type: string;
  }) => void;
  private readonly loadingUpdateListener: (
    payload: LoadingUpdatePayload,
  ) => void;
  private agentsInitTimer?: NodeJS.Timeout;

  constructor(
    private readonly coreEvents: CoreEventEmitter,
    private readonly config: Config,
    private geminiSessionId?: string,
    initialFeedbacks?: FeedbackEvent[],
  ) {
    this.projectRoot = process.cwd();
    if (initialFeedbacks) {
      // Seed the buffer with startup warnings
      for (const fb of initialFeedbacks) {
        if (
          !this.recentFeedbacks.some(
            (existing) => existing.message === fb.message,
          )
        ) {
          this.recentFeedbacks.push(fb);
        }
      }
    }
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
      this.recentFeedbacks.length = 0;
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

    this.transientMessageListener = (payload) => {
      const eventPayload: TransientMessageEvent = {
        message: payload.message,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        type: payload.type as 'warning' | 'hint',
      };
      this.emit('event:system:transient_message', eventPayload);
    };
    appEvents.on(AppEvent.TransientMessage, this.transientMessageListener);

    this.loadingUpdateListener = (payload) => {
      // 1. Update overall session status based on loading indicator (Source of Truth)
      let agentStatus: SessionStatus = 'idle';
      if (payload.status === 'responding') {
        agentStatus = 'generating';
      } else if (payload.status === 'waiting') {
        agentStatus = 'busy';
      }
      this.handleState('state:session:status', { status: agentStatus });

      // 2. Emit loading phrase (deduplicated by handleState)
      this.handleState('state:system:loading_phrase', {
        phrase: payload.phrase || null,
      } as LoadingPhraseState);

      // 3. Emit elapsed time (every second)
      this.handleState('state:system:loading_elapsed', {
        elapsed: payload.elapsedTime,
      } as LoadingElapsedState);
    };
    appEvents.on(AppEvent.LoadingUpdate, this.loadingUpdateListener);
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
   * Explicitly sets the generating state.
   */
  setGenerating(value: boolean): void {
    this.isGenerating = value;
    this.updateStatus();
  }

  /**
 * Explicitly emits the current settings hash.
...
   * If a hash is provided (e.g., from a client's set action), it is used.
   * Otherwise, a new unique hash is generated.
   */
  emitSettingsHash(hash?: string): void {
    const nextHash = hash || randomUUID();
    this.handleState('state:session:settings:hash', {
      hash: nextHash,
    } as SettingsHashState);
  }

  /**
   * Zeros out state and fetches current values from config/core.
   */
  emitInitialStates(): void {
    // 1. Model
    const model = this.config.getModel();
    if (model) {
      this.handleState('state:session:model', { model } as ModelState);
      this.handleState('state:system:tokens:limit', {
        limit: tokenLimit(model),
      } as TokensLimitState);
    }

    // 2. RAM Usage
    this.emitRamUsage();

    // 2.5. Settings Hash
    this.emitSettingsHash();

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
    this.tryEmitAgents();

    // 5. Project Info
    this.emitProjectInfo();

    // 6. Git Branch
    void this.fetchGitBranch();
  }
  /**
   * Tries to emit agents. If registry is not ready, starts a timer to retry.
   */
  private tryEmitAgents(): void {
    const agentRegistry = this.config.getAgentRegistry();
    if (agentRegistry) {
      const agents = agentRegistry.getAllDefinitions();
      this.handleState('state:system:agents', {
        agents: agents.map((a) => ({
          name: a.name,
          displayName: a.displayName,
          description: a.description,
          kind: a.kind,
        })),
      } as AgentsState);

      if (this.agentsInitTimer) {
        clearInterval(this.agentsInitTimer);
        this.agentsInitTimer = undefined;
      }
    } else if (!this.agentsInitTimer) {
      this.agentsInitTimer = setInterval(() => this.tryEmitAgents(), 1000);
    }
  }

  /**
   * Explicitly emits current RAM usage.
   * Called by RemoteApiService on a periodic timer.
   */
  emitRamUsage(): void {
    const usage = process.memoryUsage();

    this.handleState('state:system:ram:rss', {
      rss: usage.rss,
    } as RamRssState);

    this.handleState('state:system:ram:heap_total', {
      heapTotal: usage.heapTotal,
    } as RamHeapTotalState);

    this.handleState('state:system:ram:heap_used', {
      heapUsed: usage.heapUsed,
    } as RamHeapUsedState);
  }

  /**
   * Type-safe internal helper to subscribe and track handlers.
   */
  private subscribe<K extends keyof CoreEvents>(
    event: K,
    handler: (...args: CoreEvents[K]) => void,
  ): void {
    const wrappedHandler = (...args: unknown[]) => {
      if (event === CoreEvent.HookStart || event === CoreEvent.McpProgress) {
        debugLogger.debug(`[RemoteEventAdapter] RECV event: ${String(event)}`);
      }
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      (handler as (...args: unknown[]) => void)(...args);
    };

    // @ts-expect-error - EventEmitter generic types are complex to match exactly in a generic method
    this.coreEvents.on(event, wrappedHandler);

    this.unsubscribeFunctions.push(() => {
      // @ts-expect-error - EventEmitter generic types are complex
      this.coreEvents.off(event, wrappedHandler);
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
      this.emit('event:system:agents:refresh', {}),
    );

    this.subscribe(CoreEvent.ModelChanged, (p: ModelChangedPayload) => {
      const payload: ModelState = { model: p.model };
      this.handleState('state:session:model', payload);
      this.handleState('state:system:tokens:limit', {
        limit: tokenLimit(p.model),
      } as TokensLimitState);
    });

    this.subscribe(CoreEvent.SettingsChanged, () => {
      this.emitSettingsHash();
    });

    this.subscribe(CoreEvent.EditorSelected, (p: EditorSelectedPayload) => {
      const payload: EditorState = { editor: p.editor };
      this.handleState('state:session:editor', payload);
    });

    // --- 1.5 Telemetry & System state ---

    const telemetryHandler = () => {
      const metrics = uiTelemetryService.getMetrics();
      const lastTokens = uiTelemetryService.getLastPromptTokenCount();

      // Aggregate tokens across all models for real-time context bar
      let grandTotal = 0;
      const modelKeys = Object.keys(metrics.models);

      for (const key of modelKeys) {
        const m = metrics.models[key];
        grandTotal += m.tokens.total;
      }

      if (grandTotal > 0) {
        this.handleState('state:system:tokens:total', {
          total: grandTotal,
        } as TokensTotalState);
      } else if (lastTokens > 0) {
        this.handleState('state:system:tokens:total', {
          total: lastTokens,
        } as TokensTotalState);
      }
    };

    uiTelemetryService.on('update', telemetryHandler);
    this.unsubscribeFunctions.push(() => {
      uiTelemetryService.off('update', telemetryHandler);
    });

    this.setupGitWatcher();

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

    this.subscribe(CoreEvent.Thought, (p: ThoughtPayload) => {
      this.isGenerating = true;
      this.updateStatus();

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

      // Store in recent list for late-connecting clients
      if (!this.recentFeedbacks.some((f) => f.message === payload.message)) {
        this.recentFeedbacks.push(payload);
        if (this.recentFeedbacks.length > 20) {
          this.recentFeedbacks.shift();
        }
      }

      this.emit('event:system:feedback', payload);
      this.handleState('state:system:recent_feedbacks', {
        feedbacks: this.recentFeedbacks,
      } as RecentFeedbacksState);
    });

    this.setupGitWatcher();

    this.subscribe(CoreEvent.HookStart, (p: HookStartPayload) => {
      this.activeHooksCount++;
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

    // Ensure we process any queued events that happened during initialization
    if (
      typeof (this.coreEvents as { drainBacklogs?: () => void })
        .drainBacklogs === 'function'
    ) {
      (this.coreEvents as { drainBacklogs: () => void }).drainBacklogs();
    }
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
    if (this.agentsInitTimer) {
      clearInterval(this.agentsInitTimer);
      this.agentsInitTimer = undefined;
    }
    for (const unsubscribe of this.unsubscribeFunctions) {
      unsubscribe();
    }
    this.unsubscribeFunctions.length = 0;
    appEvents.off(AppEvent.SessionChanged, this.sessionChangedListener);
    appEvents.off(AppEvent.TransientMessage, this.transientMessageListener);
    appEvents.off(AppEvent.LoadingUpdate, this.loadingUpdateListener);
    this.gitWatcher?.close();
  }

  private emitProjectInfo(): void {
    const payload: ProjectInfoState = {
      name: path.basename(this.projectRoot),
      path: this.projectRoot,
    };
    this.handleState('state:system:project_info', payload);
  }

  private async fetchGitBranch(): Promise<void> {
    try {
      const { stdout } = await spawnAsync(
        'git',
        ['rev-parse', '--abbrev-ref', 'HEAD'],
        { cwd: this.projectRoot },
      );
      const branch = stdout.toString().trim();
      const payload: GitBranchState = {
        branch: branch && branch !== 'HEAD' ? branch : null,
      };
      this.handleState('state:system:git_branch', payload);
    } catch (_error) {
      this.handleState('state:system:git_branch', { branch: null });
    }
  }

  private setupGitWatcher(): void {
    const gitLogsHeadPath = path.join(this.projectRoot, '.git', 'logs', 'HEAD');

    const startWatcher = async () => {
      try {
        await fsPromises.access(gitLogsHeadPath, fs.constants.F_OK);
        this.gitWatcher = fs.watch(gitLogsHeadPath, (eventType) => {
          if (eventType === 'change' || eventType === 'rename') {
            void this.fetchGitBranch();
          }
        });
      } catch (_error) {
        // No git repo or logs/HEAD not accessible
      }
    };

    void startWatcher();
    void this.fetchGitBranch();
  }

  /**
   * Generates a full session stats report.
   */
  async getSessionStats(correlationId: string): Promise<StatsFullResponse> {
    const quota = await this.config.refreshUserQuota();
    try {
      await this.config.refreshAvailableCredits();
    } catch (e) {
      debugLogger.debug('[RemoteStats] Failed to force refresh credits:', e);
    }

    const metrics = uiTelemetryService.getMetrics();
    const buckets = quota?.buckets || [];
    const modelStats: ModelStats[] = [];

    const useGemini3_1 = this.config.getGemini31LaunchedSync?.() ?? false;
    const generatorConfig = this.config.getContentGeneratorConfig?.();
    const useCustomToolModel =
      useGemini3_1 && generatorConfig?.authType === AuthType.USE_GEMINI;

    const getBaseModelName = (name: string) => name.replace('-001', '');
    const usedModelNames = new Set(
      Object.keys(metrics.models).map(getBaseModelName).map(getDisplayString),
    );

    // 1. Models with active usage
    for (const [name, m] of Object.entries(metrics.models)) {
      const modelBaseName = getBaseModelName(name);
      const bucket = buckets.find((b) => b.modelId === modelBaseName);

      const stats: ModelStats = {
        model: getDisplayString(modelBaseName),
        requests: m.api.totalRequests,
        inputTokens: m.tokens.input,
        outputTokens: m.tokens.candidates,
        cacheReads: m.tokens.cached,
      };

      if (bucket && bucket.remainingFraction != null) {
        const resetDate = bucket.resetTime
          ? new Date(bucket.resetTime)
          : undefined;
        const isValidDate = resetDate && !isNaN(resetDate.getTime());

        let resetSeconds: number | undefined;
        if (isValidDate) {
          resetSeconds = Math.max(
            0,
            Math.floor((resetDate.getTime() - Date.now()) / 1000),
          );
        }

        stats.quota = {
          percentage: Math.round((1 - bucket.remainingFraction) * 100),
          resetSeconds,
        };
      }

      modelStats.push(stats);
    }

    // 2. Models with quota only (not yet used)
    const quotaOnlyBuckets = buckets.filter(
      (b) =>
        b.modelId &&
        isActiveModel(b.modelId, useGemini3_1, useCustomToolModel) &&
        !usedModelNames.has(getDisplayString(b.modelId)),
    );

    for (const bucket of quotaOnlyBuckets) {
      if (!bucket.modelId || bucket.remainingFraction == null) continue;

      const resetDate = bucket.resetTime
        ? new Date(bucket.resetTime)
        : undefined;
      const isValidDate = resetDate && !isNaN(resetDate.getTime());

      let resetSeconds: number | undefined;
      if (isValidDate) {
        resetSeconds = Math.max(
          0,
          Math.floor((resetDate.getTime() - Date.now()) / 1000),
        );
      }

      modelStats.push({
        model: getDisplayString(bucket.modelId),
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReads: 0,
        quota: {
          percentage: Math.round((1 - bucket.remainingFraction) * 100),
          resetSeconds,
        },
      });
    }

    // 3. Session Summary
    const computed = computeSessionStats(metrics);
    const wallTimeSeconds = Math.floor((Date.now() - this.startTime) / 1000);

    const userAccountManager = new UserAccountManager();
    const cachedAccount = userAccountManager.getCachedGoogleAccount();
    const userEmail = cachedAccount ?? undefined;

    const tier = this.config.getUserTierName();
    const authMethod = generatorConfig?.authType || 'unknown';

    const summary = {
      sessionId: this.geminiSessionId || 'unknown',
      authMethod,
      userEmail,
      tier,
      toolCalls: {
        total: metrics.tools.totalCalls,
        success: metrics.tools.totalSuccess,
        fail: metrics.tools.totalFail,
      },
      successRate: computed.successRate,
      wallTimeSeconds,
      agentActiveSeconds: Math.floor(computed.agentActiveTime / 1000),
      apiTimeSeconds: Math.floor(computed.totalApiTime / 1000),
      toolTimeSeconds: Math.floor(computed.totalToolTime / 1000),
    };

    return {
      type: 'response:stats:full',
      correlationId,
      models: modelStats,
      summary,
    };
  }
}
