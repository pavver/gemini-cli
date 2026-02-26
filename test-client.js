/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/* global console, process */

import WebSocket from 'ws';

const ORCHESTRATOR_URL = 'ws://localhost:8000/ws';
const ws = new WebSocket(ORCHESTRATOR_URL);

ws.on('open', () => {
  console.log('✅ Connected to Orchestrator');
  console.log('🚀 Starting new Gemini CLI session...');
  ws.send(
    JSON.stringify({
      action: 'START_SESSION',
      dir: '/home/radxa/gemini',
    }),
  );
});

ws.on('message', (data) => {
  const response = JSON.parse(data.toString());

  if (response.type === 'SESSION_STARTED') {
    const sessionId = response.session_id;
    console.log('✨ Session started! ID: ' + sessionId);

    ws.send(
      JSON.stringify({
        action: 'CONNECT_SESSION',
        session_id: sessionId,
      }),
    );

    console.log('💬 Sending prompt to Gemini...');
    ws.send(
      JSON.stringify({
        action: 'CLI_COMMAND',
        session_id: sessionId,
        payload: {
          type: 'SEND_PROMPT',
          payload: {
            text: 'Прочитай список папок в поточній директорії і скажи що ти бачиш.',
          },
        },
      }),
    );
  }

  if (response.type === 'PROXY_MESSAGE') {
    const msg = response.message;

    if (msg.type === 'THOUGHT_STREAM') {
      if (msg.payload && msg.payload.thought) {
        process.stdout.write(
          '🤔 Thinking: ' + msg.payload.thought.summary + '\r',
        );
      }
    }

    if (msg.type === 'HISTORY_UPDATE') {
      const item = msg.payload.item;
      if (item.type === 'gemini') {
        console.log('\n🤖 Gemini says: ' + item.text);
        console.log('\n✅ Test complete. Closing connection.');
        ws.close();
        process.exit(0);
      }
      if (item.type === 'tool_group') {
        console.log(
          '\n🛠 Tool Call: ' + item.tools.map((t) => t.name).join(', '),
        );
      }
    }
  }

  if (response.type === 'ERROR') {
    console.error('❌ Error from orchestrator: ' + response.message);
    process.exit(1);
  }
});

ws.on('error', (err) => {
  console.error('WebSocket Error:', err);
});

ws.on('close', () => {
  console.log('🔌 Disconnected from Orchestrator');
});
