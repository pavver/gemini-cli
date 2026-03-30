/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  debugLogger,
  type MessageBus,
  MessageBusType,
  ToolConfirmationOutcome,
  IdeClient,
  type SerializableConfirmationDetails,
  type Question,
  type ToolConfirmationResponse,
  type AskUserResponse,
} from '@google/gemini-cli-core';
import {
  type ConfirmReplyAction,
  type UserConfirmationRequest,
} from './types.js';

export interface PendingConfirmation {
  correlationId: string;
  type: 'tool' | 'consent' | 'ask_user';
  prompt: string;
  header?: string;
  details?: SerializableConfirmationDetails;
  options: Array<{
    value: string;
    variant?: 'primary' | 'secondary' | 'danger' | 'success' | 'warning';
  }>;
  hasInput?: boolean;
  inputPlaceholder?: string;
  questionIndex?: number;
  totalQuestions?: number;
  callback?: (outcome: string, input?: string) => void;
  messageBusType?: MessageBusType;
}

export interface ActiveAskUserSession {
  correlationId: string;
  questions: Question[];
  currentIndex: number;
  answers: Record<string, string>;
}

/**
 * ConfirmationManager handles the unified queue of user confirmation requests
 * (tools, consent, sequential ask_user questions).
 */
export class ConfirmationManager {
  private readonly pendingConfirmations: PendingConfirmation[] = [];
  private activeAskUserSession: ActiveAskUserSession | undefined;

  constructor(
    private readonly messageBus: MessageBus,
    private readonly broadcastState: (
      payload: UserConfirmationRequest | null,
    ) => void,
    private readonly broadcastEvent: (topic: string, payload: unknown) => void,
  ) {}

  enqueue(conf: PendingConfirmation): void {
    // Prevent duplicate entries for the same correlationId
    if (
      this.pendingConfirmations.some(
        (c) => c.correlationId === conf.correlationId,
      )
    ) {
      return;
    }
    this.pendingConfirmations.push(conf);
    if (this.pendingConfirmations.length === 1) {
      this.broadcastActive();
    }
  }

  private broadcastActive(): void {
    const current = this.pendingConfirmations[0];
    if (current) {
      this.broadcastState({
        correlationId: current.correlationId,
        type: current.type,
        prompt: current.prompt,
        header: current.header,
        details: current.details,
        options: current.options,
        hasInput: current.hasInput,
        inputPlaceholder: current.inputPlaceholder,
        questionIndex: current.questionIndex,
        totalQuestions: current.totalQuestions,
      });
    } else {
      this.broadcastState(null);
    }
  }

  /**
   * Resolves a confirmation request that was handled externally (e.g. in TUI).
   */
  resolveExternally(correlationId: string): void {
    const index = this.pendingConfirmations.findIndex(
      (c) => c.correlationId === correlationId,
    );
    if (index !== -1) {
      debugLogger.log(
        `[RemoteAPI] Confirmation ${correlationId} resolved externally. Removing from queue.`,
      );
      this.pendingConfirmations.splice(index, 1);
      this.broadcastActive();
    }
  }

