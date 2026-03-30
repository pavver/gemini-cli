/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ToolConfirmationOutcome,
  type SerializableConfirmationDetails,
  type UserConfirmationOption,
} from '../confirmation-bus/types.js';
import { type Config } from '../config/config.js';

/**
 * Shared logic to determine which confirmation options (buttons) should be available
 * for a given tool call based on security settings, folder trust, and IDE state.
 */
export function getToolConfirmationOptions(
  details: SerializableConfirmationDetails,
  config: Config,
  isDiffingEnabled: boolean,
): UserConfirmationOption[] {
  const options: UserConfirmationOption[] = [];
  const isTrustedFolder = config.isTrustedFolder();
  const allowPermanentApproval = config.allowPermanentToolApproval();
  const isIdeMode = config.getIdeMode();

  // Basic "Allow once" is always available
  const allowOnce: UserConfirmationOption = {
    value: ToolConfirmationOutcome.ProceedOnce,
    variant: 'success',
  };

  // Standard "Cancel" is always available
  const cancel: UserConfirmationOption = {
    value: ToolConfirmationOutcome.Cancel,
    variant: 'danger',
  };

  if (details.type === 'edit') {
    options.push(allowOnce);

    if (isTrustedFolder) {
      options.push({
        value: ToolConfirmationOutcome.ProceedAlways,
        variant: 'primary',
      });
      if (allowPermanentApproval) {
        options.push({
          value: ToolConfirmationOutcome.ProceedAlwaysAndSave,
          variant: 'primary',
        });
      }
    }

    // Mirror TUI: hide modify if IDE mode is active AND can show diff
    if (!isIdeMode || !isDiffingEnabled) {
      options.push({
        value: ToolConfirmationOutcome.ModifyWithEditor,
        variant: 'secondary',
      });
    }

    options.push(cancel);
  } else if (details.type === 'exec') {
    options.push(allowOnce);

    if (isTrustedFolder) {
      options.push({
        value: ToolConfirmationOutcome.ProceedAlways,
        variant: 'primary',
      });
      if (allowPermanentApproval) {
        options.push({
          value: ToolConfirmationOutcome.ProceedAlwaysAndSave,
          variant: 'primary',
        });
      }
    }

    options.push(cancel);
  } else if (details.type === 'mcp') {
    options.push(allowOnce);

    if (isTrustedFolder) {
      options.push({
        value: ToolConfirmationOutcome.ProceedAlwaysTool,
        variant: 'primary',
      });
      options.push({
        value: ToolConfirmationOutcome.ProceedAlwaysServer,
        variant: 'primary',
      });
      if (allowPermanentApproval) {
        options.push({
          value: ToolConfirmationOutcome.ProceedAlwaysAndSave,
          variant: 'primary',
        });
      }
    }

    options.push(cancel);
  } else {
    // Info / default / other
    options.push(allowOnce);
    if (isTrustedFolder) {
      options.push({
        value: ToolConfirmationOutcome.ProceedAlways,
        variant: 'primary',
      });
    }
    options.push(cancel);
  }

  return options;
}
