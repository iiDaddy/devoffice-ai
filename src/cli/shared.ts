/** Small helpers shared by the CLI entry points. Console output only. */
import { loadConfig, redactConfig, type AppConfig } from '../shared/config.js';
import { isDevOfficeError } from '../shared/errors.js';

export function parseArgs(argv: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const arg of argv) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (match !== null) out[match[1] as string] = match[2] ?? 'true';
  }
  return out;
}

export function heading(text: string): void {
  console.log(`\n${'='.repeat(72)}\n${text}\n${'='.repeat(72)}`);
}

export function configOrExit(): AppConfig {
  try {
    return loadConfig();
  } catch (error) {
    if (isDevOfficeError(error)) {
      console.error(`\n[${error.code}] ${error.message}\n`);
    } else {
      console.error(error);
    }
    process.exit(2);
  }
}

export function describeConfig(config: AppConfig): void {
  for (const [key, value] of Object.entries(redactConfig(config))) {
    console.log(`  ${key.padEnd(34)} ${String(value)}`);
  }
}
