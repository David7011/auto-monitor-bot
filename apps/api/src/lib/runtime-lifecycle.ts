/** The actual process start, not merely the time this module was imported. */
export const apiStartedAt = new Date(Date.now() - process.uptime() * 1_000);
