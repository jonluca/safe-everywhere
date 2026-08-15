export function sanitizeMessage(value: string): string {
  return value.replace(/https?:\/\/[^\s"']+/giu, "[redacted-url]");
}

export function errorMessage(error: unknown): string {
  return sanitizeMessage(error instanceof Error ? error.message : String(error));
}
