# Глубокий аудит Auto Monitor Bot 0.3.0

Дата: 21.07.2026.

## Итог

Проект переведён из состояния «функционально сильный, но с несколькими критическими эксплуатационными краями» в качественную локальную production-систему. Критические дефекты полноты OLX, автозапуска, ACL, открытых ZIP-бэкапов, login rate limit, API validation, watchdog и supply chain устранены.

Итоговая честная оценка: **9,5/10**.

Оценка не округлена до 10/10, потому что абсолютная полнота внешнего OLX без официального event API, CAPTCHA сторонних сайтов, отказ единственного ноутбука и app-layer HTTPS нельзя гарантировать только изменениями этого репозитория.

| Область | Оценка | Состояние |
|---|---:|---|
| OLX realtime и backfill | 9,6 | Быстрый одностраничный hot path, доказанные границы, recovery и журнал наблюдений |
| Надёжность локального runtime | 9,7 | Boot-start, watchdog recovery, pinned runtime, проверенный backup |
| Безопасность | 9,4 | ACL, Redis limiter, SSRF, secret-free ZIP, SHA-256 supply chain |
| Тесты и сборка | 9,7 | 101 unit/integration, 4 E2E, Android lint/unit, production builds |
| Наблюдаемость | 9,5 | Per-source health/latency, cursor API, очереди и план поиска |
| Поддерживаемость | 8,8 | Хорошая структура, но несколько модулей остаются слишком крупными |

## Проверенный результат

- `pnpm check`: Prisma schema, TypeScript, ESLint, PowerShell validation, 23 test files / 101 tests и все production builds — успешно.
- `pnpm audit --prod --audit-level high`: известных production-уязвимостей нет.
- Playwright 1.61.1 / Chromium: 4 из 4 авторизованных E2E-сценариев прошли, включая mobile UI и реальный stop/start.
- Android: Gradle 9.3.1, 38 задач, unit test и release lint — успешно.
- Живой health: API `OK`, PostgreSQL `OK`, Redis `OK`, monitoring `RUNNING`, failed queues `0`.
- `workers=WARN` является ожидаемым: сам worker жив, но RST показывает CAPTCHA, а AutoMoto имеет ограниченную точность. Эти внешние состояния больше не вызывают restart-loop.
- Watchdog проверен реальным убийством API: новый процесс поднялся автоматически, API/DB/Redis вернулись в `OK`, monitoring сохранился `RUNNING`.
- Ежедневная backup-задача вручную проверена: `LastTaskResult=0`, следующий запуск — 03:15.
- Зашифрованный backup проверен через `pg_restore --list` и `7z t`; рядом сохранены SHA-256 и JSON metadata.
- Некорректные `limit` для listings/logs возвращают `400`; cursor pagination и `nextCursor` проверены на живом API.

## Главный результат OLX

До финального исправления один пустой realtime-проход OLX повторно считал старые корректно распознанные ID неизвестными:

```text
5 страниц, 10 запросов, 541 наблюдение, примерно 2,6 с
```

После сохранения только безопасно классифицированных ID:

```text
1 страница, 2 запроса, 120–121 наблюдение, 0,44–0,56 с
```

Результат — примерно пятикратное сокращение работы hot path и запросов при сохранении интервала 4 ± 1 секунды. ID с ошибкой нормализации и необработанный candidate overflow намеренно не записываются как известные, поэтому ускорение не создаёт скрытого пропуска.

Дополнительно:

- старая/promoted карточка перед свежей не останавливает pagination;
- граница известности требует all-known выдачу или непрерывный известный хвост;
- полностью старая страница является достоверной cutoff-границей;
- feed error и candidate overflow запрещают ложный anchor/cutoff;
- `lastCompletedCutoff` меняется только после доказанного достижения границы;
- глубокий backfill остаётся независимым от realtime;
- исходные кандидаты сохраняются до фильтрации и доступны для replay;
- первое Telegram-сообщение отправляется до тяжёлого enrichment.

## Безопасность

