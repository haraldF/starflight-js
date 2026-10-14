/**
 * Starflight Forth Disassembler & Decompiler
 *
 * Reconstructs original Forth source code and execution token chains from:
 * 1. STARFLT.COM (Forth kernel & main vocabulary, encrypted with XOR 0x7F)
 * 2. 52 Code Overlays in STARA.COM / STARB.COM (BANK-OV, COMM-OV, COMBAT-OV, etc.)
 * 3. Reverse-engineered dictionary symbols from the Starflight research database
 */

import { STARA_SIZE, TOTAL_DISK_SIZE } from './starflight-fs';

export type ForthWordType = 'colon' | 'variable' | 'constant' | 'user' | 'afield' | 'case' | 'primitive';

export interface ForthToken {
  addr: number;
  addrHex: string;
  cfa: number;
  cfaHex: string;
  name: string;
  kind: 'call' | 'lit' | 'branch' | 'exit' | 'other';
  arg?: number | string;
  targetWord?: ForthWord;
}

export interface ForthWord {
  name: string;
  cfa: number;
  cfaHex: string;
  pfa: number;
  pfaHex: string;
  codep: number;
  codepHex: string;
  module: string;            // 'KERNEL' or overlay name e.g. 'BANK-OV'
  type: ForthWordType;
  typeLabel: string;
  decompiled: string;
  tokens: ForthToken[];
  rawBytes: Uint8Array;
}

// Known Forth Execution Tokens in Starflight's 8086 Forth Engine
export const CODE_CALL = 0x224c;       // DOCOL: ":" colon definition
export const CODE_CONSTANT = 0x2214;   // DOCON: CONSTANT
export const CODE_VARIABLE = 0x1d29;   // DOVAR: VARIABLE
export const CODE_USER = 0x1792;       // DOUSER: USER variable (offset into USER area)
export const CODE_2LIT = 0x1618;       // (2LIT): push two constants
export const CODE_AFIELD = 0x744d;     // Instance field / attribute accessor
export const CODE_LOADDATA = 0x73ea;   // File record / data loader
export const CODE_CASE = 0x4a4f;       // CCASE: CASE: jump table

export const CFA_LIT = 0x175d;         // (LIT): literal constant follows
export const CFA_0BRANCH = 0x15fa;     // (0BRANCH): conditional jump (IF / UNTIL)
export const CFA_BRANCH = 0x1660;      // (BRANCH): unconditional jump (ELSE / AGAIN)
export const CFA_EXIT1 = 0x1690;       // EXIT: return from colon definition (;)
export const CFA_EXIT2 = 0x79c9;       // RET / EXIT alias

export class ForthEngine {
  readonly words: ForthWord[] = [];
  readonly wordsByCfa = new Map<number, ForthWord>();
  readonly wordsByName = new Map<string, ForthWord[]>();
  readonly modules: string[] = [];

  constructor(words: ForthWord[]) {
    this.words = words;
    const moduleSet = new Set<string>();

    for (const w of words) {
      this.wordsByCfa.set(w.cfa, w);
      if (!this.wordsByName.has(w.name.toUpperCase())) {
        this.wordsByName.set(w.name.toUpperCase(), []);
      }
      this.wordsByName.get(w.name.toUpperCase())!.push(w);
      moduleSet.add(w.module);
    }

    this.modules = Array.from(moduleSet).sort((a, b) => {
      if (a === 'KERNEL') return -1;
      if (b === 'KERNEL') return 1;
      return a.localeCompare(b);
    });
  }

  get(nameOrCfa: string | number): ForthWord | undefined {
    if (typeof nameOrCfa === 'number') {
      return this.wordsByCfa.get(nameOrCfa);
    }
    const list = this.wordsByName.get(nameOrCfa.trim().toUpperCase());
    return list?.[0];
  }

  filter(module = 'all', type = 'all', search = ''): ForthWord[] {
    const q = search.trim().toLowerCase();
    return this.words.filter(w => {
      if (module !== 'all' && w.module !== module) return false;
      if (type !== 'all' && w.type !== type) return false;
      if (q) {
        const matchesName = w.name.toLowerCase().includes(q);
        const matchesCfa = w.cfaHex.toLowerCase().includes(q);
        const matchesCode = w.decompiled.toLowerCase().includes(q);
        if (!matchesName && !matchesCfa && !matchesCode) return false;
      }
      return true;
    });
  }
}

