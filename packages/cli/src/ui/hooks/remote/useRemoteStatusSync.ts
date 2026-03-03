/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useCallback } from 'react';
import type {
  RemoteApiService,
  type SystemStatus,
} from '../../../services/RemoteApiService.js';
import type { UIState } from '../../contexts/UIStateContext.js';
import type { HistoryItem } from '../../types.js';
import { execSync } from 'node:child_process';
import os from 'node:os';

export function useRemoteStatusSync(
  service: RemoteApiService | null,
  uiState: UIState,
) {
  const getGitBranch = useCallback((): string | null => {
    try {
      return execSync('git rev-parse --abbrev-ref HEAD', {
        stdio: ['ignore', 'pipe', 'ignore'],
        cwd: process.cwd(),
      })
        .toString()
        .trim();
    } catch {
      return null;
    }
  }, []);

  const getSystemStatus = useCallback((): SystemStatus => {
    const mcpItem = uiState.history.findLast(
      (item): item is HistoryItem & { type: 'mcp_status' } =>
        item.type === 'mcp_status',
    );
    const skillsItem = uiState.history.findLast(
      (item): item is HistoryItem & { type: 'skills_list' } =>
        item.type === 'skills_list',
    );

    return {
      model: uiState.currentModel,
      ramUsage: `${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)} MB`,
      contextTokens: uiState.sessionStats.lastPromptTokenCount || 0,
      geminiMdFileCount: uiState.geminiMdFileCount,
      skillsCount: skillsItem?.skills.length ?? 0,
      mcpServers: Object.entries(mcpItem?.servers ?? {}).map(([name, cfg]) => {
        // Explicitly check for 'enabled' property
        let isEnabled = false;
        if (typeof cfg === 'object' && cfg !== null && 'enabled' in cfg) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          isEnabled = (cfg as Record<string, unknown>)['enabled'] === true;
        }
        return {
          name,
          status: isEnabled ? 'connected' : 'disabled',
        };
      }),
      cwd: process.cwd(),
      gitBranch: getGitBranch(),
      platform: os.platform(),
      activePtyId: uiState.activePtyId ?? null,
    };
  }, [uiState, getGitBranch]);

  // Sync Status Update
  useEffect(() => {
    if (!service) return;
    service.broadcastStatus(getSystemStatus());
  }, [
    service,
    uiState.currentModel,
    uiState.geminiMdFileCount,
    uiState.history.length,
    uiState.streamingState,
    uiState.activePtyId,
    getSystemStatus,
  ]);

  // Sync Streaming State
  useEffect(() => {
    if (!service) return;
    service.broadcastStreamingState(uiState.streamingState);
  }, [service, uiState.streamingState]);
}
