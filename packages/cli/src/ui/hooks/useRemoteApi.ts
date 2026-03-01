/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import {
  RemoteApiService,
  RemoteMessageType,
  type SystemStatus,
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
} from '@google/gemini-cli-core';
import { SettingScope } from '../../config/settings.js';
import { execSync } from 'node:child_process';
import os from 'node:os';
import * as fs from 'node:fs';
import { useSlashCompletion } from './useSlashCompletion.js';
import { useConfirmingTool } from './useConfirmingTool.js';
import type { Suggestion } from '../components/SuggestionsDisplay.js';
import { TransientMessageType } from '../../utils/events.js';

const DEBUG_FILE = '/home/radxa/gemini/remote_debug.log';
const logToFile = (msg: string) => {
  try {
    fs.appendFileSync(DEBUG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch (e) {}
};

export function useRemoteApi(
  uiState: UIState,
  uiActions: UIActions,
  config: Config,
  toolActions: any, // Using any for toolActions to avoid complex type import issues
  currentLoadingPhrase?: string | null,
  elapsedTime?: number,
) {
  const remoteApiRef = useRef<RemoteApiService | null>(null);
  const lastHistoryLength = useRef(uiState.history.length);
  const confirmingTool = useConfirmingTool();

  // Always keep fresh refs for async event handlers
  const uiActionsRef = useRef(uiActions);
  const uiStateRef = useRef(uiState);
  const confirmingToolRef = useRef(confirmingTool);
  const toolActionsRef = useRef(toolActions);

  useEffect(() => {
    uiActionsRef.current = uiActions;
    uiStateRef.current = uiState;
    confirmingToolRef.current = confirmingTool;
    toolActionsRef.current = toolActions;
  }, [uiActions, uiState, confirmingTool, toolActions]);

  // Track the callId of the currently displayed confirmation
  const activeCallIdRef = useRef<string | null>(null);

  // Use the original CLI completion logic
  const [remoteSearchQuery, setRemoteQuery] = useState<string | null>(null);
  const [remoteSuggestions, setRemoteSuggestions] = useState<Suggestion[]>([]);

  useSlashCompletion({
    enabled: true,
    query: remoteSearchQuery,
    slashCommands: uiState.slashCommands || [],
    commandContext: {
      services: { config, logger: debugLogger },
      ui: uiActions,
    } as any,
    setSuggestions: setRemoteSuggestions,
    setIsLoadingSuggestions: () => {},
    setIsPerfectMatch: () => {},
  });

  // Broadcast suggestions
  useEffect(() => {
    if (remoteSearchQuery && remoteApiRef.current) {
      remoteApiRef.current.broadcast({
        type: RemoteMessageType.SEARCH_RESPONSE,
        payload: { 
          query: remoteSearchQuery, 
          suggestions: remoteSuggestions.map(s => {
            let value = s.value;
            if (remoteSearchQuery.startsWith('/') && !value.startsWith('/')) {
              const parts = remoteSearchQuery.split(' ');
              value = parts.length > 1 ? `${parts[0]} ${s.value}` : `/${s.value}`;
            }
            return { label: s.label, value, description: s.description, type: 'command' };
          })
        },
      });
    }
  }, [remoteSuggestions, remoteSearchQuery]);

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
        const cfgObj = cfg as any;
        return { name, status: cfgObj['enabled'] === true ? 'connected' : 'disabled' };
      }),
      cwd: process.cwd(),
      gitBranch: getGitBranch(),
      platform: os.platform(),
    };
  }, [getGitBranch]);

  // Main Service Initialization
  useEffect(() => {
    const isEnabled = config.getRemoteEnabled();
    const port = config.getRemotePort();

    if (isEnabled && !remoteApiRef.current) {
      logToFile('Remote API Service Starting...');
      const service = new RemoteApiService(port);
      remoteApiRef.current = service;
      uiActionsRef.current.setRemoteApiPort(port);

      service.on('session_state_request', (ws) => {
        service.sendToClient(ws, {
          type: RemoteMessageType.SESSION_INIT,
          payload: {
            apiVersion: 1,
            sessionId: config.getSessionId(),
            history: uiStateRef.current.history.slice(-50),
            config: { model: uiStateRef.current.currentModel, approvalMode: uiStateRef.current.showApprovalModeIndicator as any },
            streamingState: uiStateRef.current.streamingState,
            activePtyId: uiStateRef.current.activePtyId ?? null,
            shellHistory: null,
            status: getSystemStatus(),
            commands: [],
            authState: 'authenticated',
          },
        });
      });

      service.on('send_prompt', (text) => {
        if (!text.startsWith('/')) void uiActionsRef.current.handleFinalSubmit(text);
      });

      service.on('execute_command', (command) => {
        void uiActionsRef.current.handleFinalSubmit(command.startsWith('/') ? command : `/${command}`);
      });

      service.on('confirmation_response', (_id, confirmed, choice) => {
        logToFile(`RES RECEIVED: id=${_id} ok=${confirmed} choice=${choice}`);
        const state = uiStateRef.current;
        const callId = activeCallIdRef.current;
        const actions = toolActionsRef.current;

        if (callId && actions) {
          logToFile(`Resolving via toolActions: callId=${callId}`);
          void actions.confirm(callId, choice || (confirmed ? 'proceed_once' : 'cancel'));
        } else if (state.commandConfirmationRequest) {
          logToFile('Resolving via commandConfirmationRequest');
          state.commandConfirmationRequest.onConfirm(confirmed);
        } else if (state.authConsentRequest) {
          logToFile('Resolving via authConsentRequest');
          state.authConsentRequest.onConfirm(confirmed);
        } else {
          logToFile('No active handler found for confirmation response');
        }
      });

      service.on('search_request', (query) => setRemoteQuery(query));
      
      service.on('stop_generation', () => {
        uiActionsRef.current.handleStopGeneration();
      });

      service.on('shell_input', (text) => {
        const pid = uiStateRef.current.activePtyId;
        if (pid) ShellExecutionService.writeToPty(pid, text);
      });

      service.on('auth_submit', (method, apiKey) => {
        if (method === 'google') uiActionsRef.current.handleAuthSelect(AuthType.LOGIN_WITH_GOOGLE, SettingScope.User);
        else if (apiKey) {
          uiActionsRef.current.handleAuthSelect(AuthType.USE_GEMINI, SettingScope.User);
          void uiActionsRef.current.handleApiKeySubmit(apiKey);
        }
      });

      service.on('resize_terminal', (cols, rows) => {
        const pid = uiStateRef.current.activePtyId;
        if (pid) ShellExecutionService.resizePty(pid, cols, rows);
      });

      service.start();
    }

    return () => {
      remoteApiRef.current?.stop();
      remoteApiRef.current = null;
    };
  }, [config, getSystemStatus]);

  // Sync Confirmation Requests
  const lastSentConfirmId = useRef<string | null>(null);
  useEffect(() => {
    const service = remoteApiRef.current;
    if (!service) return;

    const request = uiState.commandConfirmationRequest || 
                    uiState.authConsentRequest || 
                    confirmingTool?.tool.confirmationDetails;

    if (!request) {
      lastSentConfirmId.current = null;
      activeCallIdRef.current = null;
      return;
    }

    const extractText = (node: any): string => {
      if (!node) return '';
      if (typeof node === 'string' || typeof node === 'number') return String(node);
      if (Array.isArray(node)) return node.map(extractText).join(' ');
      if (typeof node === 'object') {
        if (node.props && node.props.children) return extractText(node.props.children);
        if (node.children) return extractText(node.children);
      }
      return '';
    };

    let promptText = extractText((request as any).prompt);
    const commandText = (request as any).command;
    if (commandText && typeof commandText === 'string') {
      promptText = promptText ? `${promptText}: ${commandText}` : commandText;
    }

    if (!promptText || promptText === 'Confirm Shell Command') {
      const titleText = extractText((request as any).title);
      promptText = titleText && titleText !== promptText ? `${titleText}: ${promptText}` : (promptText || titleText);
    }

    const cid = `${promptText}_${(request as any).type}`;

    if (lastSentConfirmId.current !== cid) {
      // Store the callId for resolution
      if (confirmingTool) {
        activeCallIdRef.current = confirmingTool.tool.callId;
      }

      const options: Array<{label: string, value: string}> = [];
      const type = (request as any).type;
      const isTrusted = config.isTrustedFolder();
      
      if (type === 'edit' || type === 'exec' || type === 'info' || type === 'mcp') {
        options.push({ label: 'Allow once', value: 'proceed_once' });
        if (isTrusted) {
          options.push({ label: 'Allow for this session', value: 'proceed_always' });
          options.push({ label: 'Allow for all future sessions', value: 'proceed_always_and_save' });
        }
        options.push({ label: 'No, suggest changes', value: 'cancel' });
      } else {
        options.push({ label: 'Yes', value: 'true' });
        options.push({ label: 'No', value: 'false' });
      }

      logToFile(`BROADCASTING: ${promptText} id=${activeCallIdRef.current}`);
      service.broadcast({
        type: RemoteMessageType.CONFIRMATION_REQUEST,
        payload: {
          id: Date.now(),
          prompt: promptText || 'Action required',
          type: 'tool_approval',
          options: options,
        },
      });
      lastSentConfirmId.current = cid;
    }
  }, [uiState, confirmingTool, config]);

  // Sync History
  useEffect(() => {
    if (uiState.history.length > lastHistoryLength.current) {
      const newItems = uiState.history.slice(lastHistoryLength.current);
      newItems.forEach((item: HistoryItem) => {
        const itemWithType = item as unknown as Record<string, unknown>;
        const type = itemWithType['type'];
        if (typeof type === 'string' && (type.includes('tool_call') || type === 'tool_group')) {
          remoteApiRef.current?.broadcast({ type: RemoteMessageType.HISTORY_UPDATE, payload: { item } });
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
      remoteApiRef.current.broadcast({ type: RemoteMessageType.STATUS_UPDATE, payload: getSystemStatus() });
    }
  }, [uiState.currentModel, uiState.geminiMdFileCount, uiState.history.length, uiState.streamingState, uiState.activePtyId, getSystemStatus]);

  // Tool Call Interceptor
  useEffect(() => {
    const handleToolCall = (event: any) => {
      const item: HistoryItem = {
        id: Date.now(),
        type: 'tool_group',
        tools: [{
          callId: event.callId || `remote-${Date.now()}`,
          name: event.name,
          args: event.args,
          status: event.status || CoreToolCallStatus.Executing,
          description: `Executing ${event.name}...`,
          resultDisplay: undefined,
          confirmationDetails: undefined,
        }],
      };
      remoteApiRef.current?.broadcast({ type: RemoteMessageType.HISTORY_UPDATE, payload: { item } });
    };
    (coreEvents as any).on('tool_call', handleToolCall);
    return () => { (coreEvents as any).off('tool_call', handleToolCall); };
  }, []);

  // Sync Streaming State
  useEffect(() => {
    remoteApiRef.current?.broadcastStreamingState(uiState.streamingState);
  }, [uiState.streamingState]);

  // Sync Auth State
  useEffect(() => {
    remoteApiRef.current?.broadcast({
      type: RemoteMessageType.AUTH_UPDATE,
      payload: { state: uiState.isAuthenticating ? 'authenticating' : 'authenticated', error: uiState.authError },
    });
  }, [uiState.isAuthenticating, uiState.authError]);

  // Proxy shell output
  useEffect(() => {
    const pid = uiState.activePtyId;
    if (!pid) return;
    const unsubscribe = ShellExecutionService.subscribe(pid, (event) => {
      if (event.type === 'data') remoteApiRef.current?.broadcastShellOutput(event.chunk);
    });
    return unsubscribe;
  }, [uiState.activePtyId]);

  // Sync Toasts
  useEffect(() => {
    const service = remoteApiRef.current;
    if (!service) return;

    let message = '';
    let severity: 'info' | 'warning' | 'error' = 'info';

    if (uiState.ctrlCPressedOnce) {
      message = 'Press Ctrl+C again to exit.';
      severity = 'warning';
    } else if (uiState.ctrlDPressedOnce) {
      message = 'Press Ctrl+D again to exit.';
      severity = 'warning';
    } else if (uiState.queueErrorMessage) {
      message = uiState.queueErrorMessage;
      severity = 'error';
    } else if (uiState.transientMessage?.text) {
      message = uiState.transientMessage.text;
      severity =
        uiState.transientMessage.type === TransientMessageType.Warning
          ? 'warning'
          : 'info';
    } else if (currentLoadingPhrase) {
      message = currentLoadingPhrase;
      severity = 'info';
    }

    if (message) {
      service.broadcast({
        type: RemoteMessageType.TOAST,
        payload: { message, severity },
      });
    }
  }, [
    uiState.ctrlCPressedOnce,
    uiState.ctrlDPressedOnce,
    uiState.queueErrorMessage,
    uiState.transientMessage,
    currentLoadingPhrase,
  ]);

  // Sync Update Info (as history item, not toast)
  const lastSentUpdateVersion = useRef<string | null>(null);
  useEffect(() => {
    const service = remoteApiRef.current;
    const info = uiState.updateInfo;
    if (
      !service ||
      !info ||
      !info.update ||
      lastSentUpdateVersion.current === info.update.latest
    )
      return;

    service.broadcast({
      type: RemoteMessageType.HISTORY_UPDATE,
      payload: {
        item: {
          id: Date.now(),
          type: 'info',
          text: info.message,
        },
      },
    });
    lastSentUpdateVersion.current = info.update.latest;
  }, [uiState.updateInfo]);

  return remoteApiRef.current;
}