  async handleReply(action: ConfirmReplyAction): Promise<void> {
    debugLogger.log(
      `[RemoteAPI] Received confirmation reply for ${action.correlationId}: outcome=${action.outcome}`,
    );
    const index = this.pendingConfirmations.findIndex(
      (c) => c.correlationId === action.correlationId,
    );
    if (index === -1) {
      debugLogger.warn(
        `[RemoteAPI] Confirmation not found in queue: ${action.correlationId}`,
      );
      return;
    }

    const conf = this.pendingConfirmations[index];
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const outcome = action.outcome as ToolConfirmationOutcome;

    // 1. Handle Side Effects (IDE Diff)
    if (
      conf.type === 'tool' &&
      conf.details?.type === 'edit' &&
      conf.details.filePath
    ) {
      try {
        const ideClient = await IdeClient.getInstance();
        if (ideClient.isDiffingEnabled()) {
          const cliOutcome =
            outcome === ToolConfirmationOutcome.Cancel
              ? 'rejected'
              : 'accepted';
          await ideClient.resolveDiffFromCli(conf.details.filePath, cliOutcome);
        }
      } catch (e) {
        debugLogger.error('[RemoteAPI] Failed to resolve diff in IDE:', e);
      }
    }

    // 2. Resolve based on type
    if (conf.type === 'consent' && conf.callback) {
      conf.callback(action.outcome, action.input);
    } else if (conf.type === 'tool') {
      const confirmed = outcome !== ToolConfirmationOutcome.Cancel;
      const response: ToolConfirmationResponse = {
        type: MessageBusType.TOOL_CONFIRMATION_RESPONSE,
        correlationId: action.correlationId,
        confirmed,
        requiresUserConfirmation: false,
        outcome,
      };

      debugLogger.log(
        `[RemoteAPI] Publishing TOOL_CONFIRMATION_RESPONSE: correlationId=${action.correlationId}, confirmed=${confirmed}, outcome=${outcome}`,
      );

      // Emit directly to listeners (like Scheduler) to ensure immediate processing
      this.messageBus.emit(MessageBusType.TOOL_CONFIRMATION_RESPONSE, response);
      // Also publish via async method for standard bus subscribers
      await this.messageBus.publish(response);
    } else if (conf.type === 'ask_user') {
      if (action.cancelled) {
        const response: AskUserResponse = {
          type: MessageBusType.ASK_USER_RESPONSE,
          correlationId: action.correlationId,
          answers: {},
          cancelled: true,
        };
        this.messageBus.emit(MessageBusType.ASK_USER_RESPONSE, response);
        await this.messageBus.publish(response);
        this.activeAskUserSession = undefined;
      } else if (this.activeAskUserSession) {
        // Record answer for current question
        this.activeAskUserSession.answers[
          String(this.activeAskUserSession.currentIndex)
        ] = action.outcome;

        this.activeAskUserSession.currentIndex++;

        if (
          this.activeAskUserSession.currentIndex <
          this.activeAskUserSession.questions.length
        ) {
          // Update the existing queue item for the next question
          const nextQ =
            this.activeAskUserSession.questions[
              this.activeAskUserSession.currentIndex
            ];
          conf.prompt = nextQ.question;
          conf.header = nextQ.header;
          conf.questionIndex = this.activeAskUserSession.currentIndex;
          conf.options =
            nextQ.options?.map((o) => ({
              value: o.label,
            })) || [];
          if (nextQ.type === 'yesno') {
            conf.options = [
              { value: 'yes', variant: 'success' },
              { value: 'no', variant: 'danger' },
            ];
          }
          conf.hasInput = nextQ.type === 'text';
          conf.inputPlaceholder = nextQ.placeholder;

          this.broadcastActive();
          return; // Stay in queue for next question
        } else {
          // All questions done
          const response: AskUserResponse = {
            type: MessageBusType.ASK_USER_RESPONSE,
            correlationId: action.correlationId,
            answers: this.activeAskUserSession.answers,
            cancelled: false,
          };
          this.messageBus.emit(MessageBusType.ASK_USER_RESPONSE, response);
          await this.messageBus.publish(response);
          this.activeAskUserSession = undefined;
        }
      }
    }

    // 3. Notify remote client that request is resolved
    this.broadcastEvent('event:confirm:active:resolved', {
      correlationId: action.correlationId,
      confirmed: outcome !== ToolConfirmationOutcome.Cancel,
      outcome,
    });

    this.pendingConfirmations.splice(index, 1);
    this.broadcastActive();
  }

  clear(): void {
    this.pendingConfirmations.length = 0;
    this.activeAskUserSession = undefined;
  }

  setActiveAskUserSession(session: ActiveAskUserSession): void {
    this.activeAskUserSession = session;
  }
}
