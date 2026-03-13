/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type {
  MessageRecord,
  ToolCallRecord,
  TokensSummary,
  ConversationRecord,
  ThoughtSummary,
} from '@google/gemini-cli-core';

/**
 * CONTRACT VERIFICATION TEST
 *
 * This test ensures that the core data structures from @google/gemini-cli-core
 * haven't changed in a way that breaks the Remote API mapping logic.
 *
 * CRITICAL: If this test fails due to a change in core types, you MUST:
 * 1. Update the mapping logic in packages/cli/src/services/remote/RemoteApiService.ts
 * 2. Update the corresponding Remote types in packages/cli/src/services/remote/types.ts
 */

describe('Core to Remote API Contract Verification', () => {
  it('ConversationRecord should have messages array', () => {
    // If messages field is renamed or removed, history fetching will break.
    const dummy: Partial<ConversationRecord> = { messages: [] };
    expect(dummy.messages).toBeDefined();
  });

  it('MessageRecord should have required base fields', () => {
    /*
     * If any of these base fields are changed, update:
     * - RemoteMessageRecord in types.ts
     * - mapMessage() in RemoteApiService.ts
     */
    const dummy: Partial<MessageRecord> = {
      id: 'uuid',
      timestamp: '2026-01-01',
      type: 'user',
      content: [],
    };
    expect(dummy.id).toBeDefined();
    expect(dummy.timestamp).toBeDefined();
    expect(dummy.type).toBeDefined();
    expect(dummy.content).toBeDefined();
  });

  it('Gemini MessageRecord should have optional enrichment fields', () => {
    /*
     * Enrichment fields for 'gemini' type messages.
     * Update mapMessage() if changed.
     */
    const dummy: unknown = {
      type: 'gemini',
      toolCalls: [],
      thoughts: [],
      tokens: null,
      model: 'gemini-pro',
    };
    const msg = dummy as MessageRecord;
    if (msg.type === 'gemini') {
      expect(msg.toolCalls).toBeDefined();
      expect(msg.thoughts).toBeDefined();
      expect(msg.tokens).toBeDefined();
      expect(msg.model).toBeDefined();
    }
  });

  it('ToolCallRecord should have required fields', () => {
    /*
     * Fields used in RemoteToolCallRecord.
     * Update mapToolCall() if changed.
     */
    const dummy: Partial<ToolCallRecord> = {
      id: 'call-1',
      name: 'tool',
      args: {},
      result: [],
      // @ts-expect-error - testing against enum string values
      status: 'success',
      timestamp: 'ts',
    };
    expect(dummy.id).toBeDefined();
    expect(dummy.name).toBeDefined();
    expect(dummy.args).toBeDefined();
    expect(dummy.result).toBeDefined();
    expect(dummy.status).toBeDefined();
    expect(dummy.timestamp).toBeDefined();
  });

  it('ThoughtSummary should have required fields', () => {
    /*
     * Fields used in RemoteThoughtSummary.
     * Update mapThought() if changed.
     */
    const dummy: Partial<ThoughtSummary> = {
      subject: 'Thinking',
      description: 'Doing something',
    };
    expect(dummy.subject).toBeDefined();
    expect(dummy.description).toBeDefined();
  });

  it('TokensSummary should have required fields', () => {
    /*
     * Fields used in RemoteTokensSummary.
     * Update mapTokens() if changed.
     */
    const dummy: Partial<TokensSummary> = {
      input: 1,
      output: 2,
      cached: 3,
      total: 6,
    };
    expect(dummy.input).toBeDefined();
    expect(dummy.output).toBeDefined();
    expect(dummy.cached).toBeDefined();
    expect(dummy.total).toBeDefined();
  });
});
