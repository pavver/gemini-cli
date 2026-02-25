/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef } from 'react';
import {
  RemoteApiService,
  RemoteMessageType,
} from '../../services/RemoteApiService.js';
import type { UIState } from '../contexts/UIStateContext.js';
import type { UIActions } from '../contexts/UIActionsContext.js';
import { useConfig } from '../contexts/ConfigContext.js';
import { useSettings } from '../contexts/SettingsContext.js';

export function useRemoteApi(uiState: UIState, uiActions: UIActions) {
  const remoteApiRef = useRef<RemoteApiService | null>(null);
  const config = useConfig();
  const settings = useSettings();
  const lastHistoryLength = useRef(uiState.history.length);

  // Use refs for values that change often to avoid restarting the server
  const uiActionsRef = useRef(uiActions);
  const uiStateRef = useRef(uiState);

  useEffect(() => {
    uiActionsRef.current = uiActions;
    uiStateRef.current = uiState;
  }, [uiActions, uiState]);

  useEffect(() => {
    const envEnabled = process.env['GEMINI_REMOTE_ENABLED'] === 'true';
    const envPort = process.env['GEMINI_REMOTE_PORT']
      ? parseInt(process.env['GEMINI_REMOTE_PORT'], 10)
      : undefined;

    const isEnabled = envEnabled || (settings.merged.remote?.enabled ?? false);
    const port = envPort || (settings.merged.remote?.port ?? 8080);

    if (isEnabled && !remoteApiRef.current) {
      const service = new RemoteApiService(port);
      remoteApiRef.current = service;

      service.on('client_connected', (ws) => {
        // Send initial state using current refs
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
          },
        });
      });

      service.on('send_prompt', (text: string) => {
        void uiActionsRef.current.handleFinalSubmit(text);
      });

      service.on('confirmation_response', (_id: number, confirmed: boolean) => {
        const state = uiStateRef.current;
        if (state.commandConfirmationRequest) {
          state.commandConfirmationRequest.onConfirm(confirmed);
        } else if (state.authConsentRequest) {
          state.authConsentRequest.onConfirm(confirmed);
        }
      });

      service.start();
    }

    return () => {
      remoteApiRef.current?.stop();
      remoteApiRef.current = null;
    };
  }, [config, settings.merged.remote?.enabled, settings.merged.remote?.port]); // Only restart if config (sessionId) changes significantly

  // Sync history updates
  useEffect(() => {
    if (uiState.history.length > lastHistoryLength.current) {
      const newItems = uiState.history.slice(lastHistoryLength.current);
      newItems.forEach((item) => {
        remoteApiRef.current?.broadcastHistoryUpdate(item);
      });
    }
    lastHistoryLength.current = uiState.history.length;
  }, [uiState.history]);

  // Sync streaming state
  useEffect(() => {
    remoteApiRef.current?.broadcastStreamingState(uiState.streamingState);
  }, [uiState.streamingState]);

  // Sync thoughts
  useEffect(() => {
    if (uiState.thought) {
      remoteApiRef.current?.broadcastThought(uiState.thought, false);
    }
  }, [uiState.thought]);

  return remoteApiRef.current;
}
