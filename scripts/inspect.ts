import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createForthEngine } from '../src/forth-decompiler.ts';
import { ForthBootRunner } from '../src/forth-boot.ts';

const usage = `Usage: npm run inspect -- <command> [options]

Commands:
  word <name|0xCFA>       Print metadata and decompiled definition
  callers <name|0xCFA>    List direct callers across all modules
  boot                   Print boot output, trace, and stop reason

Options:
  --module <name>        Lookup module (default: KERNEL)
  --entry <0xCFA>        Boot entry CFA (default: 0x0937)
  --steps <count>        Boot safety limit (default: 50000)
  --help, -h            Show this help

Examples:
  npm run inspect -- word 'R/W'
  npm run inspect -- callers 'R/W'
  npm run inspect -- boot --steps 50000`;

function parseInteger(value: string, label: string, minimum: number, maximum: number): number {
  if (!/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value)) {
    throw new Error(`${label} must be a decimal integer or a 0x-prefixed hex integer.`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}.`);
  }
  return number;
}

async function loadBinary(name: string): Promise<ArrayBuffer> {
  const bytes = await readFile(new URL(`../public/${name}`, import.meta.url));
  return Uint8Array.from(bytes).buffer;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      module: { type: 'string' },
      entry: { type: 'string' },
      steps: { type: 'string' },
      help: { type: 'boolean', short: 'h' }
    }
  });
  if (values.help || positionals.length === 0) {
    console.log(usage);
    return;
  }

  const [command, query = ''] = positionals;
  if (!['word', 'callers', 'boot'].includes(command)) {
    throw new Error(`Unknown command '${command}'. Use --help for usage.`);
  }
  if (positionals.length !== (command === 'boot' ? 1 : 2)) {
    throw new Error(`${command} expects ${command === 'boot' ? 'no positional arguments' : 'one word name or CFA'}.`);
  }
  if (command !== 'boot' && (values.entry !== undefined || values.steps !== undefined)) {
    throw new Error('--entry and --steps are only valid for boot.');
  }
  if (command === 'boot' && values.module !== undefined) {
    throw new Error('boot always starts in KERNEL; --module is only valid for word and callers.');
  }
  const entry = parseInteger(values.entry ?? '0x0937', '--entry', 0, 0xffff);
  const steps = parseInteger(values.steps ?? '50000', '--steps', 1, Number.MAX_SAFE_INTEGER);
  const identifier = /^0x/i.test(query) ? parseInteger(query, 'CFA', 0, 0xffff) : query;

  const [stara, starb, starflt, dictionaryText] = await Promise.all([
    loadBinary('STARA.COM'),
    loadBinary('STARB.COM'),
    loadBinary('STARFLT.COM'),
    readFile(new URL('../public/forth-dict.json', import.meta.url), 'utf8')
  ]);
  const engine = await createForthEngine(stara, starb, starflt, JSON.parse(dictionaryText));

  if (command === 'boot') {
    const result = new ForthBootRunner(engine, new Uint8Array(starflt)).run(entry, steps);
    if (result.output) console.log(`Output:\n${result.output}\n`);
    console.log(result.trace.join('\n'));
    return;
  }

  const module = values.module ?? 'KERNEL';
  if (!engine.modules.includes(module)) throw new Error(`Unknown module '${module}'.`);
  const word = engine.words.find(candidate => candidate.module === module && (
    typeof identifier === 'number'
      ? candidate.cfa === identifier
      : candidate.name.toUpperCase() === identifier.toUpperCase()
  ));
  if (!word) throw new Error(`No word '${query}' in ${module}.`);

  console.log(`${word.module}:${word.name}  CFA ${word.cfaHex}  PFA ${word.pfaHex}  code ${word.codepHex}`);
  if (command === 'word') {
    console.log(`${word.typeLabel}\n\n${word.decompiled}`);
    return;
  }

  let count = 0;
  for (const caller of engine.words) {
    const calls = caller.tokens.filter(token => {
      if (token.kind !== 'call' || token.cfa !== word.cfa) return false;
      const candidates = engine.wordsByCfa.get(token.cfa) ?? [];
      const target = candidates.find(candidate => candidate.module === caller.module)
        ?? candidates.find(candidate => candidate.module === 'KERNEL')
        ?? (candidates.length === 1 ? candidates[0] : undefined);
      return target === word;
    });
    if (calls.length === 0) continue;
    count++;
    console.log(`\n${caller.module}:${caller.name}  CFA ${caller.cfaHex}  calls at ${calls.map(token => token.addrHex).join(', ')}`);
    console.log(caller.decompiled);
  }
  console.log(`\n${count} direct caller(s). Indirect EXECUTE calls are not included.`);
}

main().catch((error: unknown) => {
  console.error(`inspect: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});