- Корневой ACL и критические файлы доступны для записи только текущему пользователю, `BUILTIN\Administrators` и `NT AUTHORITY\SYSTEM`.
- Установщик `SYSTEM`-автозапуска проверяет ACL до регистрации задач.
- Dashboard login limiter хранится в Redis и работает fail-closed при недоступности limiter.
- BFF отправляет в API SHA-256 fingerprint клиента, не раскрывая исходные данные в Redis key.
- SSRF-защита блокирует private/loopback/link-local/documentation/benchmark и другие специальные IPv4/IPv6 диапазоны.
- Приватная ZIP-упаковка запрещена. Флаг database backup также больше не может положить открытый dump в ZIP.
- Node 24.18.0, Microsoft OpenJDK 17.0.19, Android command-line tools и Gradle 9.3.1 проверяются по официальным SHA-256.
- GitHub Actions закреплены по commit SHA; добавлены CodeQL и Dependabot.

## Автозапуск и локальная модель

- `Auto Monitor Bot`: только `MSFT_TaskBootTrigger`, `SYSTEM`, `Highest`.
- Триггер входа пользователя удалён, поэтому логин Windows не создаёт второй restart.
- Watchdog запускается каждую минуту и реагирует на локальную liveness-ошибку, а не на CAPTCHA отдельного сайта.
- Проект работает с момента загрузки Windows до ручного выключения ноутбука.
- API/Dashboard слушают loopback; удалённый доступ остаётся приватным внутри Tailscale.

## Очистка

- Удалены все найденные внешние ZIP-копии проекта, включая старые архивы с секретами.
- В рабочем дереве нет project ZIP вне runtime/dependency-компонентов.
- C: очищен только от безопасного мусора: 1748 старых Temp-файлов, CrashDumps, глобального Playwright cache, Gradle cache и shader caches.
- Свободное место C: увеличилось примерно с 0,65 до 2,46 ГБ; Downloads, браузерные профили, OpenAI/Discord/Steam и личные файлы не затрагивались.
- Старые Playwright Chromium runtime удалены после установки текущего браузера на D:.

## Оставшиеся минусы

1. **Нет абсолютной внешней гарантии OLX.** Публичная выдача не является договорным event stream; сайт может задержать индексирование, изменить формат или скрыть часть результатов.
2. **RST CAPTCHA.** Это внешняя защита. Проект корректно ставит паузу и не атакует сайт повторами, но не обходит CAPTCHA.
3. **Tailscale HTTP внутри туннеля.** Транспорт уже шифруется WireGuard/Tailscale, но для app-layer HTTPS требуется одноразово включить Tailscale HTTPS; после этого можно отключить Android cleartext.
4. **Single-host модель.** При выключенном или физически неисправном ноутбуке система недоступна. Локальный encrypted backup на том же диске не защищает от поломки всего накопителя.
5. **Крупные модули.** `telegram-control-bot.ts` (~1322 строки), `olx.ts` (~1013), dashboard filters (~950) и `vehicle-check.ts` (~814) стоит разделить по доменам.
6. **Major-обновления отложены.** Prisma 7, Next 16, Zod 4, Vitest 4 и другие major-ветки требуют отдельной миграции. Текущие версии проходят audit и regression suite.
7. **CI подготовлен, но не подтверждён удалённым runner.** Репозиторий и workflow готовы локально; без подключённого GitHub remote нельзя доказать результат GitHub-hosted job.
8. **Docker images закреплены по major tag, не digest.** Для локального Windows runtime это не влияет на текущую работу, но строгий reproducible Docker deployment потребует digest pinning.

## Приоритет следующего этапа

1. Включить Tailscale HTTPS и убрать cleartext из Android manifest.
2. Копировать зашифрованный backup на отдельный физический носитель без публикации самого сервиса.
3. Провести major-миграции отдельной веткой с полным E2E.
4. Разбить четыре крупнейших модуля без изменения поведения.
5. При необходимости подключить независимый inventory oracle для количественной сверки покрытия OLX.
