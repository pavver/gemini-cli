/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type MessageRecord,
  type ToolCallRecord,
  type TokensSummary,
  type ThoughtSummary,
  type SerializableConfirmationDetails,
  type Question,
  type QuestionOption,
  MessageBusType,
  type ToolCall,
} from '@google/gemini-cli-core';
import {
  type RemoteMessageRecord,
  type RemoteToolCallRecord,
  type RemoteThoughtSummary,
  type RemoteTokensSummary,
  type RemotePart,
} from './types.js';

/**
 * ProtocolMapper provides pure functions to map internal CLI types to Remote API DTOs.
 */
export class ProtocolMapper {
  static isObject(val: unknown): val is Record<string, unknown> {
    return typeof val === 'object' && val !== null;
  }

  static hasCorrelationId(val: unknown): val is { correlationId: string } {
    if (!this.isObject(val)) return false;
    const id = val['correlationId'];
    return typeof id === 'string';
  }

  static isSerializableConfirmationDetails(
    val: unknown,
  ): val is SerializableConfirmationDetails {
    if (!this.isObject(val)) return false;
    const type = val['type'];
    return (
      typeof type === 'string' &&
      ['info', 'edit', 'exec', 'mcp', 'ask_user', 'exit_plan_mode'].includes(
        type,
      )
    );
  }

  static isToolCall(val: unknown): val is ToolCall {
    if (!this.isObject(val)) return false;
    const status = val['status'];
    const request = val['request'];
    return typeof status === 'string' && this.isObject(request);
  }

  static isToolCallRecord(val: unknown): val is ToolCallRecord {
    if (!this.isObject(val)) return false;
    const id = val['id'];
    const name = val['name'];
    const args = val['args'];
    const timestamp = val['timestamp'];
    return (
      typeof id === 'string' &&
      typeof name === 'string' &&
      this.isObject(args) &&
      typeof timestamp === 'string'
    );
  }

  static isToolCallsUpdate(
    val: unknown,
  ): val is { type: MessageBusType.TOOL_CALLS_UPDATE; toolCalls: ToolCall[] } {
    if (!this.isObject(val)) return false;
    const toolCalls = val['toolCalls'];
    return (
      val['type'] === MessageBusType.TOOL_CALLS_UPDATE &&
      Array.isArray(toolCalls) &&
      toolCalls.every((tc) => this.isToolCall(tc))
    );
  }

  static mapMessage(msg: MessageRecord): RemoteMessageRecord {
    const remoteMsg: RemoteMessageRecord = {
      id: msg.id,
      timestamp: msg.timestamp,
      type: msg.type,
      content: this.mapContent(msg.content),
    };

    if (msg.displayContent) {
      remoteMsg.displayContent = this.mapContent(msg.displayContent);
    }

    if (msg.type === 'gemini') {
      if (msg.toolCalls) {
        remoteMsg.toolCalls = msg.toolCalls.map((tc: ToolCallRecord) =>
          this.mapToolCall(tc),
        );
      }
      if (msg.thoughts) {
        remoteMsg.thoughts = msg.thoughts.map(
          (t: ThoughtSummary & { timestamp: string }) => this.mapThought(t),
        );
      }
      remoteMsg.tokens = this.mapTokens(msg.tokens);
      remoteMsg.model = msg.model;
    }

    return remoteMsg;
  }

  static mapContent(content: unknown): RemotePart[] {
    if (typeof content === 'string') {
      return [{ text: content }];
    }
    if (Array.isArray(content)) {
      const result: RemotePart[] = [];
      for (const item of content) {
        result.push(this.mapPart(item));
      }
      return result;
    }
    return [this.mapPart(content)];
  }

  static mapPart(part: unknown): RemotePart {
    if (typeof part === 'string') {
      return { text: part };
    }

    if (this.isObject(part)) {
      const text = part['text'];
      if (typeof text === 'string') {
        return { text };
      }

      const fc = part['functionCall'];
      if (this.isObject(fc)) {
        const name = fc['name'];
        return {
          functionCall: {
            name: typeof name === 'string' ? name : '',
            args: this.mapSafeRecord(fc['args']),
          },
        };
      }

      const fr = part['functionResponse'];
      if (this.isObject(fr)) {
        const name = fr['name'];
        return {
          functionResponse: {
            name: typeof name === 'string' ? name : '',
            response: this.mapSafeRecord(fr['response']),
          },
        };
      }

      const id = part['inlineData'];
      if (this.isObject(id)) {
        const mimeType = id['mimeType'];
        const data = id['data'];
        return {
          inlineData: {
            mimeType: typeof mimeType === 'string' ? mimeType : '',
            data: typeof data === 'string' ? data : '',
          },
        };
      }

      const fd = part['fileData'];
      if (this.isObject(fd)) {
        const mimeType = fd['mimeType'];
        const fileUri = fd['fileUri'];
        return {
          fileData: {
            mimeType: typeof mimeType === 'string' ? mimeType : '',
            fileUri: typeof fileUri === 'string' ? fileUri : '',
          },
        };
      }

      const ec = part['executableCode'];
      if (this.isObject(ec)) {
        const language = ec['language'];
        const code = ec['code'];
        return {
          executableCode: {
            language: typeof language === 'string' ? language : '',
            code: typeof code === 'string' ? code : '',
          },
        };
      }

      const cer = part['codeExecutionResult'];
      if (this.isObject(cer)) {
        const outcome = cer['outcome'];
        const output = cer['output'];
        return {
          codeExecutionResult: {
            outcome: typeof outcome === 'string' ? outcome : '',
            output: typeof output === 'string' ? output : '',
          },
        };
      }
    }

    return { text: '[Unknown Part Type]' };
  }

