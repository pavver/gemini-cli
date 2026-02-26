# Повна специфікація Gemini Remote API (v1.0)

Цей документ є вичерпним технічним стандартом для взаємодії з Gemini CLI
дистанційно. Він містить опис протоколу, структур даних та сценаріїв
використання, необхідних для створення клієнтів (веб-панелей, мобільних додатків
або IDE плагінів).

---

## 1. Архітектурний огляд

Система працює за дворівневою моделлю:

1.  **Оркестратор (Rust)**: Керує запуском процесів CLI, tmux-сесіями та
    маршрутизацією трафіку. Працює на порту `8000`.
2.  **Gemini CLI (Node.js)**: Безпосередній "мозок", який надає WebSocket API
    для керування конкретною сесією. Працює на порту `8080` (за замовчуванням).

Всі повідомлення передаються у форматі **JSON** через **WebSocket**.

---

## 2. З'єднання та Авторизація

**WebSocket URL:** `ws://<host>:<port>/remote`

При підключенні CLI автоматично надсилає повідомлення `SESSION_INIT`. Якщо
клієнт хоче отримати актуальний стан пізніше (наприклад, після перезавантаження
сторінки), він має надіслати `SESSION_STATE_REQUEST`.

---

## 3. Вихідні повідомлення (CLI -> Client)

Ці повідомлення надсилаються сервером для оновлення стану інтерфейсу.

### 3.1. `SESSION_INIT`

Надсилається при першому підключенні. Містить зріз останніх 50 повідомлень
історії та повний системний статус.

```json
{
  "type": "SESSION_INIT",
  "payload": {
    "apiVersion": 1,
    "sessionId": "string",
    "history": HistoryItem[], // Останні 50 елементів
    "config": {
      "model": "string | undefined",
      "approvalMode": "default | yolo | plan | auto_edit"
    },
    "streamingState": "idle | responding | waiting_for_confirmation",
    "activePtyId": number | null,
    "status": SystemStatus,
    "commands": { "name": "string", "description": "string" }[],
    "authState": "authenticating | authenticated"
  }
}
```

### 3.2. `HISTORY_UPDATE`

Надсилається реактивно, коли в чаті з'являється нове повідомлення, виклик
інструменту або системний лог.

```json
{ "type": "HISTORY_UPDATE", "payload": { "item": HistoryItem } }
```

### 3.3. `HISTORY_RESPONSE` (Пагінація)

Відповідь на запит `HISTORY_REQUEST`. Дозволяє підвантажувати старі
повідомлення.

```json
{
  "type": "HISTORY_RESPONSE",
  "payload": {
    "items": HistoryItem[],
    "offset": number, // Скільки повідомлень пропущено з кінця
    "limit": number,  // Кількість запрошених повідомлень
    "total": number   // Загальна кількість повідомлень у всій історії
  }
}
```

### 3.4. `STATUS_UPDATE`

Надсилається **реактивно** при будь-якій зміні стану (модель, токени, гілка Git,
зміна CWD).

```json
{
  "type": "STATUS_UPDATE",
  "payload": {
    "model": "string",
    "ramUsage": "string (напр. '125.4 MB')",
    "contextTokens": number,
    "geminiMdFileCount": number,
    "skillsCount": number,
    "mcpServers": [ { "name": "string", "status": "connected | disabled" } ],
    "cwd": "string (повний шлях)",
    "gitBranch": "string | null",
    "platform": "linux | darwin | win32"
  }
}
```

### 3.5. `SHELL_OUTPUT`

Сирі дані з активного термінала (PTY). Може містити ANSI-коди або структурований
масив токенів.

```json
{ "type": "SHELL_OUTPUT", "payload": { "chunk": "string | AnsiOutput" } }
```

### 3.6. `SEARCH_RESPONSE`

Результати автодоповнення для файлів або команд.

```json
{
  "type": "SEARCH_RESPONSE",
  "payload": {
    "query": "string",
    "suggestions": [
      {
        "label": "file.ts",
        "value": "src/file.ts",
        "type": "file | folder | command",
        "description": "string"
      }
    ]
  }
}
```

---

## 4. Вхідні команди (Client -> CLI)

Команди, які клієнт надсилає для керування системою.

