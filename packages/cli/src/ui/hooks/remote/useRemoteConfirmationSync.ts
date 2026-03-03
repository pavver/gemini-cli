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
import { type Config, ToolConfirmationOutcome } from '@google/gemini-cli-core';
import type { ToolActionsContextValue } from '../../contexts/ToolActionsContext.js';
import type { ConfirmingToolState } from '../../utils/confirmingTool.js';

export function useRemoteConfirmationSync(
  service: RemoteApiService | null,
  uiState: UIState,
  config: Config,
  toolActions: ToolActionsContextValue,
  confirmingTool: ConfirmingToolState | null,
) {
  // Use a ref to track the actually active request ID to prevent stale confirmations
  const activeRequestIdRef = useRef<number | null>(null);
  const activeCallIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!service) return;

    const extractText = (node: unknown): string => {
      if (!node) return '';
      if (typeof node === 'string' || typeof node === 'number')
        return String(node);
      if (Array.isArray(node))
        return (node as unknown[]).map(extractText).join(' ');

      if (typeof node === 'object' && node !== null) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        const n = node as Record<string, unknown>;
        const props = n['props'];
        if (typeof props === 'object' && props !== null) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          const p = props as Record<string, unknown>;
          if (p['children']) return extractText(p['children']);
        }
        if (n['children']) return extractText(n['children']);
      }
      return '';
    };

    let promptText = '';
    let requestType:
      | 'tool_approval'
      | 'command_approval'
      | 'auth_consent'
      | 'extension_update' = 'tool_approval';
    let currentCallId: string | null = null;

    // 1. Check Tool Confirmation (Most common)
    if (confirmingTool?.tool.confirmationDetails) {
      const details = confirmingTool.tool.confirmationDetails;
      currentCallId = confirmingTool.tool.callId;
      requestType = 'tool_approval';

      if ('prompt' in details) {
        promptText = extractText(details.prompt);
      } else if (details.type === 'edit') {
        promptText = `Allow editing ${details.fileName}?`;
      } else {
        promptText = 'Execute tool action?';
      }
    }
    // 2. Check Command Approval
    else if (uiState.commandConfirmationRequest) {
      promptText = extractText(uiState.commandConfirmationRequest.prompt);
      requestType = 'command_approval';
    }
    // 3. Check Extension Updates
    else if (
      uiState.confirmUpdateExtensionRequests &&
      uiState.confirmUpdateExtensionRequests.length > 0
    ) {
      promptText = extractText(
        uiState.confirmUpdateExtensionRequests[0].prompt,
      );
      requestType = 'extension_update';
    }
    // 4. Check Auth Consent
    else if (uiState.authConsentRequest) {
      promptText = extractText(uiState.authConsentRequest.prompt);
      requestType = 'auth_consent';
    }

    // If no active request, clear refs and exit
    if (!promptText) {
      activeRequestIdRef.current = null;
      activeCallIdRef.current = null;
      return;
    }

    // Use callId or timestamp as a truly unique ID
    const requestId = currentCallId
      ? Number(currentCallId.replace(/[^0-9]/g, '')) || Date.now()
      : Date.now();

    // Check if we've already sent THIS exact request
    // We compare requestId and callId to ensure uniqueness even for identical prompts
    if (
      activeRequestIdRef.current !== requestId ||
      activeCallIdRef.current !== currentCallId
    ) {
      activeRequestIdRef.current = requestId;
      activeCallIdRef.current = currentCallId;

      const options: Array<{ label: string; value: string }> = [];

      if (
        requestType === 'tool_approval' ||
        requestType === 'command_approval'
      ) {
        options.push({
          label: 'Allow once',
          value: ToolConfirmationOutcome.ProceedOnce,
        });
        if (config.isTrustedFolder()) {
          options.push({
            label: 'Allow for this session',
            value: ToolConfirmationOutcome.ProceedAlways,
          });
        }
        options.push({
          label: 'No, suggest changes',
          value: ToolConfirmationOutcome.Cancel,
        });
      } else if (requestType === 'extension_update') {
        options.push(
          { label: 'Update All', value: 'true' },
          { label: 'Not now', value: 'false' },
        );
      } else {
        options.push(
          { label: 'Yes', value: 'true' },
          { label: 'No', value: 'false' },
        );
      }

      service.publish('confirmations', {
        type: RemoteMessageType.CONFIRMATION_REQUEST,
        payload: {
          id: requestId,
          prompt: promptText,
          type: requestType,
          options,
        },
      });
    }
  }, [uiState, confirmingTool, config, service]);

  useEffect(() => {
    if (!service) return;

    const handleResponse = (
      id: number,
      confirmed: boolean,
      choice?: string,
    ) => {
      // CRITICAL: Only proceed if the response matches our currently active request ID
      if (activeRequestIdRef.current !== id) {
        return;
      }

      const callId = activeCallIdRef.current;
      if (callId && toolActions) {
        let outcome: ToolConfirmationOutcome = confirmed
          ? ToolConfirmationOutcome.ProceedOnce
          : ToolConfirmationOutcome.Cancel;

        if (choice) {
          switch (choice) {
            case 'proceed_once':
              outcome = ToolConfirmationOutcome.ProceedOnce;
              break;
            case 'proceed_always':
              outcome = ToolConfirmationOutcome.ProceedAlways;
              break;
            case 'proceed_always_and_save':
              outcome = ToolConfirmationOutcome.ProceedAlwaysAndSave;
              break;
            case 'proceed_always_server':
              outcome = ToolConfirmationOutcome.ProceedAlwaysServer;
              break;
            case 'proceed_always_tool':
              outcome = ToolConfirmationOutcome.ProceedAlwaysTool;
              break;
            case 'modify_with_editor':
              outcome = ToolConfirmationOutcome.ModifyWithEditor;
              break;
            case 'cancel':
              outcome = ToolConfirmationOutcome.Cancel;
              break;
            default:
              break;
          }
        }

        void toolActions.confirm(callId, outcome);
      } else if (uiState.commandConfirmationRequest) {
        uiState.commandConfirmationRequest.onConfirm(confirmed);
      } else if (uiState.authConsentRequest) {
        uiState.authConsentRequest.onConfirm(confirmed);
      } else if (
        uiState.confirmUpdateExtensionRequests &&
        uiState.confirmUpdateExtensionRequests.length > 0
      ) {
        uiState.confirmUpdateExtensionRequests[0].onConfirm(confirmed);
      }

      // Clear refs after successful confirmation to prevent double-triggering
      activeRequestIdRef.current = null;
      activeCallIdRef.current = null;
    };

    service.on('confirmation_response', handleResponse);
    return () => {
      service.off('confirmation_response', handleResponse);
    };
  }, [service, uiState, toolActions]);
}
