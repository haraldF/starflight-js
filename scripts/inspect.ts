/// <reference path="../src/capstone-js.d.ts" />

import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createForthEngine } from '../src/forth-decompiler.ts';
import { BIOS_KEYS, ForthBootRunner, biosKey, screenLines, type ForthGraphicsScreen, type TimedKey } from '../src/forth-boot.ts';

const usage = `Usage: npm run inspect -- <command> [options]

Commands:
  word <name|0xCFA>       Print metadata and decompiled definition
  callers <name|0xCFA>    List direct callers across all modules
  disasm <address>        Disassemble 16-bit x86 at a runtime address (kernel or --module overlay)
  dump <address>          Hex dump bytes with little-endian words and ASCII (kernel or --module overlay)
  code <address>          List words whose code pointer is the given address
  boot                   Print boot output, trace, and stop reason

Options:
  --module <name>        Lookup module (default: KERNEL); for dump/disasm, an overlay at its load address
  --entry <0xCFA>        Boot entry CFA (default: 0x0937)
  --steps <count>        Boot safety limit (default: 50000)
  --cga                  Boot with the image's CGA default instead of presetting ?EGA
  --keys <text>          Keys typed ahead for boot: characters, or {Enter}, {Escape},
                         {ArrowUp}, {F1}, ... (KeyboardEvent.key names)
  --key-at <step>:<text> Press keys once the run reaches a step (repeatable), e.g.
                         --key-at '4800000:{ArrowRight}'; same key syntax as --keys
  --segment <seg>        dump/disasm runtime memory at seg:address after a boot run
                         (takes --steps, --keys, --cga, --entry)
  --page <seg>           boot: preview this EGA page instead of the visible one (e.g. 0xa200)
  --crop <x,y,w,h>       boot: preview only this EGA rectangle (screen pixels from the top left),
                         one hex digit per 2x1 pixels
  --trace-lines <n|all>  boot: keep only the last n trace lines (default: 1024)
  --bytes <count>        Disassembly/dump byte limit (default: 128 / 64)
  --count <count>        Disassembly instruction limit (default: 32)
  --help, -h            Show this help

Examples:
  npm run inspect -- word 'R/W'
  npm run inspect -- callers 'R/W'
  npm run inspect -- disasm 0x17b7 --bytes 64
  npm run inspect -- dump 0x0660 --bytes 16
  npm run inspect -- dump 0xe2c8 --module MUSIC --bytes 16
  npm run inspect -- disasm 0x9125 --segment 0x0192 --steps 200000 --keys '5{Enter}'
  npm run inspect -- code 0x17b7
  npm run inspect -- boot --steps 50000
  npm run inspect -- boot --steps 500000 --keys '5{Enter}'
  npm run inspect -- boot --steps 6000000 --keys '5{Enter}' --key-at '4800000:{ArrowRight}'`;

// Parse --key-at values, `<step>:<keys>`, into keys pressed at that step.
function parseTimedKeys(values: readonly string[]): TimedKey[] {
  return values.flatMap(value => {
    const match = /^(0x[0-9a-f]+|[0-9]+):(.+)$/i.exec(value);
    if (!match) throw new Error(`--key-at expects <step>:<keys>, got ${JSON.stringify(value)}.`);
    const step = parseInteger(match[1], '--key-at step', 0, Number.MAX_SAFE_INTEGER);
    return parseKeys(match[2]).map(key => ({ step, key }));
  });
}

// Parse --keys text into BIOS keyboard words; `{Name}` is a named key, anything else types itself.
function parseKeys(text: string): number[] {
  const keys: number[] = [];
  for (let index = 0; index < text.length; index++) {
    const named = text[index] === '{' ? /^\{([A-Za-z0-9]+)\}/.exec(text.slice(index)) : null;
    if (named && named[1] in BIOS_KEYS) {
      keys.push(BIOS_KEYS[named[1]]);
      index += named[0].length - 1;
      continue;
    }
    const key = biosKey(text[index]);
    if (key === undefined) throw new Error(`--keys cannot type ${JSON.stringify(text[index])}; use a {Name} key.`);
    keys.push(key);
  }
  return keys;
}

// A text thumbnail of an EGA picture: one hex digit per 4x4 block, the block's most common color, '.' for black.
function graphicsPreview(graphics: ForthGraphicsScreen): string[] {
  const lines: string[] = [];
  for (let blockY = 0; blockY < graphics.height; blockY += 4) {
    let line = '';
    for (let blockX = 0; blockX < graphics.width; blockX += 4) {
      const counts = new Array<number>(16).fill(0);
      for (let y = blockY; y < Math.min(blockY + 4, graphics.height); y++) {
        for (let x = blockX; x < Math.min(blockX + 4, graphics.width); x++) counts[graphics.pixels[y * graphics.width + x] & 0x0f]++;
      }
      const color = counts.indexOf(Math.max(...counts));
      line += color === 0 ? '.' : color.toString(16);
    }
    lines.push(line);
  }
  return lines;
}

