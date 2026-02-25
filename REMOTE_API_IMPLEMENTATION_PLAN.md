# Gemini CLI Remote API Implementation Plan

План розробки WebSocket API для дистанційного керування.

## Етап 1: Сервісний рівень (Core logic)

1.  **Створення `RemoteApiService.ts`**:
    - Пакет: `packages/cli/src/services/RemoteApiService.ts`
    - Функціонал:
      - Запуск WebSocket сервера (використовуючи `ws`).
      - Управління списком підключених клієнтів.
      - Трансляція вхідних повідомлень (Broadcast).
      - Прийом та обробка вхідних команд.
2.  **Інтеграція в `AppContainer.tsx`**:
    - Створення хука `useRemoteApi(uiState, uiActions)`.
    - Підписка на зміну `uiState.history`.
    - Перехоплення `coreEvents` для трансляції (output, console-log).
    - Мапінг `uiActions` для віддаленого виклику (handleFinalSubmit).

## Етап 2: Налаштування та запуск

1.  **Додавання налаштувань**:
    - Оновити `settings.json` (та `settings.schema.json`) параметром
      `remote.enabled` (default: false) та `remote.port` (default: 8080).
2.  **Точка входу**:
    - Ініціалізація `RemoteApiService` у `gemini.tsx` або всередині
      `AppContainer` (якщо він залежить від React-контексту).

## Етап 3: Тестування та валідація

1.  **Unit-тести**:
    - Перевірка коректності серіалізації `HistoryItem` у JSON.
    - Перевірка обробки команд `SEND_PROMPT` та `CONFIRMATION_RESPONSE`.
2.  **Інтеграційні тести**:
    - Запуск CLI з активним Remote API та перевірка підключення через простий
      WebSocket-клієнт.

## Етап 4: Кінцеві штрихи

1.  **Безпека**:
    - За замовчуванням сервер слухає лише `localhost`.
    - Додати можливість вибору хоста.
2.  **Документація**:
    - Оновити README з інструкцією по запуску Remote API.
