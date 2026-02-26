/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useCallback } from 'react';
import {
  RemoteApiService,
  RemoteMessageType,
  type SystemStatus,
  type RemoteSuggestion,
} from '../../services/RemoteApiService.js';
import { type HistoryItem } from '../types.js';
import type { UIState } from '../contexts/UIStateContext.js';
import type { UIActions } from '../contexts/UIActionsContext.js';
import {
  type Config,
  coreEvents,
  ShellExecutionService,
  debugLogger,
  AuthType,
  CoreToolCallStatus,
  type ApprovalMode,
} from '@google/gemini-cli-core';
import { useSettings } from '../contexts/SettingsContext.js';
import { SettingScope } from '../../config/settings.js';
import { glob } from 'glob';
import { execSync } from 'node:child_process';
import os from 'node:os';
import { type EventEmitter } from 'node:events';
import { type WebSocket } from 'ws';

export function useRemoteApi(
  uiState: UIState,
  uiActions: UIActions,
  config: Config,
) {
  const remoteApiRef = useRef<RemoteApiService | null>(null);
  const settings = useSettings();
  const lastHistoryLength = useRef(uiState.history.length);

  const uiActionsRef = useRef(uiActions);
  const uiStateRef = useRef(uiState);

  useEffect(() => {
    uiActionsRef.current = uiActions;
    uiStateRef.current = uiState;
  }, [uiActions, uiState]);

  const getGitBranch = useCallback((): string | null => {
    try {
      return execSync('git rev-parse --abbrev-ref HEAD', {
        stdio: ['ignore', 'pipe', 'ignore'],
        cwd: process.cwd(),
      })
        .toString()
        .trim();
    } catch (_error: unknown) {
      return null;
    }
  }, []);

  const getSystemStatus = useCallback((): SystemStatus => {
    const state = uiStateRef.current;
    const mcpItem = state.history.findLast(
      (item): item is HistoryItem & { type: 'mcp_status' } =>
        item.type === 'mcp_status',
    );
    const skillsItem = state.history.findLast(
      (item): item is HistoryItem & { type: 'skills_list' } =>
        item.type === 'skills_list',
    );
    const tokens = state.sessionStats.lastPromptTokenCount || 0;

    return {
      model: state.currentModel,
      ramUsage: `${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)} MB`,
      contextTokens: tokens,
      geminiMdFileCount: state.geminiMdFileCount,
      skillsCount: skillsItem?.skills.length ?? 0,
      mcpServers: Object.entries(mcpItem?.servers ?? {}).map(([name, cfg]) => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        const cfgObj = cfg as unknown as Record<string, unknown>;
        const isEnabled = cfgObj['enabled'] === true;
        return {
          name,
          status: isEnabled ? 'connected' : 'disabled',
        };
      }),
      cwd: process.cwd(),
      gitBranch: getGitBranch(),
      platform: os.platform(),
    };
  }, [getGitBranch]);

  useEffect(() => {
    const isEnabled =
      process.env['GEMINI_REMOTE_ENABLED'] === 'true' ||
      (settings.merged.remote?.enabled ?? false);
    const port =
      Number(process.env['GEMINI_REMOTE_PORT']) ||
      (settings.merged.remote?.port ?? 8080);

    if (isEnabled && !remoteApiRef.current) {
      const service = new RemoteApiService(port);
      remoteApiRef.current = service;

      service.on('client_connected', () => {
        debugLogger.log(
          'Remote client connected, waiting for version handshake...',
        );
      });

      service.on('session_state_request', (ws: WebSocket) => {
        const clientVersion = service.getClientVersion(ws);
        debugLogger.log(`Handshake received. Client version: ${clientVersion}`);

        const activePtyId = uiStateRef.current.activePtyId ?? null;
        const commands = (uiStateRef.current.slashCommands ?? []).map(
          (cmd) => ({
            name: cmd.name,
            description: cmd.description || '',
          }),
        );

        const fullHistory = uiStateRef.current.history;
        const initialHistory =
          clientVersion >= 1 ? fullHistory.slice(-50) : fullHistory;

        service.sendToClient(ws, {
          type: RemoteMessageType.SESSION_INIT,
          payload: {
            apiVersion: 1,
            sessionId: config.getSessionId(),
            history: initialHistory,
            config: {
              model: uiStateRef.current.currentModel,
              approvalMode: uiStateRef.current.showApprovalModeIndicator,
            },
            streamingState: uiStateRef.current.streamingState,
            activePtyId,
            shellHistory: null,
            status: getSystemStatus(),
            commands,
            authState: uiStateRef.current.isAuthenticating
              ? 'authenticating'
              : 'authenticated',
          },
        });
      });

      service.on('history_request', (offset: number, limit: number) => {
        const fullHistory = uiStateRef.current.history;
        const total = fullHistory.length;
        const start = Math.max(0, total - offset - limit);
        const end = total - offset;
        const items = fullHistory.slice(start, end);

        remoteApiRef.current?.broadcast({
          type: RemoteMessageType.HISTORY_RESPONSE,
          payload: { items, offset, limit, total },
        });
      });

      service.on('send_prompt', (text: string) => {
        const actions = uiActionsRef.current;
        if (actions && typeof actions.handleFinalSubmit === 'function') {
          void actions.handleFinalSubmit(text);
        }
      });

      service.on('stop_generation', () => {
        debugLogger.log(
          'Stop generation requested but not implemented in UIActions yet',
        );
      });

      service.on('shell_input', (text: string) => {
        const pid = uiStateRef.current.activePtyId;
        if (pid) ShellExecutionService.writeToPty(pid, text);
      });

      service.on('auth_submit', (method?: string, apiKey?: string) => {
        const actions = uiActionsRef.current;
        if (method === 'google') {
          actions.handleAuthSelect(
            AuthType.LOGIN_WITH_GOOGLE,
            SettingScope.User,
          );
        } else if (method === 'api_key' && apiKey) {
          actions.handleAuthSelect(AuthType.USE_GEMINI, SettingScope.User);
          void actions.handleApiKeySubmit(apiKey);
        } else if (apiKey) {
          void actions.handleApiKeySubmit(apiKey);
        }
      });

      service.on(
        'search_request',
        async (query: string, type: 'at' | 'slash') => {
          if (type === 'at') {
            try {
              const files = await glob(`${query}*`, {
                cwd: process.cwd(),
                mark: true,
                maxDepth: 2,
              });
              const suggestions: RemoteSuggestion[] = files.map((f) => ({
                label: f,
                value: f,
                type: f.endsWith('/') ? 'folder' : 'file',
              }));
              service.broadcast({
                type: RemoteMessageType.SEARCH_RESPONSE,
                payload: { query, suggestions },
              });
            } catch (_e: unknown) {
              debugLogger.log(`Search error: ${String(_e)}`);
            }
          } else {
            const commands = (uiStateRef.current.slashCommands ?? [])
              .filter((c) => c.name.startsWith(query.replace('/', '')))
              .map((c) => ({
                label: c.name,
                value: `/${c.name}`,
                description: c.description || '',
                type: 'command' as const,
              }));
            service.broadcast({
              type: RemoteMessageType.SEARCH_RESPONSE,
              payload: { query, suggestions: commands },
            });
          }
        },
      );

      service.on('resize_terminal', (cols: number, rows: number) => {
        const pid = uiStateRef.current.activePtyId;
        if (pid) ShellExecutionService.resizePty(pid, cols, rows);
      });

      service.on('set_config', (approvalMode?: ApprovalMode) => {
        const actions = uiActionsRef.current;
        if (approvalMode && actions) {
          void actions.handleFinalSubmit(`/${approvalMode.toLowerCase()}`);
        }
      });

      service.on(
        'confirmation_response',
        (_id: number, confirmed: boolean, choice?: string) => {
          const state = uiStateRef.current;
          if (state.commandConfirmationRequest) {
            state.commandConfirmationRequest.onConfirm(confirmed);
          } else if (state.authConsentRequest) {
            state.authConsentRequest.onConfirm(confirmed);
          } else if (
            state.loopDetectionConfirmationRequest &&
            (choice === 'disable' || choice === 'keep')
          ) {
            state.loopDetectionConfirmationRequest.onComplete({
              userSelection: choice,
            });
          }
        },
      );

      service.start();
    }

    return () => {
      remoteApiRef.current?.stop();
      remoteApiRef.current = null;
    };
  }, [
    config,
    settings.merged.remote?.enabled,
    settings.merged.remote?.port,
    getSystemStatus,
  ]);

  // Sync History
  useEffect(() => {
    if (uiState.history.length > lastHistoryLength.current) {
      const newItems = uiState.history.slice(lastHistoryLength.current);
      newItems.forEach((item: HistoryItem) => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        const itemWithType = item as unknown as Record<string, unknown>;
        const type = itemWithType['type'];
        if (
          typeof type === 'string' &&
          (type.includes('tool_call') || type === 'tool_group')
        ) {
          remoteApiRef.current?.broadcast({
            type: RemoteMessageType.HISTORY_UPDATE,
            payload: { item },
          });
        } else {
          remoteApiRef.current?.broadcastHistoryUpdate(item);
        }
      });
    }
    lastHistoryLength.current = uiState.history.length;
  }, [uiState.history]);

  // Reactive Status Updates
  useEffect(() => {
    if (remoteApiRef.current) {
      remoteApiRef.current.broadcast({
        type: RemoteMessageType.STATUS_UPDATE,
        payload: getSystemStatus(),
      });
    }
  }, [
    uiState.currentModel,
    uiState.geminiMdFileCount,
    uiState.sessionStats.lastPromptTokenCount,
    uiState.history.length,
    uiState.streamingState,
    uiState.activePtyId,
    getSystemStatus,
  ]);

  // Tool Call Interceptor
  useEffect(() => {
    const handleToolCall = (event: {
      name: string;
      args: Record<string, unknown>;
      status?: string;
      callId?: string;
    }) => {
      const item: HistoryItem = {
        id: Date.now(),
        type: 'tool_group',
        tools: [
          {
            callId: event.callId || `remote-${Date.now()}`,
            name: event.name,
            args: event.args,
            status:
              // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
              (event.status as unknown as CoreToolCallStatus) ||
              CoreToolCallStatus.Executing,
            description: `Executing ${event.name}...`,
            resultDisplay: undefined,
            confirmationDetails: undefined,
          },
        ],
      };
      remoteApiRef.current?.broadcast({
        type: RemoteMessageType.HISTORY_UPDATE,
        payload: { item },
      });
    };
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const events = coreEvents as unknown as Record<string, unknown>;
    if (
      typeof events['on'] === 'function' &&
      typeof events['off'] === 'function'
    ) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      (events as unknown as EventEmitter).on('tool_call', handleToolCall);
      return () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        (events as unknown as EventEmitter).off('tool_call', handleToolCall);
      };
    }
    return;
  }, []);

  // Sync Streaming State
  useEffect(() => {
    remoteApiRef.current?.broadcastStreamingState(uiState.streamingState);
  }, [uiState.streamingState]);

  // Sync Auth State
  useEffect(() => {
    remoteApiRef.current?.broadcast({
      type: RemoteMessageType.AUTH_UPDATE,
      payload: {
        state: uiState.isAuthenticating ? 'authenticating' : 'authenticated',
        error: uiState.authError,
      },
    });
  }, [uiState.isAuthenticating, uiState.authError]);

  // Sync Confirmation Requests
  useEffect(() => {
    if (uiState.commandConfirmationRequest && remoteApiRef.current) {
      remoteApiRef.current.broadcast({
        type: RemoteMessageType.CONFIRMATION_REQUEST,
        payload: {
          id: Date.now(),
          // Prompt is ReactNode, so we send a generic message for now
          // Ideally we should extract the text or diff from it
          prompt: 'Confirmation required for tool execution',
          type: 'tool_approval',
        },
      });
    }
  }, [uiState.commandConfirmationRequest]);

  // Proxy shell output
  useEffect(() => {
    const pid = uiState.activePtyId;
    if (!pid) return;
    const unsubscribe = ShellExecutionService.subscribe(pid, (event) => {
      if (event.type === 'data') {
        remoteApiRef.current?.broadcastShellOutput(event.chunk);
      }
    });
    return unsubscribe;
  }, [uiState.activePtyId]);

  return remoteApiRef.current;
}