  static mapSafeRecord(source: unknown): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    if (this.isObject(source)) {
      for (const [key, value] of Object.entries(source)) {
        if (
          typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'boolean' ||
          value === null
        ) {
          result[key] = value;
        } else if (Array.isArray(value)) {
          const arr: unknown[] = [];
          for (const item of value) {
            arr.push(this.isObject(item) ? this.mapSafeRecord(item) : item);
          }
          result[key] = arr;
        } else if (this.isObject(value)) {
          result[key] = this.mapSafeRecord(value);
        }
      }
    }
    return result;
  }

  static mapToolCall(tc: ToolCallRecord): RemoteToolCallRecord {
    return {
      id: tc.id,
      name: tc.name,
      args: this.mapSafeRecord(tc.args),
      result: tc.result ? this.mapContent(tc.result) : undefined,
      status: String(tc.status),
    };
  }

  static mapToolCallFromCore(tc: ToolCall): RemoteToolCallRecord {
    return {
      id: tc.request.callId,
      name: tc.request.name,
      args: this.mapSafeRecord(tc.request.args),
      result:
        'response' in tc && tc.response
          ? this.mapContent(tc.response)
          : undefined,
      status: String(tc.status),
    };
  }

  static mapThought(
    t: ThoughtSummary & { timestamp: string },
  ): RemoteThoughtSummary {
    return {
      subject: t.subject,
      summary: t.description,
      timestamp: t.timestamp,
    };
  }

  static mapTokens(
    tokens: TokensSummary | null | undefined,
  ): RemoteTokensSummary | null {
    if (!tokens) {
      return null;
    }
    const result: RemoteTokensSummary = {
      input: tokens.input,
      output: tokens.output,
      cached: tokens.cached,
      thoughts: tokens.thoughts,
      tool: tokens.tool,
      total: tokens.total,
    };
    return result;
  }

  static mapConfirmationDetails(
    details?: SerializableConfirmationDetails,
  ): SerializableConfirmationDetails | undefined {
    if (!details) return undefined;

    switch (details.type) {
      case 'info':
        return {
          type: 'info',
          title: details.title,
          prompt: details.prompt,
          urls: details.urls,
          options: details.options,
        };
      case 'edit':
        return {
          type: 'edit',
          title: details.title,
          fileName: details.fileName,
          filePath: details.filePath,
          fileDiff: details.fileDiff,
          originalContent: details.originalContent,
          newContent: details.newContent,
          isModifying: details.isModifying,
          options: details.options,
        };
      case 'exec':
        return {
          type: 'exec',
          title: details.title,
          command: details.command,
          rootCommand: details.rootCommand,
          rootCommands: details.rootCommands,
          commands: details.commands,
          options: details.options,
        };
      case 'mcp':
        return {
          type: 'mcp',
          title: details.title,
          serverName: details.serverName,
          toolName: details.toolName,
          toolDisplayName: details.toolDisplayName,
          toolArgs: this.mapSafeRecord(details.toolArgs),
          toolDescription: details.toolDescription,
          toolParameterSchema: details.toolParameterSchema,
          options: details.options,
        };
      case 'ask_user':
        return {
          type: 'ask_user',
          title: details.title,
          questions: details.questions.map((q: Question) => ({
            question: q.question,
            header: q.header,
            type: q.type,
            multiSelect: q.multiSelect,
            placeholder: q.placeholder,
            options: q.options?.map((o: QuestionOption) => ({
              label: o.label,
              description: o.description,
            })),
          })),
          options: details.options,
        };
      case 'exit_plan_mode':
        return {
          type: 'exit_plan_mode',
          title: details.title,
          planPath: details.planPath,
          options: details.options,
        };
      default:
        return undefined;
    }
  }
}
