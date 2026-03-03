/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef } from 'react';
import type { RemoteApiService } from '../../../services/RemoteApiService.js';
import type { UIState } from '../../contexts/UIStateContext.js';
import { TransientMessageType } from '../../../utils/events.js';

export function useRemoteNotificationSync(
  service: RemoteApiService | null,
  uiState: UIState,
  currentLoadingPhrase?: string | null,
  elapsedTime?: number,
) {
  const lastSentToast = useRef<string | null>(null);

  // Sync Toasts
  useEffect(() => {
    if (!service) return;

    let message = '';
    let severity: 'info' | 'warning' | 'error' = 'info';

    if (uiState.ctrlCPressedOnce) {
      message = 'Press Ctrl+C again to exit.';
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
      const timeStr =
        elapsedTime && elapsedTime > 0 ? ` (${elapsedTime.toFixed(1)}s)` : '';
      message = `${currentLoadingPhrase}${timeStr}`;
      severity = 'info';
    }

    if (message && message !== lastSentToast.current) {
      service.broadcastToast(message, severity);
      lastSentToast.current = message;
    } else if (!message && lastSentToast.current) {
      lastSentToast.current = null;
    }
  }, [
    service,
    uiState.ctrlCPressedOnce,
    uiState.queueErrorMessage,
    uiState.transientMessage,
    currentLoadingPhrase,
    elapsedTime,
  ]);

  // Sync Update Info (Version checks)
  const lastSentUpdateVersion = useRef<string | null>(null);
  useEffect(() => {
    if (
      !service ||
      !uiState.updateInfo?.update ||
      lastSentUpdateVersion.current === uiState.updateInfo.update.latest
    )
      return;

    service.broadcastHistoryUpdate({
      id: Date.now(),
      type: 'info',
      text: uiState.updateInfo.message,
    });
    lastSentUpdateVersion.current = uiState.updateInfo.update.latest;
  }, [service, uiState.updateInfo]);
}
