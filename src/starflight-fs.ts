/**
 * Starflight File System & Directory Parser
 *
 * Starflight was built using an internal Forth operating system running on MS-DOS.
 * STARA.COM and STARB.COM act as virtual disks organized into 1024-byte Forth blocks.
 *
 * The file system layout:
 * - STARA.COM: 256,000 bytes (global offsets 0x000000 - 0x03E7FF)
 * - STARB.COM: 362,496 bytes (global offsets 0x03E800 - 0x096FFF)
 * - Total disk space: 618,496 bytes (~604 KB)
 *
 * The Directory table starts at byte 0 of STARA.COM and spans 4 blocks (4096 bytes).
 * Each block holds 48 entries of 21 bytes each (192 total slots).
 */

export const STARA_SIZE = 256000;
export const STARB_SIZE = 362496;
export const TOTAL_DISK_SIZE = STARA_SIZE + STARB_SIZE; // 618496 bytes
export const BLOCK_SIZE = 1024;
export const DIR_ENTRIES_PER_BLOCK = 48;
export const DIR_ENTRY_SIZE = 21;
export const TOTAL_DIR_SLOTS = 4 * DIR_ENTRIES_PER_BLOCK; // 192 slots

export type FileTarget = 'NONE' | 'STARA' | 'STARB' | 'PAD';

export interface DirEntry {
  /** Index in the directory table (0..191) */
  idx: number;
  /** Trimmed ASCII name (e.g. "INSTANCE", "ELO-CPIC", or "<empty>") */
  name: string;
  /** Raw 12-byte name string */
  rawName: string;
  /** File number: 0 = RAM/schema only, 1 = STARA.COM, 2 = STARB.COM, 32 = 0x20 pad */
  fileno: number;
  /** Target file label */
  file: FileTarget;
  /** Starting paragraph (1 paragraph = 16 bytes) */
  startPara: number;
  /** Ending paragraph (inclusive) */
  endPara: number;
  /** Global byte offset across the combined disk space (startPara * 16) */
  startOffset: number;
  /** Global byte offset for end paragraph (endPara * 16) */
  endOffset: number;
  /** Local byte offset within STARA or STARB */
  localOffset: number;
  /** Total byte size ((endPara - startPara + 1) * 16), or 0 for virtual entries */
  size: number;
  /** Number of records / blocks in this entry */
  nblocks: number;
  /** Record size in bytes (records never cross 1024-byte block boundaries) */
  blockSize: number;
  /** Logical / payload size (used for instance entity properties) */
  lsize: number;
  /** The raw 21 bytes of this directory entry in the directory table */
  entryBytes: Uint8Array;
  /** Byte offset of this entry in the directory table (0..4095) */
  dirTableOffset: number;
  /** ArrayBuffer view over this entry's mapped byte range */
  data: Uint8Array;
  /** Get an ArrayBuffer view for a specific record index within this entry */
  getRecord(recordIdx: number): Uint8Array;
}

export class StarflightFS {
  /** The full combined 618,496-byte virtual disk */
  readonly disk: Uint8Array;
  /** STARA.COM view (first 256,000 bytes) */
  readonly stara: Uint8Array;
  /** STARB.COM view (following 362,496 bytes) */
  readonly starb: Uint8Array;
  /** All 192 directory entries */
  readonly entries: DirEntry[];
  /** Map of entry names (uppercase) to directory entries */
  private readonly byName = new Map<string, DirEntry>();
  /** Map of directory index to directory entry */
  private readonly byIndex = new Map<number, DirEntry>();

  constructor(staraBuffer: ArrayBuffer, starbBuffer: ArrayBuffer) {
    if (staraBuffer.byteLength !== STARA_SIZE) {
      console.warn(`Warning: STARA.COM is ${staraBuffer.byteLength} bytes, expected ${STARA_SIZE}`);
    }
    if (starbBuffer.byteLength !== STARB_SIZE) {
      console.warn(`Warning: STARB.COM is ${starbBuffer.byteLength} bytes, expected ${STARB_SIZE}`);
    }

    // Allocate continuous linear memory for the entire game disk
    this.disk = new Uint8Array(staraBuffer.byteLength + starbBuffer.byteLength);
    this.disk.set(new Uint8Array(staraBuffer), 0);
    this.disk.set(new Uint8Array(starbBuffer), staraBuffer.byteLength);

    this.stara = this.disk.subarray(0, staraBuffer.byteLength);
    this.starb = this.disk.subarray(staraBuffer.byteLength);

    this.entries = this.parseDirectory();

    for (const entry of this.entries) {
      if (entry.name && !entry.name.startsWith('<')) {
        this.byName.set(entry.name.toUpperCase(), entry);
      }
      this.byIndex.set(entry.idx, entry);
    }
  }

