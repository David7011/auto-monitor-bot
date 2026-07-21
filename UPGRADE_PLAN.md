# План апгрейда Auto Monitor Bot

Статус на 22.07.2026: этап 0.4.0 выполнен и переведён в live.

## Выполнено

1. Windows lifecycle переведён на долгоживущий `SYSTEM`-supervisor с boot+logon triggers, стабильной readiness-проверкой, коалесингом запусков, отдельными журналами попыток и минутным watchdog.
2. Fast Startup/гибернация отключены. Включение ноутбука гарантированно даёт полный boot, сон S3 сохранён, C: получил около 6,1 ГБ свободного места.
3. OLX hot path сохранён на 4 ± 1 секунде. HTML, regional и private shadow coverage вынесены в низкочастотные независимые lanes с per-fingerprint состоянием в PostgreSQL.
4. Добавлены структурированные OLX coverage metrics и прямой parity test. Финальная контрольная сверка: 213 из 213 доступных ID уже присутствовали в search state/journal; private lane обнаружил 47 дополнительных к fast-feed ID, HTML lane — ещё 3.
5. Observation replay, coverage-gap backfill, candidate overflow guard и безопасные cutoff/anchor правила сохранены; CAPTCHA обход не добавлялся.
6. База получила почасовые агрегаты старых collector runs, дедупликацию error log со счётчиками и транзакционную очистку legacy/orphan данных.
7. Backup получил optional mirror на другой том/UNC, реальный restore drill и еженедельную задачу. Проверено восстановление 2 фильтров и 942 объявлений во временную БД.
8. Dashboard session отделён от API token. Журнал показывает occurrence count и сортируется по последнему повтору.
9. Next.js обновлён 15 → 16.2.11 без build warnings; Prisma 6 → 7.9.0 с PostgreSQL driver adapter. Safe patch-зависимости обновлены.
10. OLX coverage scheduler и Telegram formatting выделены из крупных модулей. Добавлены тесты fingerprint scheduling, auth-secret isolation и error-log fingerprint.
11. Установлены и проверены четыре Windows-задачи: supervisor, watchdog, daily backup, weekly restore drill.
12. Добавлены fault-injection recovery, OLX parity, database restore и safe cleanup commands.
13. Финальный fault-injection подтвердил автоматическое восстановление принудительно завершённого API за 44 секунды.

## Внешние ограничения

- OLX не предоставляет проекту договорной event stream, поэтому код не может доказать наличие объявления, которое сама доступная выдача ещё не показывает. Максимально возможная проверка выполняется через API, exact-city HTML, regional и private lanes.
- Tailscale HTTPS проверен, но аккаунт возвращает `your Tailscale account does not support getting TLS certs`. До изменения внешней настройки остаётся tailnet-only TCP, защищённый WireGuard.
- RST периодически показывает CAPTCHA. Проект корректно ставит cooldown и не усиливает блокировку агрессивными повторами.
- Локальный single-host остаётся недоступен при выключенном/физически неисправном ноутбуке. Для защиты от поломки всего диска нужно указать внешний `BACKUP_MIRROR_PATH`.
- GitHub remote не подключён, поэтому подготовленные CI workflows нельзя подтвердить запуском GitHub-hosted runner из этого компьютера.

## Команды приёмки

```powershell
.\amb.cmd check:full
.\amb.cmd test:e2e
.\amb.cmd audit:prod
.\amb.cmd db:restore:test
.\amb.cmd test:recovery
.\amb.cmd test:olx-parity
.\amb.cmd local:status
```