interface OverlayInfo {
  name: string;
  storeofs: number;
  ovlsize: number;
  vocOffsets: number[];
  buf: Uint8Array;
}

/**
 * Parses and builds the complete Forth Engine from game binaries.
 */
export async function createForthEngine(
  staraBuffer: ArrayBuffer,
  starbBuffer: ArrayBuffer,
  starfltBuffer: ArrayBuffer,
  forthDictJson?: Array<{ ov: number; code: number; word: number; name: string }>
): Promise<ForthEngine> {
  const stara = new Uint8Array(staraBuffer);
  const starb = new Uint8Array(starbBuffer);
  const starflt = new Uint8Array(starfltBuffer);

  // Symbol resolution map: CFA (16-bit) -> Name
  const cfaNameMap = new Map<number, string>();

  // 1. Seed well-known Forth Primitives
  cfaNameMap.set(CFA_LIT, '(LIT)');
  cfaNameMap.set(CFA_0BRANCH, '0BRANCH');
  cfaNameMap.set(CFA_BRANCH, 'BRANCH');
  cfaNameMap.set(CFA_EXIT1, 'EXIT');
  cfaNameMap.set(CFA_EXIT2, 'EXIT');

  // 2. Load Reverse-Engineered Research Symbols (from forth-dict.json if available)
  if (forthDictJson) {
    for (const d of forthDictJson) {
      if (!d.name) continue;
      const cfa = (d.word - 2) & 0xffff;
      if (!cfaNameMap.has(cfa)) {
        cfaNameMap.set(cfa, d.name);
      }
    }
  }

  // 3. Load Kernel Memory Model (STARFLT.COM loaded at 0x100)
  const kernelMem = new Uint8Array(0x10000);
  kernelMem.set(starflt, 0x100);

  // Helper to parse linked-list Forth vocabularies
  function parseVocabulary(
    mem: Uint8Array,
    linkpStart: number,
    decrypt: boolean,
    moduleName: string,
    minAddr = 0x100,
    maxAddr = 0x10000
  ): Array<{ name: string; cfa: number; codep: number; pfa: number; linkp: number; module: string }> {
    const list: Array<{ name: string; cfa: number; codep: number; pfa: number; linkp: number; module: string }> = [];
    let curr = linkpStart;
    const visited = new Set<number>();

    while (curr >= minAddr && curr < maxAddr && !visited.has(curr)) {
      visited.add(curr);
      const linkp = mem[curr] | (mem[curr + 1] << 8);
      const bitfield = mem[curr + 2];
      const length = bitfield & 0x1f;

      let wordName = '';
      let n = 0;
      do {
        n++;
        const b = mem[curr + 2 + n];
        const charCode = decrypt ? ((length === 1 ? b : (b ^ 0x7f)) & 0x7f) : (b & 0x7f);
        wordName += String.fromCharCode(charCode);
        if ((b & 128) !== 0) break;
      } while (n < 32);

      const cfa = curr + n + 3;
      const codep = mem[cfa] | (mem[cfa + 1] << 8);
      const pfa = cfa + 2;

      list.push({ name: wordName.trim(), cfa, codep, pfa, linkp, module: moduleName });
      cfaNameMap.set(cfa, wordName.trim());

      if (linkp <= minAddr || linkp === curr) break;
      curr = linkp - 2;
    }
    return list;
  }

  // Parse STARFLT.COM vocabularies
  const rawKernelWords: Array<{ name: string; cfa: number; codep: number; pfa: number; linkp: number; module: string }> = [];
  rawKernelWords.push(...parseVocabulary(kernelMem, 0xd40f - 2, true, 'KERNEL', 0x100, 0x100 + starflt.length));
  rawKernelWords.push(...parseVocabulary(kernelMem, 0xd480 - 2, true, 'KERNEL', 0x100, 0x100 + starflt.length));

  // 4. Find and Load all 52 Code Overlays from STARA / STARB
  const overlays: OverlayInfo[] = [];
  for (let idx = 0; idx < 150; idx++) {
    const k = Math.floor(idx / 48);
    const i = idx % 48;
    const base = k * 1024 + i * 21;
    const name = String.fromCharCode(...stara.subarray(base, base + 12)).trim();
    const fileno = stara[base + 12];
    const start = (stara[base + 13] | (stara[base + 14] << 8)) * 16;
    const end = (stara[base + 15] | (stara[base + 16] << 8)) * 16;

    if (fileno > 0 && (name.endsWith('-OV') || ['CAPTAIN', 'DOCTOR', 'ENGINEER', 'NAVIGATR', 'SCIENCE', 'SHIPBUTTONS', 'LISTICONS', 'MUSIC'].includes(name))) {
      const size = end - start + 16;
      const buf = fileno === 2 
        ? starb.subarray(start - STARA_SIZE, start - STARA_SIZE + size) 
        : stara.subarray(start, start + size);

      const storeofs = buf[4] | (buf[5] << 8);
      const ovlsize = (buf[2] | (buf[3] << 8)) * 16;
      const vocOffsets: number[] = [];
      for (let v = 0; v < 8; v += 2) {
        const vocofs = buf[10 + v] | (buf[11 + v] << 8);
        if (vocofs !== 0) vocOffsets.push(vocofs);
      }

      overlays.push({ name, storeofs, ovlsize, vocOffsets, buf });
    }
  }

  // Parse all overlay vocabularies into symbol map
  const rawOverlayWords: Array<{ name: string; cfa: number; codep: number; pfa: number; linkp: number; module: string; mem: Uint8Array }> = [];
  const overlayMemMap = new Map<string, { mem: Uint8Array; storeofs: number; ovlsize: number }>();

  for (const ov of overlays) {
    const mem = new Uint8Array(0x10000);
    mem.set(ov.buf.subarray(0, ov.ovlsize), ov.storeofs);
    overlayMemMap.set(ov.name, { mem, storeofs: ov.storeofs, ovlsize: ov.ovlsize });

    for (const vocofs of ov.vocOffsets) {
      const words = parseVocabulary(mem, vocofs - 2, false, ov.name, ov.storeofs, ov.storeofs + ov.ovlsize);
      for (const w of words) {
        rawOverlayWords.push({ ...w, mem });
      }
    }
  }

  // 5. Decompile and format all words
  const parsedWords: ForthWord[] = [];

  function decompileColon(mem: Uint8Array, pfa: number, maxBytes = 256): { decompiled: string; tokens: ForthToken[] } {
    const tokens: ForthToken[] = [];
    let p = pfa;
    const bodyWords: string[] = [];

    while (p < pfa + maxBytes) {
      const cfa = mem[p] | (mem[p + 1] << 8);
      const addr = p;
      const addrHex = `0x${addr.toString(16).padStart(4, '0')}`;
      const cfaHex = `0x${cfa.toString(16).padStart(4, '0')}`;
      p += 2;

      // Exit / Return
      if (cfa === CFA_EXIT1 || cfa === CFA_EXIT2) {
        tokens.push({ addr, addrHex, cfa, cfaHex, name: ';', kind: 'exit' });
        bodyWords.push(';');
        break;
      }

      // Literal number
      if (cfa === CFA_LIT) {
        const val = (mem[p] | (mem[p + 1] << 8));
        const signedVal = (val << 16) >> 16;
        p += 2;
        tokens.push({ addr, addrHex, cfa, cfaHex, name: signedVal.toString(), kind: 'lit', arg: signedVal });
        bodyWords.push(signedVal.toString());
        continue;
      }

      // Conditional Branch
      if (cfa === CFA_0BRANCH) {
        const rel = (mem[p] | (mem[p + 1] << 8));
        const signedRel = (rel << 16) >> 16;
        p += 2;
        const target = addr + 2 + signedRel;
        tokens.push({ addr, addrHex, cfa, cfaHex, name: `IF [-> 0x${target.toString(16)}]`, kind: 'branch', arg: target });
        bodyWords.push(`IF`);
        continue;
      }

      // Unconditional Branch
      if (cfa === CFA_BRANCH) {
        const rel = (mem[p] | (mem[p + 1] << 8));
        const signedRel = (rel << 16) >> 16;
        p += 2;
        const target = addr + 2 + signedRel;
        tokens.push({ addr, addrHex, cfa, cfaHex, name: `ELSE [-> 0x${target.toString(16)}]`, kind: 'branch', arg: target });
        bodyWords.push(`ELSE`);
        continue;
      }

      // Named word call
      const name = cfaNameMap.get(cfa) || `W_${cfaHex}`;
      tokens.push({ addr, addrHex, cfa, cfaHex, name, kind: 'call' });
      bodyWords.push(name);
    }

    const decompiled = bodyWords.length > 0 ? bodyWords.join(' ') : ';';
    return { decompiled, tokens };
  }

  // Assemble kernel words
  for (const w of rawKernelWords) {
    let type: ForthWordType = 'primitive';
    let typeLabel = 'Primitive (Machine Code)';
    let decompiled = '';
    let tokens: ForthToken[] = [];

    if (w.codep === CODE_CALL) {
      type = 'colon';
      typeLabel = ': Colon Definition';
      const res = decompileColon(kernelMem, w.pfa);
      decompiled = `: ${w.name}  ${res.decompiled}`;
      tokens = res.tokens;
    } else if (w.codep === CODE_CONSTANT) {
      type = 'constant';
      typeLabel = 'CONSTANT';
      const val = kernelMem[w.pfa] | (kernelMem[w.pfa + 1] << 8);
      decompiled = `${val} CONSTANT ${w.name}`;
    } else if (w.codep === CODE_VARIABLE) {
      type = 'variable';
      typeLabel = 'VARIABLE';
      const val = kernelMem[w.pfa] | (kernelMem[w.pfa + 1] << 8);
      decompiled = `VARIABLE ${w.name} (initial: ${val})`;
    } else if (w.codep === CODE_USER) {
      type = 'user';
      typeLabel = 'USER Variable';
      const val = kernelMem[w.pfa] | (kernelMem[w.pfa + 1] << 8);
      decompiled = `${val} USER ${w.name}`;
    } else {
      decompiled = `CODE ${w.name} [codep: 0x${w.codep.toString(16)}]`;
    }

    const rawBytes = kernelMem.subarray(w.cfa, Math.min(w.cfa + 32, 0x10000));

    parsedWords.push({
      name: w.name,
      cfa: w.cfa,
      cfaHex: `0x${w.cfa.toString(16).padStart(4, '0')}`,
      pfa: w.pfa,
      pfaHex: `0x${w.pfa.toString(16).padStart(4, '0')}`,
      codep: w.codep,
      codepHex: `0x${w.codep.toString(16).padStart(4, '0')}`,
      module: 'KERNEL',
      type,
      typeLabel,
      decompiled,
      tokens,
      rawBytes
    });
  }

  // Assemble overlay words
  for (const w of rawOverlayWords) {
    let type: ForthWordType = 'primitive';
    let typeLabel = 'Primitive (Machine Code)';
    let decompiled = '';
    let tokens: ForthToken[] = [];

    if (w.codep === CODE_CALL) {
      type = 'colon';
      typeLabel = ': Colon Definition';
      const res = decompileColon(w.mem, w.pfa);
      decompiled = `: ${w.name}  ${res.decompiled}`;
      tokens = res.tokens;
    } else if (w.codep === CODE_CONSTANT) {
      type = 'constant';
      typeLabel = 'CONSTANT';
      const val = w.mem[w.pfa] | (w.mem[w.pfa + 1] << 8);
      decompiled = `${val} CONSTANT ${w.name}`;
    } else if (w.codep === CODE_VARIABLE) {
      type = 'variable';
      typeLabel = 'VARIABLE';
      const val = w.mem[w.pfa] | (w.mem[w.pfa + 1] << 8);
      decompiled = `VARIABLE ${w.name} (initial: ${val})`;
    } else if (w.codep === CODE_AFIELD) {
      type = 'afield';
      typeLabel = 'AFIELD (Record Field Accessor)';
      decompiled = `AFIELD ${w.name}`;
    } else if (w.codep === CODE_CASE) {
      type = 'case';
      typeLabel = 'CASE: Jump Table';
      decompiled = `CASE: ${w.name}`;
    } else {
      decompiled = `CODE ${w.name} [codep: 0x${w.codep.toString(16)}]`;
    }

    const rawBytes = w.mem.subarray(w.cfa, Math.min(w.cfa + 32, 0x10000));

    parsedWords.push({
      name: w.name,
      cfa: w.cfa,
      cfaHex: `0x${w.cfa.toString(16).padStart(4, '0')}`,
      pfa: w.pfa,
      pfaHex: `0x${w.pfa.toString(16).padStart(4, '0')}`,
      codep: w.codep,
      codepHex: `0x${w.codep.toString(16).padStart(4, '0')}`,
      module: w.module,
      type,
      typeLabel,
      decompiled,
      tokens,
      rawBytes
    });
  }

  return new ForthEngine(parsedWords);
}
