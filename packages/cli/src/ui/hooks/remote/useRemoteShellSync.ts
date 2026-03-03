/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect } from 'react';
import type { RemoteApiService } from '../../../services/RemoteApiService.js';
import type { UIState } from '../../contexts/UIStateContext.js';
import { ShellExecutionService } from '@google/gemini-cli-core';

export function useRemoteShellSync(
  service: RemoteApiService | null,
  uiState: UIState,
) {
  // Sync Shell Output
  useEffect(() => {
    if (!service) return;

    const pid = uiState.activePtyId;
    if (!pid) return;

    const unsubscribe = ShellExecutionService.subscribe(pid, (event) => {
      if (event.type === 'data') {
        service.broadcastShellOutput(pid, event.chunk);
      }
    });

    return unsubscribe;
  }, [uiState.activePtyId, service]);

  // Handle Shell Input
  useEffect(() => {
    if (!service) return;

    const handleShellInput = (text: string) => {
      const pid = uiState.activePtyId;
      if (pid) ShellExecutionService.writeToPty(pid, text);
    };

    const handleResizeTerminal = (cols: number, rows: number) => {
      const pid = uiState.activePtyId;
      if (pid) ShellExecutionService.resizePty(pid, cols, rows);
    };

    service.on('shell_input', handleShellInput);
    service.on('resize_terminal', handleResizeTerminal);
    return () => {
      service.off('shell_input', handleShellInput);
      service.off('resize_terminal', handleResizeTerminal);
    };
  }, [service, uiState.activePtyId]);
}
