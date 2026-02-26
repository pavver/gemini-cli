# Gemini Remote System: Full API Specification

Цей документ є вичерпною специфікацією для реалізації клієнта (веб-інтерфейсу). 
Система складається з двох рівнів: **Оркестратор (Rust)** та **Gemini CLI (Node.js)**.

---

## 1. Рівень 1: Оркестратор (Сесії)
**URL:** `ws://<host>:8000/ws`

Оркестратор керує життєвим циклом процесів Gemini CLI. Всі повідомлення — JSON.

### 1.1. Команди від Клієнта (Client -> Orchestrator)

| Action | Payload | Опис |
| :--- | :--- | :--- |
| `START_SESSION` | `{ "dir": "string" }` | Запускає новий процес CLI у вказаній папці. |
| `STOP_SESSION` | `{ "session_id": "uuid" }` | Вбиває процес CLI та закриває tmux-сесію. |
| `CONNECT_SESSION`| `{ "session_id": "uuid" }` | Підписка на повідомлення від конкретної сесії. |
| `DISCONNECT_SESSION`| `{ "session_id": "uuid" }` | Відписка від повідомлень сесії. |
| `CLI_COMMAND` | `{ "session_id": "uuid", "payload": CLI_MSG }` | Відправка команди безпосередньо в CLI (див. Розділ 2.2). |

### 1.2. Повідомлення від Оркестратора (Orchestrator -> Client)

| Type | Payload | Опис |
| :--- | :--- | :--- |
| `SESSION_STARTED` | `{ "session_id": "uuid" }` | Сесія створена та готова до підключення. |
| `SESSION_STOPPED` | `{ "session_id": "uuid" }` | Сесія була успішно завершена. |
| `PROXY_MESSAGE` | `{ "session_id": "uuid", "message": CLI_MSG }` | Обгортка для будь-якого повідомлення від CLI (див. Розділ 2.1). |
| `ERROR` | `{ "message": "string" }` | Помилка на рівні оркестратора. |

---

## 2. Рівень 2: Gemini CLI (Взаємодія)
Ці повідомлення приходять всередині `PROXY_MESSAGE.message` (від сервера) або відправляються всередині `CLI_COMMAND.payload` (від клієнта).

### 2.1. Повідомлення від CLI (CLI -> Client)

#### SESSION_INIT
Надсилається одразу після підключення до сесії. Містить весь початковий стан.
```json
{
  "type": "SESSION_INIT",
  "payload": {
    "sessionId": "string",
    "history": HistoryItem[],
    "config": { "model": "string", "approvalMode": "default | yolo | plan | auto_edit" },
    "streamingState": "idle | responding | waiting_for_confirmation",
    "activePtyId": number | null,
    "shellHistory": AnsiOutput | null,
    "status": SystemStatus,
    "commands": { "name": "string", "description": "string" }[],
    "authState": "authenticating | authenticated"
  }
}
```

#### HISTORY_UPDATE
Коли в чаті з'являється нове повідомлення, виклик інструменту або системний лог.
```json
{ "type": "HISTORY_UPDATE", "payload": { "item": HistoryItem } }
```

#### SHELL_OUTPUT
Структурований вивід внутрішнього термінала (PTY). Підтримує інкрементальні оновлення.
```json
{ "type": "SHELL_OUTPUT", "payload": { "chunk": string | AnsiOutput } }
```

#### STATUS_UPDATE
Оновлення системних метрик (кожні кілька секунд або при зміні).
```json
{
  "type": "STATUS_UPDATE",
  "payload": {
    "model": "string",
    "ramUsage": "string (напр. '120.5 MB')",
    "contextTokens": number,
    "geminiMdFileCount": number,
    "skillsCount": number,
    "mcpServers": [ { "name": "string", "status": "connected | disabled" } ]
  }
}
```

#### CONFIRMATION_REQUEST
Запит на дію користувача (дозвіл інструменту, квоти, вхід).
```json
{
  "type": "CONFIRMATION_REQUEST",
  "payload": {
    "id": number,
    "type": "tool_approval | file_permissions | loop_detection | quota | validation",
    "prompt": "string",
    "options": string[] // Варіанти вибору (напр. ["retry_later", "retry_once"])
  }
}
```

### 2.2. Команди від Клієнта (Client -> CLI)

| Type | Payload | Опис |
| :--- | :--- | :--- |
| `SEND_PROMPT` | `{ "text": "string" }` | Відправка тексту або `/команди`. |
| `SHELL_INPUT` | `{ "text": "string" }` | Відправка вводу (пароль, Enter) у активний PTY. |
| `RESIZE_TERMINAL` | `{ "cols": number, "rows": number }` | Синхронізація розміру вікна термінала. |
| `CONFIRMATION_RESPONSE` | `{ "id": number, "confirmed": bool, "choice": "string" }` | Відповідь на запит підтвердження. |
| `AUTH_SUBMIT` | `{ "method": "google | api_key", "apiKey": "string" }` | Ініціація входу або відправка ключа. |
| `SEARCH_REQUEST` | `{ "query": "string", "type": "at | slash" }` | Динамічний пошук файлів або команд. |
| `STOP_GENERATION` | `null` | Переривання поточної відповіді Gemini. |

---

## 3. Складні типи даних

### 3.1. AnsiOutput (Термінал)
Це масив рядків, де кожен рядок — масив токенів зі стилями.
```typescript
type AnsiOutput = AnsiToken[][];
interface AnsiToken {
  text: string;
  fg: string;      // Hex кольору (напр. "#ffffff")
  bg: string;      // Hex кольору
  bold: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean; // Використовується також для відображення курсора
}
```

### 3.2. HistoryItem (Історія)
Основні типи повідомлень у масиві історії:
- `user`: `{ "type": "user", "text": "..." }`
- `gemini`: `{ "type": "gemini", "text": "..." }`
- `thinking`: `{ "type": "thinking", "thought": { "summary": "..." } }`
- `tool_group`: `{ "type": "tool_group", "tools": [ { "name": "...", "status": "Executing | Success | Error | Confirming" } ] }`
- `error | warning | info`: `{ "type": "...", "text": "..." }`

---

## 4. Сценарії використання (Recipes)

### 4.1. Авторизація через Google
1. Клієнт отримує `SESSION_INIT` з `authState: "authenticating"`.
2. Клієнт відправляє `AUTH_SUBMIT { "method": "google" }`.
3. CLI через `SHELL_OUTPUT` видає URL. Клієнт показує його як посилання.
4. Користувач переходить, копіює код.
5. Клієнт відправляє код через `SHELL_INPUT { "text": "CODE\n" }`.

### 4.2. Робота з sudo
1. Користувач відправляє `SEND_PROMPT { "text": "sudo apt update" }`.
2. Клієнт отримує `SHELL_OUTPUT` з текстом `[sudo] password:`.
3. Клієнт показує поле вводу пароля.
4. Клієнт відправляє `SHELL_INPUT { "text": "password\n" }`.
