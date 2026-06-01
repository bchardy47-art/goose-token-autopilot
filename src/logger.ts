import { redactString, redactValue } from './redact';

export class AppLogger {
  public readonly entries: string[] = [];

  constructor(private readonly consoleEnabled = true) {}

  private write(level: string, message: string, meta?: unknown): void {
    const safeMessage = redactString(message);
    const safeMeta = meta === undefined ? '' : ` ${JSON.stringify(redactValue(meta))}`;
    const line = `[${level}] ${safeMessage}${safeMeta}`;
    this.entries.push(line);
    if (this.consoleEnabled) {
      console.log(line);
    }
  }

  info(message: string, meta?: unknown): void {
    this.write('INFO', message, meta);
  }

  warn(message: string, meta?: unknown): void {
    this.write('WARN', message, meta);
  }

  error(message: string, meta?: unknown): void {
    this.write('ERROR', message, meta);
  }
}
