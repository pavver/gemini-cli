/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useState } from 'react';
import {
  RemoteApiService,
  RemoteMessageType,
  mapHistoryItem,
  mapStreamingState,
} from '../../services/RemoteApiService.js';
import type { UIState } from '../contexts/UIStateContext.js';
import type { UIActions } from '../contexts/UIActionsContext.js';
import { type Config, debugLogger } from '@google/gemini-cli-core';
import { useSlashCompletion } from './useSlashCompletion.js';
import type { Suggestion } from '../components/SuggestionsDisplay.js';
import type { CommandContext } from '../commands/types.js';

// Sub-hooks
import { useRemoteHistorySync } from './remote/useRemoteHistorySync.js';
import { useRemoteShellSync } from './remote/useRemoteShellSync.js';
import { useRemoteStatusSync } from './remote/useRemoteStatusSync.js';
import { useRemoteAuthSync } from './remote/useRemoteAuthSync.js';
import { useRemoteConfirmationSync } from './remote/useRemoteConfirmationSync.js';
import { useRemoteNotificationSync } from './remote/useRemoteNotificationSync.js';

import type { ToolActionsContextValue } from '../contexts/ToolActionsContext.js';
import type { ConfirmingToolState } from '../utils/confirmingTool.js';

export function useRemoteApi(
  uiState: UIState,
  uiActions: UIActions,
  config: Config,
  toolActions: ToolActionsContextValue,
  confirmingTool: ConfirmingToolState | null,
  currentLoadingPhrase?: string | null,
  elapsedTime?: number,
) {
  const remoteApiRef = useRef<RemoteApiService | null>(null);
  const [, forceUpdate] = useState({}); // To trigger sub-hooks when service starts

  const [remoteSearchQuery, setRemoteQuery] = useState<string | null>(null);
  const [remoteSuggestions, setRemoteSuggestions] = useState<Suggestion[]>([]);

  // Always keep fresh refs for async event handlers
  const uiActionsRef = useRef(uiActions);
  const uiStateRef = useRef(uiState);

  useEffect(() => {
    uiActionsRef.current = uiActions;
    uiStateRef.current = uiState;
  }, [uiActions, uiState]);

  // Main Service Initialization
  useEffect(() => {
    const isEnabled = config.getRemoteEnabled();
    const port = config.getRemotePort();

    if (isEnabled && !remoteApiRef.current) {
      const service = new RemoteApiService(port);
      remoteApiRef.current = service;

      service.on('session_state_request', (ws) => {
        const state = uiStateRef.current;
        service.sendToClient(ws, {
          type: RemoteMessageType.SESSION_INIT,
          payload: {
            apiVersion: 1,
            sessionId: config.getSessionId(),
            history: state.history.slice(-50).map(mapHistoryItem),
            config: {
              model: state.currentModel,
              approvalMode: String(state.showApprovalModeIndicator),
            },
            streamingState: mapStreamingState(state.streamingState),
            activePtyId: state.activePtyId ?? null,
            shellHistory: null,
            status: {
              model: state.currentModel,
              ramUsage: '0 MB',
              contextTokens: 0,
              geminiMdFileCount: 0,
              skillsCount: 0,
              mcpServers: [],
              cwd: '',
              gitBranch: null,
              platform: '',
              activePtyId: null,
            },
            commands: [],
            authState: 'authenticated',
          },
        });
      });
      service.on('send_prompt', (text) => {
        if (!text.startsWith('/'))
          void uiActionsRef.current.handleFinalSubmit(text);
      });

      service.on('execute_command', (command) => {
        void uiActionsRef.current.handleFinalSubmit(
          command.startsWith('/') ? command : `/${command}`,
        );
      });

      service.on('search_request', (query) => setRemoteQuery(query));
      service.on('stop_generation', () =>
        uiActionsRef.current.handleStopGeneration(),
      );
      service.on('clear_history', () =>
        uiActionsRef.current.handleClearScreen(),
      );
      service.on('reset_session', () =>
        uiActionsRef.current.handleClearScreen(),
      );

      service.start();
      forceUpdate({}); // Trigger sub-hooks
    }

    return () => {
      // Cleanup is tricky with refs, but typically service lives as long as the CLI
    };
  }, [config]);

  const service = remoteApiRef.current;

  // Delegate logic to specialized hooks
  useRemoteHistorySync(service, uiState);
  useRemoteShellSync(service, uiState);
  useRemoteStatusSync(service, uiState);
  useRemoteAuthSync(service, uiState, uiActions);
  useRemoteConfirmationSync(
    service,
    uiState,
    config,
    toolActions,
    confirmingTool,
  );
  useRemoteNotificationSync(
    service,
    uiState,
    currentLoadingPhrase,
    elapsedTime,
  );

  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const commandContext = {
    services: {
      config,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      logger: debugLogger as unknown as CommandContext['services']['logger'],
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
      settings: {} as any,
      git: undefined,
    },
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    ui: uiActions as unknown as CommandContext['ui'],
    session: {
      stats: uiState.sessionStats,
      sessionShellAllowlist: new Set(),
    },
  } as unknown as CommandContext;

  // Sync Completion Suggestions
  useSlashCompletion({
    enabled: true,
    query: remoteSearchQuery,
    slashCommands: uiState.slashCommands || [],
    commandContext,
    setSuggestions: setRemoteSuggestions,
    setIsLoadingSuggestions: () => {},
    setIsPerfectMatch: () => {},
  });

  useEffect(() => {
    if (remoteSearchQuery && service) {
      service.publish('completion', {
        type: RemoteMessageType.SEARCH_RESPONSE,
        payload: {
          query: remoteSearchQuery,
          suggestions: remoteSuggestions.map((s) => ({
            label: s.label,
            value: s.value.startsWith('/') ? s.value : `/${s.value}`,
            description: s.description,
            type: 'command',
          })),
        },
      });
    }
  }, [remoteSuggestions, remoteSearchQuery, service]);

  return service;
}
