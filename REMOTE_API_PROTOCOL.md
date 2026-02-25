# Gemini CLI Remote API Protocol (WebSocket)

Цей протокол описує взаємодію між Gemini CLI (сервер) та Веб-інтерфейсом
(клієнт). Всі повідомлення передаються у форматі JSON.

## 1. Підключення

**URL:** `ws://localhost:<PORT>/remote`

## 2. Типи повідомлень від Сервера (CLI -> Web)

### 2.1. Початковий стан (SESSION_INIT)

Відправляється одразу після підключення.

```json
{
  "type": "SESSION_INIT",
  "payload": {
    "sessionId": "string",
    "history": HistoryItem[],
    "config": {
      "model": "string",
      "approvalMode": "DEFAULT | YOLO | PLAN",
      "isMcpReady": boolean
    },
    "streamingState": "idle | responding | waiting_for_confirmation"
  }
}
```

### 2.2. Оновлення історії (HISTORY_UPDATE)

Відправляється при додаванні або зміні елементів (текст, думки, інструменти).

```json
{
  "type": "HISTORY_UPDATE",
  "payload": {
    "item": HistoryItem // Повний об'єкт повідомлення (див. packages/cli/src/ui/types.ts)
  }
}
```

### 2.3. Потік думок (THOUGHT_STREAM)

Реал-тайм трансляція "роздумів" моделі.

```json
{
  "type": "THOUGHT_STREAM",
  "payload": {
    "thought": "string", // Поточний текст роздумів
    "isComplete": boolean
  }
}
```

### 2.4. Запит на підтвердження (CONFIRMATION_REQUEST)

Виникає, коли інструмент потребує схвалення користувача.

```json
{
  "type": "CONFIRMATION_REQUEST",
  "payload": {
    "id": "number", // ID запиту
    "prompt": "string", // Текст питання (напр. "Виконати команду 'rm -rf'?")
    "type": "tool_approval | file_permissions | loop_detection"
  }
}
```

### 2.5. Стан стрімінгу (STREAMING_STATE)

```json
{
  "type": "STREAMING_STATE",
  "payload": {
    "state": "idle | responding | waiting_for_confirmation"
  }
}
```

---

## 3. Типи повідомлень від Клієнта (Web -> CLI)

### 3.1. Відправка запиту (SEND_PROMPT)

Еквівалент введення тексту в CLI та натискання Enter.

```json
{
  "type": "SEND_PROMPT",
  "payload": {
    "text": "string" // Може бути як звичайний текст, так і /команда
  }
}
```

### 3.2. Відповідь на підтвердження (CONFIRMATION_RESPONSE)

```json
{
  "type": "CONFIRMATION_RESPONSE",
  "payload": {
    "id": "number",
    "confirmed": boolean
  }
}
```

### 3.3. Зупинка генерації (STOP_GENERATION)

```json
{
  "type": "STOP_GENERATION"
}
```

## 4. Об'єкти HistoryItem

Короткий перелік типів (відповідає `packages/cli/src/ui/types.ts`):

- `user`: Повідомлення користувача.
- `gemini`: Відповідь моделі.
- `thinking`: Блок роздумів.
- `tool_group`: Блок з викликами інструментів та їх результатами.
- `error` / `warning` / `info`: Системні сповіщення.
