/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect } from 'react';
import type {
  RemoteApiService} from '../../../services/RemoteApiService.js';
import {
  RemoteMessageType,
} from '../../../services/RemoteApiService.js';
import type { UIState } from '../../contexts/UIStateContext.js';
import type { UIActions } from '../../contexts/UIActionsContext.js';
import { AuthType } from '@google/gemini-cli-core';
import { SettingScope } from '../../../config/settings.js';

export function useRemoteAuthSync(
  service: RemoteApiService | null,
  uiState: UIState,
  uiActions: UIActions,
) {
  useEffect(() => {
    if (!service) return;

    service.publish('auth', {
      type: RemoteMessageType.AUTH_UPDATE,
      payload: {
        state: uiState.isAuthenticating ? 'authenticating' : 'authenticated',
        error: uiState.authError,
      },
    });
  }, [service, uiState.isAuthenticating, uiState.authError]);

  useEffect(() => {
    if (!service) return;

    const handleAuthSubmit = (method?: string, apiKey?: string) => {
      if (method === 'google') {
        uiActions.handleAuthSelect(
          AuthType.LOGIN_WITH_GOOGLE,
          SettingScope.User,
        );
      } else if (apiKey) {
        uiActions.handleAuthSelect(AuthType.USE_GEMINI, SettingScope.User);
        void uiActions.handleApiKeySubmit(apiKey);
      }
    };

    service.on('auth_submit', handleAuthSubmit);
    return () => {
      service.off('auth_submit', handleAuthSubmit);
    };
  }, [service, uiActions]);
}
