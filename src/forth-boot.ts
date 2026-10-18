import {
  CFA_0BRANCH,
  CFA_BRANCH,
  CFA_EXIT1,
  CFA_LIT,
  CFA_2LIT,
  CODE_CALL,
  CODE_CONSTANT,
  CODE_SIGFLD,
  CODE_TABLE,
  CODE_USER,
  CODE_VARIABLE,
  type ForthEngine,
  type ForthToken,
  type ForthWord
} from './forth-decompiler.ts';
import { BLOCK_SIZE, type StarflightFS } from './starflight-fs.ts';
import { EgaAdapter, type EgaState } from './ega.ts';

// A BIOS keyboard word to press once a run reaches `step`.
export interface TimedKey {
  step: number;
  key: number;
}

// 'break': advance() paused before a call to a breakpoint word; the next advance() makes that call and goes on.
export type BootState = 'running' | 'waiting' | 'break' | 'stopped';

interface BootSession {
  dataStack: MemoryStack;
  returnStack: number[];
  frames: CallFrame[];
  trace: TraceBuffer;
  output: string;
  steps: number;
  stopReason: string;
  state: BootState;
  // run() stops a run that is waiting for a key; the result still reports it as waiting.
  waitedForKey?: boolean;
  // Set when resuming from a breakpoint, so the call it paused before runs instead of breaking again.
  passBreakpoint?: boolean;
  // Emulated time at a step where the step rate changed; time runs on from there at the new rate.
  clock?: { step: number; milliseconds: number };
  // BIOS timer ticks (INT 8, then INT 1Ch) delivered so far, at 1193182 / 65536 Hz of emulated time.
  timerTicks?: number;
  // Set when the program returned to DOS (GO 0), as BYE does after the game saves.
  exitedToDos?: boolean;
}

// A change of the PC speaker's output at an emulated time: a square wave at `frequency` Hz, or silence (0).
export interface SpeakerEvent {
  milliseconds: number;
  frequency: number;
}

interface CallFrame {
  word: ForthWord;
  tokenIndex: number;
  // The address pushed on the return stack when this word was entered; undefined for the entry word.
  returnAddress?: number;
}

export interface ForthCheckpoint {
  version: 1;
  physicalMemory: Uint8Array;
  disks: { stara: Uint8Array; starb: Uint8Array };
  dtaSegment: number;
  dtaOffset: number;
  videoMode: number;
  cursorRow: number;
  cursorCol: number;
  keyQueue: number[];
  ega: EgaState;
  speakerPort: number;
  speakerDivisor: number;
  ports?: [number, number][];
  inferredColons: [string, ForthWord][];
  breakpoints: string[];
  session: Omit<BootSession, 'dataStack' | 'trace'> & {
    stackPointer: number;
    trace: string[];
    droppedTraceLines: number;
  };
}

const USER_AREA = 0x078c;
const CODE_USER_VECTOR = 0x17b7;
const CODE_DODOES = 0x1649;
// User-vectored words whose behavior is emulated directly instead of through the vector.
const USER_VECTOR_OVERRIDES = new Set(['R/W']);

function toSignedCell(value: number): number {
  return (value << 16) >> 16;
}

type Stack = number[] | MemoryStack;

// The data stack lives in emulated memory like the 8086 SP stack: it grows down from
// the base in user cell SP0, and SP@ exposes the address of the top cell.
export class MemoryStack {
  pointer: number;
  private readWord: (address: number) => number;
  private writeWord: (address: number, value: number) => void;

  constructor(readWord: (address: number) => number, writeWord: (address: number, value: number) => void) {
    this.readWord = readWord;
    this.writeWord = writeWord;
    this.pointer = this.base;
  }

  get base(): number {
    return this.readWord(USER_AREA); // SP0
  }

  get depth(): number {
    return ((this.base - this.pointer) & 0xffff) >>> 1;
  }

  push(value: number): number {
    this.pointer = (this.pointer - 2) & 0xffff;
    this.writeWord(this.pointer, value);
    return this.depth;
  }

  pop(): number | undefined {
    if (this.depth === 0) return undefined;
    const value = this.readWord(this.pointer);
    this.pointer = (this.pointer + 2) & 0xffff;
    return value;
  }

  // Cell `index` below the top: 0 is the top cell.
  peek(index: number): number | undefined {
    return index < this.depth ? this.readWord(this.pointer + index * 2) : undefined;
  }

  reset(): void {
    this.pointer = this.base;
  }

  // The topmost cells, deepest first.
  top(count: number): number[] {
    const cells: number[] = [];
    for (let index = Math.min(count, this.depth) - 1; index >= 0; index--) cells.push(this.peek(index)!);
    return cells;
  }
}

// A snapshot of the BIOS text screen: one cell per character, `char | attribute << 8`, as in B800 memory.
export interface ForthTextScreen {
  mode: number;
  columns: number;
  rows: number;
  cells: Uint16Array;
  cursorRow: number;
  cursorCol: number;
}

export interface ForthBootResult {
  steps: number;
  // The most recent trace lines, oldest first; see ForthBootOptions.traceLines.
  trace: string[];
  // How many earlier trace lines were dropped to keep the trace bounded.
  droppedTraceLines: number;
  output: string;
  stopReason: string;
  screen: ForthTextScreen;
  // True when the run stopped because (KEY) found the keyboard queue empty.
  waitingForKey: boolean;
  // True when the program returned to DOS, as the game does after saving.
  exitedToDos: boolean;
  // The displayed EGA picture while a graphics mode is set.
  graphics?: ForthGraphicsScreen;
}

// An EGA mode 0Dh picture: one 4-bit color index per pixel, row by row.
export interface ForthGraphicsScreen {
  width: number;
  height: number;
  pixels: Uint8Array;
}

// BIOS keyboard words (scan code << 8 | ASCII) for non-character keys, named like KeyboardEvent.key.
export const BIOS_KEYS: Readonly<Record<string, number>> = {
  Enter: 0x1c0d, Escape: 0x011b, Backspace: 0x0e08, Tab: 0x0f09,
  ArrowUp: 0x4800, ArrowDown: 0x5000, ArrowLeft: 0x4b00, ArrowRight: 0x4d00,
  Home: 0x4700, End: 0x4f00, PageUp: 0x4900, PageDown: 0x5100, Insert: 0x5200, Delete: 0x5300,
  F1: 0x3b00, F2: 0x3c00, F3: 0x3d00, F4: 0x3e00, F5: 0x3f00, F6: 0x4000, F7: 0x4100, F8: 0x4200, F9: 0x4300, F10: 0x4400
};

// The BIOS keyboard word for a KeyboardEvent.key value: a named key or one printable ASCII character.
export function biosKey(key: string): number | undefined {
  if (key in BIOS_KEYS) return BIOS_KEYS[key];
  return key.length === 1 && key.charCodeAt(0) >= 0x20 && key.charCodeAt(0) < 0x7f ? key.charCodeAt(0) : undefined;
}

// IBM PC code page 437 as Unicode; NUL and 0xFF (non-breaking space) display as blanks.
export const CP437 = Array.from(
  ' ☺☻♥♦♣♠•◘○◙♂♀♪♫☼►◄↕‼¶§▬↨↑↓→←∟↔▲▼'
  + Array.from({ length: 0x5f }, (_, index) => String.fromCharCode(0x20 + index)).join('')
  + '⌂ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»'
  + '░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀'
  + 'αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ '
);

// The screen's characters as lines of text, with trailing blanks removed.
export function screenLines(screen: ForthTextScreen): string[] {
  const lines: string[] = [];
  for (let row = 0; row < screen.rows; row++) {
    let line = '';
    for (let col = 0; col < screen.columns; col++) line += CP437[screen.cells[row * screen.columns + col] & 0xff];
    lines.push(line.trimEnd());
  }
  return lines;
}

export interface ForthBootOptions {
  // Preset ?EGA as if EGA had been chosen in the display menu; the shipped image starts with CGA.
  ega?: boolean;
  // How many trace lines to keep, most recent last (default 1024); Infinity keeps the whole trace.
  traceLines?: number;
  // Emulated CPU speed in Forth steps per millisecond of game time (default STEPS_PER_MILLISECOND).
  stepsPerMillisecond?: number;
}

// A trace line kept unformatted until it is read: formatting every step's line costs more than running the step.
interface TraceEntry {
  steps: number;
  word: ForthWord;
  token: ForthToken;
  stack: number[];
  note: string;
}

function formatTraceEntry(entry: string | TraceEntry): string {
  if (typeof entry === 'string') return entry;
  const stackText = entry.stack.map(value => `0x${value.toString(16).padStart(4, '0')}`).join(' ');
  return `${entry.steps.toString().padStart(3, ' ')} ${entry.word.module}:${entry.word.name} ${entry.token.name}  [${stackText}] ${entry.note}`;
}

// Keeps the last `limit` lines, so multi-million-step runs need neither the memory nor the time of a full trace.
class TraceBuffer {
  private readonly lines: (string | TraceEntry)[] = [];
  private readonly limit: number;
  private next = 0;
  dropped = 0;

  constructor(limit: number) {
    this.limit = limit;
  }

  push(line: string | TraceEntry): void {
    if (this.lines.length < this.limit) {
      this.lines.push(line);
      return;
    }
    if (this.limit === 0) {
      this.dropped++;
      return;
    }
    this.lines[this.next] = line;
    this.next = (this.next + 1) % this.limit;
    this.dropped++;
  }

  toArray(): string[] {
    return [...this.lines.slice(this.next), ...this.lines.slice(0, this.next)].map(formatTraceEntry);
  }
}

const EGA_FLAG = 0x5da3; // ?EGA
const OVERLAY_NUMBER = 0x55a5; // OV#: VSA of the overlay LOAD-OVERLAY loaded last
// The emulated clock: threaded steps per millisecond, a rough rate for this Forth on a 4.77 MHz PC. Tying time to
// steps keeps runs deterministic.
export const STEPS_PER_MILLISECOND = 50;
// The BIOS keyboard buffer at 0040:001Eh holds 16 words, of which 15 can be in use.
const BIOS_KEY_BUFFER = 15;
const TIME_COUNTER = 0x188; // TIME's double millisecond counter: high cell at 188h, low cell at 18Ah
// Token addresses for threads queueCall() injects: outside the COM image's threads, so they never collide.
const INJECTED_THREAD = 0xfff0;
// BANK-TRANS record 3, "BONUS": the transaction type the cheat credit is booked as.
const BANK_TRANSACTION_BONUS = 3;
// Keyboard polls: the game calls them from its idle loops, so a queued call can run before them safely.
const SAFE_POINT_WORDS = new Set(['(?TERMINAL)', '(KEY)']);
const PIT_HZ = 1193182;
const TIMER_TICK_MILLISECONDS = 0x10000 * 1000 / PIT_HZ; // the BIOS timer interrupt, about 18.2 Hz
// The MUSIC overlay's INT 1Ch handler (MUSINT) as HIMUS copies it to MUSSEG:00FFh: PUSH SI/DI/DS/DX/CX/BX/AX, PUSH CS,
// POP DS.
const MUSIC_HANDLER_PROLOGUE = [0x56, 0x57, 0x1e, 0x52, 0x51, 0x53, 0x50, 0x0e, 0x1f];
const MAX_SPEAKER_EVENTS = 4096;
// The kernel's own INT 1Ch handler at 0192:018Eh: ADD CS:[18Ah], 55 / ADC CS:[188h], 0, TIME's millisecond counter.
const CLOCK_HANDLER = { segment: 0x0192, offset: 0x018e, prologue: [0x2e, 0x81, 0x06, 0x8a, 0x01] };

export class ForthBootRunner {
  private engine: ForthEngine;
  // OV# holds the loaded overlay's VSA; the engine knows each module's VSA from the disk directory.
  private overlayModulesByVsa = new Map<number, string>();
  private memory: Uint8Array;
  private initialPhysicalMemory: Uint8Array;
  private physicalMemory: Uint8Array;
  private initialDisks: Pick<StarflightFS, 'stara' | 'starb'>;
  // Private copies; DOS writes past the end replace an image with a longer one.
  private disks: { stara: Uint8Array; starb: Uint8Array };
  private dtaSegment = 0;
  private dtaOffset = 0;
  // BIOS video mode; DOS starts the game in 80x25 color text (mode 3).
  private videoMode = 3;
  private cursorRow = 0;
  private cursorCol = 0;
  // Pending BIOS keyboard words, consumed by (KEY).
  private keyQueue: number[] = [];
  // The machine state of the current run, kept between advance() calls.
  private session?: BootSession;
  // Headerless colon words decoded during this run, by `${module}:${cfa}`; see inferColon().
  private readonly inferredColons = new Map<string, ForthWord>();
  // `${module}:${cfa}` of words whose calls pause advance(); see setBreakpoint().
  private readonly breakpoints = new Set<string>();
  // EGA planes and registers; A000h memory goes through them while a graphics mode is set.
  private ega = new EgaAdapter();
  // Port 61h: bit 0 gates PIT channel 2, bit 1 drives the PC speaker; changes are reported as SpeakerEvents.
  private speakerPort = 0;
  // PIT channel 2 divisor; the speaker sounds at 1193182 Hz / divisor while port 61h bits 0 and 1 are set.
  private speakerDivisor = 0;
  // The low byte of a divisor written to port 42h, until the high byte follows.
  private pitLowByte?: number;
  // Speaker changes not yet taken by takeSpeakerEvents(), and the frequency last reported.
  private speakerEvents: SpeakerEvent[] = [];
  private speakerFrequency = 0;
  // The step at which the next timer tick is due; 0 recomputes it on the next step.
  private nextTimerStep = 0;
  // Threads queueCallAtIdle() runs at the next keyboard poll.
  private pendingCalls: (number | string)[][] = [];
  private ports = new Map<number, number>();
  // Steps executed so far in this run; the clock reads it.
  private step = 0;
  private readonly traceLines: number;
  private rate: number;

  constructor(engine: ForthEngine, starflt: Uint8Array, disks: Pick<StarflightFS, 'stara' | 'starb'>, options: ForthBootOptions = {}) {
    this.engine = engine;
    this.traceLines = options.traceLines ?? 1024;
    this.rate = options.stepsPerMillisecond ?? STEPS_PER_MILLISECOND;
    this.initialDisks = { stara: disks.stara.slice(), starb: disks.starb.slice() };
    this.disks = { stara: this.initialDisks.stara.slice(), starb: this.initialDisks.starb.slice() };
    this.physicalMemory = new Uint8Array(0x100000);
    this.physicalMemory.set([0x87, 0xe9, 0x00, 0xf0], 9 * 4);
    const comPhysicalStart = (0x0192 << 4) + 0x0100;
    this.physicalMemory.set(starflt.subarray(0, Math.min(starflt.length, this.physicalMemory.length - comPhysicalStart)), comPhysicalStart);
    this.memory = this.physicalMemory.subarray(0x0192 << 4, (0x0192 << 4) + 0x10000);
    if (options.ega ?? true) {
      this.memory[EGA_FLAG] = 1;
      this.memory[EGA_FLAG + 1] = 0;
    }
    this.initialPhysicalMemory = this.physicalMemory.slice();
    for (const [module, overlay] of engine.overlays) this.overlayModulesByVsa.set(overlay.vsa, module);
  }

  private get textColumns(): number {
    return this.videoMode <= 1 ? 40 : 80;
  }

  private get textSegment(): number {
    return this.videoMode === 7 ? 0xb000 : 0xb800;
  }

  private textCellAddress(row: number, col: number): number {
    return ((this.textSegment << 4) + (row * this.textColumns + col) * 2) & 0xfffff;
  }

  // INT 10h/AH=00h: a text mode set clears the screen to blanks with attribute 7 and homes the cursor.
  // Bit 7 of the mode keeps video memory, as with INT 10h/AH=00h; mode 0Dh is EGA 320x200 in 16 colors.
  private setVideoMode(modeWithFlags: number): void {
    const mode = modeWithFlags & 0x7f;
    const clear = (modeWithFlags & 0x80) === 0;
    this.videoMode = mode;
    this.cursorRow = 0;
    this.cursorCol = 0;
    if (mode === 0x0d) this.ega.setMode(clear);
    else if (clear && (mode <= 3 || mode === 7)) this.scrollUp(0, 0, 0, 24, this.textColumns - 1, 0x07);
  }

  private get egaGraphics(): boolean {
    return this.videoMode === 0x0d;
  }

  // CPU byte access to physical memory; the A000h window reaches the EGA planes in graphics mode.
  private readPhysicalByte(address: number): number {
    address &= 0xfffff;
    if (this.egaGraphics && address >= 0xa0000 && address < 0xb0000) return this.ega.read(address - 0xa0000);
    return this.physicalMemory[address];
  }

  private writePhysicalByte(address: number, value: number): void {
    address &= 0xfffff;
    if (this.egaGraphics && address >= 0xa0000 && address < 0xb0000) this.ega.write(address - 0xa0000, value);
    else this.physicalMemory[address] = value & 0xff;
  }

  // INT 10h/AH=06h: scroll a window up by `lines`, blanking the vacated rows; 0 lines blanks the whole window.
  private scrollUp(lines: number, top: number, left: number, bottom: number, right: number, attribute: number): void {
    const height = bottom - top + 1;
    const shift = lines === 0 || lines >= height ? height : lines;
    for (let row = top; row <= bottom; row++) {
      for (let col = left; col <= right; col++) {
        const target = this.textCellAddress(row, col);
        if (row + shift <= bottom) {
          const source = this.textCellAddress(row + shift, col);
          this.physicalMemory[target] = this.physicalMemory[source];
          this.physicalMemory[target + 1] = this.physicalMemory[source + 1];
        } else {
          this.physicalMemory[target] = 0x20;
          this.physicalMemory[target + 1] = attribute;
        }
      }
    }
  }

  private snapshotScreen(): ForthTextScreen {
    const columns = this.textColumns;
    const cells = new Uint16Array(columns * 25);
    for (let index = 0; index < cells.length; index++) {
      const address = this.textCellAddress(Math.floor(index / columns), index % columns);
      cells[index] = this.physicalMemory[address] | (this.physicalMemory[address + 1] << 8);
    }
    return { mode: this.videoMode, columns, rows: 25, cells, cursorRow: this.cursorRow, cursorCol: this.cursorCol };
  }

  // The mode 0Dh page at A000:0000. The CRTC start address is not modelled, so this is the page shown after a mode set.
  private snapshotGraphics(): ForthGraphicsScreen {
    return this.graphicsPage(0xa000);
  }