| Тип Команди             | Payload                                                   | Опис                                                   |
| :---------------------- | :-------------------------------------------------------- | :----------------------------------------------------- | --------------------------------------------- | --------------------------------------------- |
| `SEND_PROMPT`           | `{ "text": "string" }`                                    | Відправка повідомлення в чат або `/команди`.           |
| `STOP_GENERATION`       | `null`                                                    | Негайне переривання відповіді Gemini.                  |
| `HISTORY_REQUEST`       | `{ "offset": number, "limit": number }`                   | Запит на отримання частини історії (для Lazy Loading). |
| `SHELL_INPUT`           | `{ "text": "string" }`                                    | Відправка вводу в активний термінал (PTY).             |
| `RESIZE_TERMINAL`       | `{ "cols": number, "rows": number }`                      | Синхронізація розміру вікна термінала.                 |
| `SEARCH_REQUEST`        | `{ "query": "string", "type": "at                         | slash" }`                                              | Запит на пошук файлів (`@`) або команд (`/`). |
| `AUTH_SUBMIT`           | `{ "method": "google                                      | api_key", "apiKey": "string" }`                        | Передача ключа або ініціація входу.           |
| `CONFIRMATION_RESPONSE` | `{ "id": number, "confirmed": bool, "choice": "string" }` | Відповідь на запит підтвердження дії.                  |
| `SESSION_STATE_REQUEST` | `{ "apiVersion": number }`                                | Вимога до CLI переслати стан (Handshake).              |
| `SET_CONFIG`            | `{ "approvalMode": "yolo                                  | plan                                                   | default" }`                                   | Зміна режиму схвалення для автономної роботи. |

---

## 5. Детальні структури даних

### 5.1. HistoryItem

Кожен елемент історії має унікальний `id`. Основні типи:

- **User/Gemini**: `{ "type": "user | gemini", "text": "..." }`
- **Tool Group**: Містить масив викликів інструментів з їх **аргументами** та
  статусом.
  ```json
  {
    "type": "tool_group",
    "tools": [
      {
        "callId": "string",
        "name": "replace",
        "args": {
          "file_path": "src/main.ts",
          "old_string": "const x = 1;",
          "new_string": "const x = 2;"
        },
        "status": "Success | Error | Executing",
        "description": "Updating file..."
      }
    ]
  }
  ```
- **Thinking**: `{ "type": "thinking", "thought": { "summary": "..." } }`
- **System Messages**: `info`, `warning`, `error`.

---

## 6. Відображення змін у файлах (Diffs)

Клієнт може будувати візуальні дифи (як у VS Code), використовуючи аргументи
інструментів:

1.  Перехоплюйте повідомлення `HISTORY_UPDATE` або `tool_group` у
    `SESSION_INIT`.
2.  Якщо інструмент — `replace`, використовуйте `old_string` та `new_string`.
3.  Якщо інструмент — `write_file`, використовуйте `content` (новий вміст
    файлу).
4.  Рекомендується використовувати бібліотеки типу `diff-match-patch` для
    генерації HTML-диффів.

---

## 7. Автономна робота та Режими

CLI підтримує автономне виконання навіть після відключення клієнта:

1.  **Режим YOLO**: Надішліть `SET_CONFIG { "approvalMode": "yolo" }`. Після
    цього CLI буде автоматично схвалювати всі дії.
2.  **Сесії**: Оскільки CLI працює через Оркестратор, процес не переривається
    при закритті WebSocket. Ви можете підключитися пізніше і побачити результат
    роботи в історії.

---

## 8. Логіка пагінації (Рекомендації для Клієнта)

Для ефективної роботи з великою історією клієнт має:

1.  Завантажити останні 50 повідомлень з `SESSION_INIT`.
2.  При прокрутці вгору (scroll to top), надсилати `HISTORY_REQUEST`:
    - `offset`: кількість повідомлень, які вже є в кеші клієнта.
    - `limit`: бажана кількість нових повідомлень (рекомендується 20-30).
3.  Отримані `items` з `HISTORY_RESPONSE` додавати в початок локального списку.

---

## 9. Безпека

1.  **Strict Validation**: CLI ігнорує будь-які повідомлення з неправильною
    структурою або типом даних.
2.  **Explicit Activation**: Remote API не працює, якщо він не увімкнений явно
    через налаштування або змінну оточення `GEMINI_REMOTE_ENABLED=true`.
3.  **Confirmation Flow**: Навіть дистанційно, небезпечні дії (видалення файлів,
    запуск shell) вимагають відповіді через `CONFIRMATION_RESPONSE`.
