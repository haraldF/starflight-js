/**
 * Starflight Forth Disassembler & Decompiler
 *
 * Reconstructs original Forth source code and execution token chains from:
 * 1. STARFLT.COM (Forth kernel & main vocabulary, encrypted with XOR 0x7F)
 * 2. 52 Code Overlays in STARA.COM / STARB.COM (BANK-OV, COMM-OV, COMBAT-OV, etc.)
 * 3. Reverse-engineered dictionary symbols from the Starflight research database
 */

import { STARA_SIZE } from './starflight-fs';

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
  machineCodeBytes?: Uint8Array;
  machineCodeIsInline?: boolean;
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
  readonly wordsByCfa = new Map<number, ForthWord[]>();
  readonly wordsByModuleAndCfa = new Map<string, ForthWord[]>();
  readonly wordsByName = new Map<string, ForthWord[]>();
  readonly modules: string[] = [];

  constructor(words: ForthWord[]) {
    this.words = words;
    const moduleSet = new Set<string>();

    for (const w of words) {
      const cfaWords = this.wordsByCfa.get(w.cfa) ?? [];
      cfaWords.push(w);
      this.wordsByCfa.set(w.cfa, cfaWords);

      const moduleCfaKey = `${w.module}:${w.cfa}`;
      const moduleCfaWords = this.wordsByModuleAndCfa.get(moduleCfaKey) ?? [];
      moduleCfaWords.push(w);
      this.wordsByModuleAndCfa.set(moduleCfaKey, moduleCfaWords);

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

  get(nameOrCfa: string | number, module?: string): ForthWord | undefined {
    if (typeof nameOrCfa === 'number') {
      const candidates = module
        ? this.wordsByModuleAndCfa.get(`${module}:${nameOrCfa}`) ?? []
        : this.wordsByCfa.get(nameOrCfa) ?? [];
      return candidates.length === 1 ? candidates[0] : undefined;
    }
    const list = this.wordsByName.get(nameOrCfa.trim().toUpperCase());
    if (module) {
      const moduleWord = list?.find(word => word.module === module);
      if (moduleWord) return moduleWord;
      const kernelWord = list?.find(word => word.module === 'KERNEL');
      if (kernelWord) return kernelWord;
    }
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

  const cfaNameMaps = new Map<string, Map<number, string>>();
  const getCfaNameMap = (module: string) => {
    let nameMap = cfaNameMaps.get(module);
    if (!nameMap) {
      nameMap = new Map<number, string>();
      cfaNameMaps.set(module, nameMap);
    }
    return nameMap;
  };

  const kernelCfaNameMap = getCfaNameMap('KERNEL');
  kernelCfaNameMap.set(CFA_LIT, '(LIT)');
  kernelCfaNameMap.set(CFA_0BRANCH, '0BRANCH');
  kernelCfaNameMap.set(CFA_BRANCH, 'BRANCH');
  kernelCfaNameMap.set(CFA_EXIT1, 'EXIT');
  kernelCfaNameMap.set(CFA_EXIT2, 'EXIT');

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
  ): Array<{ name: string; cfa: number; codep: number; pfa: number; linkp: number; module: string; headerAddr: number }> {
    const list: Array<{ name: string; cfa: number; codep: number; pfa: number; linkp: number; module: string; headerAddr: number }> = [];
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

      list.push({ name: wordName.trim(), cfa, codep, pfa, linkp, module: moduleName, headerAddr: curr });
      const nameMap = getCfaNameMap(moduleName);
      if (!nameMap.has(cfa)) nameMap.set(cfa, wordName.trim());

      if (linkp <= minAddr || linkp === curr) break;
      curr = linkp - 2;
    }
    return list;
  }

  // Parse STARFLT.COM vocabularies
  const rawKernelWords: Array<{ name: string; cfa: number; codep: number; pfa: number; linkp: number; module: string; headerAddr?: number }> = [];
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

  // Dictionary overlay IDs follow the same ordered overlay table.
  const researchedWords: Array<{ name: string; cfa: number; codep: number; pfa: number; module: string }> = [];
  for (const d of forthDictJson ?? []) {
    if (!d.name || /^W[0-9a-f]{4}$/i.test(d.name)) continue;
    const module = d.ov === -1 ? 'KERNEL' : overlays[d.ov]?.name;
    if (!module) continue;
    const cfa = (d.word - 2) & 0xffff;
    const nameMap = getCfaNameMap(module);
    nameMap.set(cfa, d.name);
    researchedWords.push({ name: d.name, cfa, codep: d.code, pfa: d.word, module });
  }

  // Parse all overlay vocabularies into symbol map
  const rawOverlayWords: Array<{ name: string; cfa: number; codep: number; pfa: number; linkp: number; module: string; mem: Uint8Array; headerAddr?: number }> = [];
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

  for (const researchedWord of researchedWords) {
    const words = researchedWord.module === 'KERNEL' ? rawKernelWords : rawOverlayWords;
    if (words.some(word => word.cfa === researchedWord.cfa && word.module === researchedWord.module)) continue;

    const mem = researchedWord.module === 'KERNEL'
      ? kernelMem
      : overlayMemMap.get(researchedWord.module)?.mem;
    if (!mem) continue;

    const codep = mem[researchedWord.cfa] | (mem[researchedWord.cfa + 1] << 8);
    if (codep !== researchedWord.codep) continue;

    words.push({
      ...researchedWord,
      linkp: 0,
      ...(researchedWord.module === 'KERNEL' ? {} : { mem })
    });
  }

  function getMachineCodeBytes(
    module: string,
    codep: number,
    pfa?: number,
    headerAddr?: number
  ): { bytes: Uint8Array; isInline: boolean } | undefined {
    if (codep <= 0 || codep >= 0x10000) return undefined;
    const kernelCodeEnd = 0x100 + starflt.length;
    const mem = codep >= 0x100 && codep < kernelCodeEnd
      ? kernelMem
      : (module === 'KERNEL' ? kernelMem : overlayMemMap.get(module)?.mem);
    if (!mem) return undefined;

    if (pfa === codep && headerAddr !== undefined) {
      const words = module === 'KERNEL' ? rawKernelWords : rawOverlayWords;
      const nextHeader = words.reduce<number | undefined>((next, word) => {
        if (word.headerAddr === undefined || word.headerAddr <= headerAddr) return next;
        return next === undefined || word.headerAddr < next ? word.headerAddr : next;
      }, undefined);
      const moduleEnd = module === 'KERNEL'
        ? kernelCodeEnd
        : (overlayMemMap.get(module)?.storeofs ?? 0) + (overlayMemMap.get(module)?.ovlsize ?? mem.length);
      const inlineEnd = Math.min(nextHeader ?? moduleEnd, moduleEnd, mem.length);
      if (inlineEnd > codep) {
        return { bytes: mem.subarray(codep, inlineEnd), isInline: true };
      }
    }

    return { bytes: mem.subarray(codep, Math.min(codep + 64, mem.length)), isInline: false };
  }

  const knownCodePointers = new Set([
    ...rawKernelWords.map(word => word.codep),
    ...rawOverlayWords.map(word => word.codep),
    ...(forthDictJson ?? []).map(word => word.code)
  ]);
  const memoryRegions = [
    { module: 'KERNEL', mem: kernelMem, start: 0x100, end: Math.min(0x100 + starflt.length, 0x10000), decrypt: true },
    ...Array.from(overlayMemMap, ([module, overlay]) => ({
      module,
      mem: overlay.mem,
      start: overlay.storeofs,
      end: Math.min(overlay.storeofs + overlay.ovlsize, 0x10000),
      decrypt: false
    }))
  ];
  const discoveredHeaders = new Map<string, Map<number, { name: string; cfa: number; codep: number; pfa: number; module: string; mem: Uint8Array; headerAddr: number }>>();

  for (const region of memoryRegions) {
    const headers = new Map<number, { name: string; cfa: number; codep: number; pfa: number; module: string; mem: Uint8Array; headerAddr: number }>();
    discoveredHeaders.set(region.module, headers);

    for (let header = region.start; header + 6 < region.end; header++) {
      const nameLength = region.mem[header + 2] & 0x1f;
      if (nameLength < 1 || nameLength > 31) continue;

      let name = '';
      let charCount = 0;
      let validName = true;
      while (charCount < 32 && header + 3 + charCount < region.end) {
        const byte = region.mem[header + 3 + charCount];
        const charCode = region.decrypt && nameLength !== 1 ? (byte ^ 0x7f) & 0x7f : byte & 0x7f;
        if (charCode < 33 || charCode > 126) {
          validName = false;
          break;
        }
        name += String.fromCharCode(charCode);
        charCount++;
        if (byte & 0x80) break;
      }
      if (!validName || charCount !== nameLength || !(region.mem[header + 2 + charCount] & 0x80)) continue;

      const link = region.mem[header] | (region.mem[header + 1] << 8);
      if (link < region.start || link >= header) continue;
      const cfa = header + charCount + 3;
      if (cfa + 1 >= region.end) continue;
      const codep = region.mem[cfa] | (region.mem[cfa + 1] << 8);
      if (!knownCodePointers.has(codep)) continue;

      headers.set(cfa, { name, cfa, codep, pfa: cfa + 2, module: region.module, mem: region.mem, headerAddr: header });
      const nameMap = getCfaNameMap(region.module);
      if (!nameMap.has(cfa) || /^W[0-9a-f]{4}$/i.test(nameMap.get(cfa)!)) nameMap.set(cfa, name);
    }
  }

  function hasValidUnresolvedColonBody(region: typeof memoryRegions[number], cfa: number): boolean {
    if ((region.mem[cfa] | (region.mem[cfa + 1] << 8)) !== CODE_CALL) return false;

    let p = cfa + 2;
    for (let instructions = 0; instructions < 128 && p + 1 < region.end; instructions++) {
      const token = region.mem[p] | (region.mem[p + 1] << 8);
      p += 2;

      if (token === CFA_EXIT1 || token === CFA_EXIT2) return true;
      if (token === CFA_LIT || token === CFA_0BRANCH || token === CFA_BRANCH) {
        p += 2;
        continue;
      }

      const name = cfaNameMaps.get(region.module)?.get(token) ?? kernelCfaNameMap.get(token);
      if (name === '(ABORT")' || name === '(.\")' || name === 'SET_STR_AS_PARAM') {
        if (p >= region.end) return false;
        p += 1 + region.mem[p];
      }
      if (p >= region.end) return false;
    }

    return false;
  }

  const globalCfaNames = new Map<number, Set<string>>();
  for (const nameMap of cfaNameMaps.values()) {
    for (const [cfa, name] of nameMap) {
      if (/^W[0-9a-f]{4}$/i.test(name)) continue;
      const names = globalCfaNames.get(cfa) ?? new Set<string>();
      names.add(name);
      globalCfaNames.set(cfa, names);
    }
  }

  // 5. Decompile and format all words
  const parsedWords: ForthWord[] = [];

  function decompileColon(mem: Uint8Array, pfa: number, module: string, maxBytes = 256): { decompiled: string; tokens: ForthToken[] } {
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
      const moduleName = cfaNameMaps.get(module)?.get(cfa);
      const kernelName = kernelCfaNameMap.get(cfa);
      const knownNames = globalCfaNames.get(cfa);
      const name = (moduleName && !/^W[0-9a-f]{4}$/i.test(moduleName) ? moduleName : undefined)
        ?? kernelName
        ?? (knownNames?.size === 1 ? Array.from(knownNames)[0] : undefined)
        ?? `W_${cfaHex}`;
      if (name === '(ABORT")' || name === '(.\")' || name === 'SET_STR_AS_PARAM') {
        const length = mem[p];
        const stringStart = p + 1;
        const stringEnd = Math.min(stringStart + length, mem.length);
        const inlineString = Array.from(mem.subarray(stringStart, stringEnd), byte => {
          if (byte === 0x22) return '\\"';
          if (byte === 0x5c) return '\\\\';
          if (byte < 0x20 || byte > 0x7e) return `\\x${byte.toString(16).padStart(2, '0')}`;
          return String.fromCharCode(byte);
        }).join('');
        const call = `${name} "${inlineString}"`;
        tokens.push({ addr, addrHex, cfa, cfaHex, name: call, kind: 'call' });
        bodyWords.push(call);
        p = stringEnd;
        continue;
      }
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
      const res = decompileColon(kernelMem, w.pfa, 'KERNEL');
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

    const machineCode = type === 'primitive' ? getMachineCodeBytes('KERNEL', w.codep, w.pfa, w.headerAddr) : undefined;
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
      rawBytes,
      ...(machineCode ? { machineCodeBytes: machineCode.bytes, machineCodeIsInline: machineCode.isInline } : {})
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
      const res = decompileColon(w.mem, w.pfa, w.module);
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

    const machineCode = type === 'primitive' ? getMachineCodeBytes(w.module, w.codep, w.pfa, w.headerAddr) : undefined;
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
      rawBytes,
      ...(machineCode ? { machineCodeBytes: machineCode.bytes, machineCodeIsInline: machineCode.isInline } : {})
    });
  }

  const parsedWordKeys = new Set(parsedWords.map(word => `${word.module}:${word.cfa}`));
  for (let wordIndex = 0; wordIndex < parsedWords.length; wordIndex++) {
    const sourceWord = parsedWords[wordIndex];
    for (const token of sourceWord.tokens) {
      const cfa = token.cfa;
      const candidates = Array.from(discoveredHeaders.values())
        .map(headers => headers.get(cfa))
        .filter((header): header is NonNullable<typeof header> => header !== undefined);
      const contextualCandidates = candidates.filter(header => header.module === sourceWord.module);
      const header = contextualCandidates.length === 1
        ? contextualCandidates[0]
        : (contextualCandidates.length === 0 && candidates.length === 1 ? candidates[0] : undefined);
      const anonymousCandidates = header ? [] : memoryRegions.filter(region =>
        cfa >= region.start && cfa + 1 < region.end && hasValidUnresolvedColonBody(region, cfa)
      );
      const contextualAnonymousCandidates = anonymousCandidates.filter(region => region.module === sourceWord.module);
      const anonymousRegion = contextualAnonymousCandidates.length === 1
        ? contextualAnonymousCandidates[0]
        : (contextualAnonymousCandidates.length === 0 && anonymousCandidates.length === 1 ? anonymousCandidates[0] : undefined);
      const module = header?.module ?? anonymousRegion?.module;
      const mem = header?.mem ?? anonymousRegion?.mem;
      const codep = header?.codep ?? (anonymousRegion ? CODE_CALL : undefined);
      if (!module || !mem || codep === undefined) continue;

      const key = `${module}:${cfa}`;
      if (parsedWordKeys.has(key)) continue;
      parsedWordKeys.add(key);
      const name = header?.name ?? `W_0x${cfa.toString(16).padStart(4, '0')}`;
      const pfa = cfa + 2;
      const body = codep === CODE_CALL ? decompileColon(mem, pfa, module) : undefined;
      const machineCode = !body ? getMachineCodeBytes(module, codep, pfa, header?.headerAddr) : undefined;
      parsedWords.push({
        name,
        cfa,
        cfaHex: `0x${cfa.toString(16).padStart(4, '0')}`,
        pfa,
        pfaHex: `0x${pfa.toString(16).padStart(4, '0')}`,
        codep,
        codepHex: `0x${codep.toString(16).padStart(4, '0')}`,
        module,
        type: body ? 'colon' : 'primitive',
        typeLabel: body
          ? (header ? 'Recovered colon definition (raw memory)' : 'Unresolved-name colon word (raw memory)')
          : 'Unresolved word (raw memory)',
        decompiled: body
          ? `: ${name}  ${body.decompiled}`
          : `RAW ${name} [codep: 0x${codep.toString(16).padStart(4, '0')}]`,
        tokens: body?.tokens ?? [],
        rawBytes: mem.subarray(cfa, Math.min(cfa + 32, mem.length)),
        ...(machineCode ? { machineCodeBytes: machineCode.bytes, machineCodeIsInline: machineCode.isInline } : {})
      });
    }
  }

  return new ForthEngine(parsedWords);
}
