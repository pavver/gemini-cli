/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef } from 'react';
import type {
  RemoteApiService} from '../../../services/RemoteApiService.js';
import {
  RemoteMessageType,
} from '../../../services/RemoteApiService.js';
import type { UIState } from '../../contexts/UIStateContext.js';
import type { HistoryItem } from '../../types.js';

export function useRemoteHistorySync(
  service: RemoteApiService | null,
  uiState: UIState,
) {
  const lastHistoryLength = useRef(uiState.history.length);

  // Sync History Updates
  useEffect(() => {
    if (!service) return;

    if (uiState.history.length > lastHistoryLength.current) {
      const newItems = uiState.history.slice(lastHistoryLength.current);
      newItems.forEach((item: HistoryItem) => {
        service.broadcastHistoryUpdate(item);
      });
    }
    lastHistoryLength.current = uiState.history.length;
  }, [uiState.history, service]);

  // Handle History Pagination Requests
  useEffect(() => {
    if (!service) return;

    const handleHistoryRequest = (offset: number, limit: number) => {
      // In a real implementation, we would use uiState.historyManager to fetch
      // but for now we slice from the current history
      const items = uiState.history.slice(
        Math.max(0, uiState.history.length - offset - limit),
        uiState.history.length - offset,
      );

      service.broadcast({
        type: RemoteMessageType.HISTORY_RESPONSE,
        payload: {
          items,
          offset,
          limit,
          total: uiState.history.length,
        },
      });
    };

    service.on('history_request', handleHistoryRequest);
    return () => {
      service.off('history_request', handleHistoryRequest);
    };
  }, [service, uiState.history]);
}