  private parseDirectory(): DirEntry[] {
    const staraData = this.stara;
    const entries: DirEntry[] = [];

    // All 4 blocks of STARA.COM (48 entries * 4 blocks = 192 slots)
    for (let k = 0; k < 4; k++) {
      for (let i = 0; i < DIR_ENTRIES_PER_BLOCK; i++) {
        const idx = k * DIR_ENTRIES_PER_BLOCK + i;
        const dirTableOffset = k * BLOCK_SIZE + i * DIR_ENTRY_SIZE;
        const entryBytes = staraData.subarray(dirTableOffset, dirTableOffset + DIR_ENTRY_SIZE);

        // 12 bytes name
        let rawName = '';
        for (let b = 0; b < 12; b++) {
          rawName += String.fromCharCode(entryBytes[b]);
        }
        let name = rawName.trim();

        const fileno = entryBytes[12];
        const startPara = entryBytes[13] | (entryBytes[14] << 8);
        const endPara = entryBytes[15] | (entryBytes[16] << 8);
        const nblocks = entryBytes[17] | (entryBytes[18] << 8);
        const blockSize = entryBytes[19];
        const lsize = entryBytes[20];

        const isAllSpaces = Array.from(entryBytes).every(b => b === 0x20);
        const isAllZeros = Array.from(entryBytes).every(b => b === 0x00);

        if (!name) {
          if (isAllSpaces) {
            name = `<pad 0x20>`;
          } else if (isAllZeros) {
            name = `<empty>`;
          } else {
            name = `<unnamed>`;
          }
        }

        const startOffset = startPara * 16;
        const endOffset = endPara * 16;
        const size = (startPara > 0 || endPara > 0) ? (endPara - startPara + 1) * 16 : 0;

        let file: FileTarget = 'NONE';
        let localOffset = 0;
        if (fileno === 1 || (startOffset > 0 && startOffset < STARA_SIZE)) {
          file = 'STARA';
          localOffset = startOffset;
        } else if (fileno === 2 || (startOffset >= STARA_SIZE && startOffset < TOTAL_DISK_SIZE)) {
          file = 'STARB';
          localOffset = startOffset - STARA_SIZE;
        } else if (fileno === 32 || isAllSpaces) {
          file = 'PAD';
          localOffset = startOffset;
        }

        const boundedSize = Math.max(0, Math.min(size, TOTAL_DISK_SIZE - startOffset));
        const data = (boundedSize > 0 && startOffset < TOTAL_DISK_SIZE)
          ? this.disk.subarray(startOffset, startOffset + boundedSize)
          : new Uint8Array(0);

        const entry: DirEntry = {
          idx,
          name,
          rawName,
          fileno,
          file,
          startPara,
          endPara,
          startOffset,
          endOffset,
          localOffset,
          size,
          nblocks,
          blockSize,
          lsize,
          entryBytes,
          dirTableOffset,
          data,
          getRecord: (recIdx: number) => this.getRecord(entry, recIdx)
        };

        entries.push(entry);
      }
    }

    return entries;
  }

  /**
   * Calculates the global byte offset for a specific record within an entry.
   */
  getRecordOffset(entry: DirEntry, recordIdx: number): number {
    if (entry.blockSize <= 0) {
      return entry.startOffset;
    }
    let offset = entry.startOffset & ~0x3FF; // Align to 1024-byte block
    let sp2 = entry.startOffset & 0x3FF;    // Byte offset within block

    const firstBlockRecords = Math.floor((BLOCK_SIZE - sp2) / entry.blockSize);
    if (recordIdx < firstBlockRecords) {
      sp2 += recordIdx * entry.blockSize;
    } else {
      const rem = recordIdx - firstBlockRecords;
      offset += BLOCK_SIZE;
      const recordsPerBlock = Math.floor(BLOCK_SIZE / entry.blockSize);
      const blocks = Math.floor(rem / recordsPerBlock);
      offset += blocks * BLOCK_SIZE;
      sp2 = (rem % recordsPerBlock) * entry.blockSize;
    }
    return offset + sp2;
  }

  /**
   * Retrieves a record within an entry.
   * In Forth, fixed-size records are packed inside 1024-byte blocks and never cross block boundaries.
   */
  getRecord(entry: DirEntry, recordIdx: number): Uint8Array {
    if (entry.blockSize <= 0) {
      throw new Error(`Directory entry "${entry.name}" has no valid blockSize (${entry.blockSize})`);
    }
    if (recordIdx < 0 || (entry.nblocks > 0 && recordIdx >= entry.nblocks)) {
      throw new RangeError(`Record index ${recordIdx} out of bounds for "${entry.name}" (nblocks=${entry.nblocks})`);
    }

    const absOffset = this.getRecordOffset(entry, recordIdx);
    const end = Math.min(absOffset + entry.blockSize, this.disk.length);
    return this.disk.subarray(absOffset, end);
  }

  /**
   * Look up an entry by name (case-insensitive) or index.
   */
  get(nameOrIdx: string | number): DirEntry | undefined {
    if (typeof nameOrIdx === 'number') {
      return this.byIndex.get(nameOrIdx);
    }
    return this.byName.get(nameOrIdx.trim().toUpperCase());
  }

  /**
   * Read raw bytes directly from anywhere in the combined virtual disk.
   */
  read(offset: number, length: number): Uint8Array {
    return this.disk.subarray(offset, offset + length);
  }

  /**
   * Returns a summary list of all entries formatted for console output.
   */
  getSummary(): Array<{
    idx: string;
    numIdx: number;
    name: string;
    file: FileTarget;
    offset: string;
    size: number;
    records: number;
    recordSize: number;
    lsize: number;
  }> {
    return this.entries.map(e => ({
      idx: `0x${e.idx.toString(16).padStart(2, '0')}`,
      numIdx: e.idx,
      name: e.name,
      file: e.file,
      offset: e.size > 0 ? `0x${e.startOffset.toString(16).padStart(6, '0')}` : 'none',
      size: e.size,
      records: e.nblocks,
      recordSize: e.blockSize,
      lsize: e.lsize,
    }));
  }
}

/**
 * Convenience helper to instantiate the StarflightFS from two ArrayBuffers.
 */
export function createStarflightFS(stara: ArrayBuffer, starb: ArrayBuffer): StarflightFS {
  return new StarflightFS(stara, starb);
}
