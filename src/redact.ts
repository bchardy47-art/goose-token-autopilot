const SECRET_KEYS = [
  'privatekey',
  'private_key',
  'secret',
  'seed',
  'mnemonic',
  'passphrase',
  'apikey',
  'api_key'
];

export function redactString(input: string): string {
  let output = input;
  for (const key of SECRET_KEYS) {
    const regex = new RegExp(`(${key}[^=:\\s]*[=:]\\s*)([^\\s,]+)`, 'gi');
    output = output.replace(regex, '$1[REDACTED]');
  }
  return output;
}

export function redactValue<T>(value: T): T {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'string') {
    return redactString(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item)) as T;
  }
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, current] of Object.entries(value as Record<string, unknown>)) {
      const normalized = key.toLowerCase();
      if (SECRET_KEYS.some((secretKey) => normalized.includes(secretKey))) {
        result[key] = current ? '[REDACTED]' : current;
      } else {
        result[key] = redactValue(current);
      }
    }
    return result as T;
  }
  return value;
}
