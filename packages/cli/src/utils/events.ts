/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';

export enum TransientMessageType {
  Warning = 'warning',
  Hint = 'hint',
}

export interface TransientMessagePayload {
  message: string;
  type: TransientMessageType;
}

export enum AppEvent {
  OpenDebugConsole = 'open-debug-console',
  Flicker = 'flicker',
  SelectionWarning = 'selection-warning',
  PasteTimeout = 'paste-timeout',
  TerminalBackground = 'terminal-background',
  TransientMessage = 'transient-message',
  RemotePrompt = 'remote-prompt',
  RemoteCancel = 'remote-cancel',
  LocalPrompt = 'local-prompt',
  SessionChanged = 'session-changed',
  LoadingUpdate = 'loading-update',
}

export interface LoadingUpdatePayload {
  phrase?: string;
  elapsedTime: number;
  status: 'idle' | 'responding' | 'waiting';
}

export interface AppEvents {
  [AppEvent.OpenDebugConsole]: never[];
  [AppEvent.Flicker]: never[];
  [AppEvent.SelectionWarning]: never[];
  [AppEvent.PasteTimeout]: never[];
  [AppEvent.TerminalBackground]: [string];
  [AppEvent.TransientMessage]: [TransientMessagePayload];
  [AppEvent.RemotePrompt]: [string];
  [AppEvent.RemoteCancel]: never[];
  [AppEvent.LocalPrompt]: [string];
  [AppEvent.SessionChanged]: [string];
  [AppEvent.LoadingUpdate]: [LoadingUpdatePayload];
}

export const appEvents = new EventEmitter<AppEvents>();
