import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { CLEAN_OPTIONS, PIPELINE_OPTIONS, runClean, type CommandResult } from './clean.ts';
import { EDIT_OPTIONS, runEdit, type OptionToken } from './edit.ts';
import { errorLine, toCliError, usage } from './errors.ts';
import { SHORT_USAGE, helpText } from './help.ts';
import { runInspect } from './inspect.ts';

/** Set by the CLI build from package.json. Running from source prints "dev". */
declare const __PIXEL_UNSLOP_VERSION__: string | undefined;
const VERSION = typeof __PIXEL_UNSLOP_VERSION__ === 'string' ? __PIXEL_UNSLOP_VERSION__ : 'dev';

const INSPECT_OPTIONS = PIPELINE_OPTIONS;

function write(stream: NodeJS.WriteStream, text: string): void {
  stream.write(text.endsWith('\n') ? text : `${text}\n`);
}

function parse<T extends ParseArgsOptionsConfig>(args: string[], options: T) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true, tokens: true });
  } catch (error) {
    throw usage((error as Error).message.replace(/\. To specify a positional argument.*$/s, '.'));
  }
}

function run(argv: string[]): { result: CommandResult | null; json: boolean } {
  const [command, ...rest] = argv;
  const json = rest.includes('--json');
  if (!command) {
    write(process.stdout, SHORT_USAGE);
    return { result: null, json: false };
  }
  if (command === '--version' || command === '-v' || command === 'version') {
    write(process.stdout, json ? JSON.stringify({ ok: true, version: VERSION }) : VERSION);
    return { result: null, json };
  }
  if (command === 'help' || command === '--help' || command === '-h') {
    const text = helpText(rest[0]);
    if (text === null) throw usage(`Unknown help topic "${rest[0]}". Topics: clean, inspect, edit.`);
    write(process.stdout, text);
    return { result: null, json: false };
  }
  if (rest.includes('--help') || rest.includes('-h')) {
    const text = helpText(command);
    if (text !== null) {
      write(process.stdout, text);
      return { result: null, json: false };
    }
  }
  switch (command) {
    case 'clean': {
      const { values, positionals } = parse(rest, CLEAN_OPTIONS);
      return { result: runClean(positionals, values), json: !!values.json };
    }
    case 'inspect': {
      const { values, positionals } = parse(rest, INSPECT_OPTIONS);
      return { result: runInspect(positionals, values), json: !!values.json };
    }
    case 'edit': {
      const { values, positionals, tokens } = parse(rest, EDIT_OPTIONS);
      const ordered: OptionToken[] = tokens.flatMap((token) => (token.kind === 'option' ? [{ name: token.name, value: token.value }] : []));
      return { result: runEdit(positionals, values, ordered), json: !!values.json };
    }
    default:
      throw usage(`Unknown command "${command}". Commands: clean, inspect, edit, help. Run "pixel-unslop help".`);
  }
}

function main(): number {
  const argv = process.argv.slice(2);
  try {
    const { result, json } = run(argv);
    if (!result) return 0;
    if (json) write(process.stdout, JSON.stringify(result.json, null, 2));
    else for (const line of result.lines) write(process.stdout, line);
    for (const line of result.errors) write(process.stderr, line);
    return result.exitCode;
  } catch (error) {
    const failure = toCliError(error);
    write(process.stderr, errorLine(failure));
    if (argv.includes('--json')) write(process.stdout, JSON.stringify({ ok: false, error: { code: failure.code, message: failure.message } }, null, 2));
    return failure.exitCode;
  }
}

// A closed pipe (for example "| head") ends the output quietly instead of a crash.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') throw error;
  });
}

process.exitCode = main();
