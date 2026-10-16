// EGA planar video memory and the sequencer/graphics-controller registers that shape CPU access to it.
// CPU reads and writes at A000:offset go through read() and write(); port writes go through out().

const SEQUENCER_INDEX = 0x3c4;
const SEQUENCER_DATA = 0x3c5;
const GRAPHICS_INDEX = 0x3ce;
const GRAPHICS_DATA = 0x3cf;

// Graphics controller registers (3CEh/3CFh).
const SET_RESET = 0;
const ENABLE_SET_RESET = 1;
const COLOR_COMPARE = 2;
const DATA_ROTATE = 3; // bits 0-2 rotate count, bits 3-4 function: replace, AND, OR, XOR
const READ_MAP_SELECT = 4;
const MODE = 5; // bits 0-1 write mode, bit 3 read mode
const COLOR_DONT_CARE = 7;
const BIT_MASK = 8;

// Sequencer register (3C4h/3C5h).
const MAP_MASK = 2;

export class EgaAdapter {
  readonly planes = [0, 1, 2, 3].map(() => new Uint8Array(0x10000));
  readonly graphics = new Uint8Array(9);
  readonly sequencer = new Uint8Array(5);
  private graphicsIndex = 0;
  private sequencerIndex = 0;
  private readonly latches = new Uint8Array(4);

  constructor() {
    this.resetRegisters();
  }

  // The register state the BIOS leaves after a graphics mode set; `clear` zeroes all four planes.
  setMode(clear: boolean): void {
    this.resetRegisters();
    if (clear) for (const plane of this.planes) plane.fill(0);
  }

  out(port: number, value: number): boolean {
    value &= 0xff;
    if (port === GRAPHICS_INDEX) this.graphicsIndex = value & 0x0f;
    else if (port === GRAPHICS_DATA) {
      if (this.graphicsIndex < this.graphics.length) this.graphics[this.graphicsIndex] = value;
    } else if (port === SEQUENCER_INDEX) this.sequencerIndex = value & 0x07;
    else if (port === SEQUENCER_DATA) {
      if (this.sequencerIndex < this.sequencer.length) this.sequencer[this.sequencerIndex] = value;
    } else return false;
    return true;
  }

  // A CPU read loads all four latches; read mode 0 returns one plane, read mode 1 a color-compare mask.
  read(offset: number): number {
    offset &= 0xffff;
    for (let plane = 0; plane < 4; plane++) this.latches[plane] = this.planes[plane][offset];
    if ((this.graphics[MODE] & 0x08) === 0) return this.latches[this.graphics[READ_MAP_SELECT] & 0x03];

    let matches = 0xff;
    for (let plane = 0; plane < 4; plane++) {
      if ((this.graphics[COLOR_DONT_CARE] & (1 << plane)) === 0) continue;
      const wanted = this.graphics[COLOR_COMPARE] & (1 << plane) ? 0xff : 0x00;
      matches &= ~(this.latches[plane] ^ wanted);
    }
    return matches & 0xff;
  }

  write(offset: number, value: number): void {
    offset &= 0xffff;
    value &= 0xff;
    const writeMode = this.graphics[MODE] & 0x03;
    const mapMask = this.sequencer[MAP_MASK] & 0x0f;
    if (writeMode === 1) {
      // Write mode 1 stores the latches, as loaded by the last read.
      for (let plane = 0; plane < 4; plane++) if (mapMask & (1 << plane)) this.planes[plane][offset] = this.latches[plane];
      return;
    }

    const rotate = this.graphics[DATA_ROTATE] & 0x07;
    const rotated = ((value >>> rotate) | (value << (8 - rotate))) & 0xff;
    const operation = (this.graphics[DATA_ROTATE] >>> 3) & 0x03;
    const bitMask = this.graphics[BIT_MASK];
    for (let plane = 0; plane < 4; plane++) {
      if ((mapMask & (1 << plane)) === 0) continue;
      let data: number;
      if (writeMode === 2) data = value & (1 << plane) ? 0xff : 0x00;
      else if (this.graphics[ENABLE_SET_RESET] & (1 << plane)) data = this.graphics[SET_RESET] & (1 << plane) ? 0xff : 0x00;
      else data = rotated;

      const latch = this.latches[plane];
      if (operation === 1) data &= latch;
      else if (operation === 2) data |= latch;
      else if (operation === 3) data ^= latch;
      this.planes[plane][offset] = (data & bitMask) | (latch & ~bitMask & 0xff);
    }
  }

  // The 4-bit color of a pixel in a 320x200 (mode 0Dh) page starting at `pageOffset`.
  pixel(x: number, y: number, pageOffset = 0): number {
    const offset = (pageOffset + y * 40 + (x >>> 3)) & 0xffff;
    const bit = 0x80 >>> (x & 7);
    let color = 0;
    for (let plane = 0; plane < 4; plane++) if (this.planes[plane][offset] & bit) color |= 1 << plane;
    return color;
  }

  private resetRegisters(): void {
    this.graphics.fill(0);
    this.graphics[COLOR_DONT_CARE] = 0x0f;
    this.graphics[BIT_MASK] = 0xff;
    this.graphics[6] = 0x05; // Miscellaneous: graphics mode, memory at A000h for 64K
    this.sequencer.fill(0);
    this.sequencer[MAP_MASK] = 0x0f;
    this.graphicsIndex = 0;
    this.sequencerIndex = 0;
    this.latches.fill(0);
  }
}
