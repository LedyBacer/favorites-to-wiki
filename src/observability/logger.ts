import pino from "pino";

export function createLogger(level: string) {
  return pino({
    level,
    redact: ["TELEGRAM_BOT_TOKEN", "token", "*.token"],
  });
}