interface Crop {
  x: number;
  y: number;
  width: number;
  height: number;
}

function parseCrop(value: string, graphics: ForthGraphicsScreen): Crop {
  const parts = value.split(',').map(part => parseInteger(part.trim(), '--crop', 0, 0xffff));
  if (parts.length !== 4) throw new Error('--crop expects x,y,w,h.');
  const [x, y, width, height] = parts;
  if (width < 1 || height < 1 || x + width > graphics.width || y + height > graphics.height) {
    throw new Error(`--crop must lie within ${graphics.width}x${graphics.height}.`);
  }
  return { x, y, width, height };
}

// One hex digit per 2x1 pixels (one logical pixel of the 160x200 grid), '.' for black.
function cropPreview(graphics: ForthGraphicsScreen, crop: Crop): string[] {
  const lines: string[] = [];
  for (let y = crop.y; y < crop.y + crop.height; y++) {
    let line = '';
    for (let x = crop.x; x < crop.x + crop.width; x += 2) {
      const color = graphics.pixels[y * graphics.width + x] & 0x0f;
      line += color === 0 ? '.' : color.toString(16);
    }
    lines.push(line);
  }
  return lines;
}

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

async function loadImages() {
  const [stara, starb, starflt, dictionaryText] = await Promise.all([
    loadBinary('STARA.COM'),
    loadBinary('STARB.COM'),
    loadBinary('STARFLT.COM'),
    readFile(new URL('../public/forth-dict.json', import.meta.url), 'utf8')
  ]);
  const engine = await createForthEngine(stara, starb, starflt, JSON.parse(dictionaryText));
  return { engine, stara, starb, starflt };
}

// A 64K segment image and the address range that holds real bytes: STARFLT.COM from 0x100, or an overlay at its
// load address.
interface Segment {
  memory: Uint8Array;
  start: number;
  end: number;
  label: string;
}

async function loadSegment(module: string | undefined): Promise<Segment> {
  if (module === undefined || module === 'KERNEL') {
    const binary = new Uint8Array(await loadBinary('STARFLT.COM'));
    const memory = new Uint8Array(0x10000);
    memory.set(binary.subarray(0, 0xff00), 0x100);
    return { memory, start: 0x100, end: Math.min(0x10000, 0x100 + binary.length), label: 'STARFLT.COM' };
  }
  const { engine } = await loadImages();
  const overlay = engine.overlays.get(module);
  if (!overlay) throw new Error(`No overlay '${module}'. Overlays: ${Array.from(engine.overlays.keys()).join(', ')}.`);
  return { memory: overlay.memory, start: overlay.storeofs, end: overlay.storeofs + overlay.size, label: `${module} overlay` };
}

function segmentBytes(segment: Segment, address: number, byteCount: number): Uint8Array {
  if (address < segment.start || address >= segment.end) {
    throw new Error(`Address is outside ${segment.label} (0x${segment.start.toString(16)}-0x${(segment.end - 1).toString(16)}).`);
  }
  return segment.memory.subarray(address, Math.min(address + byteCount, segment.end));
}