  // The mode 0Dh page at segment:0000 in the EGA planes as the last run left it, e.g. A200h for the hidden page.
  graphicsPage(segment: number): ForthGraphicsScreen {
    const width = 320;
    const height = 200;
    const pageOffset = ((segment - 0xa000) * 16) & 0xffff;
    const pixels = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) pixels[y * width + x] = this.ega.pixel(x, y, pageOffset);
    }
    return { width, height, pixels };
  }

  // The module named by OV#, or undefined when no known overlay is loaded.
  private loadedOverlay(): string | undefined {
    return this.overlayModulesByVsa.get(this.memory[OVERLAY_NUMBER] | (this.memory[OVERLAY_NUMBER + 1] << 8));
  }

  // A stop reason when `word` lives in an overlay other than the one OV# says is loaded.
  private checkOverlayLoaded(word: ForthWord): string | undefined {
    if (word.module === 'KERNEL' || word.module === this.loadedOverlay()) return undefined;
    const vsa = this.memory[OVERLAY_NUMBER] | (this.memory[OVERLAY_NUMBER + 1] << 8);
    return `${word.name} is in overlay ${word.module}, but OV# = 0x${vsa.toString(16)} (${this.loadedOverlay() ?? 'no known overlay'}) is loaded.`;
  }

  // Overlays share one load area, so a CFA can name a word in several modules: prefer the caller's module,
  // then the loaded overlay, then the kernel.
  // A word the dictionary doesn't list is inferred from its code field in loaded memory (such as PORTMENU-OV's
  // headerless variable at F09Dh) before falling back to another overlay's word at that CFA, which only serves the
  // "overlay not loaded" stop.
  private resolveWord(cfa: number, callerModule: string, name?: string): ForthWord | undefined {
    const candidates = this.engine.wordsByCfa.get(cfa) ?? [];
    const overlay = this.loadedOverlay();
    return candidates.find(word => word.module === callerModule)
      ?? candidates.find(word => word.module === overlay)
      ?? candidates.find(word => word.module === 'KERNEL')
      ?? this.inferWord(cfa, callerModule, name)
      ?? (candidates.length === 1 ? candidates[0] : undefined);
  }

  // `keys` are BIOS keyboard words typed ahead, in order; see biosKey().
  // Run from `entryCfa` until it returns, stops, waits for a key with all keys used up, or reaches `maxSteps`.
  // `keys` are BIOS keyboard words typed ahead, in order; see biosKey(). Each of `timedKeys` is pressed once the run
  // reaches its step, or earlier if the run is already waiting in (KEY) for it.
  run(entryCfa = 0x0937, maxSteps = 5_000_000, keys: readonly number[] = [], timedKeys: readonly TimedKey[] = []): ForthBootResult {
    this.start(entryCfa, keys);
    const pending = [...timedKeys].sort((first, second) => first.step - second.step);
    let state: BootState = 'running';
    while (state !== 'stopped' && this.session!.steps < maxSteps) {
      const next = pending[0];
      if (next && (next.step <= this.session!.steps || state === 'waiting')) {
        this.pressKey(pending.shift()!.key);
        state = 'running';
        continue;
      }
      if (state === 'waiting') break;
      state = this.advance(Math.min(maxSteps, next?.step ?? maxSteps) - this.session!.steps);
    }
    if (state === 'waiting') this.stop('Waiting for a key at (KEY); the keyboard queue is empty.', true);
    else if (state !== 'stopped') this.stop(`Stopped after the ${maxSteps}-step safety limit.`);
    return this.snapshot();
  }

  // Reset the machine and prepare to run from `entryCfa`; advance() then executes it a slice at a time.
  start(entryCfa = 0x0937, keys: readonly number[] = []): void {
    this.physicalMemory = this.initialPhysicalMemory.slice();
    this.memory = this.physicalMemory.subarray(0x0192 << 4, (0x0192 << 4) + 0x10000);
    this.disks = { stara: this.initialDisks.stara.slice(), starb: this.initialDisks.starb.slice() };
    this.dtaSegment = 0;
    this.dtaOffset = 0;
    this.keyQueue = [...keys];
    this.inferredColons.clear();
    this.ega = new EgaAdapter();
    this.speakerPort = 0;
    this.speakerDivisor = 0;
    this.pitLowByte = undefined;
    this.speakerEvents = [];
    this.speakerFrequency = 0;
    this.pendingCalls = [];
    this.nextTimerStep = 0;
    this.ports.clear();
    this.step = 0;
    this.setVideoMode(3);
    const readWord = (address: number) => this.memory[address & 0xffff] | (this.memory[(address + 1) & 0xffff] << 8);
    const writeWord = (address: number, value: number) => {
      this.memory[address & 0xffff] = value & 0xff;
      this.memory[(address + 1) & 0xffff] = (value >>> 8) & 0xff;
    };
    const entry = this.engine.get(entryCfa, 'KERNEL');
    this.session = {
      dataStack: new MemoryStack(readWord, writeWord),
      returnStack: this.memoryReturnStack(),
      frames: entry ? [{ word: entry, tokenIndex: 0 }] : [],
      trace: new TraceBuffer(this.traceLines),
      output: '',
      steps: 0,
      stopReason: '',
      state: 'running'
    };
    if (!entry) this.stop(`No kernel word at CFA 0x${entryCfa.toString(16)}.`);
  }

  // Pause advance() just before any call to the word at `cfa` in `module`, e.g. to notice the end of the intro.
  setBreakpoint(module: string, cfa: number): void {
    this.breakpoints.add(`${module}:${cfa}`);
  }

  clearBreakpoints(): void {
    this.breakpoints.clear();
  }

  private memoryReturnStack(values: number[] = []): number[] {
    // An array index property ("0", "17"), or -1; a plain digit scan, since this runs on every return-stack access.
    const arrayIndex = (property: string | symbol): number => {
      if (typeof property !== 'string' || property.length === 0 || property.length > 9) return -1;
      if (property.length > 1 && property.charCodeAt(0) === 48) return -1;
      let index = 0;
      for (let position = 0; position < property.length; position++) {
        const digit = property.charCodeAt(position) - 48;
        if (digit < 0 || digit > 9) return -1;
        index = index * 10 + digit;
      }
      return index;
    };
    const address = (index: number) => {
      const base = (this.memory[USER_AREA + 2] | (this.memory[USER_AREA + 3] << 8)) || 0xf7d0;
      return (base - (index + 1) * 2) & 0xffff;
    };
    const stack = new Proxy<number[]>([], {
      get: (target, property, receiver) => {
        const index = arrayIndex(property);
        if (index >= 0) {
          if (index >= target.length) return undefined;
          const offset = address(index);
          return this.memory[offset] | (this.memory[(offset + 1) & 0xffff] << 8);
        }
        return Reflect.get(target, property, receiver);
      },
      set: (target, property, value, receiver) => {
        const index = arrayIndex(property);
        if (index >= 0) {
          const offset = address(index);
          this.memory[offset] = value & 0xff;
          this.memory[(offset + 1) & 0xffff] = (value >>> 8) & 0xff;
        }
        return Reflect.set(target, property, value, receiver);
      }
    });
    stack.push(...values);
    return stack;
  }

  saveState(): ForthCheckpoint {
    const session = this.session;
    if (!session) throw new Error('Start a game before saving a checkpoint.');
    session.clock = { step: this.step, milliseconds: this.milliseconds }; // so loading at another rate keeps TIME
    const { dataStack, trace, ...execution } = session;
    return structuredClone({
      version: 1,
      physicalMemory: this.physicalMemory,
      disks: this.disks,
      dtaSegment: this.dtaSegment, dtaOffset: this.dtaOffset,
      videoMode: this.videoMode, cursorRow: this.cursorRow, cursorCol: this.cursorCol,
      keyQueue: this.keyQueue, ega: this.ega.saveState(),
      speakerPort: this.speakerPort, speakerDivisor: this.speakerDivisor, ports: [...this.ports],
      inferredColons: [...this.inferredColons], breakpoints: [...this.breakpoints],
      session: { ...execution, returnStack: [...execution.returnStack], stackPointer: dataStack.pointer, trace: trace.toArray(), droppedTraceLines: trace.dropped }
    });
  }

  loadState(checkpoint: ForthCheckpoint): BootState {
    if (checkpoint?.version !== 1) throw new Error('Unsupported checkpoint version.');
    if (!(checkpoint.physicalMemory instanceof Uint8Array) || checkpoint.physicalMemory.length !== 0x100000
      || !(checkpoint.disks?.stara instanceof Uint8Array) || !(checkpoint.disks?.starb instanceof Uint8Array)
      || !checkpoint.session || !['running', 'waiting', 'break', 'stopped'].includes(checkpoint.session.state)) {
      throw new Error('Invalid game checkpoint.');
    }
    const saved = structuredClone(checkpoint);
    const ega = new EgaAdapter();
    ega.loadState(saved.ega);
    const memory = saved.physicalMemory.subarray(0x0192 << 4, (0x0192 << 4) + 0x10000);
    const dataStack = new MemoryStack(
      address => memory[address & 0xffff] | (memory[(address + 1) & 0xffff] << 8),
      (address, value) => {
        memory[address & 0xffff] = value & 0xff;
        memory[(address + 1) & 0xffff] = (value >>> 8) & 0xff;
      }
    );
    dataStack.pointer = saved.session.stackPointer;
    const trace = new TraceBuffer(this.traceLines);
    for (const line of saved.session.trace) trace.push(line);
    trace.dropped += saved.session.droppedTraceLines;
    this.physicalMemory = saved.physicalMemory;
    this.memory = memory;
    this.disks = saved.disks;
    this.dtaSegment = saved.dtaSegment;
    this.dtaOffset = saved.dtaOffset;
    this.videoMode = saved.videoMode;
    this.cursorRow = saved.cursorRow;
    this.cursorCol = saved.cursorCol;
    this.keyQueue = saved.keyQueue;
    this.ega = ega;
    this.speakerPort = saved.speakerPort;
    this.speakerDivisor = saved.speakerDivisor;
    this.pitLowByte = undefined;
    this.speakerEvents = [];
    this.nextTimerStep = 0;
    this.pendingCalls = [];
    this.ports = new Map(saved.ports ?? []);
    this.inferredColons.clear();
    for (const [key, word] of saved.inferredColons) this.inferredColons.set(key, word);
    this.clearBreakpoints();
    for (const key of saved.breakpoints) this.breakpoints.add(key);
    const { stackPointer, droppedTraceLines, trace: savedTrace, ...execution } = saved.session;
    this.session = { ...execution, returnStack: this.memoryReturnStack(execution.returnStack), dataStack, trace };
    this.step = execution.steps;
    // Checkpoints from before the step rate became adjustable ran at the default rate.
    this.session.clock ??= { step: execution.steps, milliseconds: execution.steps / STEPS_PER_MILLISECOND };
    this.session.timerTicks ??= Math.floor(this.milliseconds / TIMER_TICK_MILLISECONDS);
    this.speakerFrequency = -1; // report the restored speaker state
    this.speakerChanged();
    return execution.state;
  }

  // Steps per millisecond of emulated time: a faster CPU runs more Forth words in the same game time.
  get stepsPerMillisecond(): number {
    return this.rate;
  }

  // Change the emulated CPU speed; TIME keeps counting from where it is, so timed waits stay continuous.
  setStepsPerMillisecond(rate: number): void {
    if (!(rate > 0)) throw new RangeError('The step rate must be positive.');
    if (this.session) this.session.clock = { step: this.step, milliseconds: this.milliseconds };
    this.rate = rate;
    this.nextTimerStep = 0;
  }

  // Speaker changes since the last call, oldest first, timed in emulated milliseconds (see `milliseconds`).
  takeSpeakerEvents(): SpeakerEvent[] {
    const events = this.speakerEvents;
    this.speakerEvents = [];
    return events;
  }

  // The tone the speaker is sounding now, in Hz, or 0 when it is silent.
  get speakerTone(): number {
    return this.speakerFrequency;
  }

  // Emulated milliseconds since start(), as TIME reports them.
  get milliseconds(): number {
    const clock = this.session?.clock;
    return (clock?.milliseconds ?? 0) + (this.step - (clock?.step ?? 0)) / this.rate;
  }

  // Type a key into the running machine; a run waiting in (KEY) continues on its next advance().
  // Like the BIOS keyboard buffer, at most 15 keys wait; returns false when the key is dropped because it is full.
  pressKey(key: number): boolean {
    if (this.keyQueue.length >= BIOS_KEY_BUFFER) return false;
    this.keyQueue.push(key & 0xffff);
    return true;
  }

  // Keys typed but not yet read by the game.
  get pendingKeys(): number {
    return this.keyQueue.length;
  }

  // Make the running thread call a short kernel thread next, as if its following token were a call to it: numbers
  // are pushed as literals, names call kernel words. Afterwards the game carries on where it was (a run waiting in
  // (KEY) runs it now and then waits again). Returns false when no run is in progress. Between arbitrary steps the
  // game may be halfway through an overlay load or a disk transfer; queueCallAtIdle() waits for a safe point.
  queueCall(operations: readonly (number | string)[]): boolean {
    return this.injectCall(operations);
  }

  // Like queueCall(), but run the thread the next time the game polls the keyboard ((?TERMINAL) or (KEY)), which
  // it only does from its idle loops, never in the middle of loading an overlay.
  queueCallAtIdle(operations: readonly (number | string)[]): boolean {
    const session = this.session;
    if (!session || session.state === 'stopped' || session.frames.length === 0) return false;
    this.pendingCalls.push([...operations]);
    if (session.state === 'waiting') session.state = 'running';
    return true;
  }

  private injectCall(operations: readonly (number | string)[]): boolean {
    const session = this.session;
    const frame = session?.frames.at(-1);
    if (!session || !frame || session.state === 'stopped') return false;
    const hex = (value: number) => `0x${value.toString(16).padStart(4, '0')}`;
    const tokens: ForthToken[] = operations.map((operation, index) => {
      const addr = INJECTED_THREAD + index * 2;
      if (typeof operation === 'number') {
        return { addr, addrHex: hex(addr), cfa: CFA_LIT, cfaHex: hex(CFA_LIT), name: String(operation & 0xffff), kind: 'lit', arg: operation & 0xffff };
      }
      const target = this.engine.words.find(word => word.name === operation && word.module === 'KERNEL');
      if (!target) throw new Error(`No kernel word ${operation}`);
      return { addr, addrHex: hex(addr), cfa: target.cfa, cfaHex: target.cfaHex, name: target.name, kind: 'call' };
    });
    const end = INJECTED_THREAD + operations.length * 2;
    tokens.push({ addr: end, addrHex: hex(end), cfa: CFA_EXIT1, cfaHex: hex(CFA_EXIT1), name: ';', kind: 'exit' });
    const word: ForthWord = {
      name: 'INJECTED', cfa: INJECTED_THREAD - 2, cfaHex: hex(INJECTED_THREAD - 2), pfa: INJECTED_THREAD, pfaHex: hex(INJECTED_THREAD),
      codep: CODE_CALL, codepHex: hex(CODE_CALL), module: 'KERNEL', type: 'colon', typeLabel: 'thread injected by the runner',
      decompiled: `: INJECTED ${tokens.map(token => token.name).join(' ')}`, tokens, rawBytes: new Uint8Array()
    };
    const returnAddress = frame.word.tokens[frame.tokenIndex]?.addr ?? 0;
    session.returnStack.push(returnAddress);
    session.frames.push({ word, tokenIndex: 0, returnAddress });
    if (session.state === 'waiting') session.state = 'running';
    return true;
  }

  // Add `amount` MU to the player's bank account the way the game books interest (BANK-OV's INT%):
  // `amount. ' T+BALANCE MODULE  3 ' OVTRANSACT MODULE`. T+BALANCE changes the current balance and marks it
  // uncommitted; TRANSACT commits it as a dated transaction of type 3 (BONUS in the BANK-TRANS file). Without the
  // commit the Bank screen, which shows the committed balance and resets uncommitted changes (INIT-BALANCE), never
  // shows it. MODULE puts the previous overlay back after each; EXECUTE, and so MODULE, takes a word's PFA, as ' does.
  // It runs at the game's next keyboard poll.
  creditBalance(amount: number): boolean {
    const pfa = (name: string) => this.engine.words.find(word => word.name === name && word.module === 'KERNEL')?.pfa;
    const add = pfa('T+BALANCE'), commit = pfa('OVTRANSACT');
    if (add === undefined || commit === undefined) return false;
    return this.queueCallAtIdle([
      amount & 0xffff, Math.floor(amount / 0x10000) & 0xffff, add, 'MODULE',
      BANK_TRANSACTION_BONUS, commit, 'MODULE'
    ]);
  }

  // The current result: trace, screens, and why the run stopped (empty while it is still running).
  snapshot(): ForthBootResult {
    const session = this.session;
    if (!session) throw new Error('No run has been started.');
    return {
      steps: session.steps,
      trace: session.trace.toArray(),
      droppedTraceLines: session.trace.dropped,
      output: session.output,
      stopReason: session.stopReason,
      screen: this.snapshotScreen(),
      waitingForKey: session.state === 'waiting' || session.waitedForKey === true,
      exitedToDos: session.exitedToDos === true,
      graphics: this.egaGraphics ? this.snapshotGraphics() : undefined
    };
  }

  private stop(reason: string, waitedForKey = false): void {
    const session = this.session!;
    session.state = 'stopped';
    session.stopReason = reason;
    session.waitedForKey = waitedForKey;
    session.trace.push(`STOP after ${session.steps} steps: ${reason}`);
  }

  // Execute up to `budget` more steps. Returns 'running' when the budget ran out, 'waiting' when (KEY) needs a
  // key (it retries once pressKey() supplies one), or 'stopped'.
  advance(budget: number): BootState {
    const session = this.session;
    if (!session || session.state === 'stopped') return 'stopped';
    if (session.state === 'waiting' && this.keyQueue.length === 0 && this.pendingCalls.length === 0) return 'waiting';
    if (session.state === 'break') session.passBreakpoint = true;
    session.state = 'running';

    const readWord = (address: number) => this.memory[address & 0xffff] | (this.memory[(address + 1) & 0xffff] << 8);
    const writeWord = (address: number, value: number) => {
      this.memory[address & 0xffff] = value & 0xff;
      this.memory[(address + 1) & 0xffff] = (value >>> 8) & 0xff;
    };
    const { dataStack, returnStack, frames, trace } = session;
    let output = session.output;
    let steps = session.steps;
    const maxSteps = steps + budget;
    let stopReason: string | undefined;
    let waiting = false;
    let breakpoint = false;

    const pop = (stack: Stack, label: string): number => {
      const value = stack.pop();
      if (value === undefined) throw new Error(`${label} stack underflow`);
      return value;
    };
    const push = (stack: Stack, value: number) => stack.push(value & 0xffff);
    const enter = (word: ForthWord, caller: CallFrame, callToken: ForthToken) => {
      const returnAddress = this.getReturnAddress(caller, callToken) & 0xffff;
      push(returnStack, returnAddress);
      frames.push({ word, tokenIndex: 0, returnAddress });
    };
    const readFarWord = (segment: number, offset: number) => {
      const address = ((segment & 0xffff) << 4) + (offset & 0xffff);
      return this.readPhysicalByte(address) | (this.readPhysicalByte(address + 1) << 8);
    };
    const writeFarWord = (segment: number, offset: number, value: number) => {
      const address = ((segment & 0xffff) << 4) + (offset & 0xffff);
      this.writePhysicalByte(address, value);
      this.writePhysicalByte(address + 1, value >>> 8);
    };

    try {
      while (frames.length > 0 && steps < maxSteps) {
        const frame = frames[frames.length - 1];
        const token = frame.word.tokens[frame.tokenIndex++];
        if (!token) {
          stopReason = `No EXIT token in ${frame.word.name}@${frame.word.module}.`;
          break;
        }
        steps++;
        this.step = steps;
        if (steps >= this.nextTimerStep) this.timerInterrupt();

        if (token.kind === 'lit') {
          push(dataStack, Number(token.arg ?? 0));
          trace.push(this.formatTrace(steps, frame.word, token, dataStack, 'literal'));
          continue;
        }

        if (token.kind === 'exit' || token.cfa === CFA_EXIT1) {
          frames.pop();
          let note = 'return';
          if (frame.returnAddress !== undefined) {
            const address = pop(returnStack, 'return');
            if (address !== frame.returnAddress) {
              // Words such as `R> DROP` rewrite the return stack: like the 8086 EXIT, resume wherever the popped
              // address points and unwind the frames it skips.
              let skipped = 0;
              let caller = frames.at(-1);
              let index = -1;
              while (caller && (index = caller.word.tokens.findIndex(candidate => candidate.addr === address)) < 0) {
                frames.pop();
                skipped++;
                caller = frames.at(-1);
              }
              if (!caller) {
                stopReason = `EXIT from ${frame.word.name} to 0x${address.toString(16)}, which is not in an active word.`;
                trace.push(this.formatTrace(steps, frame.word, token, dataStack, `return to unknown 0x${address.toString(16)}`));
                break;
              }
              caller.tokenIndex = index;
              note = `return to 0x${address.toString(16)} in ${caller.word.name}, unwinding ${skipped} frame(s)`;
            }
          }
          trace.push(this.formatTrace(steps, frame.word, token, dataStack, note));
          continue;
        }

        if (token.kind === 'branch' || token.cfa === CFA_0BRANCH || token.cfa === CFA_BRANCH) {
          const shouldBranch = token.cfa === CFA_BRANCH || (token.cfa === CFA_0BRANCH && pop(dataStack, 'data') === 0);
          if (shouldBranch) {
            const targetIndex = frame.word.tokens.findIndex(candidate => candidate.addr === token.arg);
            if (targetIndex < 0) {
              stopReason = `Branch target 0x${Number(token.arg).toString(16)} is not in ${frame.word.name}.`;
              break;
            }
            frame.tokenIndex = targetIndex;
          }
          trace.push(this.formatTrace(steps, frame.word, token, dataStack, shouldBranch ? 'branch' : 'fall through'));
          continue;
        }

        if (token.kind !== 'call') {
          stopReason = `Unsupported token kind '${token.kind}' in ${frame.word.name}.`;
          break;
        }

        const inlineString = token.name.match(/^(.*?) "([\s\S]*)"$/);
        if (inlineString && inlineString[1] === '(ABORT\")') {
          // ( flag -- ): print the message and abort to QUIT only when the flag is true.
          const aborting = pop(dataStack, 'data') !== 0;
          trace.push(this.formatTrace(steps, frame.word, token, dataStack, aborting ? 'abort' : 'no abort'));
          if (aborting) {
            output += inlineString[2];
            stopReason = `ABORT" ${inlineString[2]}" in ${frame.word.name}.`;
            break;
          }
          continue;
        }

        let target: ForthWord | undefined;
        if (inlineString && inlineString[1] === '(.\")') {
          // (.") types its counted inline string (count at CFA+2): hand ( addr count ) to the TYPE vector.
          push(dataStack, token.addr + 3);
          push(dataStack, this.memory[(token.addr + 2) & 0xffff]);
          target = this.engine.get('TYPE', 'KERNEL');
        } else {
          target = this.resolveWord(token.cfa, frame.word.module, token.name);
        }
        if (!target) {
          stopReason = `Unresolved call ${token.name} at CFA ${token.cfaHex} in ${frame.word.module}.`;
          break;
        }

        if (!inlineString && this.breakpoints.has(`${target.module}:${target.cfa}`)) {
          if (session.passBreakpoint) {
            session.passBreakpoint = false;
          } else {
            // Undo this step and pause; the next advance() makes the call.
            frame.tokenIndex--;
            steps--;
            breakpoint = true;
            break;
          }
        }

        const overlayStop = this.checkOverlayLoaded(target);
        if (overlayStop) {
          stopReason = overlayStop;
          break;
        }

        if (target.codep === CODE_TABLE) {
          const tableIndex = pop(dataStack, 'data');
          const entryAddress = target.pfa + tableIndex * 2;
          if (entryAddress < 0 || entryAddress + 1 >= this.memory.length) {
            stopReason = `Table index ${tableIndex} is outside ${target.name} at PFA ${target.pfaHex}.`;
            break;
          }
          const entry = readWord(entryAddress);
          push(dataStack, entry);
          trace.push(this.formatTrace(steps, frame.word, token, dataStack, `${target.name}[${tableIndex}] = 0x${entry.toString(16).padStart(4, '0')}`));
          continue;
        }

        if (target.codep === CODE_SIGFLD) {
          const helperNames = ['@', 'SIGBLK', 'BLOCK_2', '+'];
          const helperWords = helperNames.map(name => this.engine.get(name, 'KERNEL'));
          if (helperWords.some(word => !word)) {
            stopReason = `Cannot execute signature-field helper for ${target.name}: helper word is missing.`;
            break;
          }

          const helperTokens: ForthToken[] = helperWords.map((word, index) => ({
            addr: 0x6ec4 + index * 2,
            addrHex: `0x${(0x6ec4 + index * 2).toString(16)}`,
            cfa: word!.cfa,
            cfaHex: word!.cfaHex,
            name: word!.name,
            kind: 'call'
          }));
          helperTokens.push({ addr: 0x6ecc, addrHex: '0x6ecc', cfa: CFA_EXIT1, cfaHex: `0x${CFA_EXIT1.toString(16)}`, name: ';', kind: 'exit' });
          const helper: ForthWord = {
            ...target,
            name: `SIGFLD ${target.name}`,
            type: 'colon',
            typeLabel: 'CODESIGFLD helper',
            decompiled: ': SIGFLD  @ SIGBLK BLOCK_2 + ;',
            tokens: helperTokens
          };
          push(dataStack, target.pfa);
          enter(helper, frame, token);
          trace.push(this.formatTrace(steps, frame.word, token, dataStack, `SIGFLD descriptor ${target.name}`));
          continue;
        }

        // Any non-colon word may be a DOES> child (the decompiler types CASE: words as 'case', for example);
        // decodeDoesBody checks for the call to DODOES itself.
        const doesBody = target.codep !== CODE_CALL ? this.decodeDoesBody(target) : undefined;
        if (doesBody) {
          push(dataStack, target.pfa);
          enter(doesBody, frame, token);
          trace.push(this.formatTrace(steps, frame.word, token, dataStack, `DOES> ${target.name}`));
          continue;
        }

        if (target.type === 'constant') {
          push(dataStack, readWord(target.pfa));
          trace.push(this.formatTrace(steps, frame.word, token, dataStack, `constant ${target.name}`));
          continue;
        }
        if (target.type === 'variable') {
          push(dataStack, target.pfa);
          trace.push(this.formatTrace(steps, frame.word, token, dataStack, `address of ${target.name}`));
          continue;
        }
        if (target.type === 'user') {
          push(dataStack, USER_AREA + readWord(target.pfa));
          trace.push(this.formatTrace(steps, frame.word, token, dataStack, `user address ${target.name}`));
          continue;
        }

        // The loop words work only on the top two return-stack cells, as the 8086 code does: index on top, limit below.
        if (target.name === '(DO)') {
          const start = pop(dataStack, 'data');
          const limit = pop(dataStack, 'data');
          push(returnStack, limit);
          push(returnStack, start);
          trace.push(this.formatTrace(steps, frame.word, token, dataStack, `DO ${start} to ${limit}`));
          continue;
        }

        if (target.name === '(LOOP)' || target.name === '(+LOOP)' || target.name === '(/LOOP)') {
          const branchData = frame.word.tokens[frame.tokenIndex];
          if (returnStack.length < 2 || !branchData) {
            stopReason = `LOOP without matching DO in ${frame.word.name}.`;
            break;
          }

          const step = target.name === '(LOOP)' ? 1 : pop(dataStack, 'data');
          const limit = returnStack[returnStack.length - 2];
          const index = (returnStack[returnStack.length - 1] + step) & 0xffff;
          // (LOOP) and (+LOOP) compare signed; (+LOOP) with a negative step continues while index >= limit;
          // (/LOOP) compares unsigned.
          const reached = target.name === '(/LOOP)' ? index >= limit : toSignedCell(index) >= toSignedCell(limit);
          const continues = target.name === '(+LOOP)' && toSignedCell(step) < 0 ? reached : !reached;
          // The inline offset is relative to its own cell and lands on the token after (DO).
          const doAddress = (token.addr + toSignedCell(branchData.cfa)) & 0xffff;
          const doTokenIndex = frame.word.tokens.findIndex(candidate => candidate.addr === doAddress);
          frame.tokenIndex++;
          if (doTokenIndex < 0) {
            stopReason = `LOOP target 0x${doAddress.toString(16)} is not in ${frame.word.name}.`;
            break;
          }

          if (continues) {
            returnStack[returnStack.length - 1] = index;
            frame.tokenIndex = doTokenIndex + 1;
          } else {
            returnStack.length -= 2;
          }
          trace.push(this.formatTrace(steps, frame.word, token, dataStack, continues ? `loop index ${index}` : 'loop complete'));
          continue;
        }

        if (target.name === 'LEAVE') {
          // Set the limit to the index, so the next loop test ends the loop.
          if (returnStack.length < 2) {
            stopReason = `LEAVE outside a DO loop in ${frame.word.name}.`;
            break;
          }
          returnStack[returnStack.length - 2] = returnStack[returnStack.length - 1];
          trace.push(this.formatTrace(steps, frame.word, token, dataStack, 'leave: limit = index'));
          continue;
        }

        if (target.name === 'I' || target.name === "I'" || target.name === 'J') {
          const depth = target.name === 'I' ? 0 : target.name === "I'" ? 1 : 2;
          const value = returnStack[returnStack.length - 1 - depth];
          if (value === undefined) {
            stopReason = `${target.name} used with no corresponding return-stack cell.`;
            break;
          }
          push(dataStack, value);
          trace.push(this.formatTrace(steps, frame.word, token, dataStack, `return-stack cell ${value}`));
          continue;
        }

        let executionPfa: number | undefined;
        let executionLabel = target.name;
        if (target.name === 'EXECUTE' || target.name === '@EXECUTE' || target.name === 'CFAEXEC') {
          const executionOperand = pop(dataStack, 'data');
          executionPfa = target.name === '@EXECUTE' ? readWord(executionOperand)
            : target.name === 'CFAEXEC' ? (executionOperand + 2) & 0xffff // takes a CFA, not a PFA
            : executionOperand;
        } else if (target.codep === CODE_USER_VECTOR && !this.hasPrimitiveOverride(target)) {
          // The native code loads a PFA from the user area cell named by this word's PFA and jumps to its CFA.
          const userAddress = (USER_AREA + readWord(target.pfa)) & 0xffff;
          executionPfa = readWord(userAddress);
          executionLabel = `${target.name} vector 0x${userAddress.toString(16)} ->`;
        }

        if (executionPfa !== undefined) {
          const executionCfa = (executionPfa - 2) & 0xffff;
          const executionTarget = this.resolveWord(executionCfa, frame.word.module);
          const executionOverlayStop = executionTarget && this.checkOverlayLoaded(executionTarget);
          if (executionOverlayStop) {
            stopReason = executionOverlayStop;
            break;
          }
          if (target.codep === CODE_USER_VECTOR && SAFE_POINT_WORDS.has(executionTarget?.name ?? '') && this.pendingCalls.length > 0) {
            // A keyboard poll: the game is in an idle loop, so run a queued call first and then poll again.
            frame.tokenIndex--;
            steps--;
            this.injectCall(this.pendingCalls.shift()!);
            continue;
          }
          if (!executionTarget) {
            const codep = readWord(executionCfa);
            trace.push(this.formatTrace(steps, frame.word, token, dataStack, `${executionLabel} PFA 0x${executionPfa.toString(16)} -> CFA 0x${executionCfa.toString(16)} (code pointer 0x${codep.toString(16)})`));
            stopReason = `${target.name} target PFA 0x${executionPfa.toString(16)} resolves to unindexed CFA 0x${executionCfa.toString(16)} (code pointer 0x${codep.toString(16)}).`;
            break;
          }
          const executionDoesBody = executionTarget.codep !== CODE_CALL ? this.decodeDoesBody(executionTarget) : undefined;
          if (executionDoesBody) {
            push(dataStack, executionTarget.pfa);
            enter(executionDoesBody, frame, token);
            trace.push(this.formatTrace(steps, frame.word, token, dataStack, `${executionLabel} DOES> ${executionTarget.name}@${executionTarget.module}`));
            continue;
          }
          if (executionTarget.type === 'constant') {
            push(dataStack, readWord(executionTarget.pfa));
          } else if (executionTarget.type === 'variable') {
            push(dataStack, executionTarget.pfa);
          } else if (executionTarget.type === 'user') {
            push(dataStack, USER_AREA + readWord(executionTarget.pfa));
          } else if (executionTarget.codep === CODE_CALL) {
            trace.push(this.formatTrace(steps, frame.word, token, dataStack, `${executionLabel} ${executionTarget.name}@${executionTarget.module}`));
            enter(executionTarget, frame, token);
            continue;
          } else {
            const handled = this.executePrimitive(executionTarget, dataStack, returnStack, output, push, pop, readWord, writeWord, readFarWord, writeFarWord);
            output = handled.output;
            if (handled.waitForKey) {
              // Undo this step so the vectored call runs again once a key is available.
              frame.tokenIndex--;
              steps--;
              waiting = true;
              break;
            }
            if (!handled.supported) {
              stopReason = handled.stop ?? `${target.name} reached native primitive ${executionTarget.name} (code pointer ${executionTarget.codepHex}); no JS handler is implemented.`;
              break;
            }
          }
          trace.push(this.formatTrace(steps, frame.word, token, dataStack, `${executionLabel} ${executionTarget.name}@${executionTarget.module}`));
          continue;
        }

        if (target.codep === CODE_CALL) {
          trace.push(this.formatTrace(steps, frame.word, token, dataStack, `call ${target.name}`));
          enter(target, frame, token);
          continue;
        }

        const handled = this.executePrimitive(target, dataStack, returnStack, output, push, pop, readWord, writeWord, readFarWord, writeFarWord);
        output = handled.output;
        if (handled.waitForKey) {
          // Undo this step so the call runs again once a key is available.
          frame.tokenIndex--;
          steps--;
          waiting = true;
          break;
        }
        trace.push(this.formatTrace(steps, frame.word, token, dataStack, handled.note));
        if (!handled.supported) {
          stopReason = handled.stop ?? `Stopped at native primitive ${target.name} (code pointer ${target.codepHex}); no JS handler is implemented.`;
          break;
        }
      }

      if (frames.length === 0 && stopReason === undefined && !waiting) {
        stopReason = session.exitedToDos ? 'The game exited to DOS.' : 'Forth returned from the entry word.';
      }
    } catch (error) {
      stopReason = error instanceof Error ? error.message : String(error);
    }

    session.output = output;
    session.steps = steps;
    this.step = steps;
    if (stopReason !== undefined) this.stop(stopReason);
    else if (waiting) session.state = 'waiting';
    else if (breakpoint) session.state = 'break';
    return session.state;
  }

  // Recognize a word that is missing from the dictionary by its code field in runtime memory: a headerless kernel
  // word, or one in the loaded overlay (such as MUSIC's variable at 0xe2c8).
  private inferWord(cfa: number, module = 'KERNEL', name = `W_0x${cfa.toString(16).padStart(4, '0')}`): ForthWord | undefined {
    const codep = this.memory[cfa & 0xffff] | (this.memory[(cfa + 1) & 0xffff] << 8);
    const pfa = (cfa + 2) & 0xffff;
    if (codep === CODE_CALL) return this.inferColon(cfa, module, name);
    const type = codep === CODE_CONSTANT ? 'constant' : codep === CODE_VARIABLE ? 'variable' : codep === CODE_USER ? 'user' : undefined;
    const kind = type ? `${type} inferred from code field`
      : codep === 0x3672 ? 'OFFSET primitive inferred from code field'
      : codep === pfa ? 'headerless CODE inferred from code field'
      : this.callsDoDoes(codep) ? 'headerless DOES> word inferred from code field' // e.g. CHKFLIGHT-OV's field [. at F1B9h
      : undefined;
    if (!kind) return undefined;
    return {
      name,
      cfa,
      cfaHex: `0x${cfa.toString(16).padStart(4, '0')}`,
      pfa,
      pfaHex: `0x${pfa.toString(16).padStart(4, '0')}`,
      codep,
      codepHex: `0x${codep.toString(16).padStart(4, '0')}`,
      module,
      type: type ?? 'primitive',
      typeLabel: kind,
      decompiled: type ? `${type.toUpperCase()} ${name}` : codep === 0x3672 ? `OFFSET ${name}` : `CODE ${name}`,
      tokens: [],
      rawBytes: this.memory.subarray(cfa, Math.min(cfa + 32, this.memory.length))
    };
  }

  private hasPrimitiveOverride(word: ForthWord): boolean {
    return USER_VECTOR_OVERRIDES.has(word.name);
  }

  private executePrimitive(
    word: ForthWord,
    dataStack: MemoryStack,
    returnStack: number[],
    output: string,
    push: (stack: Stack, value: number) => number,
    pop: (stack: Stack, label: string) => number,
    readWord: (address: number) => number,
    writeWord: (address: number, value: number) => void,
    readFarWord: (segment: number, offset: number) => number,
    writeFarWord: (segment: number, offset: number, value: number) => void
  ): { supported: boolean; note: string; output: string; stop?: string; waitForKey?: boolean } {
    const name = word.name;

    const binary = (operation: (left: number, right: number) => number) => {
      const right = pop(dataStack, 'data');
      const left = pop(dataStack, 'data');
      push(dataStack, operation(left, right));
    };
    const unary = (operation: (value: number) => number) => {
      push(dataStack, operation(pop(dataStack, 'data')));
    };

    switch (word.codep) {
      case 0x92ef: // S/RON ( -- ): enable EGA Set/Reset on all planes
        this.ega.out(0x3ce, 1);
        this.ega.out(0x3cf, 15);
        return { supported: true, note: 'enable EGA Set/Reset', output };
      case 0x937b: // SETCOLO ( -- ): set the EGA drawing color
        this.ega.out(0x3ce, 0);
        this.ega.out(0x3cf, this.memory[0x55f2]);
        return { supported: true, note: 'set EGA drawing color', output };
      case 0x9841: { // BUFFERX ( x y x-shift y-shift -- x' y' )
        const yShift = pop(dataStack, 'data') & 0xff;
        const xShift = pop(dataStack, 'data') & 0xff;
        const y = (pop(dataStack, 'data') - readWord(0x4e53) + 1) & 0xffff;
        const x = (pop(dataStack, 'data') - readWord(0x4e49)) & 0xffff;
        push(dataStack, (xShift >= 16 ? 0 : (x << xShift) & 0xffff) + readWord(0x595d));
        push(dataStack, (yShift >= 16 ? 0 : (y << yShift) & 0xffff) + readWord(0x596b) - 1);
        return { supported: true, note: 'buffer coordinates', output };
      }
      case 0x97cc: { // COLORMA ( value -- ): select the terrain color-map entry
        const value = pop(dataStack, 'data');
        const entry = 0x6a3f + (value & 0x8000 ? 0 : (value >>> 1) & 0x38);
        writeWord(0x58cd, entry);
        writeWord(0x55f2, this.memory[entry]);
        writeWord(0x55ff, this.memory[entry + 2]);
        return { supported: true, note: 'select terrain colors', output };
      }
      case 0x95be: { // SHL-BIT ( value bit -- value' ): shift in the low bit
        const bit = pop(dataStack, 'data');
        push(dataStack, (pop(dataStack, 'data') << 1) | (bit & 1));
        return { supported: true, note: 'shift in bit', output };
      }
      case 0x6cd6: { // E>CGA ( ega -- cga ): reverse the configured color mapping
        const color = pop(dataStack, 'data') & 15;
        let entry = 0;
        for (let index = 15; index >= 0; index--) {
          if ((this.memory[0x4fcd + index] & 15) === color) { entry = index + 1; break; }
        }
        push(dataStack, this.memory[0x4fbb + entry - 1]);
        return { supported: true, note: 'EGA to CGA color', output };
      }
      case 0x0d65: { // P@ ( port -- byte ): input from a modelled device port
        const port = pop(dataStack, 'data');
        let value = this.ports.get(port) ?? 0;
        if (port === 0x61) value = this.speakerPort;
        else if (port === 0x3da) { value ^= 9; this.ports.set(port, value); }
        else if (port === 0x60) value = this.keyQueue[0] === undefined ? 0x80 : this.keyQueue[0] >>> 8;
        else if ([0x3c4, 0x3c5, 0x3ce, 0x3cf].includes(port)) value = this.ega.input(port);
        push(dataStack, value & 0xff);
        return { supported: true, note: 'read device port', output };
      }
      case 0x0d56: { // P! ( value port -- ): output to a modelled device port
        const port = pop(dataStack, 'data');
        const value = pop(dataStack, 'data') & 0xff;
        this.ports.set(port, value);
        this.writeSpeakerPort(port, value);
        this.ega.out(port, value);
        return { supported: true, note: 'write device port', output };
      }
      case 0x0ed8: // RP@ ( -- address ): read the memory-backed return-stack pointer
        push(dataStack, (readWord(USER_AREA + 2) || 0xf7d0) - returnStack.length * 2);
        return { supported: true, note: 'return stack pointer', output };
      case 0x21c9: { // headerless ?STACK ( -- ): continue into 0B10h's "Empty stack" / "stack full" ABORT" on a bad SP
        const limit = toSignedCell(readWord(0x0a0b)) + toSignedCell(readWord(USER_AREA + 4)); // #SPACE + HERE (DP)
        const pointer = dataStack.pointer;
        if (limit >= -0x8000 && limit <= 0x7fff && (limit & 0xffff) <= pointer && readWord(USER_AREA) >= pointer) {
          return { supported: true, note: 'stack within bounds', output };
        }
        const target = this.engine.get(0x0b10, 'KERNEL');
        if (!target) throw new Error('?STACK error word 0x0b10 is missing');
        const frame = this.session!.frames.at(-1)!;
        const returnAddress = frame.word.tokens[frame.tokenIndex]?.addr ?? 0;
        push(returnStack, returnAddress); // JMP [0B10h] runs it in place of NEXT, returning to the current thread
        this.session!.frames.push({ word: target, tokenIndex: 0, returnAddress });
        return { supported: true, note: 'stack out of bounds: run W_0x0b10', output };
      }
      case 0x367f: { // headerless ( block -- offset index found ): find the drive range holding a block
        const block = pop(dataStack, 'data');
        let count = readWord(0x2b3a), found = 0, slot = 0, offset = 0;
        do { // LOOP from the last range down; a hit sets CX to 1 so the loop ends after it
          slot = (count - 1) & 0xffff;
          offset = (block - readWord(0x2d74 + slot * 2)) & 0xffff;
          if (toSignedCell(offset) >= 0 && toSignedCell((readWord(0x2d4c + slot * 2) - offset) & 0xffff) >= 0) {
            found++;
            count = 1;
          }
          count = (count - 1) & 0xffff;
        } while (count !== 0);
        push(dataStack, offset);
        push(dataStack, slot);
        push(dataStack, found);
        return { supported: true, note: 'find block range', output };
      }
      case 0x36bb: { // headerless ( index -- drive ): the range's drive byte at 2D23h, or 2C15h when it is zero, minus one
        const drive = this.memory[(0x2d23 + pop(dataStack, 'data')) & 0xffff] || readWord(0x2c15);
        push(dataStack, drive - 1);
        return { supported: true, note: 'range drive', output };
      }
      case 0x8d66: // headerless ( flags -- ): set the BIOS equipment word at 0000:0410h
        writeFarWord(0, 0x410, pop(dataStack, 'data'));
        return { supported: true, note: 'set BIOS equipment flags', output };
      case 0x4a0c: // PRTSCR ( -- ): capture BIOS printer output
        return { supported: true, note: 'capture printed screen', output: output + screenLines(this.snapshotScreen()).join('\n') + '\n' };
      case 0xb40e: { // XKEYINT ( -- ): apply the keyboard-hook buffer flush before BIOS processing
        const scan = this.keyQueue[0] === undefined ? 0x80 : this.keyQueue[0] >>> 8;
        if ((scan & 0x80) === 0) writeFarWord(0x40, 0x1a, readFarWord(0x40, 0x1c));
        return { supported: true, note: 'keyboard interrupt hook', output };
      }
      case 0xdf02: // ORBIT-OV SETQUAD ( -- ): save the quadrant stack pointer
        if (word.module !== 'ORBIT-OV') break;
        writeWord(0xdc20, dataStack.pointer);
        return { supported: true, note: 'save quadrant stack pointer', output };
      case 0xdf13: { // ORBIT-OV C*/ ( a b divisor -- result ): signed byte scaling
        if (word.module !== 'ORBIT-OV') break;
        const signedByte = (value: number) => (value << 24) >> 24;
        const divisor = signedByte(pop(dataStack, 'data'));
        const multiplier = signedByte(pop(dataStack, 'data'));
        const value = signedByte(pop(dataStack, 'data'));
        let quotient = Math.trunc(value * multiplier / divisor);
        if (!Number.isFinite(quotient) || quotient < -128 || quotient > 127) quotient = this.divideFault('C*/ divide overflow (INT 0)');
        push(dataStack, quotient);
        return { supported: true, note: 'signed byte scaling', output };
      }
      case 0xe770: { // FRACT-OV headerless ARRAY-FILL ( byte -- ): fill the 'ARRAY buffer with a byte
        if (this.loadedOverlay() !== 'FRACT-OV') break;
        const value = pop(dataStack, 'data') & 0xff;
        const array = readWord(0x4cf1);
        const count = readWord(array + 4), segment = readWord(array + 6);
        for (let index = 0; index < count; index++) this.writePhysicalByte((segment << 4) + index, value);
        return { supported: true, note: 'fill array', output };
      }
      case 0xe537: { // FRACT-OV headerless ?ARRAY! ( value x y -- ): store a byte in an empty (80h) 'ARRAY cell
        if (this.loadedOverlay() !== 'FRACT-OV') break;
        const y = pop(dataStack, 'data'), x = pop(dataStack, 'data');
        this.fractal(readWord, writeWord, readFarWord).storeIfEmpty(pop(dataStack, 'data'), x, y);
        return { supported: true, note: 'store in empty array cell', output };
      }
      case 0xe75e: { // FRACT-OV headerless PLASMA ( scale 0 0 x0 y0 x1 y1 -- ): subdivide the 'ARRAY rectangle
        if (this.loadedOverlay() !== 'FRACT-OV') break;
        const y1 = pop(dataStack, 'data'), x1 = pop(dataStack, 'data');
        const y0 = pop(dataStack, 'data'), x0 = pop(dataStack, 'data');
        pop(dataStack, 'data');
        pop(dataStack, 'data');
        const scale = pop(dataStack, 'data');
        writeWord(0xe392, (readWord(USER_AREA + 2) || 0xf7d0) - returnStack.length * 2); // saved BP (return stack)
        this.fractal(readWord, writeWord, readFarWord).subdivide(scale, x0, y0, x1, y1);
        return { supported: true, note: 'midpoint-displacement fractal', output };
      }
      case 0xead1: // FRACT-OV headerless ( -- ): mark the data stack as the local-cell frame
        if (this.loadedOverlay() !== 'FRACT-OV') break;
        writeWord(0xeacd, dataStack.pointer);
        return { supported: true, note: 'save frame stack pointer', output };
      case 0xeadc: // FRACT-OV headerless ( x1..x7 -- ): drop seven cells, then mark the frame
        if (this.loadedOverlay() !== 'FRACT-OV') break;
        dataStack.pointer = (dataStack.pointer + 14) & 0xffff;
        writeWord(0xeacd, dataStack.pointer);
        return { supported: true, note: 'drop frame and save stack pointer', output };
      case 0xeaea: // FRACT-OV headerless ( offset -- value ): fetch a frame cell
        if (this.loadedOverlay() !== 'FRACT-OV') break;
        push(dataStack, readWord(pop(dataStack, 'data') + readWord(0xeacd)));
        return { supported: true, note: 'fetch frame cell', output };
      case 0xeaf8: { // FRACT-OV headerless ( value offset -- ): store a frame cell
        if (this.loadedOverlay() !== 'FRACT-OV') break;
        const address = pop(dataStack, 'data') + readWord(0xeacd);
        writeWord(address, pop(dataStack, 'data'));
        return { supported: true, note: 'store frame cell', output };
      }
      case 0xed34: // FRACT-OV headerless ( n -- ): mark the locals base at n's cell and allot n cells below it
        if (this.loadedOverlay() !== 'FRACT-OV') break;
        writeWord(0xed30, dataStack.pointer);
        dataStack.pointer = (dataStack.pointer + 2 - pop(dataStack, 'data') * 2) & 0xffff;
        return { supported: true, note: 'allot locals', output };
      case 0xed44: // FRACT-OV headerless ( n -- ): drop n cells
        if (this.loadedOverlay() !== 'FRACT-OV') break;
        dataStack.pointer = (dataStack.pointer + 2 + pop(dataStack, 'data') * 2) & 0xffff;
        return { supported: true, note: 'free locals', output };
      case 0xed50: // FRACT-OV headerless ( i -- value ): fetch local i below the locals base
        if (this.loadedOverlay() !== 'FRACT-OV') break;
        push(dataStack, readWord(readWord(0xed30) - pop(dataStack, 'data') * 2));
        return { supported: true, note: 'fetch local', output };
      case 0xed62: { // FRACT-OV headerless ( value i -- ): store local i below the locals base
        if (this.loadedOverlay() !== 'FRACT-OV') break;
        const address = readWord(0xed30) - pop(dataStack, 'data') * 2;
        writeWord(address, pop(dataStack, 'data'));
        return { supported: true, note: 'store local', output };
      }
      case 0xee65: { // FRACT-OV headerless ( offset -- word1 word3 byte0 ): read a 5-byte record from the hidden page
        if (this.loadedOverlay() !== 'FRACT-OV') break;
        const segment = readWord(EGA_FLAG) & 1 ? readWord(0x52b3) : readWord(0x55d8);
        const offset = pop(dataStack, 'data');
        push(dataStack, readFarWord(segment, offset + 1));
        push(dataStack, readFarWord(segment, offset + 3));
        push(dataStack, this.readFarByte(segment, offset));
        return { supported: true, note: 'read 5-byte record', output };
      }
      case 0xee96: { // FRACT-OV headerless ( word1 word3 byte0 -- ): append a 5-byte record at ED7Dh
        if (this.loadedOverlay() !== 'FRACT-OV') break;
        const segment = readWord(0x5144), offset = readWord(0xed7d);
        this.writePhysicalByte((segment << 4) + offset, pop(dataStack, 'data'));
        writeFarWord(segment, offset + 3, pop(dataStack, 'data'));
        writeFarWord(segment, offset + 1, pop(dataStack, 'data'));
        writeWord(0xed7d, offset + 5);
        return { supported: true, note: 'append 5-byte record', output };
      }
      case 0xeec2: // FRACT-OV headerless ( a b c -- ): drop three cells
        if (this.loadedOverlay() !== 'FRACT-OV') break;
        dataStack.pointer = (dataStack.pointer + 6) & 0xffff;
        return { supported: true, note: 'drop three cells', output };
      case 0xeecc: { // FRACT-OV headerless ( x -- x flag ): x equals ED81h
        if (this.loadedOverlay() !== 'FRACT-OV') break;
        const value = pop(dataStack, 'data');
        push(dataStack, value);
        push(dataStack, value === readWord(0xed81) ? 1 : 0);
        return { supported: true, note: 'compare with ED81h', output };
      }
      case 0xeee5: // FRACT-OV headerless ( -- 0 404h [ED81h] ): push a terminating record
        if (this.loadedOverlay() !== 'FRACT-OV') break;
        push(dataStack, 0);
        push(dataStack, 0x0404);
        push(dataStack, readWord(0xed81));
        return { supported: true, note: 'push terminating record', output };
      case 0xdd2c: { // ORBIT-OV headerless ( u v -- a b ): interpolate the quad saved by SETQUAD at (u, v) in quarters
        if (this.loadedOverlay() !== 'ORBIT-OV') break;
        const v = pop(dataStack, 'data'), u = pop(dataStack, 'data');
        writeWord(0xdc24, v);
        writeWord(0xdc28, u);
        const quad = readWord(0xdc20);
        const corner = (offset: number) => readWord(quad + offset);
        const lerp = (selector: number, from: number, to: number): number => {
          const half = (a: number, b: number) => toSignedCell((a + b + 1) & 0xffff) >> 1 & 0xffff;
          const middle = half(to, from);
          switch (readWord(0xdd14 + selector * 2)) { // DD20h: jump table at DD14h
            case 0xdce4: return from;
            case 0xdce9: return half(middle, from);
            case 0xdcf8: return middle;
            case 0xdd02: return half(middle, to);
            case 0xdd11: return to;
            default: throw new Error(`ORBIT-OV DD20h selector ${selector} has no interpolation entry`);
          }
        };
        push(dataStack, lerp(v, lerp(u, corner(0xe), corner(0xa)), lerp(u, corner(2), corner(6))));
        push(dataStack, lerp(u, lerp(v, corner(0xc), corner(0)), lerp(v, corner(8), corner(4))));
        return { supported: true, note: 'interpolate quad', output };
      }
      case 0xe16b: { // ORBIT-OV headerless ( -- ): translate 3-byte points by the centre at DBD4h/DBD8h/DBDCh
        if (this.loadedOverlay() !== 'ORBIT-OV') break;
        const segment = readWord(0x5dd3);
        let source = readWord(0x569b), destination = readWord(0x5dde);
        const centre = [this.memory[0xdbd4], this.memory[0xdbd8], this.memory[0xdbdc]];
        for (let count = readWord(0x5686) || 0x10000; count > 0; count--) {
          for (const axis of centre) {
            this.writePhysicalByte((segment << 4) + destination, this.readFarByte(segment, source) - axis);
            source = (source + 1) & 0xffff;
            destination = (destination + 1) & 0xffff;
          }
        }
        return { supported: true, note: 'translate points', output };
      }
      case 0xe1b6: { // ORBIT-OV headerless ( -- ): rotate 3-byte points by the byte matrix at DCC2h into 6-byte records
        if (this.loadedOverlay() !== 'ORBIT-OV') break;
        const segment = readWord(0x5dd3);
        const signedByte = (value: number) => (value << 24) >> 24;
        for (let row = 0; row < 3; row++) {
          const matrix = 0xdcc2 + row * 8;
          const factors = [this.memory[matrix], this.memory[matrix + 2], this.memory[matrix + 4]].map(signedByte);
          writeWord(0xdc0c, readWord(matrix + 6));
          let source = readWord(0x5dde), destination = (readWord(0x56a6) + row * 2) & 0xffff;
          for (let count = readWord(0x5686) || 0x10000; count > 0; count--) {
            let sum = readWord(0xdc0c);
            for (const factor of factors) {
              sum += signedByte(this.readFarByte(segment, source)) * factor;
              source = (source + 1) & 0xffff;
            }
            writeFarWord(segment, destination, sum);
            destination = (destination + 6) & 0xffff;
          }
        }
        return { supported: true, note: 'rotate points', output };
      }
      case 0xe228: { // ORBIT-OV headerless ( -- ): perspective-project the 6-byte (x y z) records in place
        if (this.loadedOverlay() !== 'ORBIT-OV') break;
        const segment = readWord(0x5dd3);
        const project = (value: number, scale: number, depth: number) => {
          const quotient = depth === 0 ? NaN : Math.trunc(toSignedCell(value) * toSignedCell(scale) / depth);
          return quotient >= -0x8000 && quotient <= 0x7fff ? quotient : this.divideFault('ORBIT-OV projection divide overflow (INT 0)');
        };
        let record = readWord(0x56a6);
        for (let count = readWord(0x5686) || 0x10000; count > 0; count--) {
          const depth = toSignedCell(readFarWord(segment, record + 4));
          writeFarWord(segment, record + 2, project(readFarWord(segment, record + 2), readWord(0xdc14), depth) + readWord(0x5dec));
          writeFarWord(segment, record, project(readFarWord(segment, record), readWord(0xdc10), depth) + readWord(0x5dfa));
          record = (record + 6) & 0xffff;
        }
        return { supported: true, note: 'project points', output };
      }
      case 0xe48c: // ORBIT-OV headerless ( x1 y1 x2 y2 x3 y3 x4 y4 -- ): store four pairs at DC38h
        if (this.loadedOverlay() !== 'ORBIT-OV') break;
        for (let address = 0xdc44; address >= 0xdc38; address -= 4) {
          writeWord(address, pop(dataStack, 'data'));
          writeWord(address + 2, pop(dataStack, 'data'));
        }
        return { supported: true, note: 'store four pairs', output };
      case 0xe4aa: // ORBIT-OV headerless ( x1..x8 -- ): drop eight cells
        if (this.loadedOverlay() !== 'ORBIT-OV') break;
        dataStack.pointer = (dataStack.pointer + 16) & 0xffff;
        return { supported: true, note: 'drop eight cells', output };
      case 0xe8f3: // MOVE-OV CBLTP ( x y -- ): configure the cursor bitmap
      case 0xefd9: { // MOVE-OV / MAPS-OV CBLTP ( x y -- ): configure the cursor bitmap
        if ((word.codep === 0xe8f3 && word.module !== 'MOVE-OV') || (word.codep === 0xefd9 && word.module !== 'MAPS-OV')) break;
        writeWord(0x5863, pop(dataStack, 'data') + 3);
        writeWord(0x586e, pop(dataStack, 'data') + 6);
        writeWord(0x5892, 4);
        writeWord(0x5887, 6);
        writeWord(0x589d, word.module === 'MOVE-OV' ? 0xe8e5 : 0xefcb);
        writeWord(0x58aa, 0x0192);
        return { supported: true, note: 'configure cursor bitmap', output };
      }
      case 0xf0c1: { // SITE-OV |EGA ( flag -- ): transfer the site's planar screen band
        if (word.module !== 'SITE-OV') break;
        const toDisplay = (pop(dataStack, 'data') & 1) !== 0;
        const offset = readWord(readWord(0x563a) + 197 * 2);
        const display = readWord(0x55e6), hidden = readWord(0x55d8);
        this.latchCopy(toDisplay ? hidden : display, offset, toDisplay ? display : hidden, offset, 0xa28);
        return { supported: true, note: 'copy site EGA band', output };
      }
      case 0xf050: // SITE-OV (|REGION) ( segment restore -- ): transfer a packed region
      case 0xec0c: { // SITE-OV / PORTMENU-OV (|REGION) ( segment restore -- ): transfer a packed region
        if ((word.codep === 0xf050 && word.module !== 'SITE-OV') || (word.codep === 0xec0c && word.module !== 'PORTMENU-OV')) break;
        const restore = pop(dataStack, 'data');
        const segment = pop(dataStack, 'data');
        writeWord(0x561c, restore);
        const wordsPerRow = (readWord(0x5892) >>> 2) + 2;
        const height = readWord(0x5887);
        if (height === 0) throw new RangeError('(|REGION) requires a nonzero height');
        const horizontal = readWord(0x586e) >>> 1;
        const frameSegment = readWord(0x5648);
        for (let row = 0; row < height; row++) {
          const screenRow = (readWord(0x5863) - height + row + 1) & 0xffff;
          const frameOffset = (readWord(readWord(0x563a) + screenRow * 2) + horizontal) & 0xffff;
          for (let column = 0; column < wordsPerRow; column++) {
            const packedOffset = (row * wordsPerRow + column) * 2;
            const screenOffset = frameOffset + column * 2;
            if (restore) writeFarWord(frameSegment, screenOffset, readFarWord(segment, packedOffset));
            else writeFarWord(segment, packedOffset, readFarWord(frameSegment, screenOffset));
          }
        }
        return { supported: true, note: restore ? 'restore packed region' : 'save packed region', output };
      }
      case 0xf220: { // BLT-OV .RUNBIT ( segment offset -- ): decode a packed CGA run-length bitmap
        if (word.module !== 'BLT-OV') break;
        let pointer = pop(dataStack, 'data');
        const segment = pop(dataStack, 'data');
        const runs = readFarWord(segment, pointer) || 0x10000;
        pointer = (pointer + 2) & 0xffff;
        writeWord(0x58aa, segment);
        writeWord(0x562e, pointer);
        const left = readWord(0x586e), width = readWord(0x5892);
        const end = (left + width) & 0xffff;
        let horizontal = left, vertical = readWord(0x5863);
        writeWord(0x5625, end);
        for (let run = 0; run < runs; run++) {
          const count = this.readFarByte(segment, pointer);
          pointer = (pointer + 1) & 0xffff;
          if ((run & 1) === 0) {
            for (let index = 0; index < count; index++) {
              const offset = (readWord(readWord(0x563a) + vertical * 2) + (horizontal >>> 1)) & 0xffff;
              const mask = horizontal & 1 ? 0x0f : 0xf0;
              const frameSegment = readWord(0x5648);
              const value = (this.readFarByte(frameSegment, offset) & ~mask) | (this.memory[0x55f2] & mask);
              this.writePhysicalByte((frameSegment << 4) + offset, value);
              horizontal = (horizontal + 1) & 0xffff;
              if (horizontal === end) { horizontal = left; vertical = (vertical - 1) & 0xffff; }
            }
          } else {
            horizontal = (horizontal + count) & 0xffff;
            if (count !== 0 && toSignedCell((horizontal - end) & 0xffff) >= 0) {
              horizontal = (horizontal - width) & 0xffff;
              vertical = (vertical - 1) & 0xffff;
            }
          }
        }
        writeWord(0x561c, horizontal);
        writeWord(0x5613, vertical);
        return { supported: true, note: 'draw CGA run-length bitmap', output };
      }
      case 0xeb4a: // GAME-OV PRMSAV ( buffer -- ): save data-stack context
      case 0xebaa: { // GAME-OV PRMSAV / RETSAV ( buffer -- ): save data/return stack context
        if (word.module !== 'GAME-OV') break;
        const buffer = pop(dataStack, 'data');
        const dataContext = word.codep === 0xeb4a;
        const base = readWord(USER_AREA + (dataContext ? 0 : 2));
        const count = dataContext ? 1000 : 220;
        const pointer = dataContext ? dataStack.pointer : (base - returnStack.length * 2) & 0xffff;
        writeWord(buffer, pointer);
        const frame = this.session!.frames.at(-1)!;
        const next = frame.word.tokens[frame.tokenIndex]?.addr;
        if (next === undefined) throw new Error('Stack save has no continuation');
        writeWord(dataStack.pointer - 2, next);
        writeWord(dataStack.pointer - 4, USER_AREA);
        for (let index = 0; index < count; index++) this.memory[(buffer + 2 + index) & 0xffff] = this.memory[(base - count + index) & 0xffff];
        return { supported: true, note: dataContext ? 'save data-stack context' : 'save return-stack context', output };
      }
      case 0xeb72: { // GAME-OV PRMLOD ( buffer -- ): restore data-stack context
        if (word.module !== 'GAME-OV') break;
        const buffer = pop(dataStack, 'data');
        const pointer = readWord(buffer);
        const frame = this.session!.frames.at(-1)!;
        const next = frame.word.tokens[frame.tokenIndex]?.addr;
        if (next === undefined) throw new Error('Stack restore has no continuation');
        const returnPointer = (readWord(USER_AREA + 2) - returnStack.length * 2) & 0xffff;
        writeWord(returnPointer - 2, next);
        writeWord(returnPointer - 4, USER_AREA);
        const base = readWord(USER_AREA);
        for (let index = 0; index < 1000; index++) this.memory[(base - 1000 + index) & 0xffff] = this.memory[(buffer + 2 + index) & 0xffff];
        dataStack.pointer = (pointer + readWord(0xde72)) & 0xffff;
        return { supported: true, note: 'restore data-stack context', output };
      }
      case 0xebd2: { // GAME-OV RETJMP ( buffer -- ): restore return-stack context and resume its thread
        if (word.module !== 'GAME-OV') break;
        const buffer = pop(dataStack, 'data');
        const pointer = readWord(buffer);
        const base = readWord(USER_AREA + 2);
        writeWord(dataStack.pointer - 2, USER_AREA);
        for (let index = 0; index < 220; index++) this.memory[(base - 220 + index) & 0xffff] = this.memory[(buffer + 2 + index) & 0xffff];
        const resumedPointer = (pointer + readWord(0xde6e)) & 0xffff;
        const address = readWord(resumedPointer);
        const depth = ((base - resumedPointer - 2) & 0xffff) >>> 1;
        if (depth > 0x800) throw new RangeError('Invalid restored return-stack pointer');
        returnStack.length = depth;
        this.resumeThread(address);
        return { supported: true, note: 'restore return-stack context', output };
      }
      case 0x910f: { // L@PIXEL ( x y -- color ): read the pixel pair from all four EGA planes
        const y = pop(dataStack, 'data');
        const x = pop(dataStack, 'data');
        const offset = (readWord(readWord(0x563a) + y * 2) + (x >>> 2)) & 0xffff;
        const mask = readWord(0x92cf + (x & 3) * 2);
        this.ega.out(0x3ce, 7);
        this.ega.out(0x3cf, 15);
        this.ega.out(0x3ce, 5);
        this.ega.out(0x3cf, 0);
        let color = 0;
        for (let plane = 0; plane < 4; plane++) {
          this.ega.out(0x3ce, 4);
          this.ega.out(0x3cf, plane);
          if (this.readFarByte(readWord(0x5648), offset) & mask) color |= 1 << plane;
        }
        push(dataStack, color);
        return { supported: true, note: 'read EGA pixel pair', output };
      }
      case 0x9097: // SQLPLOT ( x y -- ): plot a pixel pair on two adjacent rows
      case 0x9017: { // SQLPLOT / LXPLOT ( x y -- ): plot two rows or XOR a pixel pair
        const y = pop(dataStack, 'data');
        const x = pop(dataStack, 'data');
        this.ega.out(0x3ce, 1);
        this.ega.out(0x3cf, 15);
        if (word.codep === 0x9017) {
          this.ega.out(0x3ce, 3);
          this.ega.out(0x3cf, 0x18);
        }
        this.ega.out(0x3ce, 0);
        this.ega.out(0x3cf, this.memory[0x55f2]);
        this.plotEga(x, y);
        if (word.codep === 0x9097) this.plotEga(x, (y + 1) & 0xffff);
        else {
          this.ega.out(0x3ce, 3);
          this.ega.out(0x3cf, 0);
        }
        this.ega.out(0x3ce, 8);
        this.ega.out(0x3cf, 0xff);
        return { supported: true, note: word.codep === 0x9017 ? 'XOR EGA pixel pair' : 'plot two EGA rows', output };
      }
      case 0x9081: { // TILEFILL ( x bottom height width -- ): fill an aligned terrain tile
        const width = pop(dataStack, 'data');
        const height = pop(dataStack, 'data');
        const bottom = pop(dataStack, 'data');
        const x = pop(dataStack, 'data');
        if (height === 0) throw new RangeError('TILEFILL requires a nonzero height');
        const originalColor = readWord(0x55f2);
        writeWord(0x55f2, readWord(readWord(0x58cd)));
        this.ega.out(0x3ce, 1);
        this.ega.out(0x3cf, 15);
        this.ega.out(0x3ce, 0);
        this.ega.out(0x3cf, this.memory[0x55f2]);
        const top = (bottom - height + 1) & 0xffff;
        for (let row = 0; row < height; row++) {
          const y = (top + row) & 0xffff;
          if (width === 8) {
            const offset = (readWord(readWord(0x563a) + y * 2) + (x >>> 2)) & 0xffff;
            this.ega.out(0x3ce, 8);
            this.ega.out(0x3cf, 0xff);
            writeFarWord(readWord(0x5648), offset, 0x00ff);
          } else {
            const left = x & 0xfe;
            this.hlineEga(left, (left + width - 1) & 0xffff, y, readWord, writeWord);
          }
        }
        if (width !== 8) writeWord(0x57ce, bottom + 1);
        else writeWord(0x57ce, top);
        writeWord(0x55f2, originalColor);
        return { supported: true, note: 'fill terrain tile', output };
      }
      case 0x90c3: { // EEXTENT ( -- left bottom right top ): compute scaled arc bounds
        const radius = readWord(0x5a79);
        const horizontal = this.scaleArc(radius, readWord);
        push(dataStack, readWord(0x5a65) - horizontal);
        push(dataStack, readWord(0x5a6e) - radius);
        push(dataStack, readWord(0x5a65) + horizontal);
        push(dataStack, readWord(0x5a6e) + radius);
        return { supported: true, note: 'arc extents', output };
      }
      case 0x90f9: // ARC ( -- ): draw points or build scanlines using the selected arc helper
        this.drawArc(readWord, writeWord);
        return { supported: true, note: 'draw arc', output };
      case 0x8783: // CLIPPER ( -- ): clip the configured polygon using the cached side table
        this.clipPolygon(readWord, writeWord);
        return { supported: true, note: 'clip polygon', output };
      case 0x16a3: { // GO ( address -- ): terminate, restart the COM bootstrap, or call a translated entry point
        const address = pop(dataStack, 'data');
        if (address === 0) {
          this.session!.frames.length = 0;
          this.session!.exitedToDos = true;
          return { supported: true, note: 'DOS program return', output };
        }
        if (address === 0x100) {
          const entry = this.engine.get(readWord(0x0129), 'KERNEL');
          if (!entry || entry.codep !== CODE_CALL) throw new Error('COM bootstrap entry is not a known Forth definition');
          dataStack.pointer = (readWord(0x0705) + 0x100) & 0xffff;
          returnStack.length = 0;
          this.session!.frames.splice(0, this.session!.frames.length, { word: entry, tokenIndex: 0 });
          return { supported: true, note: 'restart Forth bootstrap', output };
        }
        const target = this.translatedCodeEntry(address, word.module);
        if (!target || target.codep === word.codep) return { supported: false, note: 'unknown machine-code target', output, stop: `GO target 0x${address.toString(16)} has no TypeScript translation.` };
        return this.executePrimitive(target, dataStack, returnStack, output, push, pop, readWord, writeWord, readFarWord, writeFarWord);
      }
      case 0x1536: { // (>CODE): run a known translated inline entry, skipping its machine-code payload
        const frame = this.session!.frames.at(-1)!;
        const next = frame.word.tokens[frame.tokenIndex]?.addr;
        if (next === undefined) throw new Error('(>CODE) has no inline payload');
        const entry = (next + 2) & 0xffff;
        const target = this.translatedCodeEntry(entry, word.module);
        if (!target || target.codep === word.codep) return { supported: false, note: 'unknown inline code', output, stop: `(>CODE) block at 0x${entry.toString(16)} has no TypeScript translation.` };
        this.resumeThread((entry + readWord(next)) & 0xffff);
        return this.executePrimitive(target, dataStack, returnStack, output, push, pop, readWord, writeWord, readFarWord, writeFarWord);
      }
      case 0x1548: { // (;VIA): resume the thread after the inline target's code field
        const frame = this.session!.frames.at(-1)!;
        const next = frame.word.tokens[frame.tokenIndex]?.addr;
        if (next === undefined) throw new Error('(;VIA) has no inline target');
        this.resumeThread((readWord(next) + 2) & 0xffff);
        return { supported: true, note: 'redirect threaded continuation', output };
      }
      case 0x1772: { // SYSCALL ( function argument -- result ): DOS CALL 5 through the existing DOS services
        const argument = pop(dataStack, 'data');
        const service = pop(dataStack, 'data') & 0xff;
        if (service === 0) {
          this.session!.frames.length = 0;
          return { supported: true, note: 'DOS process termination', output };
        }
        if (service === 2 || service === 6) {
          const character = argument & 0xff;
          if (service === 6 && character === 0xff) push(dataStack, (this.keyQueue.shift() ?? 0) & 0xff);
          else { output += CP437[character]; push(dataStack, character); }
          return { supported: true, note: 'DOS console character', output };
        }
        if (service === 9) {
          let terminated = false;
          for (let index = 0; index < 0x10000; index++) {
            const character = this.memory[(argument + index) & 0xffff];
            if (character === 0x24) { terminated = true; break; }
            output += CP437[character];
          }
          if (!terminated) throw new Error('Unterminated DOS console string');
          push(dataStack, 0x24);
          return { supported: true, note: 'DOS console string', output };
        }
        const cells = [0x16b6, 0x16bc, 0x16c0, 0x16c4];
        const saved = cells.map(readWord);
        try {
          writeWord(0x16b6, (service << 8) | (word.cfa & 0xff));
          writeWord(0x16bc, argument);
          writeWord(0x16c0, argument);
          writeWord(0x16c4, 0x0192);
          push(dataStack, 0x21);
          const result = this.executePrimitive({ ...word, name: 'INTERRUPT', codep: 0 }, dataStack, returnStack, output, push, pop, readWord, writeWord, readFarWord, writeFarWord);
          if (result.supported) push(dataStack, readWord(0x16b6) & 0xff);
          return { ...result, note: `DOS CALL 5 service 0x${service.toString(16)}` };
        } finally {
          cells.forEach((address, index) => writeWord(address, saved[index]));
        }
      }
      case 0x14bd: { // DIGIT ( char base -- digit flag | 0 ): convert a character using the low-byte base
        const base = pop(dataStack, 'data') & 0xff;
        const character = pop(dataStack, 'data');
        let digit = (character & 0xff) - 0x30;
        if (digit > 9) digit -= 7;
        const valid = digit >= 0 && digit < base && ((character & 0xff) <= 0x39 || digit >= 10);
        if (valid) push(dataStack, digit);
        push(dataStack, valid ? (character & 0xff00) | 1 : 0);
        return { supported: true, note: 'convert digit', output };
      }
      case 0x4c87: { // (SLIPPE ( n -- n mask | 0 ): test the 256-bit sliding bitmap
        const value = pop(dataStack, 'data');
        const relative = (value - readWord(0x4c57) + 0x80) & 0xffff;
        const mask = relative < 256 ? (readWord(0x4c4c) >>> (relative & 7)) & this.memory[0x4c5b + (relative >>> 3)] : 0;
        if (mask !== 0) push(dataStack, value);
        push(dataStack, mask);
        return { supported: true, note: 'sliding bitmap lookup', output };
      }
      case 0x9a82: // headerless @IB ( segment -- value ): fetch the current icon's unsigned byte field
        push(dataStack, this.readFarByte(pop(dataStack, 'data'), readWord(0x5a02)));
        return { supported: true, note: 'read icon byte', output };
      case 0x9a6c: // @IW ( segment -- value ): fetch the current icon's word field
        push(dataStack, readFarWord(pop(dataStack, 'data'), (readWord(0x5a02) << 1) & 0xffff));
        return { supported: true, note: 'read icon word', output };
      case 0x992d: { // ?INVIS ( x y -- flag ): true inside the inclusive world viewport
        const y = pop(dataStack, 'data');
        const x = pop(dataStack, 'data');
        const inside = !((y - readWord(0x5b31)) & 0x8000) && toSignedCell(y) <= toSignedCell(readWord(0x5b22))
          && !((x - readWord(0x5b3c)) & 0x8000) && toSignedCell(x) <= toSignedCell(readWord(0x5b26));
        push(dataStack, inside ? 1 : 0);
        return { supported: true, note: 'world viewport inclusion', output };
      }
      case 0x9970: { // WLD>SCR ( x y -- x' y' ): signed coordinate scaling into the viewport
        const scale = (coordinate: number, origin: number, ratio: number, destination: number) => {
          const divisor = toSignedCell(readWord(ratio + 2));
          let quotient = Math.trunc(toSignedCell((coordinate - readWord(origin)) & 0xffff) * toSignedCell(readWord(ratio)) / divisor);
          if (!Number.isFinite(quotient) || quotient < -0x8000 || quotient > 0x7fff) quotient = this.divideFault('WLD>SCR divide overflow (INT 0)');
          return (quotient + readWord(destination)) & 0xffff;
        };
        const y = scale(pop(dataStack, 'data'), 0x5b31, 0x6221, 0x596b);
        writeWord(0x48c6, y);
        const x = scale(pop(dataStack, 'data'), 0x5b3c, 0x6211, 0x595d);
        push(dataStack, x);
        push(dataStack, y);
        return { supported: true, note: 'world to screen coordinates', output };
      }
      case 0x99b4: { // SCR>BLT ( x y -- x' y' ): offset the icon's blit origin
        const y = pop(dataStack, 'data');
        const x = pop(dataStack, 'data');
        push(dataStack, x - readWord(0x5a4e));
        push(dataStack, y + 7 - readWord(0x5a4e));
        return { supported: true, note: 'screen to blit coordinates', output };
      }
      case 0x39ee: { // MATCH ( text length pattern pattern-length -- flag offset ): scan forward, returning the last compared offset
        const patternLength = pop(dataStack, 'data');
        const pattern = pop(dataStack, 'data');
        let remaining = pop(dataStack, 'data');
        const text = pop(dataStack, 'data');
        let cursor = text, residue = text;
        if (patternLength === 0) throw new RangeError('MATCH requires a nonempty pattern');
        while (remaining >= patternLength) {
          residue = patternLength;
          let equal = false;
          do {
            equal = this.memory[(pattern + patternLength - residue) & 0xffff] === this.memory[cursor & 0xffff];
            cursor = (cursor + 1) & 0xffff;
            residue--;
          } while (equal && residue !== 0);
          if (equal) { remaining = 0xffff; break; }
          remaining = (remaining - patternLength + residue) & 0xffff;
          if (remaining === 0) { residue = 0x0192; break; }
        }
        push(dataStack, residue === 0 ? 1 : 0);
        push(dataStack, remaining + cursor - text);
        return { supported: true, note: 'match byte pattern', output };
      }
      case 0x0c71: { // C!L ( value offset bank -- ): store a byte in a 64K bank
        const segment = (pop(dataStack, 'data') & 15) << 12;
        const offset = pop(dataStack, 'data');
        this.writePhysicalByte((segment << 4) + offset, pop(dataStack, 'data'));
        return { supported: true, note: 'store banked byte', output };
      }
      case 0x0ca7: { // C@L ( offset bank -- value ): fetch a byte from a 64K bank
        const segment = (pop(dataStack, 'data') & 15) << 12;
        push(dataStack, this.readFarByte(segment, pop(dataStack, 'data')));
        return { supported: true, note: 'read banked byte', output };
      }
      case 0x49f0: { // L+-@ ( segment offset -- value ): sign-extend a far byte
        const offset = pop(dataStack, 'data');
        const value = this.readFarByte(pop(dataStack, 'data'), offset);
        push(dataStack, (value << 24) >> 24);
        return { supported: true, note: 'read signed far byte', output };
      }
      case 0x4bd9: { // L1.5@ ( segment offset -- low high ): fetch a far cell and trailing byte
        const offset = pop(dataStack, 'data');
        const segment = pop(dataStack, 'data');
        push(dataStack, readFarWord(segment, offset));
        push(dataStack, this.readFarByte(segment, (offset + 2) & 0xffff));
        return { supported: true, note: 'read far cell and byte', output };
      }
      case 0x0ce4: { // CMOVE> ( source destination count -- ): copy bytes backward
        const count = pop(dataStack, 'data');
        const destination = pop(dataStack, 'data');
        const source = pop(dataStack, 'data');
        for (let index = count - 1; index >= 0; index--) this.memory[(destination + index) & 0xffff] = this.memory[(source + index) & 0xffff];
        return { supported: true, note: 'backward near byte copy', output };
      }
      case 0x48dc: { // <LCMOVE ( source-segment source-offset destination-segment destination-offset count -- )
        const count = pop(dataStack, 'data');
        const destination = pop(dataStack, 'data');
        const destinationSegment = pop(dataStack, 'data');
        const source = pop(dataStack, 'data');
        const sourceSegment = pop(dataStack, 'data');
        for (let index = count - 1; index >= 0; index--) {
          this.writePhysicalByte((destinationSegment << 4) + ((destination + index) & 0xffff), this.readFarByte(sourceSegment, (source + index) & 0xffff));
        }
        return { supported: true, note: 'backward far byte copy', output };
      }
      case 0x29e1: // V@ ( offset -- char ): read the character byte in VIDEOMEM
        push(dataStack, this.readFarByte(readWord(USER_AREA + 0x18), pop(dataStack, 'data')));
        return { supported: true, note: 'read video character', output };
      case 0x2a18: { // VFILL ( offset count value -- ): fill video cells
        const value = pop(dataStack, 'data');
        const count = pop(dataStack, 'data');
        const offset = pop(dataStack, 'data');
        for (let index = 0; index < count; index++) writeFarWord(readWord(USER_AREA + 0x18), offset + index * 2, value);
        return { supported: true, note: 'fill video cells', output };
      }
      case 0x2a36: // VMOVE ( source destination count -- ): copy video cells forward
      case 0x2a5f: { // VMOVE / VMOVE- ( source destination count -- ): copy video cells forward/backward
        const count = pop(dataStack, 'data');
        const destination = pop(dataStack, 'data');
        const source = pop(dataStack, 'data');
        const segment = readWord(USER_AREA + 0x18);
        for (let step = 0; step < count; step++) {
          const index = word.codep === 0x2a5f ? -step : step;
          writeFarWord(segment, destination + index * 2, readFarWord(segment, source + index * 2));
        }
        return { supported: true, note: 'copy video cells', output };
      }
      case 0x4910: { // 2^N ( n -- mask ): 8086 rotate-through-carry by CL after incrementing CX
        const count = (pop(dataStack, 'data') + 1) & 0xffff;
        let value = 0, carry = 1;
        for (let index = 0; index < (count & 0xff); index++) {
          const nextCarry = value >>> 15;
          value = ((value << 1) | carry) & 0xffff;
          carry = nextCarry;
        }
        push(dataStack, value);
        return { supported: true, note: 'bit mask', output };
      }
      case 0x1047: // 4* ( n -- n' ): multiply a cell by four
        unary(value => value << 2);
        return { supported: true, note: 'multiply by four', output };
      case 0x4984: // 3+ ( n -- n' ): add three with cell wrapping
        unary(value => value + 3);
        return { supported: true, note: 'add three', output };
      case 0x1355: { // TOGGLE ( addr mask -- ): XOR the low byte of mask into memory
        const mask = pop(dataStack, 'data');
        const address = pop(dataStack, 'data');
        this.memory[address] ^= mask & 0xff;
        return { supported: true, note: 'toggle byte bits', output };
      }
      case 0x0bbf: { // @L ( offset bank -- value ): bank's low nibble selects a 64K physical bank
        const segment = (pop(dataStack, 'data') & 0x0f) << 12;
        push(dataStack, readFarWord(segment, pop(dataStack, 'data')));
        return { supported: true, note: 'read banked word', output };
      }
      case 0x0bf1: { // !L ( value offset bank -- ): store a word in a 64K physical bank
        const segment = (pop(dataStack, 'data') & 0x0f) << 12;
        const offset = pop(dataStack, 'data');
        writeFarWord(segment, offset, pop(dataStack, 'data'));
        return { supported: true, note: 'store banked word', output };
      }
      case 0x9eb1: { // ?IID ( lower upper start count -- indices... matches ): find icon IDs between exclusive bounds
        const count = pop(dataStack, 'data');
        writeWord(0x5b04, pop(dataStack, 'data'));
        const upper = pop(dataStack, 'data');
        writeWord(0x48c8, pop(dataStack, 'data'));
        const segment = readWord(0x59c6);
        let matches = 0;
        push(dataStack, matches);
        for (let remaining = toSignedCell(count); remaining > 0; remaining--) {
          const index = (remaining - 1 + readWord(0x5b04)) & 0xffff;
          const id = this.readFarByte(segment, index);
          if (toSignedCell((id - upper) & 0xffff) < 0 && id > toSignedCell(readWord(0x48c8))) {
            pop(dataStack, 'data');
            push(dataStack, index);
            push(dataStack, ++matches);
          }
        }
        return { supported: true, note: `icon ID matches: ${matches}`, output };
      }
      case 0x9e14: { // XCHGICON ( first second -- ): swap three byte fields and three word fields of two icons
        const second = pop(dataStack, 'data');
        const first = pop(dataStack, 'data');
        for (const segmentCell of [0x59c6, 0x59ca, 0x59da]) {
          const segment = readWord(segmentCell);
          const firstValue = this.readFarByte(segment, first);
          const secondValue = this.readFarByte(segment, second);
          this.writePhysicalByte((segment << 4) + second, firstValue);
          this.writePhysicalByte((segment << 4) + first, secondValue);
        }
        const firstOffset = (first << 1) & 0xffff;
        const secondOffset = (second << 1) & 0xffff;
        for (const segmentCell of [0x59be, 0x59c2, 0x59ce]) {
          const segment = readWord(segmentCell);
          const firstValue = readFarWord(segment, firstOffset);
          const secondValue = readFarWord(segment, secondOffset);
          writeFarWord(segment, secondOffset, firstValue);
          writeFarWord(segment, firstOffset, secondValue);
        }
        return { supported: true, note: `swap icons ${first} and ${second}`, output };
      }
      case 0x9d18: { // ?ILOCUS ( x y radius start count -- indices... matches ): find icons within a square locus
        const count = pop(dataStack, 'data');
        writeWord(0x5b04, pop(dataStack, 'data'));
        writeWord(0x5b00, pop(dataStack, 'data'));
        writeWord(0x5afc, pop(dataStack, 'data'));
        writeWord(0x5af8, pop(dataStack, 'data'));
        let matches = 0;
        push(dataStack, matches);
        for (let remaining = toSignedCell(count); remaining > 0; remaining--) {
          const offset = ((remaining - 1 + readWord(0x5b04)) << 1) & 0xffff;
          let inside = true;
          for (const [segmentCell, centerCell] of [[0x59be, 0x5af8], [0x59c2, 0x5afc]]) {
            const difference = toSignedCell((readFarWord(readWord(segmentCell), offset) - readWord(centerCell)) & 0xffff);
            if (toSignedCell(Math.abs(difference)) > toSignedCell(readWord(0x5b00))) {
              inside = false;
              break;
            }
          }
          if (inside) {
            pop(dataStack, 'data');
            push(dataStack, offset >>> 1);
            push(dataStack, ++matches);
          }
        }
        return { supported: true, note: `icon locus matches: ${matches}`, output };
      }
      case 0x4b08: { // D2* ( low high -- low' high' ): shift a double cell left, carrying from low to high
        const high = pop(dataStack, 'data');
        const low = pop(dataStack, 'data');
        push(dataStack, low << 1);
        push(dataStack, (high << 1) | (low >>> 15));
        return { supported: true, note: 'double-cell left shift', output };
      }
      case 0x4b17: { // EASY-BITS ( low high trial count -- low' high' trial' ): iterative square-root steps
        const count = pop(dataStack, 'data') || 0x10000;
        let trial = pop(dataStack, 'data');
        let high = pop(dataStack, 'data');
        let low = pop(dataStack, 'data');
        for (let iteration = 0; iteration < count; iteration++) {
          high = ((high << 2) | (low >>> 14)) & 0xffff;
          low = (low << 2) & 0xffff;
          const difference = (high - trial) & 0xffff;
          if ((difference & 0x8000) !== 0) {
            trial = ((trial << 1) - 1) & 0xffff;
          } else {
            high = difference;
            trial = (((trial + 1) << 1) + 1) & 0xffff;
          }
        }
        push(dataStack, low);
        push(dataStack, high);
        push(dataStack, trial);
        return { supported: true, note: `square-root steps: ${count}`, output };
      }
      case 0x9a9e: { // !IW ( value segment -- ): store a word at twice the current icon index
        const segment = pop(dataStack, 'data');
        const value = pop(dataStack, 'data');
        writeFarWord(segment, (readWord(0x5a02) << 1) & 0xffff, value);
        return { supported: true, note: 'store icon word', output };
      }
      case 0x9aba: { // !IB ( value segment -- ): store a byte at the current icon index
        const segment = pop(dataStack, 'data');
        const value = pop(dataStack, 'data');
        this.writePhysicalByte((segment << 4) + readWord(0x5a02), value);
        return { supported: true, note: 'store icon byte', output };
      }
      case 0x4d5c: { // headerless 2D-array lookup ( column row descriptor -- segment offset )
        const descriptor = pop(dataStack, 'data');
        const table = readWord(descriptor + 4);
        const segment = readWord(descriptor + 6);
        const row = pop(dataStack, 'data');
        const column = pop(dataStack, 'data');
        const offset = readFarWord(segment, table + row * 2);
        push(dataStack, segment);
        push(dataStack, offset + column);
        return { supported: true, note: '2D-array element address', output };
      }
      case 0x4af3: { // +BIT ( value -- count ): count set bits in a 16-bit cell
        let value = pop(dataStack, 'data');
        let count = 0;
        for (let bit = 0; bit < 16; bit++) {
          count += value & 1;
          value >>>= 1;
        }
        push(dataStack, count);
        return { supported: true, note: 'count set bits', output };
      }
      case 0x718d: { // RECADD ( record-index record-size offset block -- offset' block' )
        let block = pop(dataStack, 'data');
        let offset = pop(dataStack, 'data');
        const recordSize = pop(dataStack, 'data');
        let recordIndex = pop(dataStack, 'data');
        if (recordSize === 0) throw new RangeError('RECADD division by zero');
        const remainingRecords = Math.floor(((0x400 - offset) & 0xffff) / recordSize);
        if (toSignedCell(remainingRecords) > toSignedCell(recordIndex)) {
          offset += recordIndex * recordSize;
        } else {
          recordIndex = (recordIndex - remainingRecords) & 0xffff;
          const recordsPerBlock = Math.floor(0x400 / recordSize);
          if (recordsPerBlock === 0) throw new RangeError('RECADD division by zero');
          block += 1 + Math.floor(recordIndex / recordsPerBlock);
          offset = (recordIndex % recordsPerBlock) * recordSize;
        }
        push(dataStack, offset);
        push(dataStack, block);
        return { supported: true, note: 'record block and offset', output };
      }
      case 0x3048: { // (BUFFER)
        const block = pop(dataStack, 'data');
        let segment = readWord(0x2c84); // PREV
        let hit = readFarWord(segment, 6) === block
          && this.readFarByte(segment, 3) === 0;

        if (!hit) {
          segment = readWord(0x2cbe); // USE
          if (readFarWord(segment, 6) === block && this.readFarByte(segment, 3) === 0) {
            hit = true;
            writeWord(0x2cbe, readWord(0x2c84));
            writeWord(0x2c84, segment);
          }
        }

        if (hit) {
          push(dataStack, segment);
          writeWord(0x2c6c, readWord(0x2c84)); // LPREV = PREV
        } else {
          push(dataStack, block);
        }
        push(dataStack, hit ? 1 : 0);
        return { supported: true, note: hit ? 'buffer cache hit' : 'buffer cache miss', output };
      }
      case 0x2efe: { // LCMOVE ( src-seg src-off dst-seg dst-off count -- ): forward rep movsw, then one odd byte
        const count = pop(dataStack, 'data');
        let destinationOffset = pop(dataStack, 'data');
        const destinationSegment = pop(dataStack, 'data');
        let sourceOffset = pop(dataStack, 'data');
        const sourceSegment = pop(dataStack, 'data');
        for (let index = 0; index < count >>> 1; index++) {
          writeFarWord(destinationSegment, destinationOffset, readFarWord(sourceSegment, sourceOffset));
          sourceOffset = (sourceOffset + 2) & 0xffff;
          destinationOffset = (destinationOffset + 2) & 0xffff;
        }
        if (count & 1) {
          this.writePhysicalByte(((destinationSegment & 0xffff) << 4) + destinationOffset, this.readFarByte(sourceSegment, sourceOffset));
        }
        return { supported: true, note: `copy ${count} far bytes`, output };
      }
      case 0x30a8: { // ADVANCE>DEF ( offset -- ): move a cache hit one slot forward in the BLKCACHE and SEGCACHE tables
        const offset = pop(dataStack, 'data');
        if (offset === 0) return { supported: true, note: 'cache hit already first', output };
        for (const table of [readWord(0x2c04), readWord(0x2c9d)]) { // BLKCACHE, SEGCACHE segments
          const hit = readFarWord(table, offset);
          writeFarWord(table, offset, readFarWord(table, offset - 2));
          writeFarWord(table, offset - 2, hit);
        }
        return { supported: true, note: `advance cache entry 0x${offset.toString(16)} one slot`, output };
      }
      case 0x2ecd: { // LC@
        const offset = pop(dataStack, 'data');
        const segment = pop(dataStack, 'data');
        push(dataStack, this.readFarByte(segment, offset));
        return { supported: true, note: 'read far byte', output };
      }
      case 0x2f51: { // LWSCAN
        const value = pop(dataStack, 'data');
        const count = pop(dataStack, 'data');
        if (count === 0) {
          pop(dataStack, 'data');
          pop(dataStack, 'data');
          push(dataStack, 0);
          return { supported: true, note: 'empty far-word search', output };
        }

        let offset = pop(dataStack, 'data');
        const segment = pop(dataStack, 'data');
        for (let index = 0; index < count; index++) {
          if (readFarWord(segment, offset) === value) {
            push(dataStack, offset);
            push(dataStack, 1);
            return { supported: true, note: `far-word found at ${segment.toString(16)}:${offset.toString(16)}`, output };
          }
          offset = (offset + 2) & 0xffff;
        }
        push(dataStack, 0);
        return { supported: true, note: 'far-word not found', output };
      }
      case 0x4873: // ON
        writeWord(pop(dataStack, 'data'), 1);
        return { supported: true, note: 'native ON: set flag to one', output };
      case 0x4886: // OFF
        writeWord(pop(dataStack, 'data'), 0);
        return { supported: true, note: 'native OFF: clear flag', output };
      case 0x0d7c: { // SEG>ADDR
        const segment = pop(dataStack, 'data');
        push(dataStack, (segment - 0x0192) * 16);
        return { supported: true, note: 'convert segment to address relative to CS', output };
      }
      case 0x22ab: { // ENCLOSE ( addr delim -- addr n1 n2 n3 ): offsets of word start, end, and next scan
        const delimiter = pop(dataStack, 'data') & 0xff;
        const address = pop(dataStack, 'data');
        push(dataStack, address);
        const byte = (offset: number) => this.memory[(address + offset) & 0xffff];
        let offset = 0;
        while (byte(offset) === delimiter) offset = (offset + 1) & 0xffff;
        push(dataStack, offset);
        if (byte(offset) === 0) {
          // NUL at the start: n2 > n3 tells (WORD) the input is exhausted.
          push(dataStack, offset + 1);
          push(dataStack, offset);
          return { supported: true, note: 'enclose: end of input', output };
        }
        do offset = (offset + 1) & 0xffff;
        while (byte(offset) !== delimiter && byte(offset) !== 0);
        push(dataStack, offset);
        push(dataStack, byte(offset) === 0 ? offset : offset + 1);
        return { supported: true, note: 'enclose word', output };
      }
      case 0x1818: { // (FIND) ( name nfa -- pfa flags 1 | 0 ): search one vocabulary thread
        let nfa = pop(dataStack, 'data');
        const name = pop(dataStack, 'data');
        const byte = (address: number) => this.memory[address & 0xffff];
        for (let visited = 0; nfa !== 0; visited++) {
          if (visited > 0x8000) throw new RangeError(`(FIND) link chain does not terminate at NFA 0x${nfa.toString(16)}`);
          if ((byte(nfa) & 0x3f) === byte(name)) {
            // Compare until the bytes differ; a difference only in bit 7 is the dictionary name's last character.
            let index = 1;
            while (index < 0x100 && byte(nfa + index) === byte(name + index)) index++;
            if (((byte(nfa + index) ^ byte(name + index)) & 0x7f) === 0) {
              push(dataStack, nfa + index + 3);
              push(dataStack, byte(nfa));
              push(dataStack, 1);
              return { supported: true, note: `found at NFA 0x${nfa.toString(16)}`, output };
            }
          }
          nfa = readWord(nfa - 2);
        }
        push(dataStack, 0);
        return { supported: true, note: 'not found in thread', output };
      }
      case 0x1ac0: { // headerless vocabulary hash ( name -- thread-offset ): count + first char selects one of 4 threads
        const address = pop(dataStack, 'data');
        const sum = this.memory[address & 0xffff] + this.memory[(address + 1) & 0xffff];
        push(dataStack, (sum & 6) + 6);
        return { supported: true, note: 'vocabulary thread offset', output };
      }
      case 0x143a: { // >UPPERCASE ( addr count -- ): uppercase a-z in place
        const count = pop(dataStack, 'data');
        const address = pop(dataStack, 'data');
        for (let index = 0; index < count; index++) {
          const byte = this.memory[(address + index) & 0xffff];
          if (byte >= 0x61 && byte <= 0x7a) this.memory[(address + index) & 0xffff] = byte & 0xdf;
        }
        return { supported: true, note: `uppercase ${count} bytes`, output };
      }
      case 0x2973: { // SCROLLUP ( lines -- ): BIOS INT 10h/AH=06h over the window in user cells +1Eh/+1Fh
        const lines = pop(dataStack, 'data') & 0xff;
        const bottom = this.memory[(USER_AREA + 0x1e) & 0xffff];
        const right = this.memory[(USER_AREA + 0x1f) & 0xffff];
        const attribute = this.memory[(USER_AREA + 0x21) & 0xffff];
        this.scrollUp(lines, 0, 0, bottom, right, attribute);
        const action = lines === 0 ? 'clear' : `scroll up ${lines} line(s)`;
        return { supported: true, note: `BIOS INT 10h/AH=06h ${action} 0,0-${bottom},${right} attribute 0x${attribute.toString(16)}`, output };
      }
      case 0x2767: { // (POSITION) ( row col -- ): record in user cells +1Ah/+1Bh and set the BIOS cursor (INT 10h/AH=02h)
        const col = pop(dataStack, 'data') & 0xff;
        const row = pop(dataStack, 'data') & 0xff;
        this.memory[(USER_AREA + 0x1a) & 0xffff] = row;
        this.memory[(USER_AREA + 0x1b) & 0xffff] = col;
        this.cursorRow = row;
        this.cursorCol = col;
        return { supported: true, note: `BIOS INT 10h/AH=02h cursor ${row},${col}`, output };
      }
      case 0x25d7: { // (KEY) ( -- char ): INT 16h; ASCII, or 100h + scan code for extended keys
        const key = this.keyQueue.shift();
        if (key === undefined) return { supported: false, note: 'waiting for a key', output, waitForKey: true };
        const ascii = key & 0xff;
        push(dataStack, ascii !== 0 ? ascii : 0x100 | (key >>> 8));
        return { supported: true, note: `key 0x${key.toString(16).padStart(4, '0')}`, output };
      }
      case 0x4892: // CAPSON: BIOS keyboard flags at 0040:0017h = 40h (Caps Lock on, other shift states cleared)
        this.physicalMemory[0x417] = 0x40;
        return { supported: true, note: 'Caps Lock on (BIOS flags 0040:0017 = 40h)', output };
      case 0x25bc: // (?TERMINAL) ( -- flag ): INT 16h/AH=01h
        push(dataStack, this.keyQueue.length > 0 ? 1 : 0);
        return { supported: true, note: this.keyQueue.length > 0 ? 'key waiting' : 'no key waiting', output };
      case 0x2836: // ?POSITION ( -- row col )
        push(dataStack, this.memory[(USER_AREA + 0x1a) & 0xffff]);
        push(dataStack, this.memory[(USER_AREA + 0x1b) & 0xffff]);
        return { supported: true, note: 'cursor row and column', output };
      case 0x2852: { // CUR>ADDR ( -- offset ): video offset of the cursor inside the window at +1Ch/+1Dh
        const row = (this.memory[(USER_AREA + 0x1a) & 0xffff] + this.memory[(USER_AREA + 0x1c) & 0xffff]) & 0xff;
        const col = (this.memory[(USER_AREA + 0x1b) & 0xffff] + this.memory[(USER_AREA + 0x1d) & 0xffff]) & 0xff;
        push(dataStack, (row * 80 + col) * 2);
        return { supported: true, note: 'cursor video offset', output };
      }
      case 0x29fc: { // V! ( cell offset -- ): store a character/attribute cell in VIDEOMEM
        const offset = pop(dataStack, 'data');
        writeFarWord(readWord(USER_AREA + 0x18), offset, pop(dataStack, 'data'));
        return { supported: true, note: 'store video cell', output };
      }
      case 0x27f8: { // >VMOVE ( addr offset count -- ): copy characters to VIDEOMEM with the high byte of ATTRIBUTE
        const count = pop(dataStack, 'data');
        const offset = pop(dataStack, 'data');
        const address = pop(dataStack, 'data');
        const segment = readWord(USER_AREA + 0x18);
        const attribute = readWord(USER_AREA + 0x20) & 0xff00;
        for (let index = 0; index < count; index++) {
          writeFarWord(segment, offset + index * 2, attribute | this.memory[(address + index) & 0xffff]);
        }
        return { supported: true, note: `write ${count} characters to video memory`, output };
      }
      case 0x8d8b: { // >LORES: enter the low-resolution graphics mode for the selected monitor
        if (readWord(0x584a) === 4) {
          return { supported: false, note: 'Hercules graphics', output, stop: '>LORES for Hercules (MONITOR = 4) programs the CRTC directly; only EGA is emulated.' };
        }
        if (this.memory[EGA_FLAG] === 0) {
          return { supported: false, note: 'CGA graphics', output, stop: '>LORES for CGA programs the 6845 CRTC directly; only EGA is emulated.' };
        }
        // INT 10h AX=008Dh (mode 0Dh, keep memory), then GC register 1 (Enable Set/Reset) = 0Fh, written twice.
        this.setVideoMode(0x8d);
        for (let write = 0; write < 2; write++) {
          this.ega.out(0x3ce, 0x01);
          this.ega.out(0x3cf, 0x0f);
        }
        return { supported: true, note: 'EGA mode 0Dh 320x200x16 (memory kept), Enable Set/Reset = 0Fh', output };
      }
      case 0x8f8b: { // BFILL: fill BUF-CNT bytes at BUF-SEG:0 with COLOR
        const color = this.memory[0x55f2]; // COLOR
        const segment = readWord(0x5648); // BUF-SEG
        const count = readWord(0x5656); // BUF-CNT
        const base = segment << 4;
        if (this.memory[EGA_FLAG] !== 0) {
          // Map Mask 0Fh, Enable Set/Reset 0Fh, Set/Reset = color, Bit Mask FFh, then rep stosb.
          for (const [port, index, value] of [[0x3c4, 2, 0x0f], [0x3ce, 1, 0x0f], [0x3ce, 0, color], [0x3ce, 8, 0xff]]) {
            this.ega.out(port, index);
            this.ega.out(port + 1, value);
          }
          for (let offset = 0; offset < count; offset++) this.writePhysicalByte(base + offset, segment & 0xff);
        } else {
          for (let offset = 0; offset + 1 < count; offset += 2) writeFarWord(segment, offset, color | (color << 8));
        }
        return { supported: true, note: `fill ${count} bytes at ${segment.toString(16)}:0 with color ${color}`, output };
      }
      case 0x90ad: { // V>DISPLAY ( -- ): copy the packed main view to the display, 120 rows of 18 bytes
        const sourceSegment = readWord(0x55d8);
        const destinationSegment = readWord(0x55e6);
        for (let row = 0; row < 120; row++) {
          const destinationOffset = (readWord(0x6598 + row * 2) + 1) & 0xffff;
          this.latchCopy(sourceSegment, row * 18, destinationSegment, destinationOffset, 18);
        }
        return { supported: true, note: 'copy main view to display', output };
      }
      case 0x8e4f: { // headerless EGA page copy ( src-seg src-off dst-seg dst-off -- ): 2000h bytes in write mode 1
        const destinationOffset = pop(dataStack, 'data');
        const destinationSegment = pop(dataStack, 'data');
        const sourceOffset = pop(dataStack, 'data');
        const sourceSegment = pop(dataStack, 'data');
        this.latchCopy(sourceSegment, sourceOffset, destinationSegment, destinationOffset, 0x2000);
        return { supported: true, note: `EGA latch copy 2000h bytes ${sourceSegment.toString(16)}:${sourceOffset.toString(16)} -> ${destinationSegment.toString(16)}:${destinationOffset.toString(16)}`, output };
      }
      case 0xec7d: { // PORTMENU-OV |EGA ( flag -- ): copy a 2D0h-byte band between the display and hidden pages
        if (word.module !== 'PORTMENU-OV') break;
        const toDisplay = (pop(dataStack, 'data') & 1) !== 0;
        const offset = readWord(readWord(0x563a) + ((readWord(0xebfc) + 3) & 0xffff) * 2); // YTABL row of [EBFCh] + 3
        const display = readWord(0x55e6); // DBUF-SEG
        const hidden = readWord(0x55d8); // HBUF-SEG
        const [from, to] = toDisplay ? [hidden, display] : [display, hidden];
        this.latchCopy(from, offset, to, offset, 0x2d0);
        return { supported: true, note: `EGA latch copy 2D0h bytes ${from.toString(16)}:${offset.toString(16)} -> ${to.toString(16)}:${offset.toString(16)}`, output };
      }
      case 0x4a15: { // headerless CASE: lookup ( selector pfa -- pfa' ): table of count, default, then (value, pfa) pairs
        let address = pop(dataStack, 'data');
        const selector = pop(dataStack, 'data');
        let count = readWord(address);
        address = (address + 2) & 0xffff;
        let found = readWord(address); // the default
        address = (address + 2) & 0xffff;
        let matched = false;
        do {
          if (readWord(address) === selector) {
            found = readWord(address + 2);
            matched = true;
            count = 1; // the original sets CX to 1 so LOOP ends
          }
          address = (address + 4) & 0xffff;
          count = (count - 1) & 0xffff;
        } while (count !== 0);
        push(dataStack, found);
        return { supported: true, note: `case ${selector}: ${matched ? 'match' : 'default'} 0x${found.toString(16)}`, output };
      }
      case 0x9390: { // ?EXTENTX ( left bottom right top -- ): outcode the box corners (top, right), (bottom, left)
        let vertex = readWord(0x569b); // VIN
        for (let index = 0; index < 4; index++) {
          writeWord(vertex, pop(dataStack, 'data'));
          vertex = (vertex + 2) & 0xffff;
        }
        writeWord(0x5686, 2); // #IN
        this.outcodeVertices(readWord, writeWord);
        return { supported: true, note: `box outcodes: TRJCT ${readWord(0x56e8)} TACCPT ${readWord(0x56dc)}`, output };
      }
      case 0x903f: { // LLINE ( x1 y1 x2 y2 -- ): far call to the EGA driver's line routine at REMSEG:0815h
        const values = [0, 1, 2, 3].map(() => pop(dataStack, 'data'));
        this.drawLine(readWord, writeWord, values);
        return { supported: true, note: `line ${values[1]},${values[0]} to ${values[3]},${values[2]} color ${this.memory[0x55f2]}`, output };
      }
      case 0x906b: { // LCOPYBLK ( x1 y2 x2 y1 dx dy2 -- ): far call to the EGA driver's block copy at REMSEG:09DCh
        const [destinationY, destinationX, lowY, right, highY, left] = [0, 1, 2, 3, 4, 5].map(() => pop(dataStack, 'data'));
        let rows = (highY - lowY) & 0xffff; // 0988h: rows go towards the destination, so overlapping blocks copy safely
        let step = 0xffff, sourceY = highY, targetY = destinationY;
        if (toSignedCell((highY - destinationY) & 0xffff) >= 0) {
          step = 1;
          sourceY = (highY - rows) & 0xffff;
          targetY = (destinationY - rows) & 0xffff;
        }
        rows = (rows + 1) & 0xffff || 0x10000;
        const width = ((((right - left) & 0xffff) >>> 2) + 1) & 0xffff;
        const segment = readWord(0x5648); // BUF-SEG
        const yTable = readWord(0x563a); // YTABL
        for (let row = 0; row < rows; row++) { // 0939h addresses, 0903h copy
          const source = (readWord(yTable + sourceY * 2) + (left >>> 2)) & 0xffff;
          const target = (readWord(yTable + targetY * 2) + (destinationX >>> 2)) & 0xffff;
          sourceY = (sourceY + step) & 0xffff;
          targetY = (targetY + step) & 0xffff;
          if (toSignedCell(target) > toSignedCell(source)) { // STD: copy from the row's end, like the driver
            this.latchCopyBackward(segment, (source + width - 1) & 0xffff, (target + width - 1) & 0xffff, width);
          } else {
            this.latchCopy(segment, source, segment, target, width);
          }
        }
        return { supported: true, note: `EGA block copy x ${left}-${right} y ${lowY}-${highY} to ${destinationX},${destinationY}`, output };
      }
      case 0x902b: // {BLT}: far call to the EGA driver's bitmap blit at REMSEG:064Fh
        this.blitBitmap(readWord, writeWord, readFarWord);
        return { supported: true, note: `bitmap blit ${readWord(0x5892)}x${readWord(0x5887)} at ${readWord(0x586e)},${readWord(0x5863)} color ${this.memory[0x55f2]}${readWord(0x587c) ? ' (XOR)' : ''}`, output };
      case 0x4abb: { // FRND ( -- n ): SEED = SEED * 7ABDh + 1B0Fh (low 16 bits of the IMUL), pushed
        const seed = (Math.imul(readWord(0x4ab0), 0x7abd) + 0x1b0f) & 0xffff;
        writeWord(0x4ab0, seed);
        push(dataStack, seed);
        return { supported: true, note: `random 0x${seed.toString(16)}`, output };
      }
      case 0x93b1: { // BEXTENT ( -- left bottom right top ): the blit's box from XBLT, YBLT, WBLT, LBLT
        const left = readWord(0x586e); // XBLT
        const top = readWord(0x5863); // YBLT
        push(dataStack, left);
        push(dataStack, top - readWord(0x5887) + 1); // LBLT
        push(dataStack, left + readWord(0x5892) - 1); // WBLT
        push(dataStack, top);
        return { supported: true, note: 'blit extent', output };
      }
      case 0x9055: { // LFILLPOLY ( -- ): far call to the EGA driver's fill loop at REMSEG:050Fh
        const scan = readWord(0x57d9); // SCAN
        const top = readWord(0x57ec); // YMIN
        const bottom = readWord(0x57f7); // YMAX
        const middle = (scan + ((((top + bottom + 1) & 0xffff) >>> 1) << 1)) & 0xffff;
        if ((this.memory[(middle + 1) & 0xffff] - this.memory[middle]) & 0x8000) {
          return { supported: true, note: 'fill polygon: middle row is empty', output };
        }
        // Enable Set/Reset 0Fh, Bit Mask FFh, Set/Reset = COLOR, then one line per row with YMAX bumped meanwhile.
        for (const [index, value] of [[1, 0x0f], [8, 0xff], [0, this.memory[0x55f2]]]) {
          this.ega.out(0x3ce, index);
          this.ega.out(0x3cf, value);
        }
        writeWord(0x57f7, bottom + 1);
        let y = top;
        do {
          const entry = (scan + y * 2) & 0xffff;
          this.hlineEga(this.memory[entry], this.memory[(entry + 1) & 0xffff], y, readWord, writeWord);
          y = (y + 1) & 0xffff;
        } while (y !== readWord(0x57f7));
        writeWord(0x57f7, bottom);
        return { supported: true, note: `fill polygon rows ${toSignedCell(top)}..${toSignedCell(bottom)} color ${this.memory[0x55f2]}`, output };
      }
      case 0x8891: // SCANPOLY ( -- ): build the SCAN table for the polygon at VIN
        this.scanPolygon(readWord, writeWord);
        return { supported: true, note: `scan polygon of ${readWord(0x5686)} vertices: y ${toSignedCell(readWord(0x57ec))}..${toSignedCell(readWord(0x57f7))}`, output };
      case 0x9002: // LPLOT ( x y -- ): enable Set/Reset on all planes, then plot as below
      case 0x9367: { // PLOT ( x y -- ): set a 2-pixel-wide EGA pixel at (x, y) of the 160x200 grid to COLOR
        const y = pop(dataStack, 'data');
        const x = pop(dataStack, 'data');
        if (word.codep === 0x9002) {
          this.ega.out(0x3ce, 1);
          this.ega.out(0x3cf, 0x0f);
        }
        this.ega.out(0x3ce, 0); // Set/Reset = COLOR
        this.ega.out(0x3cf, this.memory[0x55f2]);
        this.plotEga(x, y);
        if (word.codep === 0x9002) this.ega.out(0x3ce, 0);
        return { supported: true, note: `plot ${x},${y} color ${this.memory[0x55f2]}`, output };
      }
      case 0xf379: { // BLT-OV .EGARUNBIT ( seg off -- ): draw a run-length bitmap at XBLT,YBLT, WBLT wide, in COLOR
        if (word.module !== 'BLT-OV') break;
        const offset = pop(dataStack, 'data');
        const segment = pop(dataStack, 'data');
        this.ega.out(0x3ce, 0); // Set/Reset = COLOR
        this.ega.out(0x3cf, this.memory[0x55f2]);
        const left = readWord(0x586e); // XBLT
        const rowEnd = (left + readWord(0x5892) - 1) & 0xffff; // XBLT + WBLT - 1
        let x1 = left;
        let y1 = readWord(0x5863); // YBLT
        const runs = readFarWord(segment, offset);
        writeWord(0xf35c, rowEnd);
        writeWord(0xf368, runs);
        const setX1 = (value: number) => { x1 = value & 0xffff; writeWord(0x561c, x1); }; // X1
        const setY1 = (value: number) => { y1 = value & 0xffff; writeWord(0x5613, y1); }; // Y1
        setX1(x1);
        setY1(y1);
        // Runs alternate between drawn (even index) and transparent (odd); a run past the right edge wraps up a row.
        let run = 0;
        do {
          const length = this.readFarByte(segment, offset + run + 2);
          if (length !== 0) {
            let x2 = (x1 + length - 1) & 0xffff;
            writeWord(0x562e, x2); // X2
            while (x2 > rowEnd) {
              if ((run & 1) === 0) this.hlineEga(x1, rowEnd, y1, readWord, writeWord);
              x2 = (x2 - readWord(0x5892)) & 0xffff;
              writeWord(0x562e, x2);
              setX1(left);
              setY1(y1 - 1);
            }
            if ((run & 1) === 0) this.hlineEga(x1, x2, y1, readWord, writeWord);
            setX1(x2 + 1);
          }
          run = (run + 1) & 0xffff;
        } while (run !== runs);
        return { supported: true, note: `run-length blit of ${runs} runs at ${left},${readWord(0x5863)} color ${this.memory[0x55f2]}`, output };
      }
      case 0x6c86: { // C>EGA ( cga -- ega ): find the color in the table at 4FBBh-4FCAh, map through the table at 4FCDh
        const color = pop(dataStack, 'data') & 0x0f;
        let position = 0; // 1-based; the scan runs from 4FCAh down and stops at the first match
        for (let count = 16; count >= 1; count--) {
          if ((this.memory[0x4fba + count] & 0x0f) === color) {
            position = count;
            break;
          }
        }
        const ega = this.memory[0x4fcc + position]; // position 0 (no match) reads the byte before the table
        push(dataStack, ega);
        return { supported: true, note: `CGA color ${color} -> EGA ${ega}`, output };
      }
      case 0x0c60: { // C!_2 and <C!> ( char addr -- )
        const address = pop(dataStack, 'data');
        this.memory[address & 0xffff] = pop(dataStack, 'data') & 0xff;
        return { supported: true, note: 'write byte', output };
      }
      case 0x49ae: { // 1.5!_2 and <1.5!> ( lo hi addr -- ): a cell at addr and a byte at addr+2
        const address = pop(dataStack, 'data');
        this.memory[(address + 2) & 0xffff] = pop(dataStack, 'data') & 0xff;
        writeWord(address, pop(dataStack, 'data'));
        return { supported: true, note: 'write 1.5 cells', output };
      }
      case 0x4997: { // 1.5@ ( addr -- lo hi ): the cell at addr and the byte at addr+2
        const address = pop(dataStack, 'data');
        push(dataStack, readWord(address));
        push(dataStack, this.memory[(address + 2) & 0xffff]);
        return { supported: true, note: 'read 1.5 cells', output };
      }
      // The context stack: 3-byte entries (a cell, then a byte) growing down from CXSP (54B0h).
      case 0x753f: { // >C ( lo hi -- ): store at CXSP, then move CXSP down 3
        const pointer = readWord(0x54b0);
        this.memory[(pointer + 2) & 0xffff] = pop(dataStack, 'data') & 0xff;
        writeWord(pointer, pop(dataStack, 'data'));
        writeWord(0x54b0, pointer - 3);
        return { supported: true, note: `push to context stack at 0x${pointer.toString(16)}`, output };
      }
      case 0x755a: { // C> ( -- lo hi ): move CXSP up 3, then fetch from it
        const pointer = (readWord(0x54b0) + 3) & 0xffff;
        writeWord(0x54b0, pointer);
        push(dataStack, readWord(pointer));
        push(dataStack, this.memory[(pointer + 2) & 0xffff]);
        return { supported: true, note: `pop from context stack at 0x${pointer.toString(16)}`, output };
      }
      case 0x7577: { // CI ( -- lo hi ): the top context-stack entry, left in place
        const pointer = (readWord(0x54b0) + 3) & 0xffff;
        push(dataStack, readWord(pointer));
        push(dataStack, this.memory[(pointer + 2) & 0xffff]);
        return { supported: true, note: `context stack top at 0x${pointer.toString(16)}`, output };
      }
      case 0x7425: { // IFLDADR ( pfa -- addr ): the field at offset [pfa+1] of the current instance record at 63EFh
        const field = pop(dataStack, 'data');
        const address = (this.memory[(field + 1) & 0xffff] + 0x63ef) & 0xffff;
        push(dataStack, address);
        return { supported: true, note: `instance field at 0x${address.toString(16)}`, output };
      }
      case 0x763a: // @[IOFF] ( -- n ): the cell in [IOFF]
        push(dataStack, readWord(0x558c));
        return { supported: true, note: 'read [IOFF]', output };
      case 0x7684: { // PRIORIT ( offset -- offset' ): move an instance-cache hit one slot toward the front
        const offset = pop(dataStack, 'data');
        if (offset === 0) {
          push(dataStack, 0);
          return { supported: true, note: 'instance cache hit already first', output };
        }
        const previous = (offset - 2) & 0xffff;
        for (const table of [readWord(0x54ea), readWord(0x54f2)]) { // LOISEG, LOCSEC: word entries
          const hit = readFarWord(table, offset);
          writeFarWord(table, offset, readFarWord(table, previous));
          writeFarWord(table, previous, hit);
        }
        const bytes = readWord(0x54ee); // HIISEG: byte entries at half the offset
        const base = bytes << 4;
        const hitByte = this.readPhysicalByte(base + (offset >>> 1));
        this.writePhysicalByte(base + (offset >>> 1), this.readPhysicalByte(base + (previous >>> 1)));
        this.writePhysicalByte(base + (previous >>> 1), hitByte);
        push(dataStack, previous);
        return { supported: true, note: `advance instance cache entry 0x${offset.toString(16)}`, output };
      }
      case 0x75d7: { // CDEPTH ( -- n ): (6398h - CXSP) / 3 by an 8-bit DIV: quotient in AL, remainder in AH
        const used = (0x6398 - readWord(0x54b0)) & 0xffff;
        push(dataStack, ((used % 3) << 8) | (Math.floor(used / 3) & 0xff));
        return { supported: true, note: `context stack depth ${Math.floor(used / 3)}`, output };
      }
      case 0x7ae7: { // >V ( n -- ): store at VSP, then move VSP down a cell
        const pointer = readWord(0x54b4); // VSP
        writeWord(pointer, pop(dataStack, 'data'));
        writeWord(0x54b4, pointer - 2);
        return { supported: true, note: `push to V stack at 0x${pointer.toString(16)}`, output };
      }
      case 0x7afe: { // V> ( -- n ): move VSP up a cell, then fetch from it
        const pointer = (readWord(0x54b4) + 2) & 0xffff;
        writeWord(0x54b4, pointer);
        push(dataStack, readWord(pointer));
        return { supported: true, note: `pop from V stack at 0x${pointer.toString(16)}`, output };
      }
      case 0x2a9a: { // TIME ( -- addr ): bring the millisecond counter up to date and return its address
        // The original reads PIT channel 0 and a budget refilled by the timer interrupt; here time follows the steps.
        const milliseconds = Math.floor(this.milliseconds);
        writeWord(TIME_COUNTER, Math.floor(milliseconds / 0x10000));
        writeWord(TIME_COUNTER + 2, milliseconds);
        push(dataStack, TIME_COUNTER);
        return { supported: true, note: `time ${milliseconds} ms`, output };
      }
      case 0x2618: { // TONE ( divisor -- ): PIT channel 2, mode 3 square wave (control B6h to port 43h, divisor to 42h)
        this.speakerDivisor = pop(dataStack, 'data');
        this.speakerChanged();
        const hertz = this.speakerDivisor === 0 ? 1193182 / 0x10000 : 1193182 / this.speakerDivisor;
        return { supported: true, note: `speaker tone ${hertz.toFixed(1)} Hz (divisor ${this.speakerDivisor})`, output };
      }
      case 0x2638: // BEEPON: set the timer gate and speaker bits of port 61h
        this.speakerPort |= 0x03;
        this.speakerChanged();
        return { supported: true, note: 'PC speaker on (port 61h bits 0-1 set)', output };
      case 0x2653: // BEEPOFF: clear the timer gate and speaker bits of port 61h
        this.speakerPort &= ~0x03;
        this.speakerChanged();
        return { supported: true, note: 'PC speaker off (port 61h bits 0-1 cleared)', output };
      case 0x7b15: { // VI ( -- n ): the top of the V stack (VSP + 2), left in place
        const pointer = (readWord(0x54b4) + 2) & 0xffff;
        push(dataStack, readWord(pointer));
        return { supported: true, note: `V stack top at 0x${pointer.toString(16)}`, output };
      }
      case 0x8d09: { // DISPLAY-WAIT: poll the CRT status port for the end of a retrace; no beam timing is emulated
        const port = readWord(0x584a) === 4 ? 0x3ba : 0x3da; // MONITOR = 4 is Hercules
        const bit = this.memory[EGA_FLAG] !== 0 ? 'vertical retrace' : 'display enable';
        return { supported: true, note: `wait for ${bit} on port 0x${port.toString(16)} (completes at once)`, output };
      }
      case 0x8df0: { // >ALPHACODE: back to text mode (Hercules CRTC setup when MONITOR = 4, else INT 10h mode 2)
        if (readWord(0x584a) === 4) {
          return { supported: true, note: 'Hercules text mode (CRTC programming not emulated)', output };
        }
        this.setVideoMode(2);
        return { supported: true, note: 'BIOS INT 10h/AX=0002h: 80x25 text mode', output };
      }
      case 0x0be1: { // ! and <!>
        const address = pop(dataStack, 'data');
        writeWord(address, pop(dataStack, 'data'));
        return { supported: true, note: 'write word', output };
      }
      case 0x0f85: { // +! and <+!>
        const address = pop(dataStack, 'data');
        writeWord(address, readWord(address) + pop(dataStack, 'data'));
        return { supported: true, note: 'add to word in memory', output };
      }
      case 0x0c24: { // 2!_2 and <D!> (the same code, with interrupts masked)
        const address = pop(dataStack, 'data');
        const first = pop(dataStack, 'data');
        const second = pop(dataStack, 'data');
        writeWord(address, first);
        writeWord(address + 2, second);
        return { supported: true, note: 'write double cell', output };
      }
      case 0x6f49: { // VA>BLK ( dva -- offset block ): split a virtual address into 1,024-byte blocks
        const high = pop(dataStack, 'data');
        const low = pop(dataStack, 'data');
        const address = high * 0x10000 + low;
        push(dataStack, address % BLOCK_SIZE);
        push(dataStack, Math.floor(address / BLOCK_SIZE));
        return { supported: true, note: 'virtual address to block offset and block', output };
      }
      case 0x7295: { // BVSA>OFFBLK ( vsa -- offset block ): paragraphs above 3E80h, 64 per 1,024-byte block
        const paragraphs = (pop(dataStack, 'data') - 0x3e80) & 0xffff;
        push(dataStack, (paragraphs & 0x3f) << 4);
        push(dataStack, paragraphs >>> 6);
        return { supported: true, note: 'VSA to block offset and block', output };
      }
      case 0x71dd: { // DOFFBLK ( index -- entry-offset block ): 48 directory entries of 21 bytes per block
        let index = toSignedCell(pop(dataStack, 'data'));
        let block = readWord(0x535e); // DIRBLK
        for (const threshold of [0x90, 0x60, 0x30]) {
          if (index >= threshold) {
            block += threshold / 0x30;
            index -= threshold;
            break;
          }
        }
        push(dataStack, index * 21);
        push(dataStack, block);
        return { supported: true, note: 'directory entry offset and block', output };
      }
      case 0x3672: // OFFSET
        push(dataStack, pop(dataStack, 'data') + readWord(0x2c79));
        return { supported: true, note: 'add DOS disk offset', output };
      case 0x0d10: { // CMOVE_2
        const count = pop(dataStack, 'data');
        const destination = pop(dataStack, 'data');
        const source = pop(dataStack, 'data');
        const copy = new Uint8Array(count);
        for (let index = 0; index < count; index++) copy[index] = this.memory[(source + index) & 0xffff];
        for (let index = 0; index < count; index++) this.memory[(destination + index) & 0xffff] = copy[index];
        return { supported: true, note: `native CMOVE_2: copy ${count} bytes`, output };
      }
      case 0x0d35: { // FILL_2
        const value = pop(dataStack, 'data') & 0xff;
        const count = pop(dataStack, 'data');
        const destination = pop(dataStack, 'data');
        for (let index = 0; index < count; index++) this.memory[(destination + index) & 0xffff] = value;
        return { supported: true, note: `native FILL_2: fill ${count} bytes`, output };
      }
      case 0x4da4: { // !OFFSET
        const descriptor = pop(dataStack, 'data');
        const multiplier = readWord(descriptor);
        let count = readWord(descriptor + 2);
        const baseOffset = readWord(descriptor + 4);
        const segment = readWord(descriptor + 6);
        let destination = (baseOffset + count * 2) & 0xffff;
        do {
          writeFarWord(segment, destination, multiplier * count);
          destination = (destination - 2) & 0xffff;
          count = (count - 1) & 0xffff;
        } while (count !== 0);
        writeFarWord(segment, destination, 0);
        return { supported: true, note: 'build 2D-array offset table', output };
      }
    }

    switch (name) {
      case 'R/W': {
        const reading = pop(dataStack, 'data') !== 0;
        const block = pop(dataStack, 'data');
        const offset = pop(dataStack, 'data');
        const segment = pop(dataStack, 'data');
        const file = block >= 1500 ? 'STARA.COM' : 'STARB.COM';
        const image = block >= 1500 ? this.disks.stara : this.disks.starb;
        const imageOffset = (block - (block >= 1500 ? 1500 : 720)) * BLOCK_SIZE;
        if (imageOffset < 0 || imageOffset + BLOCK_SIZE > image.length) {
          throw new RangeError(`R/W block ${block} is outside ${file}.`);
        }
        const address = (segment << 4) + offset;
        for (let index = 0; index < BLOCK_SIZE; index++) {
          const physicalAddress = (address + index) & 0xfffff;
          if (reading) {
            this.physicalMemory[physicalAddress] = image[imageOffset + index];
          } else {
            image[imageOffset + index] = this.physicalMemory[physicalAddress];
          }
        }
        return { supported: true, note: `${reading ? 'read' : 'write'} ${file} block ${imageOffset / BLOCK_SIZE} at ${segment.toString(16)}:${offset.toString(16)}`, output };
      }
      case '0':
        push(dataStack, 0);
        return { supported: true, note: 'push zero', output };
      case '1':
        push(dataStack, 1);
        return { supported: true, note: 'push one', output };
      case '2':
        push(dataStack, 2);
        return { supported: true, note: 'push two', output };
      case '@':
        push(dataStack, readWord(pop(dataStack, 'data')));
        return { supported: true, note: 'read word', output };
      case 'C@':
        push(dataStack, this.memory[pop(dataStack, 'data') & 0xffff]);
        return { supported: true, note: 'read byte', output };
      case '+-@': // ( addr -- n ): fetch a byte and sign-extend it (CBW)
        push(dataStack, (this.memory[pop(dataStack, 'data') & 0xffff] << 24) >> 24);
        return { supported: true, note: 'read signed byte', output };
      case '?UPDATE': {
        const address = pop(dataStack, 'data');
        const signedAddress = toSignedCell(address);
        if (signedAddress >= 0) {
          if (signedAddress >= 0x63ef && signedAddress < 0x64fd) this.memory[0x63ee] = 0xff;
        } else {
          for (const bufferAddress of [0x54a1, 0x54a5]) {
            const buffer = readWord(bufferAddress);
            const start = (buffer + 7) & 0xffff;
            const end = (start + 0x401) & 0xffff;
            if (signedAddress > toSignedCell(start) && signedAddress < toSignedCell(end)) {
              this.memory[(buffer + 2) & 0xffff] = 0xff;
              break;
            }
          }
        }
        push(dataStack, address);
        return { supported: true, note: 'mark cache buffer dirty if address is cached', output };
      }
      case '2@': {
        const address = pop(dataStack, 'data');
        push(dataStack, readWord(address + 2));
        push(dataStack, readWord(address));
        return { supported: true, note: 'read double cell', output };
      }
      case 'L@': {
        const offset = pop(dataStack, 'data');
        const segment = pop(dataStack, 'data');
        push(dataStack, readFarWord(segment, offset));
        return { supported: true, note: 'read far word', output };
      }
      case 'L!': {
        const offset = pop(dataStack, 'data');
        const segment = pop(dataStack, 'data');
        const value = pop(dataStack, 'data');
        writeFarWord(segment, offset, value);
        return { supported: true, note: 'write far word', output };
      }
      case 'LC!': {
        const offset = pop(dataStack, 'data');
        const segment = pop(dataStack, 'data');
        const value = pop(dataStack, 'data');
        this.writePhysicalByte(((segment & 0xffff) << 4) + (offset & 0xffff), value);
        return { supported: true, note: 'write far byte', output };
      }
      case 'U/MOD': {
        const divisor = pop(dataStack, 'data');
        const high = pop(dataStack, 'data');
        const low = pop(dataStack, 'data');
        if (divisor === 0 || high >= divisor) {
          push(dataStack, this.divideFault(divisor === 0 ? 'Forth U/MOD division by zero' : 'Forth U/MOD quotient overflow (INT 0)'));
          push(dataStack, 0);
          return { supported: true, note: 'unsigned divide fault recovered by SET0/: zero remainder and quotient', output };
        }
        const dividend = low + high * 0x10000;
        push(dataStack, dividend % divisor);
        push(dataStack, Math.floor(dividend / divisor));
        return { supported: true, note: 'unsigned double-cell divide', output };
      }
      case '(!OLD)': {
        const vector = pop(dataStack, 'data');
        const address = (vector & 0xff) * 4;
        const offset = readFarWord(0, address);
        const segment = readFarWord(0, address + 2);
        push(dataStack, segment);
        push(dataStack, offset);
        return { supported: true, note: `read IVT vector 0x${(vector & 0xff).toString(16).padStart(2, '0')}`, output };
      }
      case '(!SET)': {
        const vector = pop(dataStack, 'data') & 0xff;
        const offset = pop(dataStack, 'data');
        const segment = pop(dataStack, 'data');
        const address = vector * 4;
        writeFarWord(0, address, offset);
        writeFarWord(0, address + 2, segment);
        return { supported: true, note: `write IVT vector 0x${vector.toString(16).padStart(2, '0')}`, output };
      }
      case 'OR':
        binary((left, right) => left | right);
        return { supported: true, note: 'bitwise OR', output };
      case 'NOT':
        unary(value => value === 0 ? 1 : 0);
        return { supported: true, note: 'logical not', output };
      case 'XOR':
        binary((left, right) => left ^ right);
        return { supported: true, note: 'bitwise XOR', output };
      case 'AND':
        binary((left, right) => left & right);
        return { supported: true, note: 'bitwise AND', output };
      case '+':
        binary((left, right) => left + right);
        return { supported: true, note: 'add', output };
      case '*':
        binary((left, right) => left * right);
        return { supported: true, note: 'multiply', output };
      case '-':
        binary((left, right) => left - right);
        return { supported: true, note: 'subtract', output };
      case '/':
        binary((left, right) => {
          const dividend = toSignedCell(left);
          const divisor = toSignedCell(right);
          if (divisor === 0) throw new RangeError('Forth division by zero');
          return Math.trunc(dividend / divisor);
        });
        return { supported: true, note: 'signed divide', output };
      case '/MOD': { // POP BX; POP AX; CWD; IDIV BX; PUSH DX; PUSH AX: truncating, remainder takes the dividend's sign
        const divisor = toSignedCell(pop(dataStack, 'data'));
        const dividend = toSignedCell(pop(dataStack, 'data'));
        const quotient = divisor === 0 ? NaN : Math.trunc(dividend / divisor);
        if (!(quotient >= -0x8000 && quotient <= 0x7fff)) {
          push(dataStack, this.divideFault('Forth /MOD divide overflow (INT 0)'));
          push(dataStack, 0);
          return { supported: true, note: 'signed divide fault recovered: zero remainder and quotient', output };
        }
        push(dataStack, dividend % divisor);
        push(dataStack, quotient);
        return { supported: true, note: 'signed divide with remainder', output };
      }
      case '0=':
        unary(value => value === 0 ? 1 : 0);
        return { supported: true, note: 'zero test', output };
      case '0<':
        unary(value => toSignedCell(value) < 0 ? 1 : 0);
        return { supported: true, note: 'signed negative test', output };
      case '0>': // NEG AX; CWD; NEG DX: 1 when -n is negative, so also for 8000h, which negates to itself
        unary(value => toSignedCell(-value & 0xffff) < 0 ? 1 : 0);
        return { supported: true, note: 'signed positive test', output };
      case '=':
        binary((left, right) => left === right ? 1 : 0);
        return { supported: true, note: 'equality test', output };
      case 'U<':
        binary((left, right) => left < right ? 0xffff : 0);
        return { supported: true, note: 'unsigned less-than', output };
      case 'UMIN':
        binary((left, right) => Math.min(left, right));
        return { supported: true, note: 'unsigned minimum', output };
      case '<':
        binary((left, right) => toSignedCell(left) < toSignedCell(right) ? 1 : 0);
        return { supported: true, note: 'signed less-than', output };
      case '>':
        binary((left, right) => toSignedCell(left) > toSignedCell(right) ? 1 : 0);
        return { supported: true, note: 'signed greater-than', output };
      case '(CS?)':
      case '@DS':
        push(dataStack, 0x0192);
        return { supported: true, note: name === '(CS?)' ? 'push current code segment' : 'push current data segment', output };
      case 'ME':
        push(dataStack, USER_AREA);
        return { supported: true, note: 'push OPERATOR user-area base', output };
      case 'ADDR>SEG':
        push(dataStack, (pop(dataStack, 'data') >>> 4) + 0x0192);
        return { supported: true, note: 'convert real-mode address to segment', output };
      case 'SET0/': // The CPU-detection probe selects the 8086 recovery handler at 01C7h.
        writeFarWord(0, 0, 0x01c7);
        writeFarWord(0, 2, 0x0192);
        return { supported: true, note: 'install divide-error recovery IVT handler', output };
      case 'INTERRUPT': {
        const interrupt = pop(dataStack, 'data') & 0xff;
        const ax = readWord(0x16b6);
        if (interrupt === 0x10 && (ax >>> 8) === 0x00) {
          this.setVideoMode(ax & 0xff);
          return { supported: true, note: `BIOS INT 10h/AH=00h set video mode 0x${(ax & 0xff).toString(16)}`, output };
        }
        if (interrupt === 0x10 && (ax >>> 8) === 0x0f) {
          writeWord(0x16b6, this.videoMode);
          return { supported: true, note: `BIOS INT 10h/AH=0Fh current video mode = ${this.videoMode}`, output };
        }
        if (interrupt === 0x11) {
          writeWord(0x16b6, 0xd426);
          return { supported: true, note: 'BIOS INT 11h equipment list = 0xd426', output };
        }
        if (interrupt === 0x21 && (ax >>> 8) === 0x19) {
          writeWord(0x16b6, 0x0002);
          return { supported: true, note: 'DOS INT 21h/AH=19h default drive = 2', output };
        }
        if (interrupt === 0x21 && (ax >>> 8) === 0x1a) {
          this.dtaOffset = readWord(0x16bc);
          this.dtaSegment = readWord(0x16c4);
          return { supported: true, note: `DOS INT 21h/AH=1Ah set DTA ${this.dtaSegment.toString(16)}:${this.dtaOffset.toString(16)}`, output };
        }
        if (interrupt === 0x21 && (ax >>> 8) === 0x11) {
          writeWord(0x16b6, 0);
          return { supported: true, note: 'DOS INT 21h/AH=11h FCB find-first: file found', output };
        }
        if (interrupt === 0x21 && (ax >>> 8) === 0x0d) {
          return { supported: true, note: 'DOS INT 21h/AH=0Dh drive reset (no-op in reference emulator)', output };
        }
        if (interrupt === 0x21 && (ax >>> 8) === 0x0f) {
          const fcb = readWord(0x16c0);
          this.memory[fcb & 0xffff] = 0x03;
          writeWord(0x16b6, 0);
          return { supported: true, note: 'DOS INT 21h/AH=0Fh FCB open', output };
        }
        if (interrupt === 0x21 && ((ax >>> 8) === 0x21 || (ax >>> 8) === 0x22)) {
          // FCB random read/write at DS:DX: one record of RECSIZE (+14) at the random record (+33), via the DTA.
          const writing = (ax >>> 8) === 0x22;
          const call = `DOS INT 21h/AH=${writing ? '22h random write' : '21h random read'}`;
          const fcb = ((readWord(0x16c4) << 4) + readWord(0x16bc)) & 0xfffff;
          const byte = (offset: number) => this.physicalMemory[(fcb + offset) & 0xfffff];
          const setByte = (offset: number, value: number) => { this.physicalMemory[(fcb + offset) & 0xfffff] = value & 0xff; };
          const name = Array.from({ length: 8 }, (_, index) => String.fromCharCode(byte(1 + index))).join('').trim();
          const disk = name === 'STARA' ? 'stara' : name === 'STARB' ? 'starb' : undefined;
          if (!disk) {
            return { supported: false, note: `${call} of ${JSON.stringify(name)}`, output, stop: `${call} of unknown file ${JSON.stringify(name)}.` };
          }
          const recordSize = (byte(14) | (byte(15) << 8)) || 128;
          const record = (byte(33) | (byte(34) << 8) | (byte(35) << 16) | (recordSize < 64 ? byte(36) << 24 : 0)) >>> 0;
          const start = record * recordSize;
          const dta = ((this.dtaSegment << 4) + this.dtaOffset) & 0xfffff;
          let status: number;
          if (writing) {
            // Writes go to the private image; writing past its end extends it, as DOS extends the file.
            const end = start + recordSize;
            if (end > this.disks[disk].length) {
              const grown = new Uint8Array(end);
              grown.set(this.disks[disk]);
              this.disks[disk] = grown;
            }
            for (let index = 0; index < recordSize; index++) this.disks[disk][start + index] = this.readPhysicalByte(dta + index);
            const size = (byte(16) | (byte(17) << 8) | (byte(18) << 16) | (byte(19) << 24)) >>> 0;
            if (end > size) for (let index = 0; index < 4; index++) setByte(16 + index, end >>> (index * 8));
            status = 0;
          } else {
            const image = this.disks[disk];
            const available = Math.max(0, Math.min(recordSize, image.length - start));
            for (let index = 0; index < recordSize; index++) {
              this.writePhysicalByte(dta + index, index < available ? image[start + index] : 0);
            }
            status = available === recordSize ? 0 : available === 0 ? 1 : 3;
          }
          // DOS also moves the sequential position (block +12, record +32) to the random record.
          setByte(12, record >>> 7);
          setByte(13, record >>> 15);
          setByte(32, record & 0x7f);
          writeWord(0x16b6, (ax & 0xff00) | status);
          const direction = writing ? 'from' : 'into';
          return { supported: true, note: `${call} ${name} record ${record} (${recordSize} bytes) ${direction} ${this.dtaSegment.toString(16)}:${this.dtaOffset.toString(16)}: AL=${status}`, output };
        }
        if (interrupt === 0x21 && (ax >>> 8) === 0x10) {
          // R/W writes go straight to the private disk images, so there is nothing to flush.
          writeWord(0x16b6, ax & 0xff00);
          return { supported: true, note: 'DOS INT 21h/AH=10h FCB close: AL=0', output };
        }
        if (interrupt === 0x21 && (ax >>> 8) === 0x29) {
          const source = (((readWord(0x16c4) & 0xffff) << 4) + readWord(0x16c2)) & 0xfffff;
          const destination = (((readWord(0x16c6) & 0xffff) << 4) + readWord(0x16c0)) & 0xfffff;
          this.physicalMemory[destination] = 0;
          for (let index = 0; index < 5; index++) {
            this.physicalMemory[(destination + 1 + index) & 0xfffff] = this.physicalMemory[(source + index) & 0xfffff];
          }
          const fileSize = this.physicalMemory[(source + 4) & 0xfffff] === 0x42 ? 362496 : 256000;
          for (let index = 0; index < 4; index++) {
            this.physicalMemory[(destination + 0x10 + index) & 0xfffff] = (fileSize >>> (index * 8)) & 0xff;
          }
          writeWord(0x16b6, 0);
          writeWord(0x16b8, 0);
          return { supported: true, note: 'DOS INT 21h/AH=29h parsed FCB filename and size', output };
        }
        if (interrupt === 0x21 && (ax >>> 8) === 0x4a) {
          writeWord(0x16b6, 0x01fe);
          return { supported: true, note: 'DOS INT 21h/AH=4Ah memory resize', output };
        }
        return { supported: false, note: `unsupported interrupt 0x${interrupt.toString(16).padStart(2, '0')} AX=0x${ax.toString(16).padStart(4, '0')}`, output };
      }
      case '2+':
        unary(value => value + 2);
        return { supported: true, note: 'add two', output };
      case '2-':
        unary(value => value - 2);
        return { supported: true, note: 'subtract two', output };
      case '2*':
        unary(value => value * 2);
        return { supported: true, note: 'multiply by two', output };
      case '2/':
        unary(value => toSignedCell(value) >> 1);
        return { supported: true, note: 'signed divide by two', output };
      case '16*':
        unary(value => value << 4);
        return { supported: true, note: 'multiply by 16', output };
      case '16/':
        unary(value => value >>> 4);
        return { supported: true, note: 'divide unsigned value by 16', output };
      case '1+':
        unary(value => value + 1);
        return { supported: true, note: 'increment', output };
      case '1-':
        unary(value => value - 1);
        return { supported: true, note: 'decrement', output };
      case 'NEGATE':
        unary(value => -value);
        return { supported: true, note: 'negate signed cell', output };
      case 'DUP': {
        const value = pop(dataStack, 'data');
        push(dataStack, value);
        push(dataStack, value);
        return { supported: true, note: 'duplicate', output };
      }
      case '2DUP': {
        const top = dataStack.peek(0);
        const second = dataStack.peek(1);
        if (top === undefined || second === undefined) throw new RangeError('data stack underflow');
        push(dataStack, second);
        push(dataStack, top);
        return { supported: true, note: 'duplicate top two cells', output };
      }
      case 'OVER': {
        const value = dataStack.peek(1);
        if (value === undefined) throw new RangeError('data stack underflow');
        push(dataStack, value);
        return { supported: true, note: 'copy second data-stack cell', output };
      }
      case '?DUP': {
        const value = dataStack.peek(0);
        if (value !== undefined && value !== 0) push(dataStack, value);
        return { supported: true, note: 'duplicate if nonzero', output };
      }
      case 'DROP':
        pop(dataStack, 'data');
        return { supported: true, note: 'drop', output };
      case '2DROP':
        pop(dataStack, 'data');
        pop(dataStack, 'data');
        return { supported: true, note: 'drop two cells', output };
      case '>R':
        push(returnStack, pop(dataStack, 'data'));
        return { supported: true, note: 'move to return stack', output };
      case 'R>':
        push(dataStack, pop(returnStack, 'return'));
        return { supported: true, note: 'move from return stack', output };
      case 'R@': {
        const value = returnStack[returnStack.length - 1];
        if (value === undefined) throw new RangeError('return stack underflow');
        push(dataStack, value);
        return { supported: true, note: 'copy return-stack top', output };
      }
      case 'SP!':
        dataStack.reset();
        return { supported: true, note: `reset data stack to SP0 0x${dataStack.pointer.toString(16)}`, output };
      case 'SP@': {
        // The 8086 code pushes SP as it was before the push: the address of the current top cell.
        const pointer = dataStack.pointer;
        push(dataStack, pointer);
        return { supported: true, note: 'data stack pointer', output };
      }
      case 'RP!':
        returnStack.length = 0;
        return { supported: true, note: 'reset return stack to initialized base', output };
      case 'U*': { // ( u1 u2 -- ud ): unsigned 16x16 -> 32 MUL, low cell then high
        const product = pop(dataStack, 'data') * pop(dataStack, 'data');
        push(dataStack, product % 0x10000);
        push(dataStack, Math.floor(product / 0x10000));
        return { supported: true, note: 'unsigned multiply to double', output };
      }
      case 'S->D': { // MOV AX,[SP]; CWD; PUSH DX: keep n, push its sign as the high cell
        const value = pop(dataStack, 'data');
        push(dataStack, value);
        push(dataStack, value & 0x8000 ? 0xffff : 0);
        return { supported: true, note: 'sign-extend to double', output };
      }
      case 'D+': {
        const high2 = pop(dataStack, 'data');
        const low2 = pop(dataStack, 'data');
        const high1 = pop(dataStack, 'data');
        const low1 = pop(dataStack, 'data');
        const low = low1 + low2;
        push(dataStack, low);
        push(dataStack, high1 + high2 + (low >>> 16));
        return { supported: true, note: 'add doubles', output };
      }
      case 'DNEGATE': {
        const high = pop(dataStack, 'data');
        const low = pop(dataStack, 'data');
        push(dataStack, -low);
        push(dataStack, -high - (low !== 0 ? 1 : 0));
        return { supported: true, note: 'negate double', output };
      }
      case 'D16*': {
        const high = pop(dataStack, 'data');
        const low = pop(dataStack, 'data');
        const shifted = ((high << 16) | low) << 4;
        push(dataStack, shifted & 0xffff);
        push(dataStack, (shifted >>> 16) & 0xffff);
        return { supported: true, note: 'multiply double by 16', output };
      }
      case '2SWAP': {
        const d = pop(dataStack, 'data');
        const c = pop(dataStack, 'data');
        const b = pop(dataStack, 'data');
        const a = pop(dataStack, 'data');
        push(dataStack, c);
        push(dataStack, d);
        push(dataStack, a);
        push(dataStack, b);
        return { supported: true, note: 'swap top two cell pairs', output };
      }
      case 'ROT': {
        const third = pop(dataStack, 'data');
        const second = pop(dataStack, 'data');
        const first = pop(dataStack, 'data');
        push(dataStack, second);
        push(dataStack, third);
        push(dataStack, first);
        return { supported: true, note: 'rotate third cell to top', output };
      }
      case 'SWAP': {
        const top = pop(dataStack, 'data');
        const next = pop(dataStack, 'data');
        push(dataStack, top);
        push(dataStack, next);
        return { supported: true, note: 'swap', output };
      }
      default:
        return { supported: false, note: 'native primitive without a TypeScript handler', output };
    }
  }

  private translatedCodeEntry(address: number, module: string): ForthWord | undefined {
    const candidates = this.engine.words.filter(candidate => candidate.type === 'primitive' && candidate.codep === address && candidate.codep !== CODE_USER_VECTOR);
    return candidates.find(candidate => candidate.module === module) ?? candidates.find(candidate => candidate.module === 'KERNEL');
  }

  private resumeThread(address: number): void {
    const frames = this.session!.frames;
    for (let depth = frames.length - 1; depth >= 0; depth--) {
      const frame = frames[depth];
      const index = frame.word.tokens.findIndex(token => token.addr === address);
      if (index < 0) continue;
      frames.length = depth + 1;
      frame.tokenIndex = index;
      return;
    }
    throw new Error(`Unindexed thread continuation 0x${address.toString(16)}`);
  }

  private formatTrace(steps: number, word: ForthWord, token: ForthToken, stack: MemoryStack, note: string): TraceEntry {
    return { steps, word, token, stack: stack.top(8), note };
  }

  private getReturnAddress(frame: CallFrame, token: ForthToken): number {
    const inlineString = token.name.match(/^(.*?) "[\s\S]*"$/);
    if (inlineString?.[1] === 'SET_STR_AS_PARAM') return (token.addr + 2) & 0xffff;
    return frame.word.tokens[frame.tokenIndex]?.addr ?? ((token.addr + 2) & 0xffff);
  }

  // A headerless colon definition (e.g. ASSCREW-OV's word at EAC2h), decoded from runtime memory once per run.
  private inferColon(cfa: number, module: string, name: string): ForthWord | undefined {
    const key = `${module}:${cfa}`;
    const cached = this.inferredColons.get(key);
    if (cached) return cached;
    const pfa = (cfa + 2) & 0xffff;
    const tokens = this.decodeThreaded(pfa, module);
    if (!tokens) return undefined;
    const hex = (value: number) => `0x${value.toString(16).padStart(4, '0')}`;
    const word: ForthWord = {
      name, cfa, cfaHex: hex(cfa), pfa, pfaHex: hex(pfa), codep: CODE_CALL, codepHex: hex(CODE_CALL), module,
      type: 'colon', typeLabel: 'headerless colon definition decoded from memory',
      decompiled: `: ${name} ${tokens.map(token => token.name).join(' ')}`, tokens,
      rawBytes: this.memory.subarray(cfa, Math.min(cfa + 32, this.memory.length))
    };
    this.inferredColons.set(key, word);
    return word;
  }

  // A DOES> child's code field points at `call DODOES`.
  private callsDoDoes(codep: number): boolean {
    const offset = this.memory[(codep + 1) & 0xffff] | (this.memory[(codep + 2) & 0xffff] << 8);
    return this.memory[codep & 0xffff] === 0xe8 && ((codep + 3 + offset) & 0xffff) === CODE_DODOES;
  }

  // A DOES> code field starts with `call DODOES`; the threaded body follows the call.
  private decodeDoesBody(word: ForthWord): ForthWord | undefined {
    if (!this.callsDoDoes(word.codep)) return undefined;
    const body = (word.codep + 3) & 0xffff;
    const tokens = this.decodeThreaded(body, 'KERNEL');
    if (!tokens) return undefined;
    return { ...word, name: `DOES> ${word.name}`, type: 'colon', typeLabel: `DOES> body at 0x${body.toString(16)}`, tokens };
  }

  // Decode threaded code from runtime memory up to the first EXIT, like the decompiler: literals, double literals,
  // branches, inline strings, and calls. Calls are named from the dictionary when possible and otherwise resolved
  // when they run. Returns undefined when no EXIT turns up within `maxBytes`.
  private decodeThreaded(start: number, module: string, maxBytes = 1024): ForthToken[] | undefined {
    const readWord = (address: number) => this.memory[address & 0xffff] | (this.memory[(address + 1) & 0xffff] << 8);
    const hex = (value: number) => `0x${value.toString(16).padStart(4, '0')}`;
    const tokens: ForthToken[] = [];
    let address = start & 0xffff;
    // An EXIT before the furthest forward branch target is an early exit (`IF ... EXIT THEN`); keep decoding.
    let furthestTarget = 0;
    while (((address - start) & 0xffff) < maxBytes) {
      const cfa = readWord(address);
      const addrHex = hex(address);
      const cfaHex = hex(cfa);
      if (cfa === CFA_EXIT1) {
        tokens.push({ addr: address, addrHex, cfa, cfaHex, name: ';', kind: 'exit' });
        if (furthestTarget <= address) return tokens;
        address = (address + 2) & 0xffff;
        continue;
      }
      if (cfa === CFA_LIT) {
        const value = readWord(address + 2);
        tokens.push({ addr: address, addrHex, cfa, cfaHex, name: String(value), kind: 'lit', arg: value });
        address = (address + 4) & 0xffff;
        continue;
      }
      if (cfa === CFA_2LIT) {
        const low = readWord(address + 2);
        const high = readWord(address + 4);
        const double = `${(high << 16) | low}.`;
        tokens.push({ addr: address, addrHex, cfa, cfaHex, name: `${double} (low)`, kind: 'lit', arg: low });
        const highAddress = (address + 2) & 0xffff;
        tokens.push({ addr: highAddress, addrHex: hex(highAddress), cfa, cfaHex, name: `${double} (high)`, kind: 'lit', arg: high });
        address = (address + 6) & 0xffff;
        continue;
      }
      if (cfa === CFA_0BRANCH || cfa === CFA_BRANCH) {
        // The offset cell follows, relative to its own address (e.g. <ON> and <OFF> at 3AECh).
        const target = (address + 2 + toSignedCell(readWord(address + 2))) & 0xffff;
        furthestTarget = Math.max(furthestTarget, target);
        const name = `${cfa === CFA_0BRANCH ? 'IF' : 'ELSE'} [-> 0x${target.toString(16)}]`;
        tokens.push({ addr: address, addrHex, cfa, cfaHex, name, kind: 'branch', arg: target });
        address = (address + 4) & 0xffff;
        continue;
      }
      const known = this.engine.wordsByCfa.get(cfa)?.find(candidate => candidate.module === module || candidate.module === 'KERNEL');
      const name = known?.name ?? `W_${cfaHex}`;
      if (name === '(.")' || name === '(ABORT")' || name === 'SET_STR_AS_PARAM') {
        // A counted string follows the call.
        const length = this.memory[(address + 2) & 0xffff];
        const text = Array.from({ length }, (_, index) => String.fromCharCode(this.memory[(address + 3 + index) & 0xffff])).join('');
        tokens.push({ addr: address, addrHex, cfa, cfaHex, name: `${name} "${text}"`, kind: 'call' });
        address = (address + 3 + length) & 0xffff;
        continue;
      }
      tokens.push({ addr: address, addrHex, cfa, cfaHex, name, kind: 'call' });
      address = (address + 2) & 0xffff;
    }
    return undefined;
  }

  // One 2-pixel-wide pixel of the 160x200 grid, as PLOT and the driver's line helpers write it: the row offset from
  // YTABL, the byte at row + x/4 in BUF-SEG, the mask from the C0h/30h/0Ch/03h table at 92CFh, and a latch
  // read-modify-write through the current Set/Reset color.
  private plotEga(x: number, y: number): void {
    const readWord = (address: number) => this.memory[address & 0xffff] | (this.memory[(address + 1) & 0xffff] << 8);
    const row = readWord(readWord(0x563a) + y * 2); // YTABL
    const mask = this.memory[(0x92cf + (x & 3) * 2) & 0xffff];
    const address = (readWord(0x5648) << 4) + ((row + (x >>> 2)) & 0xffff); // BUF-SEG
    this.ega.out(0x3ce, 8); // Bit Mask
    this.ega.out(0x3cf, mask);
    this.writePhysicalByte(address, this.readPhysicalByte(address));
  }

  private clipPolygon(readWord: (address: number) => number, writeWord: (address: number, value: number) => void): void {
    if (readWord(0x5686) === 0) return;
    this.outcodeVertices(readWord, writeWord);
    if (readWord(0x56e8) !== 0) { writeWord(0x5686, 0); return; }
    const sides = readWord(0x56dc);
    if (sides === 0) return;
    const outcode = (x: number, y: number) => {
      let code = 0;
      if ((x - readWord(0x5738)) & 0x8000) code |= 1;
      if (toSignedCell(x) > toSignedCell(readWord(0x5745))) code |= 2;
      if ((y - readWord(0x5752)) & 0x8000) code |= 4;
      if (toSignedCell(y) > toSignedCell(readWord(0x575f))) code |= 8;
      return code;
    };
    for (let side = 0; side < 4; side++) {
      const descriptor = 0x5253 + side * 5;
      const mask = readWord(descriptor);
      if ((mask & sides & 0xff) === 0) continue;
      const axis = this.memory[(descriptor + 2) & 0xffff];
      const bound = readWord(descriptor + 3);
      writeWord(0x5728, mask);
      writeWord(0x56cf, axis);
      writeWord(0x572c, bound);
      writeWord(0x5691, 0);
      const input = readWord(0x569b), output = readWord(0x56a6);
      const inputCodes = readWord(0x56b0), outputCodes = readWord(0x56bb);
      const count = readWord(0x5686);
      const open = readWord(0x56f4) === 1;
      const vertex = (index: number) => ({
        y: readWord(input + index * 4), x: readWord(input + index * 4 + 2),
        code: this.memory[(inputCodes + index) & 0xffff]
      });
      let emitted = 0;
      const emit = (point: { x: number; y: number; code: number }, intersection = false) => {
        writeWord(output + emitted * 4, point.y);
        writeWord(output + emitted * 4 + 2, point.x);
        this.memory[(outputCodes + emitted) & 0xffff] = point.code;
        if (intersection) this.memory[(outputCodes + emitted + 1) & 0xffff] = 0;
        writeWord(0x5691, ++emitted);
      };
      let previous = vertex(open ? 0 : count - 1);
      if (open && (previous.code & mask & 0xff) === 0) emit(previous);
      for (let index = open ? 1 : 0; index < count; index++) {
        const current = vertex(index);
        writeWord(0x5708, previous.y);
        writeWord(0x5704, previous.x);
        this.memory[0x570c] = previous.code;
        writeWord(0x5714, current.y);
        writeWord(0x5710, current.x);
        this.memory[0x5718] = current.code;
        const previousOutside = (previous.code & (mask >>> 8)) !== 0;
        const currentOutside = (current.code & (mask & 0xff)) !== 0;
        const currentAxis = axis === 1 ? current.y : current.x;
        const previousAxis = axis === 1 ? previous.y : previous.x;
        if (previousOutside !== currentOutside && (open || (currentAxis !== bound && previousAxis !== bound))) {
          const currentOther = axis === 1 ? current.x : current.y;
          const previousOther = axis === 1 ? previous.x : previous.y;
          const numerator = toSignedCell((bound - currentAxis) & 0xffff) * toSignedCell((previousOther - currentOther) & 0xffff);
          const quotient = Math.trunc(numerator / toSignedCell((previousAxis - currentAxis) & 0xffff));
          if (!Number.isFinite(quotient) || quotient < -0x8000 || quotient > 0x7fff) throw new RangeError('CLIPPER divide overflow (INT 0)');
          const other = (currentOther + quotient) & 0xffff;
          const x = axis === 1 ? other : bound, y = axis === 1 ? bound : other;
          emit({ x, y, code: outcode(x, y) }, true);
        }
        if (!currentOutside) emit(current);
        previous = current;
      }
      writeWord(0x5708, previous.y);
      writeWord(0x5704, previous.x);
      this.memory[0x570c] = previous.code;
      writeWord(0x569b, output);
      writeWord(0x56a6, input);
      writeWord(0x56b0, outputCodes);
      writeWord(0x56bb, inputCodes);
      writeWord(0x5686, emitted);
      if (emitted === 0) break;
    }
  }

  private scaleArc(value: number, readWord: (address: number) => number): number {
    const quotient = Math.trunc(toSignedCell(value) * toSignedCell(readWord(0x5a86)) / toSignedCell(readWord(0x5a93)));
    if (!Number.isFinite(quotient) || quotient < -0x8000 || quotient > 0x7fff) throw new RangeError('Arc scaling divide overflow (INT 0)');
    return quotient & 0xffff;
  }

  private drawArc(readWord: (address: number) => number, writeWord: (address: number, value: number) => void): void {
    const helper = readWord(0x5aa0);
    if (![0x0b20, 0x0b53, 0x0be7, 0x0c01].includes(helper)) throw new Error(`Unsupported arc helper 0x${helper.toString(16)}`);
    const radius = readWord(0x5a79);
    if (radius & 0x8000) throw new RangeError('ARC requires a nonnegative radius');
    this.ega.out(0x3ce, 1);
    this.ega.out(0x3cf, 15);
    const point = (horizontal: number, vertical: number) => {
      const x = (readWord(0x5a65) + horizontal) & 0xffff;
      const y = (readWord(0x5a6e) + vertical) & 0xffff;
      writeWord(readWord(0x569b), y);
      writeWord(readWord(0x569b) + 2, x);
      writeWord(0x5686, 1);
      this.outcodeVertices(readWord, writeWord);
      if (readWord(0x56dc) === 0) {
        this.ega.out(0x3ce, 0);
        this.ega.out(0x3cf, this.memory[0x55f2]);
        this.plotEga(x, y);
        this.ega.out(0x3ce, 0);
      }
    };
    const quadrant = (horizontal: number, vertical: number) => {
      const scaled = this.scaleArc(horizontal, readWord);
      if (helper === 0x0b20 || helper === 0x0c01) {
        point(scaled, vertical);
        point(-scaled, vertical);
        point(-scaled, -vertical);
        point(scaled, -vertical);
      } else {
        let right = (readWord(0x5a65) + scaled) & 0xffff;
        if (toSignedCell(right) > toSignedCell(readWord(0x5745))) right = readWord(0x5745);
        if ((right - readWord(0x5738)) & 0x8000) right = (readWord(0x5738) - 1) & 0xffff;
        this.memory[0x48c7] = right & 0xff;
        let left = (readWord(0x5a65) - scaled) & 0xffff;
        if ((left - readWord(0x5738)) & 0x8000) left = readWord(0x5738);
        if (toSignedCell(left) > toSignedCell(readWord(0x5745))) left = (((left & 0xff00) | (right & 0xff)) + 1) & 0xffff;
        this.memory[0x48c6] = left & 0xff;
        for (const y of [(readWord(0x5a6e) + vertical) & 0xffff, (readWord(0x5a6e) - vertical) & 0xffff]) {
          if (!((y - readWord(0x5752)) & 0x8000) && toSignedCell(y) <= toSignedCell(readWord(0x575f))) {
            writeWord(readWord(0x57d9) + y * 2, (left & 0xff) | ((right & 0xff) << 8));
          }
        }
      }
    };
    const visit = (horizontal: number, vertical: number) => {
      quadrant(horizontal, vertical);
      if (helper === 0x0be7 || helper === 0x0c01) quadrant(vertical, horizontal);
    };
    let horizontal = 0, vertical = radius;
    let decision = (3 - radius * 2) & 0xffff;
    while (((horizontal - vertical) & 0x8000) !== 0) {
      visit(horizontal, vertical);
      if (decision & 0x8000) decision = (decision + 6 + horizontal * 4) & 0xffff;
      else {
        decision = (decision + 10 + (horizontal - vertical) * 4) & 0xffff;
        vertical = (vertical - 1) & 0xffff;
      }
      horizontal = (horizontal + 1) & 0xffff;
    }
    if (horizontal === vertical) visit(horizontal, vertical);
  }

  private hlineEga(
    start: number,
    end: number,
    y: number,
    readWord: (address: number) => number,
    writeWord: (address: number, value: number) => void
  ): void {
    writeWord(0x57b7, start); // XSTART
    writeWord(0x57c2, end); // XEND
    writeWord(0x57ce, y); // YLINE
    if (end > readWord(0x5745) || start > end) return; // IRIGHT
    for (let x = start; x <= end; x++) this.plotEga(x, y);
  }

  // LLINE (far call to the EGA driver at REMSEG:0815h) ( x1 y1 x2 y2 -- ): a Bresenham line from (x2, y2) to (x1, y1)
  // in COLOR, with 8-bit coordinates and no clipping. Like SCANPOLY's edge walk, the driver patches its loop (step
  // opcodes and deltas at 08D1h-08E1h) and uses half the minor delta as the error threshold.
  private drawLine(readWord: (address: number) => number, writeWord: (address: number, value: number) => void, values: number[]): void {
    // Popped y2 first: the driver's Y1/X1 (the start) get y2/x2, and Y2/X2 (the end) get y1/x1.
    const [startY, startX, endY, endX] = values;
    writeWord(0x5613, startY); // Y1
    writeWord(0x561c, startX); // X1
    writeWord(0x5625, endY); // Y2
    writeWord(0x562e, endX); // X2
    this.ega.out(0x3ce, 1); // Enable Set/Reset on all planes
    this.ega.out(0x3cf, 0x0f);
    const INC_BL = 0xc3, DEC_BL = 0xcb, INC_BH = 0xc7, DEC_BH = 0xcf; // ModRM bytes of inc/dec bl/bh
    let xStep = INC_BL;
    let minor = (endX - startX) & 0xffff;
    if (toSignedCell(minor) < 0) {
      xStep = DEC_BL;
      minor = -minor & 0xffff;
    }
    let yStep = INC_BH;
    let major = (endY - startY) & 0xffff;
    if (toSignedCell(major) < 0) {
      yStep = DEC_BH;
      major = -major & 0xffff;
    }
    let majorStep = yStep;
    let minorStep = xStep;
    if (toSignedCell(major) < toSignedCell(minor)) {
      [major, minor] = [minor, major];
      [majorStep, minorStep] = [minorStep, majorStep];
    }
    const threshold = minor >>> 1;
    const driver = readWord(0x52a5) << 4; // REMSEG
    this.writePhysicalByte(driver + 0x8d1, majorStep);
    this.writePhysicalByte(driver + 0x8d4, minor);
    this.writePhysicalByte(driver + 0x8d5, minor >>> 8);
    this.writePhysicalByte(driver + 0x8d8, threshold);
    this.writePhysicalByte(driver + 0x8d9, threshold >>> 8);
    this.writePhysicalByte(driver + 0x8de, major);
    this.writePhysicalByte(driver + 0x8df, major >>> 8);
    this.writePhysicalByte(driver + 0x8e1, minorStep);

    let x = startX & 0xff; // bl
    let y = startY & 0xff; // bh
    const step = (opcode: number) => {
      if (opcode === INC_BL) x = (x + 1) & 0xff;
      else if (opcode === DEC_BL) x = (x - 1) & 0xff;
      else if (opcode === INC_BH) y = (y + 1) & 0xff;
      else y = (y - 1) & 0xff;
    };
    this.ega.out(0x3ce, 0); // Set/Reset = COLOR
    this.ega.out(0x3cf, this.memory[0x55f2]);
    let error = 0;
    let remaining = major;
    do {
      this.plotEga(x, y);
      step(majorStep);
      error = (error + minor) & 0xffff;
      if (toSignedCell(error) > toSignedCell(threshold)) {
        error = (error - major) & 0xffff;
        step(minorStep);
      }
      remaining = (remaining - 1) & 0xffff;
    } while (toSignedCell(remaining) >= 0);
    this.ega.out(0x3ce, 8); // Bit Mask FFh
    this.ega.out(0x3cf, 0xff);
  }

  // 8E32h: copy `count` bytes in write mode 1. Each read loads all four latches and each write stores them, so the
  // rep movsb copies every plane.
  private latchCopy(sourceSegment: number, sourceOffset: number, destinationSegment: number, destinationOffset: number, count: number): void {
    this.ega.out(0x3ce, 5);
    this.ega.out(0x3cf, 1);
    for (let index = 0; index < count; index++) {
      const value = this.readPhysicalByte((sourceSegment << 4) + ((sourceOffset + index) & 0xffff));
      this.writePhysicalByte((destinationSegment << 4) + ((destinationOffset + index) & 0xffff), value);
    }
    this.ega.out(0x3ce, 5);
    this.ega.out(0x3cf, 0);
  }

  // latchCopy with the direction flag set: from the given last bytes down, as the driver's STD; REP MOVSB.
  private latchCopyBackward(segment: number, sourceEnd: number, destinationEnd: number, count: number): void {
    this.ega.out(0x3ce, 5);
    this.ega.out(0x3cf, 1);
    for (let index = 0; index < count; index++) {
      const value = this.readPhysicalByte((segment << 4) + ((sourceEnd - index) & 0xffff));
      this.writePhysicalByte((segment << 4) + ((destinationEnd - index) & 0xffff), value);
    }
    this.ega.out(0x3ce, 5);
    this.ega.out(0x3cf, 0);
  }

  // {BLT} (far call to the EGA driver at REMSEG:064Fh): draw a 1-bit bitmap from BLTSEG:ABLT, WBLT by LBLT, with
  // its top-left at XBLT,YBLT and rows going down (y decreasing). Bits are read MSB first from 16-bit words, without
  // row padding; set bits plot in COLOR through Set/Reset (XORed when XORMODE is set). Unless the whole box is inside
  // the clip window (the driver's check at 0588h), rows and columns are clipped with unsigned compares; clipped
  // pixels still consume their bits.
  private blitBitmap(
    readWord: (address: number) => number,
    writeWord: (address: number, value: number) => void,
    readFarWord: (segment: number, offset: number) => number
  ): void {
    const signed = toSignedCell;
    const left = readWord(0x586e); // XBLT
    const top = readWord(0x5863); // YBLT
    const width = readWord(0x5892); // WBLT
    const height = readWord(0x5887); // LBLT
    const clipLeft = readWord(0x5738), clipRight = readWord(0x5745); // ILEFT, IRIGHT
    const clipBelow = readWord(0x5752), clipAbove = readWord(0x575f); // IBELOW, IABOVE
    const inside = !(signed(left) < signed(clipLeft) || signed(left + width - 1) > signed(clipRight)
      || signed(top) > signed(clipAbove) || signed(top - height + 1) < signed(clipBelow));
    writeWord(0x52be, inside ? 0xff : 0);
    this.ega.out(0x3ce, 1); // Enable Set/Reset on all planes
    this.ega.out(0x3cf, 0x0f);

    const segment = readWord(0x58aa); // BLTSEG
    let pointer = readWord(0x589d); // ABLT
    let shift = 0;
    let count = 0;
    const load = () => {
      shift = readFarWord(segment, pointer);
      pointer = (pointer + 2) & 0xffff;
      count = 16;
    };
    const nextBit = () => {
      count = (count - 1) & 0xffff;
      const bit = (shift & 0x8000) !== 0;
      shift = (shift << 1) & 0xffff;
      return bit;
    };
    const xor = readWord(0x587c) !== 0; // XORMODE
    load();
    let row = 0;
    do {
      const y = (top - row) & 0xffff;
      writeWord(0x57ce, readWord(readWord(0x563a) + y * 2)); // the row's offset from YTABL
      const rowVisible = inside || (y <= clipAbove && y >= clipBelow);
      writeWord(0x52c9, inside ? 0xff : rowVisible ? 5 : 0);
      let column = 0;
      do {
        const x = (left + column) & 0xffff;
        const visible = rowVisible && (inside || (x <= clipRight && x >= clipLeft));
        if (nextBit() && visible) {
          if (xor) {
            this.ega.out(0x3ce, 3); // function select: XOR
            this.ega.out(0x3cf, 0x18);
          }
          this.ega.out(0x3ce, 0); // Set/Reset = COLOR
          this.ega.out(0x3cf, this.memory[0x55f2]);
          this.plotEga(x, y);
          if (xor) {
            this.ega.out(0x3ce, 3); // back to replace
            this.ega.out(0x3cf, 0);
            this.ega.out(0x3ce, 8); // Bit Mask FFh
            this.ega.out(0x3cf, 0xff);
          }
        }
        if ((count & 0x0f) === 0) load();
        column = (column + 1) & 0xffff;
      } while (column !== width);
      row = (row + 1) & 0xffff;
    } while (row !== height);
    writeWord(0x58b5, pointer);
    writeWord(0x602b, count);
    writeWord(0x601f, shift);
  }

  // 8538h: Cohen-Sutherland outcodes for the #IN (y, x) vertices at VIN against ILEFT/IRIGHT/IBELOW/IABOVE, one byte
  // per vertex into OIN: 1 left, 2 right, 4 below, 8 above. TRJCT gets the AND of all codes (trivial reject when
  // nonzero), TACCPT the OR (trivial accept when zero). "Left"/"below" use the sign of the difference (JNS), "right"/
  // "above" a signed compare (JLE), as in the original.
  private outcodeVertices(readWord: (address: number) => number, writeWord: (address: number, value: number) => void): void {
    const below = (value: number, limit: number) => ((value - limit) & 0x8000) !== 0;
    const above = (value: number, limit: number) => toSignedCell(value) > toSignedCell(limit);
    let vertex = readWord(0x569b); // VIN
    let code = readWord(0x56b0); // OIN
    let all = 0x0f;
    let any = 0;
    let count = readWord(0x5686); // #IN
    do {
      const y = readWord(vertex);
      const x = readWord(vertex + 2);
      vertex = (vertex + 4) & 0xffff;
      let outcode = 0;
      if (below(y, readWord(0x5752))) outcode |= 4; // IBELOW
      if (above(y, readWord(0x575f))) outcode |= 8; // IABOVE
      if (below(x, readWord(0x5738))) outcode |= 1; // ILEFT
      if (above(x, readWord(0x5745))) outcode |= 2; // IRIGHT
      this.memory[code] = outcode;
      code = (code + 1) & 0xffff;
      all &= outcode;
      any |= outcode;
      count = (count - 1) & 0xffff;
    } while (count !== 0);
    writeWord(0x56e8, all); // TRJCT
    writeWord(0x56dc, any); // TACCPT
  }

  // SCANPOLY (8891h): scan-convert the #IN (y, x) vertices at VIN into SCAN, a table of (left, right) x bytes per
  // scanline, tracking YMIN/YMAX. Sloped edges go through the Bresenham walk at 87E1h; horizontal edges are kept on
  // the stack and merged into the table afterwards.
  private scanPolygon(readWord: (address: number) => number, writeWord: (address: number, value: number) => void): void {
    const signed = toSignedCell;
    const PREV_Y = 0x5708, PREV_X = 0x5704, CUR_Y = 0x5714, CUR_X = 0x5710, HORIZONTALS = 0x57fb;
    const YMIN = 0x57ec, YMAX = 0x57f7, ELEMENT = 0x57dd, SCAN = 0x57d9, SCAN_SIDE = 0x57e1;
    writeWord(HORIZONTALS, 0);
    writeWord(ELEMENT, 0);
    const vertices = readWord(0x569b); // VIN
    const count = readWord(0x5686); // #IN
    const last = (vertices + ((count - 1) & 0xffff) * 4) & 0xffff;
    writeWord(PREV_Y, readWord(last));
    writeWord(PREV_X, readWord(last + 2));
    writeWord(YMIN, readWord(vertices));
    writeWord(YMAX, readWord(vertices));
    const pending: number[] = []; // the 8086 stack: x pair, then y, per horizontal edge
    let vertex = vertices;
    let remaining = count;
    do {
      const y = readWord(vertex);
      const x = readWord(vertex + 2);
      writeWord(CUR_Y, y);
      writeWord(CUR_X, x);
      vertex = (vertex + 4) & 0xffff;
      if (y === readWord(PREV_Y)) {
        writeWord(HORIZONTALS, readWord(HORIZONTALS) + 1);
        const previousX = readWord(PREV_X);
        if (((x - previousX) & 0x8000) === 0) pending.push(x, previousX);
        else pending.push(previousX, x);
        pending.push(y);
      } else {
        if (signed(readWord(YMIN)) > signed(y)) writeWord(YMIN, y);
        else if ((readWord(YMAX) - y) & 0x8000) writeWord(YMAX, y);
        const side = signed(readWord(PREV_Y)) > signed(y) ? 1 : 0;
        writeWord(ELEMENT, side);
        writeWord(SCAN_SIDE, side + readWord(SCAN));
        this.scanEdge(readWord, writeWord);
      }
      writeWord(PREV_Y, readWord(CUR_Y));
      writeWord(PREV_X, readWord(CUR_X));
      remaining = (remaining - 1) & 0xffff;
    } while (remaining !== 0);

    const horizontals = readWord(HORIZONTALS);
    if (signed(horizontals) <= 0) return;
    writeWord(PREV_Y, 0x0900);
    for (let index = 0; index < horizontals; index++) {
      const y = pending.pop()!;
      const entry = (y * 2 + readWord(SCAN)) & 0xffff;
      const left = pending.pop()! & 0xff;
      const right = pending.pop()! & 0xff;
      if (y === readWord(PREV_Y)) {
        // Widen the row: left if smaller (sign of the byte difference), right if larger (signed bytes).
        if ((left - this.memory[entry]) & 0x80) this.memory[entry] = left;
        if (((right << 24) >> 24) > ((this.memory[(entry + 1) & 0xffff] << 24) >> 24)) this.memory[(entry + 1) & 0xffff] = right;
      } else {
        writeWord(PREV_Y, y);
        this.memory[entry] = left;
        this.memory[(entry + 1) & 0xffff] = right;
      }
    }
  }

  // 87E1h: walk one edge from (PREV_Y, PREV_X) to (CUR_Y, CUR_X), ordered by y, writing x bytes into the SCAN column
  // at [57E1h]. The original patches its loop (step opcodes and deltas at 8868h-8878h) before running it; the error
  // threshold is half the minor delta, as in the original.
  private scanEdge(readWord: (address: number) => number, writeWord: (address: number, value: number) => void): void {
    const PREV_Y = 0x5708, PREV_X = 0x5704, CUR_Y = 0x5714, CUR_X = 0x5710;
    const savedX = readWord(CUR_X);
    const savedY = readWord(CUR_Y);
    if ((readWord(CUR_Y) - readWord(PREV_Y)) & 0x8000) {
      const y = readWord(PREV_Y);
      writeWord(PREV_Y, readWord(CUR_Y));
      writeWord(CUR_Y, y);
      const x = readWord(PREV_X);
      writeWord(PREV_X, readWord(CUR_X));
      writeWord(CUR_X, x);
    }
    const INC_BH = 0xc7, INC_BL = 0xc3, DEC_BL = 0xcb; // ModRM bytes of inc bh / inc bl / dec bl
    let minorStep = INC_BL;
    let minor = (readWord(CUR_X) - readWord(PREV_X)) & 0xffff;
    if (toSignedCell(minor) < 0) {
      minorStep = DEC_BL;
      minor = -minor & 0xffff;
    }
    let majorStep = INC_BH;
    let major = (readWord(CUR_Y) - readWord(PREV_Y)) & 0xffff;
    if (toSignedCell(major) < toSignedCell(minor)) {
      [major, minor] = [minor, major];
      [majorStep, minorStep] = [minorStep, majorStep];
    }
    const threshold = minor >>> 1;
    this.memory[0x8868] = majorStep;
    writeWord(0x886b, minor);
    writeWord(0x886f, threshold);
    writeWord(0x8875, major);
    this.memory[0x8878] = minorStep;

    let x = readWord(PREV_X) & 0xff; // bl
    let y = readWord(PREV_Y) & 0xff; // bh
    const step = (opcode: number) => {
      if (opcode === INC_BH) y = (y + 1) & 0xff;
      else if (opcode === INC_BL) x = (x + 1) & 0xff;
      else x = (x - 1) & 0xff;
    };
    let error = 0;
    let counter = major;
    do {
      this.memory[(y * 2 + readWord(0x57e1)) & 0xffff] = x;
      step(majorStep);
      error = (error + minor) & 0xffff;
      if (toSignedCell(error) > toSignedCell(threshold)) {
        error = (error - major) & 0xffff;
        step(minorStep);
      }
      counter = (counter - 1) & 0xffff;
    } while (toSignedCell(counter) >= 0);
    writeWord(CUR_Y, savedY);
    writeWord(CUR_X, savedX);
  }

  // A copy of physical memory at segment:offset as the last run left it (RAM, not the EGA planes), for inspection.
  readMemory(segment: number, offset: number, length: number): Uint8Array {
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index++) {
      bytes[index] = this.physicalMemory[((segment & 0xffff) * 16 + ((offset + index) & 0xffff)) & 0xfffff];
    }
    return bytes;
  }

  private readFarByte(segment: number, offset: number): number {
    return this.readPhysicalByte(((segment & 0xffff) << 4) + (offset & 0xffff));
  }

  // Ports 42h/43h program PIT channel 2's divisor (low byte, then high byte); port 61h gates it to the speaker.
  private writeSpeakerPort(port: number, value: number): void {
    if (port === 0x43) this.pitLowByte = undefined;
    else if (port === 0x42) {
      if (this.pitLowByte === undefined) this.pitLowByte = value & 0xff;
      else {
        this.speakerDivisor = this.pitLowByte | ((value & 0xff) << 8);
        this.pitLowByte = undefined;
      }
    } else if (port === 0x61) this.speakerPort = value & 0xff;
    else return;
    this.speakerChanged();
  }

  // Report the speaker's tone when it changes: it sounds while port 61h has both the gate and data bits set.
  private speakerChanged(): void {
    const frequency = (this.speakerPort & 3) === 3 ? PIT_HZ / (this.speakerDivisor || 0x10000) : 0;
    if (frequency === this.speakerFrequency) return;
    this.speakerFrequency = frequency;
    if (this.speakerEvents.length >= MAX_SPEAKER_EVENTS) this.speakerEvents.shift(); // nobody is listening
    this.speakerEvents.push({ milliseconds: this.milliseconds, frequency });
  }

  // Deliver the BIOS timer ticks that are due by now, then work out the step of the next one. INT 8 itself only
  // counts; what matters is the INT 1Ch user hook, which the MUSIC overlay points at its player.
  private timerInterrupt(): void {
    const session = this.session!;
    const due = Math.floor(this.milliseconds / TIMER_TICK_MILLISECONDS);
    session.timerTicks ??= due;
    while (session.timerTicks < due) {
      session.timerTicks++;
      this.userTimerTick();
    }
    const clock = session.clock ?? { step: 0, milliseconds: 0 };
    const nextMilliseconds = (session.timerTicks + 1) * TIMER_TICK_MILLISECONDS;
    this.nextTimerStep = Math.max(this.step + 1, Math.ceil(clock.step + (nextMilliseconds - clock.milliseconds) * this.rate));
  }

  // INT 1Ch: nothing for the BIOS's IRET (vector 0000:0000 here) or the kernel clock; the MUSIC player when hooked.
  private userTimerTick(): void {
    const offset = this.readPhysicalByte(0x70) | (this.readPhysicalByte(0x71) << 8);
    const segment = this.readPhysicalByte(0x72) | (this.readPhysicalByte(0x73) << 8);
    if (offset === 0 && segment === 0) return;
    const at = (bytes: number[]) => bytes.every((value, index) => this.readFarByte(segment, offset + index) === value);
    // The kernel clock only advances TIME's counter, which TIME derives from the step count instead.
    if (segment === CLOCK_HANDLER.segment && offset === CLOCK_HANDLER.offset && at(CLOCK_HANDLER.prologue)) return;
    if (!at(MUSIC_HANDLER_PROLOGUE)) {
      throw new Error(`INT 1Ch handler at ${segment.toString(16)}:${offset.toString(16)} has no TypeScript translation`);
    }
    this.musicTick(segment);
  }

  // MUSINT (MUSIC overlay, MUSSEG:00FFh): one timer tick of the song player. Its data sits at the start of MUSSEG:
  // ?MUSIC (2), the phrase list entry (5: count, then the phrase address), the note pointer (7), REPEATS (9), COUNTER
  // (10), DURATION (11), RESTVALUE (12), TONESTATE (13) and the divisor table SCALE (24h). A note is a length byte
  // (bit 40h: leave one tick of silence after it) and a SCALE index, FFh for a rest; a zero length ends the phrase.
  private musicTick(segment: number): void {
    const byte = (offset: number) => this.readFarByte(segment, offset);
    const word = (offset: number) => byte(offset) | (byte(offset + 1) << 8);
    const setByte = (offset: number, value: number) => this.writePhysicalByte((segment << 4) + (offset & 0xffff), value);
    const setWord = (offset: number, value: number) => {
      setByte(offset, value);
      setByte(offset + 1, value >>> 8);
    };
    const silence = (ticks: number) => { // E3F7h with COUNTER and TONESTATE
      setByte(10, ticks);
      this.writeSpeakerPort(0x61, this.speakerPort & 0xfc);
      setByte(13, 1);
    };
    if (byte(2) === 0) return;
    setByte(10, byte(10) - 1);
    if (byte(10) !== 0) return;
    if (byte(13) === 0 && byte(12) !== 0) { // the gap after a staccato note
      silence(byte(12));
      return;
    }
    for (let notes = 0; notes < 0x10000; notes++) {
      let pointer = word(7);
      const length = byte(pointer) & 0x7f;
      if (length !== 0) {
        setByte(11, length & 0x3f);
        setByte(12, length & 0x40 ? 1 : 0);
        const note = byte(pointer + 1);
        setWord(7, pointer + 2);
        if (note === 0xff) {
          silence(byte(11));
          return;
        }
        setByte(10, byte(11) - byte(12));
        const divisor = word(0x24 + note * 2); // E3E4h: mode 3 on channel 2, then gate it to the speaker
        this.writeSpeakerPort(0x43, 0xb6);
        this.writeSpeakerPort(0x42, divisor & 0xff);
        this.writeSpeakerPort(0x42, divisor >>> 8);
        this.writeSpeakerPort(0x61, this.speakerPort | 3);
        setByte(13, 0);
        return;
      }
      pointer = word(5); // the end of a phrase: repeat it, or go on to the next entry
      setByte(9, byte(9) - 1);
      if (byte(9) === 0) {
        pointer = (pointer + 3) & 0xffff;
        const repeats = byte(pointer);
        if (repeats === 0) {
          setWord(2, 0);
          return;
        }
        setWord(5, pointer);
        setByte(9, repeats);
      }
      setWord(7, word(pointer + 1));
      setByte(10, 1);
      setByte(13, 1);
    }
    throw new Error('MUSIC player found no note in 65,536 empty phrases');
  }

  // A DIV/IDIV fault (INT 0) reaches the handler SET0/ installs, which clears AX and DX and resumes after the divide
  // (01C7h; 01C4h on later CPUs, 01D1h while probing): the quotient and remainder read as 0. Without it, stop.
  private divideFault(message: string): 0 {
    const vector = (offset: number) => this.readPhysicalByte(offset) | (this.readPhysicalByte(offset + 1) << 8);
    if (vector(2) !== 0x0192 || ![0x01c4, 0x01c7, 0x01d1].includes(vector(0))) throw new RangeError(message);
    return 0;
  }

  // FRACT-OV's near subroutines at E3C0h-E534h, shared by its headerless CODE words. They work on the 'ARRAY
  // (4CF1h): width at +0, height at +2, a row offset table at segment:[+4] and the cell segment at +6.
  private fractal(
    readWord: (address: number) => number,
    writeWord: (address: number, value: number) => void,
    readFarWord: (segment: number, offset: number) => number
  ) {
    const signed = toSignedCell;
    // E3C0h ( lo hi -- n ): step the generator at 4AB0h and scale it into lo..hi.
    const random = (low: number, high: number): number => {
      const seed = (Math.imul(signed(readWord(0x4ab0)), 0x7abd) + 0x1b0f) & 0xffff;
      writeWord(0x4ab0, seed);
      return (Math.floor(seed * ((high - low) & 0xffff) / 0x10000) + low) & 0xffff;
    };
    // E4B9h ( x y -- ): wrap x y when 4CCAh is set, then point E378h:E37Ch at the cell.
    const locate = (x: number, y: number): void => {
      const array = readWord(0x4cf1);
      if (signed(readWord(0x4cca)) > 0) { // E469h: reflect y over the poles (shifting x half way round), wrap x
        const width = readWord(array), height = readWord(array + 2);
        if (signed(y) < 0) {
          y = -(y + 1) & 0xffff;
          x = (x + (width >>> 1)) & 0xffff;
        } else if (signed((y - height) & 0xffff) >= 0) {
          y = (2 * height - y + 1) & 0xffff;
          x = (x + (width >>> 1)) & 0xffff;
        }
        if (signed(x) < 0) x = (x + width) & 0xffff;
        else if (signed((x - width) & 0xffff) >= 0) x = (x - width) & 0xffff;
      }
      const segment = readWord(array + 6);
      writeWord(0xe378, segment);
      writeWord(0xe37c, readFarWord(segment, readWord(array + 4) + y * 2) + x);
    };
    // E4EFh ( -- n ): the located cell, sign-extended when 4CD8h is set.
    const fetch = (): number => {
      const value = this.readFarByte(readWord(0xe378), readWord(0xe37c));
      return signed(readWord(0x4cd8)) > 0 ? ((value << 24) >> 24) & 0xffff : value;
    };
    const cell = (x: number, y: number): number => {
      locate(x, y);
      return fetch();
    };
    // E50Fh ( value x y -- ): store into the cell only if it is still unset (FF80h).
    const storeIfEmpty = (value: number, x: number, y: number): void => {
      locate(x, y);
      if (fetch() === 0xff80) this.writePhysicalByte((readWord(0xe378) << 4) + readWord(0xe37c), value);
    };
    // E3FAh + E3E0h ( average x y -- n ): add a random offset within +-scale, reseeded from the position when E356h
    // is set, and clamp to -127..127.
    const displace = (average: number, x: number, y: number, scale: number): number => {
      if (signed(readWord(0xe356)) > 0) {
        x = (x + readWord(0xe370)) & 0xffff;
        y = (y + readWord(0xe374)) & 0xffff;
        if (signed(y) < 0) {
          y = -(y + 1) & 0xffff;
          x = (x + 0x480) & 0xffff;
        } else if (signed((y - 0x3c0) & 0xffff) >= 0) {
          y = (0x781 - y) & 0xffff;
          x = (x + 0x480) & 0xffff;
        }
        writeWord(0x4ab0, y);
        const first = random(1, 0xffff);
        writeWord(0x4ab0, x);
        writeWord(0x4ab0, random(1, 0xffff) ^ readWord(0x5979) ^ first);
      }
      let sum = signed((average + random(-scale & 0xffff, scale)) & 0xffff);
      if (sum > 0x7f) sum = 0x7f;
      if (signed((sum + 0x7f) & 0xffff) < 0) sum = -0x7f;
      return sum & 0xffff;
    };
    const half = (value: number) => (signed(value & 0xffff) >> 1) & 0xffff;
    // E6C2h ( scale 0 0 x0 y0 x1 y1 -- ): fill edge midpoints and the centre, scale the amplitude by E360h/E35Eh,
    // then recurse into the four quadrants.
    const subdivide = (scale: number, x0: number, y0: number, x1: number, y1: number): void => {
      const spanX = signed((x1 - x0 - 1) & 0xffff) > 0 ? 1 : 0;
      const spanY = signed((y1 - y0 - 1) & 0xffff) > 0 ? 1 : 0;
      writeWord(0xe36c, spanX);
      writeWord(0xe368, spanY);
      if (!(spanX | spanY)) return;
      const midX = half(x0 + x1), midY = half(y0 + y1); // E691h
      if (spanY) { // E5B4h: the midpoint of the column x between y0 and y1
        for (const x of x0 === 0 ? [x0, x1] : [x1]) {
          writeWord(0xe396, x);
          storeIfEmpty(displace(half(cell(x, y0) + cell(x, y1)), x, midY, scale), x, midY);
        }
      }
      if (spanX) { // E56Dh: the midpoint of the row y between x0 and x1
        for (const y of y0 === 0 ? [y0, y1] : [y1]) {
          writeWord(0xe396, y);
          storeIfEmpty(displace(half(cell(x0, y) + cell(x1, y)), midX, y, scale), midX, y);
        }
      }
      if (spanX & spanY) { // E630h: the centre from the four edge midpoints
        const sum = cell(midX, y0) + cell(midX, y1) + cell(x0, midY) + cell(x1, midY);
        storeIfEmpty(displace((signed(sum & 0xffff) >> 2) & 0xffff, midX, midY, scale), midX, midY);
      }
      const product = scale * readWord(0xe360), divisor = readWord(0xe35e); // E6AAh: unsigned MUL / DIV
      let quotient = divisor === 0 ? NaN : Math.floor(product / divisor);
      if (!(quotient <= 0xffff)) quotient = this.divideFault('FRACT-OV amplitude divide overflow (INT 0)');
      const next = signed(quotient) > 0 ? quotient : 1;
      subdivide(next, x0, y0, midX, midY);
      subdivide(next, midX, y0, x1, midY);
      subdivide(next, x0, midY, midX, y1);
      subdivide(next, midX, midY, x1, y1);
    };
    return { storeIfEmpty, subdivide };
  }
}