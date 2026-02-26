/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef } from 'react';
import {
  RemoteApiService,
  RemoteMessageType,
  type SystemStatus,
  type RemoteSuggestion,
} from '../../services/RemoteApiService.js';
import type { HistoryItem } from '../types.js';
import type { UIState } from '../contexts/UIStateContext.js';
import type { UIActions } from '../contexts/UIActionsContext.js';
import {
  type Config,
  coreEvents,
  ShellExecutionService,
  debugLogger,
  AuthType,
} from '@google/gemini-cli-core';
import { useSettings } from '../contexts/SettingsContext.js';
import { SettingScope } from '../../config/settings.js';
import { glob } from 'glob';

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

  const getSystemStatus = (): SystemStatus => {
    const state = uiStateRef.current;
    const mcpItem = state.history.findLast((item): item is HistoryItem & { type: 'mcp_status' } => item.type === 'mcp_status');
    const skillsItem = state.history.findLast((item): item is HistoryItem & { type: 'skills_list' } => item.type === 'skills_list');
    const tokens = state.sessionStats.lastPromptTokenCount || 0;

    return {
      model: state.currentModel,
      ramUsage: `${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)} MB`,
      contextTokens: tokens,
      geminiMdFileCount: state.geminiMdFileCount,
      skillsCount: skillsItem?.skills.length ?? 0,
      mcpServers: Object.entries(mcpItem?.servers ?? {}).map(([name, cfg]) => ({
        name,
        status: (cfg as Record<string, unknown>)?.enabled ? 'connected' : 'disabled',
      })),
    };
  };

  useEffect(() => {
    const isEnabled = process.env['GEMINI_REMOTE_ENABLED'] === 'true' || (settings.merged.remote?.enabled ?? false);
    const port = Number(process.env['GEMINI_REMOTE_PORT']) || (settings.merged.remote?.port ?? 8080);

    if (isEnabled && !remoteApiRef.current) {
      const service = new RemoteApiService(port);
      remoteApiRef.current = service;

      service.on('client_connected', (ws) => {
        const activePtyId = uiStateRef.current.activePtyId ?? null;
        const commands = (uiStateRef.current.slashCommands ?? []).map((cmd) => ({
          name: cmd.name,
          description: cmd.description || '',
        }));

        service.sendToClient(ws, {
          type: RemoteMessageType.SESSION_INIT,
          payload: {
            sessionId: config.getSessionId(),
            history: uiStateRef.current.history,
            config: {
              model: uiStateRef.current.currentModel,
              approvalMode: uiStateRef.current.showApprovalModeIndicator,
            },
            streamingState: uiStateRef.current.streamingState,
            activePtyId,
            shellHistory: null,
            status: getSystemStatus(),
            commands,
            authState: uiStateRef.current.isAuthenticating ? 'authenticating' : 'authenticated',
          },
        });
      });

      service.on('session_state_request', () => {
        service.broadcast({
          type: RemoteMessageType.SESSION_INIT,
          payload: {
            sessionId: config.getSessionId(),
            history: uiStateRef.current.history,
            config: {
              model: uiStateRef.current.currentModel,
              approvalMode: uiStateRef.current.showApprovalModeIndicator,
            },
            streamingState: uiStateRef.current.streamingState,
            activePtyId: uiStateRef.current.activePtyId ?? null,
            shellHistory: null,
            status: getSystemStatus(),
            commands: [],
            authState: uiStateRef.current.isAuthenticating ? 'authenticating' : 'authenticated',
          },
        });
      });

      service.on('send_prompt', (text: string) => {
        const actions = uiActionsRef.current;
        if (actions && typeof actions.handleFinalSubmit === 'function') {
          void actions.handleFinalSubmit(text);
        }
      });

      service.on('stop_generation', () => {
        debugLogger.log('Stop generation requested via Remote API');
      });

      service.on('shell_input', (text: string) => {
        const pid = uiStateRef.current.activePtyId;
        if (pid) ShellExecutionService.writeToPty(pid, text);
      });

      service.on('auth_submit', (method?: string, apiKey?: string) => {
        const actions = uiActionsRef.current;
        if (method === 'google') {
          actions.handleAuthSelect(AuthType.LOGIN_WITH_GOOGLE, SettingScope.User);
        } else if (method === 'api_key' && apiKey) {
          actions.handleAuthSelect(AuthType.USE_GEMINI, SettingScope.User);
          void actions.handleApiKeySubmit(apiKey);
        } else if (apiKey) {
          void actions.handleApiKeySubmit(apiKey);
        }
      });

      service.on('search_request', async (query: string, type: 'at' | 'slash') => {
        if (type === 'at') {
          try {
            const files = await glob(`${query}*`, { cwd: process.cwd(), mark: true, maxDepth: 2 });
            const suggestions: RemoteSuggestion[] = files.map(f => ({
              label: f, value: f, type: f.endsWith('/') ? 'folder' : 'file'
            }));
            service.broadcast({ type: RemoteMessageType.SEARCH_RESPONSE, payload: { query, suggestions } });
          } catch (e) { debugLogger.log(`Search error: ${String(e)}`); }
        } else {
          const commands = (uiStateRef.current.slashCommands ?? [])
            .filter(c => c.name.startsWith(query.replace('/', '')))
            .map(c => ({ label: c.name, value: `/${c.name}`, description: c.description || '', type: 'command' as const }));
          service.broadcast({ type: RemoteMessageType.SEARCH_RESPONSE, payload: { query, suggestions: commands } });
        }
      });

      service.on('resize_terminal', (cols: number, rows: number) => {
        const pid = uiStateRef.current.activePtyId;
        if (pid) ShellExecutionService.resizePty(pid, cols, rows);
      });

      service.on('confirmation_response', (_id: number, confirmed: boolean, choice?: string) => {
        const state = uiStateRef.current;
        if (state.commandConfirmationRequest) {
          state.commandConfirmationRequest.onConfirm(confirmed);
        } else if (state.authConsentRequest) {
          state.authConsentRequest.onConfirm(confirmed);
        } else if (state.loopDetectionConfirmationRequest && (choice === 'disable' || choice === 'keep')) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          state.loopDetectionConfirmationRequest.onComplete({ userSelection: choice as 'disable' | 'keep' });
        }
      });

      service.start();
    }

    return () => {
      remoteApiRef.current?.stop();
      remoteApiRef.current = null;
    };
  }, [config, settings.merged.remote?.enabled, settings.merged.remote?.port]);

  // Sync History
  useEffect(() => {
    if (uiState.history.length > lastHistoryLength.current) {
      const newItems = uiState.history.slice(lastHistoryLength.current);
      newItems.forEach((item: HistoryItem) => {
        // Use a safe check for additional properties instead of any
        const hasCalls = 'calls' in item && Array.isArray(item.calls);
        if (item.type.includes('tool_call') || hasCalls) {
          remoteApiRef.current?.broadcast({ type: RemoteMessageType.HISTORY_UPDATE, payload: { item } });
        } else {
          remoteApiRef.current?.broadcastHistoryUpdate(item);
        }
      });
    }
    lastHistoryLength.current = uiState.history.length;
  }, [uiState.history]);

  // Periodic Status Updates
  useEffect(() => {
    const interval = setInterval(() => {
      if (remoteApiRef.current) {
        remoteApiRef.current.broadcast({ type: RemoteMessageType.STATUS_UPDATE, payload: getSystemStatus() });
      }
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  // Tool Call Interceptor
  useEffect(() => {
    const handleToolCall = (event: { name: string; args: Record<string, unknown> }) => {
      // Create a plain object that satisfies HistoryItem interface requirements
      const item = { 
        id: Date.now(), 
        type: 'tool_call', 
        calls: [{ name: event.name, args: event.args }] 
      };
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      remoteApiRef.current?.broadcast({ type: RemoteMessageType.HISTORY_UPDATE, payload: { item: item as unknown as HistoryItem } });
    };
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    (coreEvents as unknown as Record<string, { on: (e: string, cb: (ev: any) => void) => void }>).on('tool_call', handleToolCall);
    return () => { 
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      (coreEvents as unknown as Record<string, { off: (e: string, cb: (ev: any) => void) => void }>).off('tool_call', handleToolCall); 
    };
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
        error: uiState.authError
      }
    });
  }, [uiState.isAuthenticating, uiState.authError]);

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