async function disassemble(segment: Segment, address: number, byteCount: number, instructionCount: number): Promise<void> {
  const bytes = segmentBytes(segment, address, byteCount);
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

function dump(segment: Segment, address: number, byteCount: number): void {
  const bytes = segmentBytes(segment, address, byteCount);
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
      keys: { type: 'string' },
      'key-at': { type: 'string', multiple: true },
      segment: { type: 'string' },
      page: { type: 'string' },
      crop: { type: 'string' },
      'trace-lines': { type: 'string' },
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
  const runtime = values.segment !== undefined;
  if (runtime && command !== 'dump' && command !== 'disasm') {
    throw new Error('--segment is only valid for dump and disasm.');
  }
  if (runtime && values.module !== undefined) {
    throw new Error('--segment reads runtime memory; it cannot be combined with --module.');
  }
  if (command !== 'boot' && !runtime && (values.entry !== undefined || values.steps !== undefined || values.cga !== undefined || values.keys !== undefined || values['key-at'] !== undefined)) {
    throw new Error('--entry, --steps, --cga, --keys, and --key-at are only valid for boot, or for dump and disasm with --segment.');
  }
  if (command === 'boot' && values.module !== undefined) {
    throw new Error('--module is not valid for boot.');
  }
  if (command !== 'boot' && values.crop !== undefined) {
    throw new Error('--crop is only valid for boot.');
  }
  if (command !== 'boot' && values.page !== undefined) {
    throw new Error('--page is only valid for boot.');
  }
  if (command !== 'boot' && values['trace-lines'] !== undefined) {
    throw new Error('--trace-lines is only valid for boot.');
  }
  const traceOption = values['trace-lines'] ?? '1024';
  const traceLines = traceOption === 'all' ? Infinity : parseInteger(traceOption, '--trace-lines', 0, Number.MAX_SAFE_INTEGER);
  const timedKeys = parseTimedKeys(values['key-at'] ?? []);
  const entry = parseInteger(values.entry ?? '0x0937', '--entry', 0, 0xffff);
  const steps = parseInteger(values.steps ?? '50000', '--steps', 1, Number.MAX_SAFE_INTEGER);
  const runBoot = async () => {
    const { engine, stara, starb, starflt } = await loadImages();
    const runner = new ForthBootRunner(engine, new Uint8Array(starflt), {
      stara: new Uint8Array(stara),
      starb: new Uint8Array(starb)
    }, { ega: !values.cga, traceLines });
    return { runner, result: runner.run(entry, steps, parseKeys(values.keys ?? ''), timedKeys) };
  };
  // Runtime memory: boot first, then read the segment as the run left it.
  const loadRuntimeSegment = async (): Promise<Segment> => {
    const segment = parseInteger(values.segment!, '--segment', 0, 0xffff);
    const { runner, result } = await runBoot();
    console.log(`Runtime memory at ${segment.toString(16)}:0000 after ${result.steps} steps: ${result.stopReason}`);
    return { memory: runner.readMemory(segment, 0, 0x10000), start: 0, end: 0x10000, label: `runtime segment ${segment.toString(16)}` };
  };
  if (command !== 'disasm' && command !== 'dump' && values.bytes !== undefined) {
    throw new Error('--bytes is only valid for disasm and dump.');
  }
  if (command !== 'disasm' && values.count !== undefined) {
    throw new Error('--count is only valid for disasm.');
  }
  if (command === 'dump') {
    const address = parseInteger(query, 'Address', 0, 0xffff);
    dump(runtime ? await loadRuntimeSegment() : await loadSegment(values.module), address, parseInteger(values.bytes ?? '64', '--bytes', 1, 0x10000));
    return;
  }
  if (command === 'disasm') {
    const address = parseInteger(query, 'Address', 0, 0xffff);
    const byteCount = parseInteger(values.bytes ?? '128', '--bytes', 1, 0x10000);
    const instructionCount = parseInteger(values.count ?? '32', '--count', 1, 0x10000);
    await disassemble(runtime ? await loadRuntimeSegment() : await loadSegment(values.module), address, byteCount, instructionCount);
    return;
  }
  const codeAddress = command === 'code' ? parseInteger(query, 'Address', 0, 0xffff) : 0;
  const identifier = /^0x/i.test(query) ? parseInteger(query, 'CFA', 0, 0xffff) : query;

  if (command === 'boot') {
    const { runner, result } = await runBoot();
    if (result.output) console.log(`Output:\n${result.output}\n`);
    const { screen } = result;
    const page = values.page === undefined ? undefined : parseInteger(values.page, '--page', 0xa000, 0xafff);
    const graphics = page === undefined ? result.graphics : runner.graphicsPage(page);
    if (graphics) {
      const crop = values.crop === undefined ? undefined : parseCrop(values.crop, graphics);
      const lines = crop ? cropPreview(graphics, crop) : graphicsPreview(graphics);
      const border = `+${'-'.repeat(lines[0].length)}+`;
      const where = `page ${(page ?? 0xa000).toString(16)}:0000`;
      const scale = crop
        ? `x ${crop.x}-${crop.x + crop.width - 1}, y ${crop.y}-${crop.y + crop.height - 1} from the top; one hex digit per 2x1 pixels`
        : 'each character is the main color of a 4x4 block';
      console.log(`EGA graphics, ${where} (${graphics.width}x${graphics.height}; ${scale}, . = black):\n${border}`);
      for (const line of lines) console.log(`|${line}|`);
      console.log(`${border}\n`);
    } else {
      const border = `+${'-'.repeat(screen.columns)}+`;
      console.log(`Screen (BIOS mode ${screen.mode}, cursor ${screen.cursorRow},${screen.cursorCol}):\n${border}`);
      for (const line of screenLines(screen)) console.log(`|${line.padEnd(screen.columns)}|`);
      console.log(`${border}\n`);
    }
    if (result.droppedTraceLines) {
      console.log(`… ${result.droppedTraceLines} earlier trace lines dropped (use --trace-lines all to keep them)`);
    }
    console.log(result.trace.join('\n'));
    return;
  }

  const { engine } = await loadImages();
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