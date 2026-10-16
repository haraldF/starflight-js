/// <reference path="../src/capstone-js.d.ts" />

import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createForthEngine } from '../src/forth-decompiler.ts';
import { ForthBootRunner } from '../src/forth-boot.ts';

const usage = `Usage: npm run inspect -- <command> [options]

Commands:
  word <name|0xCFA>       Print metadata and decompiled definition
  callers <name|0xCFA>    List direct callers across all modules
  disasm <address>        Disassemble 16-bit x86 at a kernel runtime address
  dump <address>          Hex dump kernel bytes with little-endian words and ASCII
  code <address>          List words whose code pointer is the given address
  boot                   Print boot output, trace, and stop reason

Options:
  --module <name>        Lookup module (default: KERNEL)
  --entry <0xCFA>        Boot entry CFA (default: 0x0937)
  --steps <count>        Boot safety limit (default: 50000)
  --cga                  Boot with the image's CGA default instead of presetting ?EGA
  --bytes <count>        Disassembly/dump byte limit (default: 128 / 64)
  --count <count>        Disassembly instruction limit (default: 32)
  --help, -h            Show this help

Examples:
  npm run inspect -- word 'R/W'
  npm run inspect -- callers 'R/W'
  npm run inspect -- disasm 0x17b7 --bytes 64
  npm run inspect -- dump 0x0660 --bytes 16
  npm run inspect -- code 0x17b7
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

async function disassemble(address: number, byteCount: number, instructionCount: number): Promise<void> {
  const binary = new Uint8Array(await loadBinary('STARFLT.COM'));
  const offset = address - 0x100;
  if (offset >= binary.length) throw new Error('Address is outside STARFLT.COM.');
  const bytes = binary.subarray(offset, Math.min(offset + byteCount, 0xff00));
  const { default: createCapstone } = await import('@alexaltea/capstone-js');
  const capstone = await createCapstone();
  const decoder = new capstone.Capstone(capstone.ARCH_X86, capstone.MODE_16);
  try {
    const instructions = decoder.disasm(bytes, address, instructionCount);
    if (instructions.length === 0) throw new Error('No x86 instructions decoded.');
    for (const instruction of instructions) {
      const location = instruction.address.toString(16).padStart(4, '0');
      const encoded = instruction.bytes.map(byte => byte.toString(16).padStart(2, '0')).join(' ').padEnd(20, ' ');
      console.log(`${location}:  ${encoded} ${instruction.mnemonic.padEnd(8, ' ')} ${instruction.op_str}`.trimEnd());
    }
  } finally {
    decoder.close();
  }
}

async function dump(address: number, byteCount: number): Promise<void> {
  const binary = new Uint8Array(await loadBinary('STARFLT.COM'));
  const offset = address - 0x100;
  if (offset >= binary.length) throw new Error('Address is outside STARFLT.COM.');
  const bytes = binary.subarray(offset, Math.min(offset + byteCount, 0xff00, binary.length));
  for (let row = 0; row < bytes.length; row += 16) {
    const line = bytes.subarray(row, row + 16);
    const hex = Array.from(line, byte => byte.toString(16).padStart(2, '0')).join(' ').padEnd(47, ' ');
    const words: string[] = [];
    for (let index = 0; index + 1 < line.length; index += 2) {
      words.push((line[index] | (line[index + 1] << 8)).toString(16).padStart(4, '0'));
    }
    const ascii = Array.from(line, byte => byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.').join('');
    console.log(`${(address + row).toString(16).padStart(4, '0')}:  ${hex}  ${words.join(' ').padEnd(39, ' ')}  ${ascii}`);
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      module: { type: 'string' },
      entry: { type: 'string' },
      steps: { type: 'string' },
      cga: { type: 'boolean' },
      bytes: { type: 'string' },
      count: { type: 'string' },
      help: { type: 'boolean', short: 'h' }
    }
  });
  if (values.help || positionals.length === 0) {
    console.log(usage);
    return;
  }

  const [command, query = ''] = positionals;
  if (!['word', 'callers', 'boot', 'disasm', 'dump', 'code'].includes(command)) {
    throw new Error(`Unknown command '${command}'. Use --help for usage.`);
  }
  if (positionals.length !== (command === 'boot' ? 1 : 2)) {
    throw new Error(`${command} expects ${command === 'boot' ? 'no positional arguments' : ['disasm', 'dump', 'code'].includes(command) ? 'one runtime address' : 'one word name or CFA'}.`);
  }
  if (command !== 'boot' && (values.entry !== undefined || values.steps !== undefined || values.cga !== undefined)) {
    throw new Error('--entry, --steps, and --cga are only valid for boot.');
  }
  if (!['word', 'callers', 'code'].includes(command) && values.module !== undefined) {
    throw new Error('--module is only valid for word, callers, and code.');
  }
  if (command !== 'disasm' && command !== 'dump' && values.bytes !== undefined) {
    throw new Error('--bytes is only valid for disasm and dump.');
  }
  if (command !== 'disasm' && values.count !== undefined) {
    throw new Error('--count is only valid for disasm.');
  }
  if (command === 'dump') {
    const address = parseInteger(query, 'Address', 0x100, 0xffff);
    await dump(address, parseInteger(values.bytes ?? '64', '--bytes', 1, 0x10000));
    return;
  }
  if (command === 'disasm') {
    const address = parseInteger(query, 'Address', 0x100, 0xffff);
    const byteCount = parseInteger(values.bytes ?? '128', '--bytes', 1, 0x10000);
    const instructionCount = parseInteger(values.count ?? '32', '--count', 1, 0x10000);
    await disassemble(address, byteCount, instructionCount);
    return;
  }
  const entry = parseInteger(values.entry ?? '0x0937', '--entry', 0, 0xffff);
  const steps = parseInteger(values.steps ?? '50000', '--steps', 1, Number.MAX_SAFE_INTEGER);
  const codeAddress = command === 'code' ? parseInteger(query, 'Address', 0, 0xffff) : 0;
  const identifier = /^0x/i.test(query) ? parseInteger(query, 'CFA', 0, 0xffff) : query;

  const [stara, starb, starflt, dictionaryText] = await Promise.all([
    loadBinary('STARA.COM'),
    loadBinary('STARB.COM'),
    loadBinary('STARFLT.COM'),
    readFile(new URL('../public/forth-dict.json', import.meta.url), 'utf8')
  ]);
  const engine = await createForthEngine(stara, starb, starflt, JSON.parse(dictionaryText));

  if (command === 'boot') {
    const result = new ForthBootRunner(engine, new Uint8Array(starflt), {
      stara: new Uint8Array(stara),
      starb: new Uint8Array(starb)
    }, { ega: !values.cga }).run(entry, steps);
    if (result.output) console.log(`Output:\n${result.output}\n`);
    console.log(result.trace.join('\n'));
    return;
  }

  if (values.module !== undefined && !engine.modules.includes(values.module)) throw new Error(`Unknown module '${values.module}'.`);
  if (command === 'code') {
    const matches = engine.words.filter(candidate => candidate.codep === codeAddress
      && (values.module === undefined || candidate.module === values.module));
    for (const match of matches) {
      console.log(`${match.module}:${match.name}  CFA ${match.cfaHex}  PFA ${match.pfaHex}  type ${match.type}`);
    }
    console.log(`\n${matches.length} word(s) with code pointer 0x${codeAddress.toString(16).padStart(4, '0')}.`);
    return;
  }

  const module = values.module ?? 'KERNEL';
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