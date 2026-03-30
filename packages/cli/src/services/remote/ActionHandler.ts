/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { type GeminiClient, type MessageRecord } from '@google/gemini-cli-core';
import {
  type RemoteSession,
  type ChatSendAction,
  type ChatGetHistoryPageAction,
  type SettingsGetAction,
  type SettingsSetAction,
  type StatsGetAction,
  type RemoteSettingDefinition,
  type SettingsListResponse,
  type SettingsSetResponse,
} from './types.js';
import { ProtocolMapper } from './ProtocolMapper.js';
import {
  getFlattenedSchema,
  getEffectiveValue,
  getDefaultValue,
  isInSettingsScope,
  parseEditedValue,
} from '../../utils/settingsUtils.js';
import { SettingScope, type LoadedSettings } from '../../config/settings.js';
import { appEvents, AppEvent } from '../../utils/events.js';
import { type RemoteEventAdapter } from './RemoteEventAdapter.js';

/**
 * ActionHandler processes incoming actions from remote clients.
 */
export class ActionHandler {
  constructor(
    private readonly geminiClient: GeminiClient,
    private readonly loadedSettings: LoadedSettings,
    private readonly eventAdapter: RemoteEventAdapter,
    private readonly updateLastMessageId: () => void,
  ) {}

  handleChatSend(
    action: ChatSendAction,
    broadcastEvent: (topic: string, payload: unknown) => void,
  ) {
    this.eventAdapter.setGenerating(true);
    broadcastEvent('event:chat:user_message', {
      text: action.text,
    });
    appEvents.emit(AppEvent.RemotePrompt, action.text);
    this.updateLastMessageId();
  }

  handleChatStop() {
    appEvents.emit(AppEvent.RemoteCancel);
  }

  handleChatGetHistoryPage(
    session: RemoteSession,
    action: ChatGetHistoryPageAction,
  ) {
    const recordingService = this.geminiClient.getChatRecordingService();
    if (!recordingService) {
      session.ws.send(
        JSON.stringify({
          type: 'response:chat:history',
          correlationId: action.correlationId,
          messages: [],
          total: 0,
        }),
      );
      return;
    }
    const conversation = recordingService.getConversation();
    if (!conversation) {
      session.ws.send(
        JSON.stringify({
          type: 'response:chat:history',
          correlationId: action.correlationId,
          messages: [],
          total: 0,
        }),
      );
      return;
    }

    const allMessages = conversation.messages;
    const total = allMessages.length;
    let slicedMessages: MessageRecord[] = [];

    if (action.sort === 'asc') {
      slicedMessages = allMessages.slice(
        action.offset,
        action.offset + action.limit,
      );
    } else {
      const end = Math.max(0, total - action.offset);
      const start = Math.max(0, end - action.limit);
      slicedMessages = allMessages.slice(start, end).reverse();
    }

    const messages = slicedMessages.map((m) => ProtocolMapper.mapMessage(m));

    session.ws.send(
      JSON.stringify({
        type: 'response:chat:history',
        correlationId: action.correlationId,
        messages,
        total,
      }),
    );
  }

  handleSettingsGet(session: RemoteSession, action: SettingsGetAction) {
    const schema = getFlattenedSchema();
    const mergedSettings = this.loadedSettings.merged;
    const userSettings = this.loadedSettings.user.settings;

    const remoteSettings: RemoteSettingDefinition[] = Object.keys(schema)
      .filter((key) => schema[key].showInDialog !== false)
      .map((key) => {
        const def = schema[key];
        return {
          id: key,
          label: def.label,
          description: def.description,
          type: def.type as RemoteSettingDefinition['type'],
          value: getEffectiveValue(key, mergedSettings),
          default: getDefaultValue(key),
          isChanged: isInSettingsScope(key, userSettings),
          options: def.options
            ? def.options.map((o) => ({ label: o.label, value: o.value }))
            : undefined,
          requiresRestart: def.requiresRestart,
          category: def.category,
        };
      });

    const response: SettingsListResponse = {
      type: 'response:settings:list',
      correlationId: action.correlationId,
      settings: remoteSettings,
    };

    session.ws.send(JSON.stringify(response));
  }

  handleSettingsSet(session: RemoteSession, action: SettingsSetAction) {
    const schema = getFlattenedSchema();
    const def = schema[action.id];

    if (!def) {
      const response: SettingsSetResponse = {
        type: 'response:settings:set',
        correlationId: action.correlationId,
        success: false,
        error: `Setting ${action.id} not found`,
      };
      session.ws.send(JSON.stringify(response));
      return;
    }

    try {
      let valueToSet = action.value;
      if (typeof valueToSet === 'string' && def.type !== 'string') {
        const parsed = parseEditedValue(def.type, valueToSet);
        if (parsed !== null) {
          valueToSet = parsed;
        }
      }

      this.loadedSettings.setValue(SettingScope.User, action.id, valueToSet);

      if (action.settingsHash) {
        this.eventAdapter.emitSettingsHash(action.settingsHash);
      }

      const response: SettingsSetResponse = {
        type: 'response:settings:set',
        correlationId: action.correlationId,
        success: true,
        settingsHash: action.settingsHash,
      };
      session.ws.send(JSON.stringify(response));
    } catch (e) {
      const response: SettingsSetResponse = {
        type: 'response:settings:set',
        correlationId: action.correlationId,
        success: false,
        settingsHash: action.settingsHash,
        error: e instanceof Error ? e.message : String(e),
      };
      session.ws.send(JSON.stringify(response));
    }
  }

  async handleStatsGet(session: RemoteSession, action: StatsGetAction) {
    const stats = await this.eventAdapter.getSessionStats(action.correlationId);
    session.ws.send(JSON.stringify(stats));
  }
}
