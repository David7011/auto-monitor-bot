# Rollback plan

Use this if the HP fails after cutover.

1. Disable the four Auto Monitor Bot scheduled tasks on the HP.
2. Stop the HP project with `scripts\stop.ps1 -All`.
3. Confirm the HP no longer owns ports 3001, 4000, 55432 or 6380 and no project Node/supervisor/watchdog process remains.
4. Preserve HP logs and database; do not delete or reset them.
5. On the old laptop, confirm its project and database were not modified or removed.
6. Re-enable the four old scheduled tasks.
7. Start the old project and run `amb.cmd local:status`.
8. Check queue counts and PostgreSQL health before allowing monitoring to resume.
9. Confirm OLX realtime freshness, startup recovery boundary and exactly one Telegram producer.
10. Record the HP failure and compare any HP-only observations before attempting another cutover.

If the HP accepted new durable observations before failure, do not blindly overwrite either database. Stop both instances and reconcile by observation/listing identifiers first. That case requires manual review.

Never solve rollback by deleting Redis keys, removing database directories, resetting Git or cleaning the old laptop.
