# Інструкція з розгортання Gemini Remote System

Цей документ описує процес встановлення модифікованого Gemini CLI та Rust Оркестратора на новій машині.

## Крок 1: Встановлення модифікованого Gemini CLI

Для того, щоб оркестратор міг керувати сесіями, необхідно встановити версію CLI з підтримкою Remote API.

1. **Клонування та збірка:**
   ```bash
   git clone <url-вашого-репозиторію> gemini-cli
   cd gemini-cli
   npm install
   npm run build:all
   ```

2. **Глобальне встановлення:**
   Щоб команда `gemini` була доступна системі (її використовує оркестратор):
   ```bash
   cd packages/cli
   npm link
   ```
   *Перевірте доступність: `gemini --version`*

## Крок 2: Налаштування Оркестратора (Rust)

1. **Перейдіть до папки оркестратора:**
   ```bash
   cd ../../../gemini-remote-orchestrator
   ```

2. **Збірка проекту:**
   ```bash
   cargo build --release
   ```
   Бінарний файл буде знаходитись у `target/release/gemini-remote-orchestrator`.

## Крок 3: Запуск як системного сервісу (Linux/systemd)

Для стабільної роботи в фоні рекомендується використовувати systemd.

1. **Створення сервіс-файлу:**
   Створіть файл `/etc/systemd/system/gemini-orchestrator.service` (інструкція нижче).

2. **Активація:**
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable gemini-orchestrator
   sudo systemctl start gemini-orchestrator
   ```

## Параметри мережі
- **Оркестратор:** `ws://<IP-АДРЕСА>:8000/ws`
- **Динамічні порти для CLI:** 8100+ (відкриваються оркестратором автоматично)

---
**Важливо:** Переконайтеся, що порти 8000 та діапазон 8100-8200 відкриті у вашому Firewall.
