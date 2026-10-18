import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { ForthBootRunner, STEPS_PER_MILLISECOND, biosKey, screenLines } from '../src/forth-boot.ts';
import { CODE_CALL, CFA_EXIT1, ForthEngine, createForthEngine, type ForthToken, type ForthWord } from '../src/forth-decompiler.ts';
import { BLOCK_SIZE, createStarflightFS } from '../src/starflight-fs.ts';
import { extractFluxes, extractStarSystems } from '../src/starsystems.ts';
import { EgaAdapter } from '../src/ega.ts';
import { decodeSaveFile, encodeSaveFile } from '../src/save-file.ts';

type Operation = number | string;

let nativeFixture: Promise<{ engine: ForthEngine; image: Uint8Array; disks: { stara: Uint8Array; starb: Uint8Array }; checkpoint: ReturnType<ForthBootRunner['saveState']> }> | undefined;

function realNativeFixture() {
  return nativeFixture ??= (async () => {
    const [stara, starb, image, dictionary] = await Promise.all([
      readFile(new URL('../public/STARA.COM', import.meta.url)).then(bytes => Uint8Array.from(bytes)),
      readFile(new URL('../public/STARB.COM', import.meta.url)).then(bytes => Uint8Array.from(bytes)),
      readFile(new URL('../public/STARFLT.COM', import.meta.url)).then(bytes => Uint8Array.from(bytes)),
      readFile(new URL('../public/forth-dict.json', import.meta.url), 'utf8')
    ]);
    const engine = await createForthEngine(stara.buffer, starb.buffer, image.buffer, JSON.parse(dictionary));
    const disks = { stara, starb };
    const runner = new ForthBootRunner(engine, image, disks);
    runner.start(0x0937, [biosKey('5')!, biosKey('Enter')!]);
    runner.advance(200_000);
    const checkpoint = runner.saveState();
    return { engine, image, disks, checkpoint };
  })();
}

async function runRealNative(operations: (number | ForthWord)[], setup?: (state: ReturnType<ForthBootRunner['saveState']>) => void) {
  const fixture = await realNativeFixture();
  const runner = new ForthBootRunner(fixture.engine, fixture.image, fixture.disks);
  const checkpoint = structuredClone(fixture.checkpoint);
  const tokens: ForthToken[] = operations.map((operation, index) => ({
    addr: 0x1000 + index * 4, addrHex: `0x${(0x1000 + index * 4).toString(16)}`,
    cfa: typeof operation === 'number' ? 0 : operation.cfa,
    cfaHex: typeof operation === 'number' ? '0x0000' : operation.cfaHex,
    name: typeof operation === 'number' ? String(operation) : operation.name,
    kind: typeof operation === 'number' ? 'lit' : 'call', arg: typeof operation === 'number' ? operation : undefined
  }));
  tokens.push({ addr: 0x1000 + operations.length * 4, addrHex: '0x0000', cfa: CFA_EXIT1, cfaHex: '0x1690', name: ';', kind: 'exit' });
  checkpoint.session.frames = [{ word: word('NATIVE-TEST', 0x0937, CODE_CALL, tokens), tokenIndex: 0 }];
  checkpoint.session.returnStack = [];
  checkpoint.session.stackPointer = new DataView(checkpoint.physicalMemory.buffer).getUint16((0x0192 << 4) + 0x078c, true);
  checkpoint.session.state = 'running';
  checkpoint.session.stopReason = '';
  checkpoint.session.trace = [];
  checkpoint.breakpoints = [];
  for (const operation of operations) {
    if (typeof operation === 'number' || operation.module === 'KERNEL') continue;
    const overlay = fixture.engine.overlays.get(operation.module)!;
    checkpoint.physicalMemory.set(overlay.memory.subarray(overlay.storeofs, overlay.storeofs + overlay.size), (0x0192 << 4) + overlay.storeofs);
    new DataView(checkpoint.physicalMemory.buffer).setUint16((0x0192 << 4) + 0x55a5, overlay.vsa, true);
  }
  setup?.(checkpoint);
  runner.loadState(checkpoint);
  runner.advance(10_000);
  return { runner, result: runner.snapshot() };
}

const CODE_POINTERS: Record<string, number> = { 'LC@': 0x2ecd, 'C!': 0x0c60, RECADD: 0x718d, '+BIT': 0x4af3, '!IB': 0x9aba, '!IW': 0x9a9e, 'EASY-BITS': 0x4b17, 'D2*': 0x4b08, '?ILOCUS': 0x9d18, XCHGICON: 0x9e14, '?IID': 0x9eb1, '4*': 0x1047, '3+': 0x4984, TOGGLE: 0x1355, '@L': 0x0bbf, '!L': 0x0bf1 };

function createRunner(operations: Operation[], stara: Uint8Array, starb: Uint8Array): ForthBootRunner {
  const names = Object.keys(CODE_POINTERS).concat(['R/W', 'LC!', 'C@']);
  const primitives: ForthWord[] = names.map((name, index) => ({
    name: name === 'C!' ? 'C!_2' : name,
    cfa: 0x200 + index * 2,
    cfaHex: `0x${(0x200 + index * 2).toString(16)}`,
    pfa: 0,
    pfaHex: '0x0000',
    // Primitives the runner dispatches by code pointer need their real one.
    codep: CODE_POINTERS[name] ?? 0,
    codepHex: `0x${(CODE_POINTERS[name] ?? 0).toString(16).padStart(4, '0')}`,
    module: 'KERNEL',
    type: 'primitive',
    typeLabel: 'test primitive',
    decompiled: '',
    tokens: [],
    rawBytes: new Uint8Array()
  }));
  const tokens: ForthToken[] = operations.map((operation, index) => {
    const primitive = typeof operation === 'string' ? primitives[names.indexOf(operation)] : undefined;
    if (typeof operation === 'string' && !primitive) throw new Error(`Unknown test primitive ${operation}`);
    return {
      addr: 0x1000 + index * 4,
      addrHex: `0x${(0x1000 + index * 4).toString(16)}`,
      cfa: primitive?.cfa ?? 0,
      cfaHex: primitive?.cfaHex ?? '0x0000',
      name: primitive?.name ?? String(operation),
      kind: primitive ? 'call' : 'lit',
      arg: typeof operation === 'number' ? operation : undefined
    };
  });
  tokens.push({ addr: 0x7000, addrHex: '0x7000', cfa: CFA_EXIT1, cfaHex: '0x1690', name: ';', kind: 'exit' });
  const entry: ForthWord = {
    ...primitives[0], name: 'TEST', cfa: 0x0937, cfaHex: '0x0937',
    codep: CODE_CALL, type: 'colon', tokens
  };
  // These tests count trace lines, so keep the whole trace.
  return new ForthBootRunner(new ForthEngine([...primitives, entry]), new Uint8Array(), { stara, starb }, { traceLines: Infinity });
}

function transfer(segment: number, offset: number, block: number, reading = 1): Operation[] {
  return [segment, offset, block, reading, 'R/W'];
}

Object.assign(CODE_POINTERS, {
  'C!L': 0x0c71, 'C@L': 0x0ca7, 'L+-@': 0x49f0, 'L1.5@': 0x4bd9,
  'CMOVE>': 0x0ce4, '<LCMOVE': 0x48dc, 'V@': 0x29e1, VFILL: 0x2a18,
  VMOVE: 0x2a36, 'VMOVE-': 0x2a5f, '2^N': 0x4910
});
Object.assign(CODE_POINTERS, { DIGIT: 0x14bd, '(SLIPPE': 0x4c87, '@IW': 0x9a6c, '?INVIS': 0x992d, 'WLD>SCR': 0x9970, 'SCR>BLT': 0x99b4, MATCH: 0x39ee });

test('U/MOD follows the installed divide-error recovery handler for zero and overflow', async () => {
  const { engine } = await realNativeFixture();
  const divide = engine.get('U/MOD', 'KERNEL');
  assert.ok(divide);
  const cases = [
    { operands: [0xffff, 0, 1], expected: [0, 0xffff] },
    { operands: [0xffff, 1, 2], expected: [1, 0xffff] },
    { operands: [0x1234, 0x5678, 0], expected: [0, 0] },
    { operands: [0, 1, 1], expected: [0, 0] }
  ];
  for (const { operands, expected } of cases) {
    const { result } = await runRealNative([0xbeef, ...operands, divide]);
    assert.equal(result.stopReason, 'Forth returned from the entry word.', result.trace.join('\n'));
    const stack = [0xbeef, ...expected].map(value => `0x${value.toString(16).padStart(4, '0')}`).join(' ');
    assert.ok(result.trace.at(-2)!.endsWith(`[${stack}] return`), result.trace.join('\n'));
  }
  for (const handler of [0x01c4, 0x01c7, 0x01d1, 0]) {
    const { result } = await runRealNative([0xbeef, 0, 0, 0, divide], checkpoint => {
      const memory = new DataView(checkpoint.physicalMemory.buffer);
      memory.setUint16(0, handler, true);
      memory.setUint16(2, handler ? 0x0192 : 0, true);
    });
    assert.equal(result.stopReason, handler ? 'Forth returned from the entry word.' : 'Forth U/MOD division by zero');
    if (handler) assert.match(result.trace.at(-2)!, /\[0xbeef 0x0000 0x0000\] return$/);
  }
});

test('HYPER .AUXSHIP renders the orbital auxiliary map when its radius is zero', async () => {
  const { engine } = await realNativeFixture();
  const auxiliaryShip = engine.get('.AUXSHIP', 'HYPER-OV');
  assert.ok(auxiliaryShip);
  const { result } = await runRealNative([0xbeef, auxiliaryShip], checkpoint => {
    const memory = new DataView(checkpoint.physicalMemory.buffer);
    const poke = (address: number, value: number) => memory.setUint16((0x0192 << 4) + address, value, true);
    for (const [address, value] of [[0x5a5c, 1], [0x5d81, 5], [0xd9dc, 0], [0x5dae, 0], [0x5db9, 0], [0x5648, 0xa000], [0x563a, 0x6000]]) poke(address, value);
    for (let row = 0; row < 200; row++) poke(0x6000 + row * 2, row * 40);
    checkpoint.ega.planes.forEach(plane => plane.fill(0));
  });
  assert.equal(result.stopReason, 'Forth returned from the entry word.', result.trace.join('\n'));
  assert.match(result.trace.at(-2)!, /\[0xbeef\] return$/);
  assert.equal(result.graphics!.pixels[161 * 320 + 120 * 2], 15);
  assert.equal(result.trace.filter(line => line.includes('unsigned divide fault recovered')).length, 2);
});

test('SQRT returns integer distances for unsigned double-cell inputs', async () => {
  const { engine } = await realNativeFixture();
  const sqrt = engine.get('SQRT', 'KERNEL');
  assert.ok(sqrt);
  for (const value of [0, 1, 2, 3, 4, 9, 25, 144, 65535, 65536, 0x7fffffff, 0xffffffff]) {
    const { result } = await runRealNative([0xbeef, value & 0xffff, value >>> 16, sqrt]);
    assert.equal(result.stopReason, 'Forth returned from the entry word.', result.trace.join('\n'));
    const expected = Math.floor(Math.sqrt(value));
    assert.ok(result.trace.at(-2)!.endsWith(`[0xbeef 0x${expected.toString(16).padStart(4, '0')}] return`), `SQRT(${value})\n${result.trace.join('\n')}`);
  }
});

test('*/ preserves a nonzero divisor through nested return-stack calls', async () => {
  const { engine } = await realNativeFixture();
  const multiplyDivide = engine.get('*/', 'KERNEL');
  assert.ok(multiplyDivide);
  for (const [left, right, divisor, expected] of [[4, 25, 10, 10], [0, 25, 10, 0], [0xfffc, 25, 10, 0xfff6]]) {
    const { result } = await runRealNative([0xbeef, left, right, divisor, multiplyDivide]);
    assert.equal(result.stopReason, 'Forth returned from the entry word.', result.trace.join('\n'));
    assert.ok(result.trace.at(-2)!.endsWith(`[0xbeef 0x${expected.toString(16).padStart(4, '0')}] return`), result.trace.join('\n'));
  }
});

test('native conversion and icon helpers use the configured tables and video word counts', () => {
  const operations: Operation[] = [
    65, 16, 'DIGIT', 71, 16, 'DIGIT',
    0x34, 0x5a02, 'C!', 0x1234, 0x3000, '!IW', 0x3000, '@IW',
    2, 0x5a4e, 'C!', 10, 20, 'SCR>BLT',
    0, 0, '?INVIS', 1, 0, '?INVIS',
    0, 0x07a4, 'C!', 0xb8, 0x07a5, 'C!',
    0, 3, 0x0741, 'VFILL', 0, 'V@', 4, 6, 2, 'VMOVE-', 6, 'V@', 4, 'V@'
  ];
  const result = createRunner(operations, new Uint8Array(), new Uint8Array()).run();
  assert.equal(result.stopReason, 'Forth returned from the entry word.');
  assert.match(result.trace.at(-2)!, /0x1234 0x0008 0x0019 0x0001 0x0000 0x0041 0x0041 0x0041\] return$/);
});

test('native memory helpers copy overlapping ranges backward and fetch banked values', () => {
  const result = createRunner([
    0x1234, 0x8000, 3, '!L', 0x80, 0x8002, 3, 'C!L',
    0x3000, 0x8000, 'L1.5@', 0x3000, 0x8002, 'L+-@',
    0x8002, 3, 'C@L',
    1, 0x6000, 'C!', 2, 0x6001, 'C!', 3, 0x6002, 'C!',
    0x6000, 0x6001, 3, 'CMOVE>',
    0x6001, 'C@', 0x6002, 'C@', 0x6003, 'C@',
    15, '2^N', 16, '2^N', 17, '2^N', 0xffff, '2^N'
  ], new Uint8Array(), new Uint8Array()).run();
  assert.equal(result.stopReason, 'Forth returned from the entry word.');
  assert.match(result.trace.at(-2)!, /0x0080 0x0001 0x0002 0x0003 0x8000 0x0000 0x0001 0x0000\] return$/);
});

test('native search helpers preserve byte matching, sliding masks and reverse color mapping', async () => {
  const { engine } = await realNativeFixture();
  const get = (name: string) => {
    const target = engine.get(name, 'KERNEL');
    assert.ok(target);
    return target;
  };
  const { result } = await runRealNative([
    0x7000, 5, 0x7100, 2, get('MATCH'),
    100, get('(SLIPPE'), 101, get('(SLIPPE'), 500, get('(SLIPPE'),
    9, get('E>CGA'), 0x17, get('E>CGA')
  ], checkpoint => {
    const base = 0x0192 << 4;
    const memory = new DataView(checkpoint.physicalMemory.buffer);
    memory.setUint16(base + 0x4c57, 100, true);
    memory.setUint16(base + 0x4c4c, 1, true);
    checkpoint.physicalMemory.fill(0, base + 0x4c5b, base + 0x4c5b + 32);
    checkpoint.physicalMemory[base + 0x4c5b + 16] = 1;
    checkpoint.physicalMemory.set([65, 66, 65, 66, 67], base + 0x7000);
    checkpoint.physicalMemory.set([66, 67], base + 0x7100);
    for (let index = 0; index < 16; index++) {
      checkpoint.physicalMemory[base + 0x4fcd + index] = index;
      checkpoint.physicalMemory[base + 0x4fbb + index] = 0x10 + index;
    }
  });
  assert.equal(result.stopReason, 'Forth returned from the entry word.', result.trace.join('\n'));
  assert.match(result.trace.at(-2)!, /\[0x0001 0x0004 0x0064 0x0001 0x0000 0x0000 0x0019 0x0017\] return$/);
});

test('compiler helpers redirect threads, GO dispatches translated entries, and arbitrary code stops explicitly', async () => {
  const { engine } = await realNativeFixture();
  const get = (name: string) => {
    const target = engine.get(name, 'KERNEL');
    assert.ok(target);
    return target;
  };
  const operations = [0xbad, 0xbad, 0xbad, 0xbad, 0xbeef];
  for (const name of ['(>CODE)', '(;VIA)']) {
    const { result } = await runRealNative([get(name), ...operations], checkpoint => {
      if (name === '(>CODE)') checkpoint.physicalMemory.set([0x0e, 0, 0xb8, 7, 0, 0x50, 0xad, 0x8b, 0xd8, 0xff, 0x27], (0x0192 << 4) + 0x1004);
      else new DataView(checkpoint.physicalMemory.buffer).setUint16((0x0192 << 4) + 0x1004, 0x1012, true);
    });
    if (name === '(>CODE)') assert.equal(result.stopReason, '(>CODE) block at 0x1006 has no TypeScript translation.');
    else {
      assert.equal(result.stopReason, 'Forth returned from the entry word.', result.trace.join('\n'));
      assert.match(result.trace.at(-2)!, /\[0xbeef\] return$/);
    }
  }
  const jump = await runRealNative([0x7000, get('GO'), 0xbeef], checkpoint => {
    checkpoint.physicalMemory.set([0xb8, 7, 0, 0x50, 0xad, 0x8b, 0xd8, 0xff, 0x27], (0x0192 << 4) + 0x7000);
  });
  assert.equal(jump.result.stopReason, 'GO target 0x7000 has no TypeScript translation.');
  const translated = await runRealNative([0xbeef, 0x4984, get('GO')]);
  assert.equal(translated.result.stopReason, 'Forth returned from the entry word.', translated.result.trace.join('\n'));
  assert.match(translated.result.trace.at(-2)!, /\[0xbef2\] return$/);
  const exit = await runRealNative([0, get('GO'), 0xbad]);
  assert.equal(exit.result.stopReason, 'The game exited to DOS.', exit.result.trace.join('\n'));
  const syscall = await runRealNative([0x0d, 0, get('SYSCALL'), get('PRTSCR'), get('XKEYINT')]);
  assert.equal(syscall.result.stopReason, 'Forth returned from the entry word.', syscall.result.trace.join('\n'));
  assert.ok(syscall.result.output.length > 0);
});

test('translated CLIPPER handles closed polygons, open lines and boundary vertices', async () => {
  const { engine } = await realNativeFixture();
  const clipper = engine.get('CLIPPER', 'KERNEL');
  assert.ok(clipper);
  const cases = [
    { vertices: [-5, -5, -5, 15, 15, 15, 15, -5], open: 0, expected: ['0,0', '0,10', '10,0', '10,10'] },
    { vertices: [-5, 0, -5, 10, 5, 10, 5, 0], open: 0, expected: ['0,0', '0,10', '5,0', '5,10'] },
    { vertices: [-5, 5, 15, 5], open: 1, expected: ['0,5', '10,5'] },
    { vertices: [1, 1, 1, 9, 9, 9, 9, 1], open: 0, expected: ['1,1', '1,9', '9,1', '9,9'] },
    { vertices: [20, 20, 20, 30, 30, 30, 30, 20], open: 0, expected: [] }
  ];
  for (const { vertices, open, expected } of cases) {
  const { runner, result } = await runRealNative([0xbeef, clipper], checkpoint => {
    const memory = new DataView(checkpoint.physicalMemory.buffer);
    const poke = (address: number, value: number) => memory.setUint16((0x0192 << 4) + address, value & 0xffff, true);
    for (const [address, value] of [[0x569b, 0x7000], [0x56a6, 0x7100], [0x56b0, 0x7200], [0x56bb, 0x7300],
      [0x5686, vertices.length / 2], [0x56f4, open], [0x5738, 0], [0x5745, 10], [0x5752, 0], [0x575f, 10]]) poke(address, value);
    for (let side = 0; side < 4; side++) {
      const mask = checkpoint.physicalMemory[(0x0192 << 4) + 0x5253 + side * 5];
      poke(0x5253 + side * 5 + 3, mask & 0x0a ? 10 : 0);
    }
    vertices.forEach((value, index) => poke(0x7000 + index * 2, value));
  });
  assert.equal(result.stopReason, 'Forth returned from the entry word.', result.trace.join('\n'));
  const memory = new DataView(runner.saveState().physicalMemory.buffer);
  const base = 0x0192 << 4;
  const count = memory.getUint16(base + 0x5686, true);
  const vertex = memory.getUint16(base + 0x569b, true);
  assert.equal(count, expected.length);
  const corners = Array.from({ length: count }, (_, index) => [memory.getInt16(base + vertex + index * 4, true), memory.getInt16(base + vertex + index * 4 + 2, true)]);
  assert.deepEqual(corners.map(corner => corner.join(',')).sort(), expected.toSorted());
  }
});

test('native overlay routines scale bytes, configure blits, copy regions and decode CGA runs', async () => {
  const { engine } = await realNativeFixture();
  const get = (cfa: number, module: string) => {
    const target = engine.get(cfa, module);
    assert.ok(target, `${module}:${cfa.toString(16)}`);
    return target;
  };
  const orbit = await runRealNative([0xbeef, 0xfff4, 4, 3, get(0xdf11, 'ORBIT-OV'), get(0xdf00, 'ORBIT-OV')]);
  assert.equal(orbit.result.stopReason, 'Forth returned from the entry word.', orbit.result.trace.join('\n'));
  assert.match(orbit.result.trace.at(-2)!, /\[0xbeef 0xfff0\] return$/);
  const orbitState = orbit.runner.saveState();
  assert.equal(new DataView(orbitState.physicalMemory.buffer).getUint16((0x0192 << 4) + 0xdc20, true), orbitState.session.stackPointer);
  for (const [module, cfa, bitmap] of [['MOVE-OV', 0xe8f1, 0xe8e5], ['MAPS-OV', 0xefd7, 0xefcb]] as const) {
    const blit = await runRealNative([0xbeef, 10, 20, get(cfa, module)]);
    assert.equal(blit.result.stopReason, 'Forth returned from the entry word.', blit.result.trace.join('\n'));
    const memory = new DataView(blit.runner.saveState().physicalMemory.buffer);
    for (const [address, value] of [[0x586e, 16], [0x5863, 23], [0x5892, 4], [0x5887, 6], [0x589d, bitmap], [0x58aa, 0x0192]]) {
      assert.equal(memory.getUint16((0x0192 << 4) + address, true), value);
    }
  }
  for (const [module, cfa] of [['SITE-OV', 0xf04e], ['PORTMENU-OV', 0xec0a]] as const) {
    const region = await runRealNative([0xbeef, 0x4000, 0, get(cfa, module)], checkpoint => {
      const memory = new DataView(checkpoint.physicalMemory.buffer);
      for (const [address, value] of [[0x5648, 0x3000], [0x563a, 0x6000], [0x5892, 0], [0x586e, 4], [0x5863, 4], [0x5887, 2], [0x6006, 120], [0x6008, 160]]) {
        memory.setUint16((0x0192 << 4) + address, value, true);
      }
      checkpoint.physicalMemory.set([1, 2, 3, 4], 0x30000 + 122);
      checkpoint.physicalMemory.set([5, 6, 7, 8], 0x30000 + 162);
    });
    assert.equal(region.result.stopReason, 'Forth returned from the entry word.', region.result.trace.join('\n'));
    assert.deepEqual([...region.runner.readMemory(0x4000, 0, 8)], [1, 2, 3, 4, 5, 6, 7, 8]);
  }
  const run = await runRealNative([0xbeef, 0x5000, 0x7000, get(0xf21e, 'BLT-OV')], checkpoint => {
    const memory = new DataView(checkpoint.physicalMemory.buffer);
    for (const [address, value] of [[0x5648, 0x3000], [0x563a, 0x6000], [0x6000, 0], [0x586e, 0], [0x5863, 0], [0x5892, 4], [0x55f2, 0x99]]) {
      memory.setUint16((0x0192 << 4) + address, value, true);
    }
    checkpoint.physicalMemory.set([1, 0, 3], 0x50000 + 0x7000);
  });
  assert.equal(run.result.stopReason, 'Forth returned from the entry word.', run.result.trace.join('\n'));
  assert.deepEqual([...run.runner.readMemory(0x3000, 0, 2)], [0x99, 0x90]);
});

test('native context save/load restores the data stack and RETJMP resumes the saved thread', async () => {
  const { engine } = await realNativeFixture();
  const get = (cfa: number) => {
    const target = engine.get(cfa, 'GAME-OV');
    assert.ok(target);
    return target;
  };
  const data = await runRealNative([0xbeef, 0x7000, get(0xeb48), 0xcafe, 0x7000, get(0xeb70)], checkpoint => {
    new DataView(checkpoint.physicalMemory.buffer).setUint16((0x0192 << 4) + 0xde72, 0, true);
  });
  assert.equal(data.result.stopReason, 'Forth returned from the entry word.', data.result.trace.join('\n'));
  assert.match(data.result.trace.at(-2)!, /\[0xbeef\] return$/);
  const saved = await runRealNative([0xbeef, 0x7000, get(0xeba8)]);
  assert.equal(saved.result.stopReason, 'Forth returned from the entry word.', saved.result.trace.join('\n'));
  const jumped = await runRealNative([0xbeef, 0x7000, get(0xebd0), 0xbad], checkpoint => {
    const memory = new DataView(checkpoint.physicalMemory.buffer);
    const returnBase = memory.getUint16((0x0192 << 4) + 0x078e, true);
    memory.setUint16((0x0192 << 4) + 0xde6e, 0, true);
    memory.setUint16((0x0192 << 4) + 0x7000, returnBase - 2, true);
    memory.setUint16((0x0192 << 4) + 0x7002 + 218, 0x1010, true);
  });
  assert.equal(jumped.result.stopReason, 'Forth returned from the entry word.', jumped.result.trace.join('\n'));
  assert.match(jumped.result.trace.at(-2)!, /\[0xbeef\] return$/);
});

test('native site EGA transfer copies all four planes in both directions', async () => {
  const { engine } = await realNativeFixture();
  const target = engine.get(0xf0bf, 'SITE-OV');
  assert.ok(target);
  for (const direction of [0, 1]) {
    const { runner, result } = await runRealNative([0xbeef, direction, target], checkpoint => {
      const memory = new DataView(checkpoint.physicalMemory.buffer);
      for (const [address, value] of [[0x55e6, 0xa000], [0x55d8, 0xa200], [0x563a, 0x6000], [0x6000 + 197 * 2, 0x200]]) {
        memory.setUint16((0x0192 << 4) + address, value, true);
      }
      checkpoint.ega.planes.forEach((plane, index) => {
        plane.fill(0);
        plane.fill(0x31 + index, (direction ? 0x2000 : 0) + 0x200, (direction ? 0x2000 : 0) + 0x200 + 0xa28);
      });
    });
    assert.equal(result.stopReason, 'Forth returned from the entry word.', result.trace.join('\n'));
    runner.saveState().ega.planes.forEach((plane, index) => {
      const offset = (direction ? 0 : 0x2000) + 0x200;
      assert.ok(plane.subarray(offset, offset + 0xa28).every(value => value === 0x31 + index));
    });
  }
});

test('native EGA routines plot, XOR, read pixels, fill tiles and compute extents', async () => {
  const { engine } = await realNativeFixture();
  const find = (name: string) => {
    const target = engine.get(name, 'KERNEL');
    assert.ok(target, name);
    return target;
  };
  const setup = (checkpoint: ReturnType<ForthBootRunner['saveState']>) => {
    const memory = new DataView(checkpoint.physicalMemory.buffer);
    const poke = (address: number, value: number) => memory.setUint16((0x0192 << 4) + address, value, true);
    for (const plane of checkpoint.ega.planes) plane.fill(0);
    for (const [address, value] of [[0x5648, 0xa000], [0x563a, 0x6000], [0x55f2, 9], [0x5745, 159],
      [0x58cd, 0x6a3f], [0x6a3f, 9], [0x5a79, 4], [0x5a86, 1], [0x5a93, 1], [0x5a65, 20], [0x5a6e, 30]]) poke(address, value);
    for (let row = 0; row < 200; row++) poke(0x6000 + row * 2, row * 40);
  };
  const { runner, result } = await runRealNative([
    0xbeef, 8, 10, find('SQLPLOT'), 8, 10, find('L@PIXEL'),
    12, 20, 2, 4, find('TILEFILL'), find('EEXTENT')
  ], setup);
  assert.equal(result.stopReason, 'Forth returned from the entry word.', result.trace.join('\n'));
  assert.match(result.trace.at(-2)!, /\[0xbeef 0x0009 0x0010 0x001a 0x0018 0x0022\] return$/);
  const pixel = (x: number, y: number) => result.graphics!.pixels[y * 320 + x * 2];
  assert.deepEqual([pixel(8, 10), pixel(8, 11), pixel(8, 12)], [9, 9, 0]);
  assert.deepEqual([pixel(11, 19), pixel(12, 19), pixel(15, 20), pixel(16, 20)], [0, 9, 9, 0]);
  assert.equal(runner.saveState().ega.graphics[1], 15);
  const xor = await runRealNative([8, 10, find('LXPLOT'), 8, 10, find('LXPLOT'), 8, 10, find('L@PIXEL')], setup);
  assert.equal(xor.result.stopReason, 'Forth returned from the entry word.', xor.result.trace.join('\n'));
  assert.match(xor.result.trace.at(-2)!, /\[0x0000\] return$/);
  const arc = await runRealNative([find('ARC')], checkpoint => {
    setup(checkpoint);
    new DataView(checkpoint.physicalMemory.buffer).setUint16((0x0192 << 4) + 0x5aa0, 0x0b20, true);
  });
  assert.equal(arc.result.stopReason, 'Forth returned from the entry word.', arc.result.trace.join('\n'));
  assert.ok(arc.result.graphics!.pixels.some(color => color === 9));
});

test('translated ARC handles four/eight-way plotting and scanline helpers', async () => {
  const { engine } = await realNativeFixture();
  const arc = engine.get('ARC', 'KERNEL');
  assert.ok(arc);
  for (const helper of [0x0b20, 0x0c01, 0x0b53, 0x0be7]) {
    const { runner, result } = await runRealNative([arc], checkpoint => {
      const memory = new DataView(checkpoint.physicalMemory.buffer);
      const poke = (address: number, value: number) => memory.setUint16((0x0192 << 4) + address, value, true);
      checkpoint.ega.planes.forEach(plane => plane.fill(0));
      for (const [address, value] of [[0x5648, 0xa000], [0x563a, 0x6000], [0x55f2, 9], [0x5738, 0], [0x5745, 159],
        [0x5752, 0], [0x575f, 199], [0x5a79, 4], [0x5a86, 1], [0x5a93, 1], [0x5a65, 20], [0x5a6e, 30], [0x5aa0, helper],
        [0x57d9, 0x7000]]) poke(address, value);
      for (let row = 0; row < 200; row++) { poke(0x6000 + row * 2, row * 40); poke(0x7000 + row * 2, 0xffff); }
    });
    assert.equal(result.stopReason, 'Forth returned from the entry word.', result.trace.join('\n'));
    if (helper === 0x0b20 || helper === 0x0c01) {
      assert.equal(result.graphics!.pixels[34 * 320 + 20 * 2], 9);
      assert.equal(result.graphics!.pixels[30 * 320 + 24 * 2], helper === 0x0c01 ? 9 : 0);
    } else {
      const memory = new DataView(runner.saveState().physicalMemory.buffer);
      assert.equal(memory.getUint16((0x0192 << 4) + 0x7000 + 34 * 2, true), 0x1513);
      assert.equal(memory.getUint16((0x0192 << 4) + 0x7000 + 30 * 2, true), helper === 0x0be7 ? 0x1810 : 0xffff);
      assert.ok(result.graphics!.pixels.every(color => color === 0));
    }
  }
});

test('RP@ exposes return-stack memory and writes through ! affect R>', async () => {
  const { engine } = await realNativeFixture();
  const find = (name: string) => {
    const target = engine.get(name, 'KERNEL');
    assert.ok(target);
    return target;
  };
  const { result } = await runRealNative([0xaaaa, find('>R'), 0xbbbb, find('RP@'), find('!'), find('R>')]);
  assert.equal(result.stopReason, 'Forth returned from the entry word.', result.trace.join('\n'));
  assert.match(result.trace.at(-2)!, /\[0xbbbb\] return$/);
});

test('native kernel routines execute from real images with register and stack effects', async () => {
  const { engine } = await realNativeFixture();
  const find = (name: string) => {
    const target = engine.get(name, 'KERNEL');
    assert.ok(target, name);
    return target;
  };
  const { runner, result } = await runRealNative([
    0xbeef, 0x1234, 1, find('SHL-BIT'), 10, 20, 1, 2, find('BUFFERX'),
    0, find('COLORMA'), find('SETCOLO'), find('S/RON'), find('RP@'),
    find('@'), 0x55, 0x123, find('P!'), 0x123, find('P@')
  ], checkpoint => {
    const memory = new DataView(checkpoint.physicalMemory.buffer);
    for (const address of [0x4e53, 0x4e49, 0x596b, 0x595d]) memory.setUint16((0x0192 << 4) + address, 0, true);
    checkpoint.physicalMemory[(0x0192 << 4) + 0x6a3f] = 9;
    checkpoint.physicalMemory[(0x0192 << 4) + 0x6a41] = 7;
  });
  assert.equal(result.stopReason, 'Forth returned from the entry word.', result.trace.join('\n'));
  assert.match(result.trace.at(-2)!, /\[0xbeef 0x2469 0x0014 0x0053 0x[0-9a-f]{4} 0x0055\] return$/);
  const ega = runner.saveState().ega;
  assert.equal(ega.graphics[0], 9);
  assert.equal(ega.graphics[1], 15);
});

test('basic native helpers preserve wrapping and banked memory semantics', () => {
  const result = createRunner([
    0xffff, '4*', '3+',
    0xabcd, 0x1234, 0x13, '!L', 0x1234, 3, '@L',
    0x55, 0x6000, 'C!', 0x6000, 0xffaa, 'TOGGLE', 0x6000, 'C@'
  ], new Uint8Array(), new Uint8Array()).run();
  assert.equal(result.stopReason, 'Forth returned from the entry word.');
  assert.match(result.trace.at(-2)!, /\[0xffff 0xabcd 0x00ff\] return$/);
});

test('?IID filters icon IDs with exclusive bounds, descending indices and native signed branches', () => {
  const cases = [
    { lower: 10, upper: 20, start: 2, count: 6, icons: [[2, 9], [3, 10], [4, 11], [5, 19], [6, 20], [7, 21]], expected: [5, 4, 2] },
    { lower: 0xffff, upper: 256, start: 0, count: 2, icons: [[0, 0], [1, 255]], expected: [1, 0, 2] },
    { lower: 10, upper: 20, start: 0xffff, count: 2, icons: [[0xffff, 16], [0, 15]], expected: [0, 0xffff, 2] },
    { lower: 0xffff, upper: 0x8000, start: 0, count: 1, icons: [[0, 0]], expected: [0, 1] },
    { lower: 0xffff, upper: 0x8100, start: 0, count: 1, icons: [[0, 0]], expected: [0] },
    { lower: 0, upper: 20, start: 5, count: 0, icons: [], expected: [0] },
    { lower: 0, upper: 20, start: 5, count: 0xffff, icons: [], expected: [0] }
  ];
  for (const { lower, upper, start, count, icons, expected } of cases) {
    const runner = createRunner([0xbeef, lower, upper, start, count, '?IID'], new Uint8Array(), new Uint8Array());
    runner.start();
    const checkpoint = runner.saveState();
    new DataView(checkpoint.physicalMemory.buffer).setUint16((0x0192 << 4) + 0x59c6, 0x3000, true);
    for (const [index, id] of icons) checkpoint.physicalMemory[(0x3000 << 4) + index] = id;
    runner.loadState(checkpoint);
    runner.advance(100);
    const result = runner.snapshot();
    assert.equal(result.stopReason, 'Forth returned from the entry word.', result.trace.join('\n'));
    const stack = [0xbeef, ...expected].map(cell => `0x${cell.toString(16).padStart(4, '0')}`).join(' ');
    assert.ok(result.trace.at(-2)!.endsWith(`[${stack}] return`), result.trace.join('\n'));
    const memory = new DataView(runner.saveState().physicalMemory.buffer);
    assert.equal(memory.getUint16((0x0192 << 4) + 0x5b04, true), start);
    assert.equal(memory.getUint16((0x0192 << 4) + 0x48c8, true), lower);
  }
});

test('XCHGICON swaps all six icon tables with word-index wrapping and no adjacent changes', () => {
  const tables = [[0x59c6, 1], [0x59ca, 1], [0x59da, 1], [0x59be, 2], [0x59c2, 2], [0x59ce, 2]];
  for (const [first, second] of [[2, 5], [3, 3], [0xffff, 0x8001]]) {
    const runner = createRunner([0xbeef, first, second, 'XCHGICON'], new Uint8Array(), new Uint8Array());
    runner.start();
    const checkpoint = runner.saveState();
    const memory = new DataView(checkpoint.physicalMemory.buffer);
    const expected = tables.map(([segmentCell, size], tableIndex) => {
      const segment = 0x3000 + tableIndex * 0x1000;
      memory.setUint16((0x0192 << 4) + segmentCell, segment, true);
      const bytes = Uint8Array.from({ length: 0x10000 }, (_, offset) => (offset * 17 + (offset >>> 8) + tableIndex * 29) & 0xff);
      checkpoint.physicalMemory.set(bytes, segment << 4);
      for (let byte = 0; byte < size; byte++) {
        const firstOffset = ((first * size) & 0xffff) + byte;
        const secondOffset = ((second * size) & 0xffff) + byte;
        const value = bytes[firstOffset];
        bytes[firstOffset] = bytes[secondOffset];
        bytes[secondOffset] = value;
      }
      return { segment, bytes };
    });
    runner.loadState(checkpoint);
    runner.advance(100);
    const result = runner.snapshot();
    assert.equal(result.stopReason, 'Forth returned from the entry word.', result.trace.join('\n'));
    assert.match(result.trace.at(-2)!, /\[0xbeef\] return$/);
    const restoredMemory = runner.saveState().physicalMemory;
    for (const { segment, bytes } of expected) {
      assert.deepEqual(restoredMemory.subarray(segment << 4, (segment << 4) + 0x10000), bytes);
    }
  }
});

test('?ILOCUS finds descending icon indices with inclusive signed 16-bit bounds', () => {
  const cases = [
    { center: [10, 20], radius: 3, start: 2, count: 4, icons: [[2, 10, 20], [3, 10, 24], [4, 14, 20], [5, 13, 17]], expected: [5, 2, 2] },
    { center: [0xffff, 0xffff], radius: 1, start: 0, count: 2, icons: [[0, 0, 0], [1, 0xfffe, 0xfffe]], expected: [1, 0, 2] },
    { center: [0, 0], radius: 0, start: 0x7fff, count: 2, icons: [[0, 0, 0], [0x7fff, 0, 0]], expected: [0, 0x7fff, 2] },
    { center: [0, 0], radius: 0, start: 0, count: 1, icons: [[0, 0x8000, 0x8000]], expected: [0, 1] },
    { center: [0, 0], radius: 0xffff, start: 0, count: 1, icons: [[0, 0, 0]], expected: [0] },
    { center: [0, 0], radius: 0, start: 0, count: 0, icons: [], expected: [0] },
    { center: [0, 0], radius: 0, start: 0, count: 0xffff, icons: [], expected: [0] }
  ];
  for (const { center, radius, start, count, icons, expected } of cases) {
    const runner = createRunner([0xbeef, ...center, radius, start, count, '?ILOCUS'], new Uint8Array(), new Uint8Array());
    runner.start();
    const checkpoint = runner.saveState();
    const pokeWord = (segment: number, offset: number, value: number) => {
      const address = (segment << 4) + (offset & 0xffff);
      checkpoint.physicalMemory[address] = value & 0xff;
      checkpoint.physicalMemory[address + 1] = value >>> 8;
    };
    pokeWord(0x0192, 0x59be, 0x3000);
    pokeWord(0x0192, 0x59c2, 0x4000);
    for (const [index, horizontal, vertical] of icons) {
      pokeWord(0x3000, index * 2, horizontal);
      pokeWord(0x4000, index * 2, vertical);
    }
    runner.loadState(checkpoint);
    runner.advance(100);
    const result = runner.snapshot();
    assert.equal(result.stopReason, 'Forth returned from the entry word.', result.trace.join('\n'));
    const stack = [0xbeef, ...expected].map(cell => `0x${cell.toString(16).padStart(4, '0')}`).join(' ');
    assert.ok(result.trace.at(-2)!.endsWith(`[${stack}] return`), result.trace.join('\n'));
    const memory = new DataView(runner.saveState().physicalMemory.buffer);
    for (const [address, value] of [[0x5af8, center[0]], [0x5afc, center[1]], [0x5b00, radius], [0x5b04, start]]) {
      assert.equal(memory.getUint16((0x0192 << 4) + address, true), value);
    }
  }
});

test('D2* shifts a double cell with carry, overflow and stack preservation', () => {
  const cases = [
    [0, 0], [1, 0], [0x7fff, 0], [0x8000, 0], [0xffff, 0],
    [0, 0x8000], [0xffff, 0xffff], [0x1234, 0xabcd], [0x8001, 0x7fff]
  ];
  for (const [low, high] of cases) {
    const doubled = (((BigInt(high) << 16n) | BigInt(low)) << 1n) & 0xffffffffn;
    const expected = [Number(doubled & 0xffffn), Number(doubled >> 16n)];
    const result = createRunner([0xbeef, low, high, 'D2*'], new Uint8Array(), new Uint8Array()).run();
    assert.equal(result.stopReason, 'Forth returned from the entry word.', result.trace.join('\n'));
    const stack = [0xbeef, ...expected].map(cell => `0x${cell.toString(16).padStart(4, '0')}`).join(' ');
    assert.ok(result.trace.at(-2)!.endsWith(`[${stack}] return`), result.trace.join('\n'));
  }
});

test('EASY-BITS follows the native shifts, sign-bit branch and 16-bit loop count', () => {
  const cases = [
    { input: [0, 0, 1, 1], expected: [0, 0, 1] },
    { input: [0xc000, 0, 1, 1], expected: [0, 2, 5] },
    { input: [0x8000, 0, 3, 1], expected: [0, 2, 5] },
    { input: [0xffff, 0xffff, 0xffff, 1], expected: [0xfffc, 0, 1] },
    { input: [0, 0x2000, 1, 1], expected: [0, 0x7fff, 5] },
    { input: [0, 0x4000, 0, 1], expected: [0, 0, 3] },
    { input: [0xffff, 0, 1, 2], expected: [0xfff0, 6, 13] },
    { input: [0xffff, 0, 1, 8], expected: [0, 510, 1021] },
    { input: [0, 0, 1, 0], expected: [0, 0, 1] }
  ];
  for (const { input, expected } of cases) {
    const result = createRunner([0xbeef, ...input, 'EASY-BITS'], new Uint8Array(), new Uint8Array()).run();
    assert.equal(result.stopReason, 'Forth returned from the entry word.', result.trace.join('\n'));
    const stack = [0xbeef, ...expected].map(cell => `0x${cell.toString(16).padStart(4, '0')}`).join(' ');
    assert.ok(result.trace.at(-2)!.endsWith(`[${stack}] return`), result.trace.join('\n'));
    assert.ok(result.trace.some(line => line.endsWith(`square-root steps: ${input[3] || 0x10000}`)));
  }
});

test('headerless 0x9a80 fetches the unsigned icon byte without scaling its index', async () => {
  const target = word('W_0x9a80', 0x9a80, 0x9a82);
  for (const [segment, index, value] of [[0x3000, 8, 0x80], [0x0192, 0x8000, 0xab], [0x4000, 0xffff, 0xff], [0xffff, 0x10, 0]]) {
    const address = ((segment << 4) + index) & 0xfffff;
    const { runner, result } = await runRealNative([0xbeef, segment, target], checkpoint => {
      new DataView(checkpoint.physicalMemory.buffer).setUint16((0x0192 << 4) + 0x5a02, index, true);
      checkpoint.physicalMemory[address] = value;
      checkpoint.physicalMemory[(address + 1) & 0xfffff] = 0xcd;
    });
    assert.equal(result.stopReason, 'Forth returned from the entry word.', result.trace.join('\n'));
    assert.ok(result.trace.at(-2)!.endsWith(`[0xbeef 0x${value.toString(16).padStart(4, '0')}] return`), result.trace.join('\n'));
    const memory = runner.saveState().physicalMemory;
    assert.equal(memory[address], value);
    assert.equal(memory[(address + 1) & 0xfffff], 0xcd);
  }
});

test('FRACT-OV headerless 0xe76e fills the current \'ARRAY buffer with the low byte', async () => {
  const target = { ...word('W_0xe76e', 0xe76e, 0xe770), module: 'FRACT-OV' };
  const { runner, result } = await runRealNative([0xbeef, 0x12a5, target], checkpoint => {
    const memory = new DataView(checkpoint.physicalMemory.buffer);
    memory.setUint16((0x0192 << 4) + 0x4cf1, 0x6000, true);
    memory.setUint16((0x0192 << 4) + 0x6004, 5, true);
    memory.setUint16((0x0192 << 4) + 0x6006, 0x3000, true);
    checkpoint.physicalMemory.fill(0x11, 0x30000, 0x30008);
  });
  assert.equal(result.stopReason, 'Forth returned from the entry word.', result.trace.join('\n'));
  assert.ok(result.trace.at(-2)!.endsWith('[0xbeef] return'), result.trace.join('\n'));
  assert.deepEqual([...runner.readMemory(0x3000, 0, 7)], [0xa5, 0xa5, 0xa5, 0xa5, 0xa5, 0x11, 0x11]);
});

test('FRACT-OV headerless 0xe535 stores only into empty cells, wrapping coordinates over the poles', async () => {
  const target = { ...word('W_0xe535', 0xe535, 0xe537), module: 'FRACT-OV' };
  // An 8x4 'ARRAY at 3000:0000 with its row table at 3000:0040; cells hold 80h except offset 3.
  const cases = [
    { x: 0xffff, y: 1, wrap: 1, signed: 1, offset: 15 }, // x wraps around to the last column
    { x: 2, y: 0xffff, wrap: 1, signed: 1, offset: 6 }, // y reflects at the top pole, x shifts by half the width
    { x: 5, y: 6, wrap: 1, signed: 1, offset: 24 + 1 }, // y reflects at the bottom pole (2h - y + 1), x wraps after the shift
    { x: 3, y: 0, wrap: 0, signed: 1, offset: 3, unchanged: 0x11 }, // occupied cell
    { x: 4, y: 2, wrap: 0, signed: 0, offset: 20, unchanged: 0x80 } // unsigned mode never matches FF80h
  ];
  for (const { x, y, wrap, signed, offset, unchanged } of cases) {
    const { runner, result } = await runRealNative([0xbeef, 0x55, x, y, target], checkpoint => {
      const memory = new DataView(checkpoint.physicalMemory.buffer);
      for (const [address, value] of [[0x4cf1, 0x6000], [0x6000, 8], [0x6002, 4], [0x6004, 0x40], [0x6006, 0x3000], [0x4cca, wrap], [0x4cd8, signed]]) {
        memory.setUint16((0x0192 << 4) + address, value, true);
      }
      checkpoint.physicalMemory.fill(0x80, 0x30000, 0x30020);
      checkpoint.physicalMemory[0x30003] = 0x11;
      for (let row = 0; row < 4; row++) memory.setUint16(0x30040 + row * 2, row * 8, true);
    });
    assert.equal(result.stopReason, 'Forth returned from the entry word.', result.trace.join('\n'));
    assert.ok(result.trace.at(-2)!.endsWith('[0xbeef] return'), result.trace.join('\n'));
    const cells = [...runner.readMemory(0x3000, 0, 0x20)];
    assert.equal(cells[offset], unchanged ?? 0x55, `${x},${y}`);
    assert.equal(cells.filter(cell => cell === 0x55).length, unchanged === undefined ? 1 : 0);
    const memory = new DataView(runner.saveState().physicalMemory.buffer);
    assert.deepEqual([memory.getUint16((0x0192 << 4) + 0xe378, true), memory.getUint16((0x0192 << 4) + 0xe37c, true)], [0x3000, offset]);
  }
});

const overlayCode = (module: string, cfa: number): ForthWord => ({ ...word(`W_0x${cfa.toString(16)}`, cfa, cfa + 2), module });
const finalStack = (result: { trace: string[] }) => result.trace.at(-2)!.match(/\[([^\]]*)\] return$/)![1];
const setWords = (checkpoint: ReturnType<ForthBootRunner['saveState']>, cells: [number, number][]) => {
  const memory = new DataView(checkpoint.physicalMemory.buffer);
  for (const [address, value] of cells) memory.setUint16((0x0192 << 4) + address, value, true);
};
const readWords = (runner: ForthBootRunner, address: number, count: number) => {
  const memory = new DataView(runner.saveState().physicalMemory.buffer);
  return Array.from({ length: count }, (_, index) => memory.getUint16((0x0192 << 4) + address + index * 2, true));
};

test('FRACT-OV headerless frame, local and record words address the data stack and 5-byte records', async () => {
  const fract = (cfa: number) => overlayCode('FRACT-OV', cfa);
  const frame = await runRealNative([0xbeef, 10, 20, 30, fract(0xeacf), 2, fract(0xeae8), 99, 4, fract(0xeaf6)]);
  assert.equal(frame.result.stopReason, 'Forth returned from the entry word.', frame.result.trace.join('\n'));
  assert.equal(finalStack(frame.result), '0xbeef 0x0063 0x0014 0x001e 0x0014');
  const dropped = await runRealNative([0xbeef, 1, 2, 3, 4, 5, 6, 7, fract(0xeada), 0, fract(0xeae8)]);
  assert.equal(finalStack(dropped.result), '0xbeef 0xbeef');

  const locals = [0xbeef, 3, fract(0xed32), 7, 1, fract(0xed60), 9, 0, fract(0xed60), 5, 2, fract(0xed60), 1, fract(0xed4e), 0, fract(0xed4e)];
  const fetched = await runRealNative(locals);
  assert.equal(fetched.result.stopReason, 'Forth returned from the entry word.', fetched.result.trace.join('\n'));
  assert.equal(finalStack(fetched.result), '0xbeef 0x0009 0x0007 0x0005 0x0007 0x0009');
  const freed = await runRealNative([...locals, fract(0xeec0), 2, fract(0xed42)]);
  assert.equal(finalStack(freed.result), '0xbeef');

  const compared = await runRealNative([0xbeef, 0x1234, fract(0xeeca), 5, fract(0xeeca), fract(0xeee3)], checkpoint => setWords(checkpoint, [[0xed81, 0x1234]]));
  assert.equal(finalStack(compared.result), '0xbeef 0x1234 0x0001 0x0005 0x0000 0x0000 0x0404 0x1234');

  for (const ega of [1, 0]) {
    const record = await runRealNative([0xbeef, 0x10, fract(0xee63), fract(0xee94)], checkpoint => {
      setWords(checkpoint, [[0x5da3, ega], [0x52b3, 0x3000], [0x55d8, 0x3100], [0x5144, 0x4000], [0xed7d, 0x20]]);
      checkpoint.physicalMemory.set([0xaa, 0x34, 0x12, 0x78, 0x56], (ega ? 0x30000 : 0x31000) + 0x10);
    });
    assert.equal(record.result.stopReason, 'Forth returned from the entry word.', record.result.trace.join('\n'));
    assert.ok(record.result.trace.some(line => line.includes('[0xbeef 0x1234 0x5678 0x00aa]')), record.result.trace.join('\n'));
    assert.equal(finalStack(record.result), '0xbeef');
    assert.deepEqual([...record.runner.readMemory(0x4000, 0x20, 5)], [0xaa, 0x34, 0x12, 0x78, 0x56]);
    assert.deepEqual(readWords(record.runner, 0xed7d, 1), [0x25]);
  }
});

test('FRACT-OV headerless 0xe75c fills edge midpoints and the centre with displaced averages', async () => {
  // A 3x3 signed 'ARRAY at 3000:0000 (rows at 0, 3, 6) with its corners set and the rest unset (80h).
  const corners: Record<number, number> = { 0: 10, 2: 20, 6: 0xf6, 8: 30 };
  const { runner, result } = await runRealNative([0xbeef, 8, 0, 0, 0, 0, 2, 2, overlayCode('FRACT-OV', 0xe75c)], checkpoint => {
    setWords(checkpoint, [[0x4cf1, 0x6000], [0x6000, 3], [0x6002, 3], [0x6004, 0x40], [0x6006, 0x3000], [0x4cca, 0], [0x4cd8, 1],
      [0xe356, 0], [0x4ab0, 0x1234], [0xe360, 1], [0xe35e, 2]]);
    checkpoint.physicalMemory.fill(0x80, 0x30000, 0x30009);
    for (const [offset, value] of Object.entries(corners)) checkpoint.physicalMemory[0x30000 + Number(offset)] = value;
    checkpoint.physicalMemory.set([0, 0, 3, 0, 6, 0], 0x30040);
  });
  assert.equal(result.stopReason, 'Forth returned from the entry word.', result.trace.join('\n'));
  assert.equal(finalStack(result), '0xbeef');

  let seed = 0x1234;
  const signed = (value: number) => (value << 16) >> 16;
  const displace = (average: number) => {
    seed = (Math.imul(signed(seed), 0x7abd) + 0x1b0f) & 0xffff;
    const offset = signed((Math.floor(seed * 16 / 0x10000) - 8) & 0xffff);
    return Math.max(-127, Math.min(127, average + offset));
  };
  const left = displace(0), right = displace(25), top = displace(15), bottom = displace(10); // (0+-10)/2, (20+30)/2, ...
  const centre = displace((top + bottom + left + right) >> 2);
  const cells = [...runner.readMemory(0x3000, 0, 9)].map(value => (value << 24) >> 24);
  assert.deepEqual(cells, [10, top, 20, left, centre, right, -10, bottom, 30]);
  assert.equal(readWords(runner, 0x4ab0, 1)[0], seed);
});

test('ORBIT-OV headerless point routines interpolate, translate, rotate, project and store pairs', async () => {
  const orbit = (cfa: number) => overlayCode('ORBIT-OV', cfa);
  const quad: [number, number][] = [0, 40, 80, 120, 160, 200, 240, 280].map((value, index) => [0x6100 + index * 2, value]);
  for (const [u, v, expected] of [[3, 0, '0x00dc 0x00b4'], [2, 1, '0x00c8 0x00a0']] as const) {
    const interpolated = await runRealNative([0xbeef, u, v, orbit(0xdd2a)], checkpoint => setWords(checkpoint, [[0xdc20, 0x6100], ...quad]));
    assert.equal(interpolated.result.stopReason, 'Forth returned from the entry word.', interpolated.result.trace.join('\n'));
    assert.equal(finalStack(interpolated.result), `0xbeef ${expected}`);
  }

  const points = await runRealNative([0xbeef, orbit(0xe169), orbit(0xe1b4)], checkpoint => {
    setWords(checkpoint, [[0x5dd3, 0x3000], [0x569b, 0x10], [0x5dde, 0x40], [0x5686, 2], [0x56a6, 0x80]]);
    const base = 0x0192 << 4;
    checkpoint.physicalMemory.set([1], base + 0xdbd4);
    checkpoint.physicalMemory.set([2], base + 0xdbd8);
    checkpoint.physicalMemory.set([3], base + 0xdbdc);
    checkpoint.physicalMemory.set([2, 4, 2, 0x81, 2, 4], 0x30010); // translated to (1, 2, -1) and (-128, 0, 1)
    checkpoint.physicalMemory.set([2, 0, 0, 0, 0, 0, 100, 0, 0, 0, 1, 0, 0xff, 0, 0, 0, 1, 0, 1, 0, 1, 0, 0xf0, 0xff], base + 0xdcc2);
  });
  assert.equal(points.result.stopReason, 'Forth returned from the entry word.', points.result.trace.join('\n'));
  assert.deepEqual([...points.runner.readMemory(0x3000, 0x40, 6)], [1, 2, 0xff, 0x80, 0, 1]);
  const records = new DataView(Uint8Array.from(points.runner.readMemory(0x3000, 0x80, 12)).buffer);
  assert.deepEqual(Array.from({ length: 6 }, (_, index) => records.getInt16(index * 2, true)), [102, 3, -14, -156, -1, -143]);

  const project = (depth: number, handler = true) => runRealNative([0xbeef, orbit(0xe226)], checkpoint => {
    setWords(checkpoint, [[0x5dd3, 0x3000], [0x56a6, 0x80], [0x5686, 2], [0xdc10, 3], [0xdc14, 4], [0x5dfa, 160], [0x5dec, 100]]);
    checkpoint.physicalMemory.set(handler ? [0xc7, 0x01, 0x92, 0x01] : [0, 0, 0, 0], 0); // INT 0 -> 0192:01C7 (SET0/)
    const memory = new DataView(checkpoint.physicalMemory.buffer);
    for (const [index, value] of [100, -50, depth, 7, 3, -2].entries()) memory.setInt16(0x30080 + index * 2, value, true);
  });
  const projected = await project(10);
  assert.equal(projected.result.stopReason, 'Forth returned from the entry word.', projected.result.trace.join('\n'));
  const projectedRecords = new DataView(Uint8Array.from(projected.runner.readMemory(0x3000, 0x80, 12)).buffer);
  assert.deepEqual(Array.from({ length: 6 }, (_, index) => projectedRecords.getInt16(index * 2, true)), [190, 80, 10, 150, 94, -2]);
  // A zero depth faults; SET0/'s handler zeroes AX and the projection continues with just the screen offset.
  const flat = await project(0);
  assert.equal(flat.result.stopReason, 'Forth returned from the entry word.', flat.result.trace.join('\n'));
  const flatRecords = new DataView(Uint8Array.from(flat.runner.readMemory(0x3000, 0x80, 12)).buffer);
  assert.deepEqual(Array.from({ length: 6 }, (_, index) => flatRecords.getInt16(index * 2, true)), [160, 100, 0, 150, 94, -2]);
  assert.match((await project(0, false)).result.stopReason, /projection divide overflow \(INT 0\)/);

  const pairs = await runRealNative([0xbeef, 1, 2, 3, 4, 5, 6, 7, 8, orbit(0xe48a), 1, 2, 3, 4, 5, 6, 7, 8, orbit(0xe4a8)]);
  assert.equal(pairs.result.stopReason, 'Forth returned from the entry word.', pairs.result.trace.join('\n'));
  assert.equal(finalStack(pairs.result), '0xbeef');
  assert.deepEqual(readWords(pairs.runner, 0xdc38, 8), [2, 1, 4, 3, 6, 5, 8, 7]);
});

test('kernel headerless block-range, drive, equipment and ?STACK words follow the native code', async () => {
  const kernel = (cfa: number) => word(`W_0x${cfa.toString(16)}`, cfa, cfa + 2);
  const ranges: [number, number][] = [[0x2b3a, 3], [0x2d74, 0], [0x2d76, 100], [0x2d78, 200], [0x2d4c, 99], [0x2d4e, 99], [0x2d50, 50], [0x2c15, 5]];
  const lookup = await runRealNative([150, kernel(0x367d), 300, kernel(0x367d), 2, kernel(0x36b9), 1, kernel(0x36b9)], checkpoint => {
    setWords(checkpoint, ranges);
    checkpoint.physicalMemory.set([0, 3], (0x0192 << 4) + 0x2d24);
  });
  assert.equal(lookup.result.stopReason, 'Forth returned from the entry word.', lookup.result.trace.join('\n'));
  // 150 lies 50 into range 1; 300 is in no range, leaving range 0's offset; drive bytes 3 and 0 (-> 2C15h) less one.
  assert.equal(finalStack(lookup.result), '0x0032 0x0001 0x0001 0x012c 0x0000 0x0000 0x0002 0x0004');

  const equipment = await runRealNative([0xbeef, 113, kernel(0x8d64)]);
  assert.equal(finalStack(equipment.result), '0xbeef');
  assert.deepEqual([...equipment.runner.readMemory(0, 0x410, 2)], [113, 0]);

  const fine = await runRealNative([0xbeef, kernel(0x21c7)]);
  assert.equal(fine.result.stopReason, 'Forth returned from the entry word.', fine.result.trace.join('\n'));
  assert.equal(finalStack(fine.result), '0xbeef');
  const full = await runRealNative([0xbeef, kernel(0x21c7)], checkpoint => { // #SPACE + HERE reaches FF00h, above SP
    const here = new DataView(checkpoint.physicalMemory.buffer).getUint16((0x0192 << 4) + 0x0790, true);
    setWords(checkpoint, [[0x0a0b, (0xff00 - here) & 0xffff]]);
  });
  assert.ok(full.result.trace.some(line => line.includes('stack out of bounds: run W_0x0b10')), full.result.trace.join('\n'));
  assert.ok(full.result.trace.some(line => line.includes('W_0x0ad7')), full.result.trace.join('\n'));
  assert.match(full.result.output, /Dictionary or stack full/);
});

test('!IW stores a little-endian word at twice the icon index with 16-bit wrapping', () => {
  const cases = [
    { segment: 0x3000, index: 8, value: 0xabcd },
    { segment: 0x0192, index: 0x4000, value: 0x1200 },
    { segment: 0x4000, index: 0xffff, value: 0xfffe },
    { segment: 0x3000, index: 0x8001, value: 0x5678 },
    { segment: 0xffff, index: 8, value: 0x1234 }
  ];
  for (const { segment, index, value } of cases) {
    const offset = (index * 2) & 0xffff;
    const before = (offset - 1) & 0xffff;
    const after = (offset + 2) & 0xffff;
    const operations: Operation[] = [
      0xbeef,
      index & 0xff, 0x5a02, 'C!', index >>> 8, 0x5a03, 'C!',
      0x11, segment, before, 'LC!', 0x22, segment, after, 'LC!',
      value, segment, '!IW',
      segment, before, 'LC@', segment, offset, 'LC@',
      segment, offset + 1, 'LC@', segment, after, 'LC@'
    ];
    const result = createRunner(operations, new Uint8Array(), new Uint8Array()).run();
    assert.equal(result.stopReason, 'Forth returned from the entry word.', result.trace.join('\n'));
    const stack = [0xbeef, 0x11, value & 0xff, value >>> 8, 0x22]
      .map(cell => `0x${cell.toString(16).padStart(4, '0')}`).join(' ');
    assert.ok(result.trace.at(-2)!.endsWith(`[${stack}] return`), result.trace.join('\n'));
  }
});

test('!IB stores only the low byte at the current icon offset in the supplied segment', () => {
  const cases = [
    { segment: 0x3000, offset: 8, value: 0xabcd },
    { segment: 0x0192, offset: 0x8000, value: 0x1200 },
    { segment: 0x4000, offset: 0xffff, value: 0xfffe },
    { segment: 0xffff, offset: 0x10, value: 0x1234 }
  ];
  for (const { segment, offset, value } of cases) {
    const before = (offset - 1) & 0xffff;
    const after = (offset + 1) & 0xffff;
    const operations: Operation[] = [
      0xbeef,
      offset & 0xff, 0x5a02, 'C!', offset >>> 8, 0x5a03, 'C!',
      0x11, segment, before, 'LC!', 0x22, segment, after, 'LC!',
      value, segment, '!IB',
      segment, before, 'LC@', segment, offset, 'LC@', segment, after, 'LC@'
    ];
    const result = createRunner(operations, new Uint8Array(), new Uint8Array()).run();
    assert.equal(result.stopReason, 'Forth returned from the entry word.', result.trace.join('\n'));
    const stack = [0xbeef, 0x11, value & 0xff, 0x22].map(cell => `0x${cell.toString(16).padStart(4, '0')}`).join(' ');
    assert.ok(result.trace.at(-2)!.endsWith(`[${stack}] return`), result.trace.join('\n'));
  }
});

test('headerless 0x4d5a computes far 2D-array addresses with 16-bit wrapping', () => {
  const cases = [
    { descriptor: 0x0600, table: 0x8000, segment: 0x3000, row: 3, column: 7, rowOffset: 120, expected: 127 },
    { descriptor: 0x0600, table: 0xfffe, segment: 0x4000, row: 1, column: 0x30, rowOffset: 0xfff0, expected: 0x20 },
    { descriptor: 0xfffc, table: 0x9000, segment: 0x5000, row: 0x8001, column: 0xffff, rowOffset: 10, expected: 9 }
  ];
  for (const { descriptor, table, segment, row, column, rowOffset, expected } of cases) {
    const tokens: ForthToken[] = [0xabcd, column, row, descriptor].map((value, index) => ({
      addr: 0x1000 + index * 4, addrHex: `0x${(0x1000 + index * 4).toString(16)}`,
      cfa: 0, cfaHex: '0x0000', name: String(value), kind: 'lit', arg: value
    }));
    tokens.push(
      { addr: 0x1010, addrHex: '0x1010', cfa: 0x4d5a, cfaHex: '0x4d5a', name: 'W_0x4d5a', kind: 'call' },
      { addr: 0x1012, addrHex: '0x1012', cfa: CFA_EXIT1, cfaHex: '0x1690', name: ';', kind: 'exit' }
    );
    const image = new Uint8Array(0x4e00);
    image.set([0x5c, 0x4d], 0x4d5a - 0x100);
    const runner = new ForthBootRunner(new ForthEngine([word('TEST', 0x0937, CODE_CALL, tokens)]), image, {
      stara: new Uint8Array(), starb: new Uint8Array()
    });
    runner.start();
    const checkpoint = runner.saveState();
    const pokeWord = (targetSegment: number, address: number, value: number) => {
      checkpoint.physicalMemory[(targetSegment << 4) + (address & 0xffff)] = value & 0xff;
      checkpoint.physicalMemory[(targetSegment << 4) + ((address + 1) & 0xffff)] = value >>> 8;
    };
    pokeWord(0x0192, descriptor + 4, table);
    pokeWord(0x0192, descriptor + 6, segment);
    pokeWord(segment, table + row * 2, rowOffset);
    runner.loadState(checkpoint);
    assert.equal(runner.advance(100), 'stopped');
    const result = runner.snapshot();
    assert.equal(result.stopReason, 'Forth returned from the entry word.', result.trace.join('\n'));
    const stack = [0xabcd, segment, expected].map(value => `0x${value.toString(16).padStart(4, '0')}`).join(' ');
    assert.ok(result.trace.at(-2)!.endsWith(`[${stack}] return`), result.trace.join('\n'));
  }
});

test('checkpoints restore execution, memory and private disks without sharing mutable state', () => {
  const operations: Operation[] = [
    ...transfer(0x3000, 8, 1500), 0xab, 0x3000, 8, 'LC!',
    ...transfer(0x3000, 8, 1500, 0),
    ...transfer(0x4000, 8, 1500), 0x4000, 8, 'LC@', 0xffff, '+BIT'
  ];
  const disk = new Uint8Array(BLOCK_SIZE);
  const runner = createRunner(operations, disk, disk);
  runner.start();
  runner.advance(16);
  const checkpoint = runner.saveState();
  runner.advance(100);
  const expected = runner.snapshot();
  const restored = createRunner(operations, disk, disk);
  assert.equal(restored.loadState(structuredClone(checkpoint)), 'running');
  restored.advance(100);
  assert.deepEqual(restored.snapshot(), expected);
  assert.equal(restored.loadState(checkpoint), 'running');
  restored.advance(100);
  assert.deepEqual(restored.snapshot(), expected);
  assert.throws(() => restored.loadState({ ...checkpoint, version: 2 } as unknown as typeof checkpoint), /version/);
  assert.deepEqual(restored.snapshot(), expected);
});

test('checkpoints resume nested calls, queued keys, input waits and breakpoints', () => {
  const key = word('(KEY)', 0x25d5, 0x25d7);
  const time = word('TIME', 0x2a98, 0x2a9a);
  const call = (addr: number, target: ForthWord): ForthToken => ({
    addr, addrHex: `0x${addr.toString(16)}`, cfa: target.cfa, cfaHex: target.cfaHex, name: target.name, kind: 'call'
  });
  const exit = (addr: number): ForthToken => ({
    addr, addrHex: `0x${addr.toString(16)}`, cfa: CFA_EXIT1, cfaHex: '0x1690', name: ';', kind: 'exit'
  });
  const inner = word('INNER', 0x3000, CODE_CALL, [call(0x3002, key), call(0x3004, key), exit(0x3006)]);
  const entry = word('TEST', 0x0937, CODE_CALL, [call(0x1000, inner), call(0x1002, time), exit(0x1004)]);
  const create = () => new ForthBootRunner(new ForthEngine([key, time, inner, entry]), new Uint8Array(), {
    stara: new Uint8Array(), starb: new Uint8Array()
  });
  for (const state of ['running', 'waiting', 'break'] as const) {
    const runner = create();
    runner.start(0x0937, state === 'waiting' ? [biosKey('A')!] : [biosKey('A')!, biosKey('B')!]);
    if (state === 'break') runner.setBreakpoint('KERNEL', inner.cfa);
    assert.equal(runner.advance(state === 'running' ? 1 : 100), state);
    const checkpoint = runner.saveState();
    if (state === 'waiting') runner.pressKey(biosKey('B')!);
    runner.advance(100);
    const expected = runner.snapshot();
    assert.equal(expected.stopReason, 'Forth returned from the entry word.');
    const restored = create();
    assert.equal(restored.loadState(checkpoint), state);
    if (state === 'waiting') restored.pressKey(biosKey('B')!);
    restored.advance(100);
    assert.deepEqual(restored.snapshot(), expected);
  }
});

test('EGA checkpoints preserve plane data, latches and selected registers', () => {
  const ega = new EgaAdapter();
  ega.out(0x3ce, 1);
  ega.out(0x3cf, 0);
  ega.write(10, 0xa5);
  ega.read(10);
  ega.out(0x3ce, 5);
  const checkpoint = ega.saveState();
  const restored = new EgaAdapter();
  restored.loadState(structuredClone(checkpoint));
  restored.out(0x3cf, 1);
  restored.write(20, 0);
  assert.ok(restored.planes.every(plane => plane[20] === 0xa5));
  assert.ok(checkpoint.planes.every(plane => plane[20] === 0));
});

test('+BIT counts set bits in a 16-bit cell and preserves the rest of the stack', () => {
  const cases = [
    [0, 0], [0xffff, 16], [0xaaaa, 8], [0x5555, 8], [0x8001, 2], [0x7fff, 15],
    ...Array.from({ length: 16 }, (_, bit) => [1 << bit, 1])
  ];
  for (const [value, expected] of cases) {
    const result = createRunner([0xabcd, value, '+BIT'], new Uint8Array(), new Uint8Array()).run();
    assert.equal(result.stopReason, 'Forth returned from the entry word.');
    assert.ok(result.trace.at(-2)!.endsWith(`[0xabcd 0x${expected.toString(16).padStart(4, '0')}] return`), result.trace.join('\n'));
  }
});

test('RECADD advances record addresses across block boundaries and unused tails', () => {
  const cases = [
    { index: 0, size: 100, offset: 200, block: 7, expected: [200, 7] },
    { index: 7, size: 100, offset: 200, block: 7, expected: [900, 7] },
    { index: 8, size: 100, offset: 200, block: 7, expected: [0, 8] },
    { index: 29, size: 100, offset: 200, block: 7, expected: [100, 10] },
    { index: 1, size: 100, offset: 1000, block: 7, expected: [100, 8] },
    { index: 8, size: 128, offset: 0, block: 7, expected: [0, 8] },
    { index: 1, size: 1024, offset: 0, block: 0xffff, expected: [0, 0] },
    { index: 0xffff, size: 100, offset: 200, block: 7, expected: [100, 7] }
  ];
  for (const { index, size, offset, block, expected } of cases) {
    const result = createRunner([0xabcd, index, size, offset, block, 'RECADD'], new Uint8Array(), new Uint8Array()).run();
    assert.equal(result.stopReason, 'Forth returned from the entry word.');
    const stack = [0xabcd, ...expected].map(value => `0x${value.toString(16).padStart(4, '0')}`).join(' ');
    assert.ok(result.trace.at(-2)!.endsWith(`[${stack}] return`), result.trace.join('\n'));
  }
});

test('R/W reads every byte of both mounted images and consumes its arguments', () => {
  const stara = Uint8Array.from({ length: BLOCK_SIZE * 2 }, (_, index) => index % 251);
  const starb = Uint8Array.from({ length: BLOCK_SIZE * 2 }, (_, index) => (index * 3) % 253);
  for (const [block, image] of [[1501, stara], [721, starb]] as const) {
    const operations = transfer(0x3000, 8, block);
    for (let index = 0; index < BLOCK_SIZE; index++) {
      operations.push(0x3000, 8 + index, 'LC@');
    }
    const result = createRunner(operations, stara, starb).run();
    assert.equal(result.stopReason, 'Forth returned from the entry word.');
    const reads = result.trace.filter(line => line.endsWith('read far byte'));
    assert.equal(reads.length, BLOCK_SIZE);
    reads.forEach((line, index) => {
      assert.match(line, new RegExp(`0x${image[BLOCK_SIZE + index].toString(16).padStart(4, '0')}\\] read far byte$`));
    });
    assert.match(result.trace[4], /\[\] read /);
  }
});

test('R/W writes both images privately and resets disk changes on each run', () => {
  for (const block of [1500, 720]) {
    const stara = new Uint8Array(BLOCK_SIZE);
    const starb = new Uint8Array(BLOCK_SIZE);
    const operations: Operation[] = [
      ...transfer(0x3000, 8, block),
      0x3000, 8, 'LC@',
      0xab, 0x3000, 8, 'LC!',
      0xcd, 0x3000, 8 + BLOCK_SIZE - 1, 'LC!',
      ...transfer(0x3000, 8, block, 0),
      ...transfer(0x4000, 16, block),
      0x4000, 16, 'LC@',
      0x4000, 16 + BLOCK_SIZE - 1, 'LC@'
    ];
    const runner = createRunner(operations, stara, starb);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = runner.run();
      assert.equal(result.stopReason, 'Forth returned from the entry word.');
      assert.match(result.trace.at(-2)!, /\[0x0000 0x00ab 0x00cd\] return$/);
    }
    assert.ok(stara.every(value => value === 0));
    assert.ok(starb.every(value => value === 0));
  }
});

test('R/W transfers into and out of the near-memory COM segment', () => {
  const stara = new Uint8Array(BLOCK_SIZE).fill(0x42);
  const operations: Operation[] = [
    ...transfer(0x0192, 0x8000, 1500),
    0x8000, 'C@',
    0x61, 0x8000, 'C!',
    0x62, 0x0192, 0x8001, 'LC!',
    ...transfer(0x0192, 0x8000, 1500, 0),
    ...transfer(0x3000, 8, 1500),
    0x3000, 8, 'LC@',
    0x3000, 9, 'LC@'
  ];
  const result = createRunner(operations, stara, new Uint8Array(BLOCK_SIZE)).run();
  assert.equal(result.stopReason, 'Forth returned from the entry word.');
  assert.match(result.trace.at(-2)!, /\[0x0042 0x0061 0x0062\] return$/);
});

test('R/W rejects unmapped blocks and incomplete blocks for reads and writes', () => {
  for (const block of [0, 719, 721, 1499, 1501, 0xffff]) {
    for (const reading of [0, 1]) {
      const result = createRunner(transfer(0x3000, 8, block, reading),
        new Uint8Array(BLOCK_SIZE + 1), new Uint8Array(BLOCK_SIZE + 1)).run();
      assert.match(result.stopReason, /^R\/W block .* is outside STAR[AB]\.COM\.$/);
    }
  }
});

function word(name: string, cfa: number, codep: number, tokens: ForthToken[] = []): ForthWord {
  return {
    name, cfa, cfaHex: `0x${cfa.toString(16)}`, pfa: cfa + 2, pfaHex: `0x${(cfa + 2).toString(16)}`,
    codep, codepHex: `0x${codep.toString(16)}`, module: 'KERNEL', type: codep === CODE_CALL ? 'colon' : 'primitive',
    typeLabel: 'test word', decompiled: '', tokens, rawBytes: new Uint8Array()
  };
}

function runImage(words: ForthWord[], image: Uint8Array) {
  return new ForthBootRunner(new ForthEngine(words), image, { stara: new Uint8Array(), starb: new Uint8Array() }).run();
}

test('the data stack lives in memory below SP0 and SP@ addresses its top cell', () => {
  const spFetch = word('SP@', 0x0f12, 0x0f14);
  const fetch = word('@', 0x0bae, 0x0bb0);
  const add = word('+', 0x0f72, 0x0f74);
  const reset = word('SP!', 0x0f03, 0x0f05);
  const call = (target: ForthWord, index: number): ForthToken => ({
    addr: 0x1000 + index * 2, addrHex: `0x${(0x1000 + index * 2).toString(16)}`,
    cfa: target.cfa, cfaHex: target.cfaHex, name: target.name, kind: 'call'
  });
  const lit = (value: number, index: number): ForthToken => ({
    addr: 0x1000 + index * 2, addrHex: `0x${(0x1000 + index * 2).toString(16)}`,
    cfa: 0, cfaHex: '0x0000', name: String(value), kind: 'lit', arg: value
  });
  // 0x11 0x22 0x33  4 SP@ + @  ( 2 PICK )  SP@  SP!  0x44
  const entry = word('TEST', 0x0937, CODE_CALL, [
    lit(0x11, 0), lit(0x22, 1), lit(0x33, 2), lit(4, 3), call(spFetch, 4), call(add, 5), call(fetch, 6),
    call(spFetch, 7), call(reset, 8), lit(0x44, 9),
    { addr: 0x1100, addrHex: '0x1100', cfa: CFA_EXIT1, cfaHex: '0x1690', name: ';', kind: 'exit' }
  ]);
  const image = new Uint8Array(0x800);
  image.set([0x00, 0x60], 0x078c - 0x100); // SP0 = 0x6000
  const result = runImage([spFetch, fetch, add, reset, entry], image);
  assert.equal(result.stopReason, 'Forth returned from the entry word.');
  assert.match(result.trace[4], /\[0x0011 0x0022 0x0033 0x0004 0x5ff8\] data stack pointer$/);
  assert.match(result.trace[6], /\[0x0011 0x0022 0x0033 0x0022\] read word$/);
  assert.match(result.trace[7], /\[0x0011 0x0022 0x0033 0x0022 0x5ff8\] data stack pointer$/);
  assert.match(result.trace[8], /\[\] reset data stack to SP0 0x6000$/);
  assert.match(result.trace.at(-2)!, /\[0x0044\] return$/);
});

test('?EGA is preset to EGA unless the runner is asked for the image default', () => {
  const fetch = word('@', 0x0bae, 0x0bb0);
  const entry = word('TEST', 0x0937, CODE_CALL, [
    { addr: 0x1000, addrHex: '0x1000', cfa: 0, cfaHex: '0x0000', name: '23971', kind: 'lit', arg: 0x5da3 },
    { addr: 0x1004, addrHex: '0x1004', cfa: fetch.cfa, cfaHex: fetch.cfaHex, name: fetch.name, kind: 'call' },
    { addr: 0x1006, addrHex: '0x1006', cfa: CFA_EXIT1, cfaHex: '0x1690', name: ';', kind: 'exit' }
  ]);
  for (const [options, flag] of [[{}, '0x0001'], [{ ega: false }, '0x0000']] as const) {
    const result = new ForthBootRunner(new ForthEngine([fetch, entry]), new Uint8Array(), {
      stara: new Uint8Array(), starb: new Uint8Array()
    }, options).run();
    assert.match(result.trace.at(-2)!, new RegExp(`\\[${flag}\\] return$`));
  }
});

test('headerless CODE words run by code pointer when called or executed', () => {
  const execute = word('EXECUTE', 0x0a00, 0x0a02);
  const token = (addr: number, kind: 'lit' | 'call' | 'exit', cfa: number, name: string, arg?: number): ForthToken => ({
    addr, addrHex: `0x${addr.toString(16)}`, cfa, cfaHex: `0x${cfa.toString(16)}`, name, kind, arg
  });
  const entry = word('TEST', 0x0937, CODE_CALL, [
    token(0x1000, 'lit', 0, '0x0600', 0x0600),
    token(0x1004, 'call', 0x1abe, 'W_0x1abe'), // called directly
    token(0x1006, 'lit', 0, '0x0600', 0x0600),
    token(0x100a, 'lit', 0, '0x1ac0', 0x1ac0),
    token(0x100e, 'call', execute.cfa, execute.name), // EXECUTE takes the PFA
    token(0x1010, 'exit', CFA_EXIT1, ';')
  ]);
  const image = new Uint8Array(0x1c00);
  image.set([0xc0, 0x1a], 0x1abe - 0x100); // codep == PFA
  image.set([0x05, 0x41], 0x0600 - 0x100); // count 5, 'A': (0x05 + 0x41) & 6 = 6
  const result = runImage([execute, entry], image);
  assert.equal(result.stopReason, 'Forth returned from the entry word.');
  assert.match(result.trace[1], /\[0x000c\] vocabulary thread offset$/);
  assert.match(result.trace[4], /\[0x000c 0x000c\] EXECUTE W_0x1abe@KERNEL$/);
});

test('EXIT resumes at the popped return address, so R> DROP returns to the caller\'s caller', () => {
  const fromReturn = word('R>', 0x0e50, 0x0e52);
  const drop = word('DROP', 0x0e60, 0x0e62);
  const token = (addr: number, target: ForthWord | number): ForthToken => typeof target === 'number'
    ? { addr, addrHex: `0x${addr.toString(16)}`, cfa: 0, cfaHex: '0x0000', name: String(target), kind: 'lit', arg: target }
    : { addr, addrHex: `0x${addr.toString(16)}`, cfa: target.cfa, cfaHex: target.cfaHex, name: target.name, kind: 'call' };
  const exit = (addr: number): ForthToken => ({ addr, addrHex: `0x${addr.toString(16)}`, cfa: CFA_EXIT1, cfaHex: '0x1690', name: ';', kind: 'exit' });
  // : INNER  R> DROP ;   : MIDDLE  INNER 99 ;   : TEST  MIDDLE 7 ;
  const inner = word('INNER', 0x3000, CODE_CALL, [token(0x3002, fromReturn), token(0x3004, drop), exit(0x3006)]);
  const middle = word('MIDDLE', 0x3100, CODE_CALL, [token(0x3102, inner), token(0x3104, 99), exit(0x3108)]);
  const entry = word('TEST', 0x0937, CODE_CALL, [token(0x1000, middle), token(0x1002, 7), exit(0x1006)]);
  const result = runImage([fromReturn, drop, inner, middle, entry], new Uint8Array());
  assert.equal(result.stopReason, 'Forth returned from the entry word.');
  const trace = result.trace.join('\n');
  assert.ok(result.trace.some(line => /:INNER ;  \[\] return to 0x1002 in TEST, unwinding 1 frame\(s\)$/.test(line)), trace);
  assert.ok(!result.trace.some(line => line.includes(' 99 ')), trace);
  assert.match(result.trace.at(-2)!, /\[0x0007\] return$/);
});

test('(ABORT") consumes its flag and stops only when the flag is true', () => {
  for (const flag of [0, 1]) {
    const entry = word('TEST', 0x0937, CODE_CALL, [
      { addr: 0x1000, addrHex: '0x1000', cfa: 0, cfaHex: '0x0000', name: String(flag), kind: 'lit', arg: flag },
      { addr: 0x1004, addrHex: '0x1004', cfa: 0x1c13, cfaHex: '0x1c13', name: '(ABORT") "Oops"', kind: 'call' },
      { addr: 0x100a, addrHex: '0x100a', cfa: CFA_EXIT1, cfaHex: '0x1690', name: ';', kind: 'exit' }
    ]);
    const result = runImage([entry], new Uint8Array());
    assert.equal(result.stopReason, flag ? 'ABORT" Oops" in TEST.' : 'Forth returned from the entry word.');
    assert.equal(result.output, flag ? 'Oops' : '');
    assert.match(result.trace[1], flag ? /\[\] abort$/ : /\[\] no abort$/);
  }
});

test('overlay words run only while OV# holds their directory VSA', () => {
  // Module names need not match the kernel OVERLAY word (MUSIC is loaded by MUSIC-OV), so the VSA comes from the engine.
  const inOverlay: ForthWord = {
    ...word('GREET', 0xe010, CODE_CALL, [
      { addr: 0xe012, addrHex: '0xe012', cfa: 0, cfaHex: '0x0000', name: '42', kind: 'lit', arg: 42 },
      // A headerless VARIABLE in the overlay, known only from its code field in loaded memory.
      { addr: 0xe016, addrHex: '0xe016', cfa: 0xe020, cfaHex: '0xe020', name: 'W_0xe020', kind: 'call' },
      { addr: 0xe018, addrHex: '0xe018', cfa: CFA_EXIT1, cfaHex: '0x1690', name: ';', kind: 'exit' }
    ]),
    module: 'MUSIC'
  };
  const entry = word('TEST', 0x0937, CODE_CALL, [
    { addr: 0x1000, addrHex: '0x1000', cfa: inOverlay.cfa, cfaHex: inOverlay.cfaHex, name: inOverlay.name, kind: 'call' },
    { addr: 0x1002, addrHex: '0x1002', cfa: CFA_EXIT1, cfaHex: '0x1690', name: ';', kind: 'exit' }
  ]);
  // Another overlay has a word at the headerless variable's CFA; it must not be chosen while MUSIC is loaded.
  const elsewhere: ForthWord = { ...word('ELSEWHERE', 0xe020, CODE_CALL, []), module: 'VITA-OV' };
  const engine = new ForthEngine([inOverlay, entry, elsewhere], new Map([['MUSIC', { vsa: 0x2d86, storeofs: 0xe000, size: 0x20, memory: new Uint8Array(0x10000) }]]));
  for (const loadedVsa of [0x2d86, 0x1234]) {
    const image = new Uint8Array(0xe100);
    image.set([loadedVsa & 0xff, loadedVsa >> 8], 0x55a5 - 0x100); // OV#
    image.set([0x29, 0x1d], 0xe020 - 0x100); // DOVAR code field
    const result = new ForthBootRunner(engine, image, { stara: new Uint8Array(), starb: new Uint8Array() }).run();
    if (loadedVsa === 0x2d86) {
      assert.equal(result.stopReason, 'Forth returned from the entry word.');
      assert.match(result.trace[1], /^ *2 MUSIC:GREET 42  \[0x002a\] literal$/);
      assert.match(result.trace[2], /MUSIC:GREET W_0xe020  \[0x002a 0xe022\] address of W_0xe020$/);
    } else {
      assert.equal(result.stopReason, 'GREET is in overlay MUSIC, but OV# = 0x1234 (no known overlay) is loaded.');
    }
  }
});

test('text output lands in B800 memory at the cursor and SCROLLUP moves it', () => {
  const position = word('(POSITION)', 0x2765, 0x2767);
  const cursorAddress = word('CUR>ADDR', 0x2850, 0x2852);
  const videoMove = word('>VMOVE', 0x27f6, 0x27f8);
  const scroll = word('SCROLLUP', 0x2971, 0x2973);
  let addr = 0x1000;
  const step = (target: ForthWord | number): ForthToken => {
    const token: ForthToken = typeof target === 'number'
      ? { addr, addrHex: `0x${addr.toString(16)}`, cfa: 0, cfaHex: '0x0000', name: String(target), kind: 'lit', arg: target }
      : { addr, addrHex: `0x${addr.toString(16)}`, cfa: target.cfa, cfaHex: target.cfaHex, name: target.name, kind: 'call' };
    addr += 4;
    return token;
  };
  // 2 5 (POSITION)  0x600 CUR>ADDR 2 >VMOVE  1 SCROLLUP
  const entry = word('TEST', 0x0937, CODE_CALL, [
    step(2), step(5), step(position), step(0x0600), step(cursorAddress), step(2), step(videoMove), step(1), step(scroll),
    { addr, addrHex: `0x${addr.toString(16)}`, cfa: CFA_EXIT1, cfaHex: '0x1690', name: ';', kind: 'exit' }
  ]);
  const image = new Uint8Array(0x800);
  image.set([0x48, 0x49], 0x0600 - 0x100); // "HI"
  image.set([0x00, 0xb8], 0x078c + 0x18 - 0x100); // VIDEOMEM
  image.set([24, 79, 0x00, 0x1e], 0x078c + 0x1e - 0x100); // ROWMAX, COLMAX, ATTRIBUTE 0x1E00
  const { screen, stopReason } = runImage([position, cursorAddress, videoMove, scroll, entry], image);
  assert.equal(stopReason, 'Forth returned from the entry word.');
  assert.deepEqual([screen.mode, screen.columns, screen.cursorRow, screen.cursorCol], [3, 80, 2, 5]);
  assert.equal(screen.cells[1 * 80 + 5], 0x1e48);
  assert.equal(screen.cells[1 * 80 + 6], 0x1e49);
  assert.equal(screen.cells[2 * 80 + 5], 0x0720); // scrolled in from the blank row below
  assert.equal(screen.cells[24 * 80], 0x1e20); // vacated bottom row uses the attribute in ATTRIBUTE's high byte
  assert.equal(screenLines(screen)[1], '     HI');
});

test('DO loops follow the 8086 tests: no skip on equal bounds, signed (+LOOP) both ways, and LEAVE', () => {
  const doWord = word('(DO)', 0x15b8, 0x15ba);
  const loopWord = word('(LOOP)', 0x15d0, 0x15d2);
  const plusLoop = word('(+LOOP)', 0x155c, 0x155e);
  const leave = word('LEAVE', 0x174a, 0x174c);
  const index = word('I', 0x1700, 0x1702);
  // Builds `limit start DO body... LOOP-word ;` and returns the stack it leaves.
  const run = (limit: number, start: number, body: Array<ForthWord | number>, loop: ForthWord) => {
    const tokens: ForthToken[] = [];
    let addr = 0x1000;
    const emit = (target: ForthWord | number, kind: 'lit' | 'call' = typeof target === 'number' ? 'lit' : 'call') => {
      tokens.push(typeof target === 'number'
        ? { addr, addrHex: `0x${addr.toString(16)}`, cfa: kind === 'lit' ? 0 : target & 0xffff, cfaHex: '0x0000', name: String(target), kind, arg: target }
        : { addr, addrHex: `0x${addr.toString(16)}`, cfa: target.cfa, cfaHex: target.cfaHex, name: target.name, kind: 'call' });
      addr += typeof target === 'number' && kind === 'lit' ? 4 : 2;
    };
    emit(limit);
    emit(start);
    const doAddr = addr;
    emit(doWord);
    for (const item of body) emit(item);
    const loopAddr = addr;
    emit(loop);
    emit(doAddr - loopAddr, 'call'); // inline offset: (LOOP) address + offset = (DO) address
    tokens.push({ addr, addrHex: `0x${addr.toString(16)}`, cfa: CFA_EXIT1, cfaHex: '0x1690', name: ';', kind: 'exit' });
    const result = runImage([doWord, loopWord, plusLoop, leave, index, word('TEST', 0x0937, CODE_CALL, tokens)], new Uint8Array());
    assert.equal(result.stopReason, 'Forth returned from the entry word.', result.trace.join('\n'));
    return /\[([^\]]*)\] return$/.exec(result.trace.at(-2)!)![1];
  };
  assert.equal(run(0, 0, [index], loopWord), '0x0000'); // 0 0 DO runs once
  assert.equal(run(3, 0, [index], loopWord), '0x0000 0x0001 0x0002');
  assert.equal(run(0, 3, [index, -1], plusLoop), '0x0003 0x0002 0x0001 0x0000'); // negative step stops below the limit
  assert.equal(run(10, 0, [index, 3], plusLoop), '0x0000 0x0003 0x0006 0x0009'); // stepping past the limit stops
  assert.equal(run(5, 0, [index, leave], loopWord), '0x0000'); // LEAVE ends the loop at the next test
});

test('EGA write modes 0-2, bit mask, latches, and color-compare reads', () => {
  const ega = new EgaAdapter();
  ega.setMode(true);
  const gc = (index: number, value: number) => { ega.out(0x3ce, index); ega.out(0x3cf, value); };

  gc(1, 0x0f); // Enable Set/Reset on all planes: the CPU byte is ignored
  gc(0, 0x05);
  ega.write(0, 0x00);
  assert.equal(ega.pixel(0, 0), 5);
  assert.equal(ega.pixel(7, 0), 5);

  ega.read(0); // latch color 5
  gc(0, 0x0a);
  gc(8, 0x0f); // Bit Mask: only the right four pixels take the new color
  ega.write(0, 0x00);
  assert.deepEqual([ega.pixel(0, 0), ega.pixel(4, 0)], [5, 10]);

  gc(1, 0x00);
  gc(5, 0x02); // write mode 2: the CPU byte is a color
  gc(8, 0x80);
  ega.read(1);
  ega.write(1, 0x0c);
  assert.deepEqual([ega.pixel(8, 0), ega.pixel(9, 0)], [12, 0]);

  gc(5, 0x08); // read mode 1: color compare
  gc(2, 0x0c);
  assert.equal(ega.read(1), 0x80);

  gc(5, 0x01); // write mode 1 copies the latches
  ega.read(0);
  ega.write(40, 0xff);
  assert.equal(ega.pixel(0, 1), 5);
  assert.equal(ega.pixel(4, 1), 10);

  ega.out(0x3c4, 2);
  ega.out(0x3c5, 0x01); // Map Mask: plane 0 only
  gc(5, 0x00);
  gc(1, 0x00);
  gc(8, 0xff);
  ega.read(80);
  ega.write(80, 0xff);
  assert.equal(ega.pixel(0, 2), 1);
});

test('A000h far accesses reach the EGA planes only in graphics mode', () => {
  const lores = word('>LORES', 0x8d89, 0x8d8b);
  const storeByte = word('LC!', 0x2ec0, 0x2ec2);
  const fetchByte = word('LC@', 0x2ecb, 0x2ecd);
  let addr = 0x1000;
  const step = (target: ForthWord | number): ForthToken => {
    const token: ForthToken = typeof target === 'number'
      ? { addr, addrHex: `0x${addr.toString(16)}`, cfa: 0, cfaHex: '0x0000', name: String(target), kind: 'lit', arg: target }
      : { addr, addrHex: `0x${addr.toString(16)}`, cfa: target.cfa, cfaHex: target.cfaHex, name: target.name, kind: 'call' };
    addr += 4;
    return token;
  };
  // 0xAB A000:0 LC!  A000:0 LC@  >LORES  0xAB A000:1 LC!  A000:1 LC@
  const entry = word('TEST', 0x0937, CODE_CALL, [
    step(0xab), step(0xa000), step(0), step(storeByte), step(0xa000), step(0), step(fetchByte),
    step(lores),
    step(0xab), step(0xa000), step(1), step(storeByte), step(0xa000), step(1), step(fetchByte),
    { addr, addrHex: `0x${addr.toString(16)}`, cfa: CFA_EXIT1, cfaHex: '0x1690', name: ';', kind: 'exit' }
  ]);
  const image = new Uint8Array(0x5e00);
  image.set([3, 0], 0x584a - 0x100); // MONITOR = RGB, not Hercules
  const result = runImage([lores, storeByte, fetchByte, entry], image);
  assert.equal(result.stopReason, 'Forth returned from the entry word.', result.trace.join('\n'));
  // In text mode A000h is plain RAM; in mode 0Dh Enable Set/Reset = 0Fh with Set/Reset 0 stores color 0.
  assert.match(result.trace.at(-2)!, /\[0x00ab 0x0000\] return$/);
  assert.equal(result.screen.mode, 0x0d);
});

test('INT 21h AH=21h reads one FCB record into the DTA with DOS status codes', () => {
  const store = word('!', 0x0bdf, 0x0be1);
  const interrupt = word('INTERRUPT', 0x16d7, 0x16d9);
  const fetchByte = word('C@', 0x0c92, 0x0c94);
  let addr = 0x1000;
  const tokens: ForthToken[] = [];
  const emit = (target: ForthWord | number) => {
    tokens.push(typeof target === 'number'
      ? { addr, addrHex: `0x${addr.toString(16)}`, cfa: 0, cfaHex: '0x0000', name: String(target), kind: 'lit', arg: target }
      : { addr, addrHex: `0x${addr.toString(16)}`, cfa: target.cfa, cfaHex: target.cfaHex, name: target.name, kind: 'call' });
    addr += 4;
  };
  const register = (cell: number, value: number) => { emit(value); emit(cell); emit(store); };
  const dos = (ah: number, dx: number) => { register(0x16c4, 0x0192); register(0x16bc, dx); register(0x16b6, ah << 8); emit(0x21); emit(interrupt); };
  dos(0x1a, 0x0700); // DTA = 0192:0700
  for (const record of [2, 4, 5]) {
    emit(record);
    emit(0x0600 + 33);
    emit(store);
    dos(0x21, 0x0600);
    for (const cell of [0x16b6, 0x0700, 0x0703]) { emit(cell); emit(fetchByte); } // AL, first and last DTA byte
  }
  tokens.push({ addr, addrHex: `0x${addr.toString(16)}`, cfa: CFA_EXIT1, cfaHex: '0x1690', name: ';', kind: 'exit' });

  const image = new Uint8Array(0x800);
  image.set([0x01, ...Array.from('STARA   COM', char => char.charCodeAt(0))], 0x0600 - 0x100);
  image.set([4, 0], 0x0600 + 14 - 0x100); // record size 4
  const stara = Uint8Array.from({ length: 18 }, (_, index) => 0x40 + index); // records 0-3 full, record 4 has 2 bytes
  const result = new ForthBootRunner(new ForthEngine([store, interrupt, fetchByte, word('TEST', 0x0937, CODE_CALL, tokens)]), image, {
    stara, starb: new Uint8Array()
  }).run();
  assert.equal(result.stopReason, 'Forth returned from the entry word.', result.trace.join('\n'));
  // Record 2: full (AL=0, 48h..4Bh); record 4: partial, zero-padded (AL=3, 50h..00h); record 5: past the end
  // (AL=1, zeros). The trace shows the top eight of these nine cells.
  assert.match(result.trace.at(-2)!, /\[0x0048 0x004b 0x0003 0x0050 0x0000 0x0001 0x0000 0x0000\] return$/);
});

test('INT 21h AH=22h writes the DTA into a private image, extending it past the end', () => {
  const store = word('!', 0x0bdf, 0x0be1);
  const interrupt = word('INTERRUPT', 0x16d7, 0x16d9);
  const fetchByte = word('C@', 0x0c92, 0x0c94);
  let addr = 0x1000;
  const tokens: ForthToken[] = [];
  const emit = (target: ForthWord | number) => {
    tokens.push(typeof target === 'number'
      ? { addr, addrHex: `0x${addr.toString(16)}`, cfa: 0, cfaHex: '0x0000', name: String(target), kind: 'lit', arg: target }
      : { addr, addrHex: `0x${addr.toString(16)}`, cfa: target.cfa, cfaHex: target.cfaHex, name: target.name, kind: 'call' });
    addr += 4;
  };
  const register = (cell: number, value: number) => { emit(value); emit(cell); emit(store); };
  const dos = (ah: number, record?: number) => {
    if (record !== undefined) { emit(record); emit(0x0600 + 33); emit(store); }
    register(0x16c4, 0x0192); register(0x16bc, ah === 0x1a ? 0x0700 : 0x0600); register(0x16b6, ah << 8); emit(0x21); emit(interrupt);
  };
  dos(0x1a); // DTA = 0192:0700
  dos(0x21, 1); // DTA = record 1
  dos(0x22, 6); // write it as record 6, past the 18-byte image
  emit(0x16b6); emit(fetchByte); // AL of the write
  dos(0x21, 0); // overwrite the DTA
  dos(0x21, 6); // and read record 6 back
  emit(0x16b6); emit(fetchByte); emit(0x0700); emit(fetchByte); emit(0x0703); emit(fetchByte);
  tokens.push({ addr, addrHex: `0x${addr.toString(16)}`, cfa: CFA_EXIT1, cfaHex: '0x1690', name: ';', kind: 'exit' });

  const image = new Uint8Array(0x800);
  image.set([0x01, ...Array.from('STARA   COM', char => char.charCodeAt(0))], 0x0600 - 0x100);
  image.set([4, 0, 18, 0, 0, 0], 0x0600 + 14 - 0x100); // record size 4, file size 18
  const stara = Uint8Array.from({ length: 18 }, (_, index) => 0x40 + index);
  const runner = new ForthBootRunner(new ForthEngine([store, interrupt, fetchByte, word('TEST', 0x0937, CODE_CALL, tokens)]), image, {
    stara, starb: new Uint8Array()
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = runner.run();
    assert.equal(result.stopReason, 'Forth returned from the entry word.', result.trace.join('\n'));
    // Write AL=0; record 6 reads back record 1's bytes 44h..47h with AL=0.
    assert.match(result.trace.at(-2)!, /\[0x0000 0x0000 0x0044 0x0047\] return$/);
  }
  assert.equal(stara.length, 18); // the caller's image is untouched and never grows
  assert.equal(stara[0], 0x40);
});

for (const [name, cfa, codep] of [['PLOT', 0x9365, 0x9367], ['LPLOT', 0x9000, 0x9002]] as const) {
test(`${name} draws on the hidden EGA page and the latch copy moves all planes to the visible page`, () => {
  const lores = word('>LORES', 0x8d89, 0x8d8b);
  const plot = word(name, cfa, codep);
  const copy = word('W_0x8e4d', 0x8e4d, 0x8e4f);
  const fetchByte = word('LC@', 0x2ecb, 0x2ecd);
  let addr = 0x1000;
  const step = (target: ForthWord | number): ForthToken => {
    const token: ForthToken = typeof target === 'number'
      ? { addr, addrHex: `0x${addr.toString(16)}`, cfa: 0, cfaHex: '0x0000', name: String(target), kind: 'lit', arg: target }
      : { addr, addrHex: `0x${addr.toString(16)}`, cfa: target.cfa, cfaHex: target.cfaHex, name: target.name, kind: 'call' };
    addr += 4;
    return token;
  };
  // >LORES  7 4 PLOT  A200 0 A000 0 copy  A000:(row 4 + 7/4) LC@  (read mode 0 returns plane 0)
  const entry = word('TEST', 0x0937, CODE_CALL, [
    step(lores), step(7), step(4), step(plot),
    step(0xa200), step(0), step(0xa000), step(0), step(copy),
    step(0xa000), step(4 * 40 + 1), step(fetchByte),
    { addr, addrHex: `0x${addr.toString(16)}`, cfa: CFA_EXIT1, cfaHex: '0x1690', name: ';', kind: 'exit' }
  ]);
  const image = new Uint8Array(0x9400);
  const poke = (address: number, ...bytes: number[]) => image.set(bytes, address - 0x100);
  poke(0x584a, 3, 0); // MONITOR = RGB
  poke(0x55f2, 9, 0); // COLOR 9: planes 0 and 3
  poke(0x5648, 0x00, 0xa2); // BUF-SEG = A200h, the hidden page
  poke(0x563a, 0x00, 0x60); // YTABL -> row table at 6000h
  for (let row = 0; row < 8; row++) poke(0x6000 + row * 2, (row * 40) & 0xff, (row * 40) >> 8);
  poke(0x92cf, 0xc0, 0, 0x30, 0, 0x0c, 0, 0x03, 0);
  const runner = new ForthBootRunner(new ForthEngine([lores, plot, copy, fetchByte, entry]), image, {
    stara: new Uint8Array(), starb: new Uint8Array()
  });
  runner.start();
  runner.advance(1);
  if (name === 'LPLOT') {
    const checkpoint = runner.saveState();
    checkpoint.ega.graphics[1] = 0;
    runner.loadState(checkpoint);
  }
  runner.advance(3);
  if (name === 'LPLOT') {
    const ega = runner.saveState().ega;
    assert.equal(ega.graphics[1], 0x0f);
    assert.equal(ega.graphicsIndex, 0);
  }
  runner.advance(100);
  const result = runner.snapshot();
  assert.equal(result.stopReason, 'Forth returned from the entry word.', result.trace.join('\n'));
  assert.match(result.trace[3], /plot 7,4 color 9$/);
  assert.match(result.trace[8], /EGA latch copy 2000h bytes a200:0 -> a000:0$/);
  assert.match(result.trace.at(-2)!, /\[0x0003\] return$/); // x = 7 is the last pair of bits in its byte
  // The snapshot shows logical pixel 7 as hardware pixels 14 and 15 of row 4 in color 9.
  const pixel = (x: number, y: number) => result.graphics!.pixels[y * result.graphics!.width + x];
  assert.deepEqual([pixel(13, 4), pixel(14, 4), pixel(15, 4), pixel(16, 4)], [0, 9, 9, 0]);
});
}

test('.EGARUNBIT draws even runs, skips odd runs, and wraps a long run up a row', () => {
  const lores = word('>LORES', 0x8d89, 0x8d8b);
  const runBit: ForthWord = { ...word('.EGARUNBIT', 0xf377, 0xf379), module: 'BLT-OV' };
  let addr = 0x1000;
  const step = (target: ForthWord | number): ForthToken => {
    const token: ForthToken = typeof target === 'number'
      ? { addr, addrHex: `0x${addr.toString(16)}`, cfa: 0, cfaHex: '0x0000', name: String(target), kind: 'lit', arg: target }
      : { addr, addrHex: `0x${addr.toString(16)}`, cfa: target.cfa, cfaHex: target.cfaHex, name: target.name, kind: 'call' };
    addr += 4;
    return token;
  };
  // >LORES  0192 7000 .EGARUNBIT
  const entry = word('TEST', 0x0937, CODE_CALL, [
    step(lores), step(0x0192), step(0x7000), step(runBit),
    { addr, addrHex: `0x${addr.toString(16)}`, cfa: CFA_EXIT1, cfaHex: '0x1690', name: ';', kind: 'exit' }
  ]);
  const image = new Uint8Array(0x9400);
  const poke = (address: number, ...bytes: number[]) => image.set(bytes, address - 0x100);
  const pokeWord = (address: number, value: number) => poke(address, value & 0xff, value >> 8);
  pokeWord(0x584a, 3); // MONITOR = RGB
  pokeWord(0x55f2, 9); // COLOR
  pokeWord(0x5648, 0xa000); // BUF-SEG
  pokeWord(0x563a, 0x6000); // YTABL
  for (let row = 0; row < 4; row++) pokeWord(0x6000 + row * 2, row * 40);
  poke(0x92cf, 0xc0, 0, 0x30, 0, 0x0c, 0, 0x03, 0);
  pokeWord(0x586e, 0); // XBLT
  pokeWord(0x5892, 8); // WBLT: rows are 8 logical pixels wide
  pokeWord(0x5863, 1); // YBLT
  pokeWord(0x5745, 159); // IRIGHT
  pokeWord(0x55a5, 0x1234); // OV# = BLT-OV
  pokeWord(0x7000, 3); // three runs: draw 3, skip 2, draw 6 (3 on row 1, wrapping 3 onto row 0)
  poke(0x7002, 3, 2, 6);
  const engine = new ForthEngine([lores, runBit, entry], new Map([['BLT-OV', { vsa: 0x1234, storeofs: 0xf000, size: 0x800, memory: new Uint8Array(0x10000) }]]));
  const result = new ForthBootRunner(engine, image, { stara: new Uint8Array(), starb: new Uint8Array() }).run();
  assert.equal(result.stopReason, 'Forth returned from the entry word.', result.trace.join('\n'));
  // Logical pixel x covers hardware pixels 2x and 2x+1.
  const row = (y: number) => Array.from({ length: 8 }, (_, x) => result.graphics!.pixels[y * 320 + x * 2]).join('');
  assert.equal(row(1), '99900999');
  assert.equal(row(0), '99900000');
});

test('SCANPOLY fills SCAN from vertical, diagonal, and horizontal edges like the 8086 code', () => {
  const scan = word('SCANPOLY', 0x888f, 0x8891);
  const entry = word('TEST', 0x0937, CODE_CALL, [
    { addr: 0x1000, addrHex: '0x1000', cfa: scan.cfa, cfaHex: scan.cfaHex, name: scan.name, kind: 'call' },
    { addr: 0x1002, addrHex: '0x1002', cfa: CFA_EXIT1, cfaHex: '0x1690', name: ';', kind: 'exit' }
  ]);
  const image = new Uint8Array(0x8900);
  const pokeWord = (address: number, value: number) => image.set([value & 0xff, value >> 8], address - 0x100);
  // Triangle (y, x): (0,0) (4,4) (4,0)
  [0, 0, 4, 4, 4, 0].forEach((value, index) => pokeWord(0x6000 + index * 2, value));
  pokeWord(0x569b, 0x6000); // VIN
  pokeWord(0x5686, 3); // #IN
  pokeWord(0x57d9, 0x7000); // SCAN
  const runner = new ForthBootRunner(new ForthEngine([scan, entry]), image, { stara: new Uint8Array(), starb: new Uint8Array() });
  const result = runner.run();
  assert.equal(result.stopReason, 'Forth returned from the entry word.', result.trace.join('\n'));
  assert.match(result.trace[0], /scan polygon of 3 vertices: y 0\.\.4$/);
  // (left, right) per row: the closing vertical edge fills the right column, the diagonal the left one, and the
  // horizontal bottom edge replaces row 4 with its extent.
  assert.deepEqual(Array.from(runner.readMemory(0x0192, 0x7000, 10)), [0, 0, 1, 0, 2, 0, 3, 0, 0, 4]);
});

test('SCANPOLY and LFILLPOLY fill a rectangle row by row in COLOR', () => {
  const lores = word('>LORES', 0x8d89, 0x8d8b);
  const scan = word('SCANPOLY', 0x888f, 0x8891);
  const fill = word('LFILLPOLY', 0x9053, 0x9055);
  const call = (target: ForthWord, index: number): ForthToken => ({
    addr: 0x1000 + index * 2, addrHex: `0x${(0x1000 + index * 2).toString(16)}`,
    cfa: target.cfa, cfaHex: target.cfaHex, name: target.name, kind: 'call'
  });
  const entry = word('TEST', 0x0937, CODE_CALL, [
    call(lores, 0), call(scan, 1), call(fill, 2),
    { addr: 0x1006, addrHex: '0x1006', cfa: CFA_EXIT1, cfaHex: '0x1690', name: ';', kind: 'exit' }
  ]);
  const image = new Uint8Array(0x9400);
  const pokeWord = (address: number, value: number) => image.set([value & 0xff, value >> 8], address - 0x100);
  // Rectangle (y, x): (0,3) (0,1) (2,1) (2,3), in the boot's window-band order; the reverse order yields
  // (right, left) rows, which LFILLPOLY skips as empty.
  [0, 3, 0, 1, 2, 1, 2, 3].forEach((value, index) => pokeWord(0x6000 + index * 2, value));
  pokeWord(0x569b, 0x6000); // VIN
  pokeWord(0x5686, 4); // #IN
  pokeWord(0x57d9, 0x7000); // SCAN
  pokeWord(0x584a, 3); // MONITOR = RGB
  pokeWord(0x55f2, 9); // COLOR
  pokeWord(0x5648, 0xa000); // BUF-SEG
  pokeWord(0x563a, 0x6100); // YTABL
  for (let row = 0; row < 4; row++) pokeWord(0x6100 + row * 2, row * 40);
  image.set([0xc0, 0, 0x30, 0, 0x0c, 0, 0x03, 0], 0x92cf - 0x100);
  pokeWord(0x5745, 159); // IRIGHT
  const runner = new ForthBootRunner(new ForthEngine([lores, scan, fill, entry]), image, { stara: new Uint8Array(), starb: new Uint8Array() });
  const result = runner.run();
  assert.equal(result.stopReason, 'Forth returned from the entry word.', result.trace.join('\n'));
  assert.match(result.trace[2], /fill polygon rows 0\.\.2 color 9$/);
  const row = (y: number) => Array.from({ length: 6 }, (_, x) => result.graphics!.pixels[y * 320 + x * 2]).join('');
  assert.deepEqual([row(0), row(1), row(2), row(3)], ['099900', '099900', '099900', '000000']);
  assert.equal(runner.readMemory(0x0192, 0x57f7, 1)[0], 2); // YMAX restored after the loop
});

test('{BLT} draws a 1-bit bitmap MSB first, rows going down, clipping columns without losing bits', () => {
  const lores = word('>LORES', 0x8d89, 0x8d8b);
  const blit = word('{BLT}', 0x9029, 0x902b);
  const call = (target: ForthWord, index: number): ForthToken => ({
    addr: 0x1000 + index * 2, addrHex: `0x${(0x1000 + index * 2).toString(16)}`,
    cfa: target.cfa, cfaHex: target.cfaHex, name: target.name, kind: 'call'
  });
  const entry = word('TEST', 0x0937, CODE_CALL, [
    call(lores, 0), call(blit, 1),
    { addr: 0x1004, addrHex: '0x1004', cfa: CFA_EXIT1, cfaHex: '0x1690', name: ';', kind: 'exit' }
  ]);
  const draw = (clipLeft: number) => {
    const image = new Uint8Array(0x9400);
    const pokeWord = (address: number, value: number) => image.set([value & 0xff, value >> 8], address - 0x100);
    pokeWord(0x584a, 3); // MONITOR = RGB
    pokeWord(0x55f2, 9); // COLOR
    pokeWord(0x5648, 0xa000); // BUF-SEG
    pokeWord(0x563a, 0x6100); // YTABL
    for (let row = 0; row < 4; row++) pokeWord(0x6100 + row * 2, row * 40);
    image.set([0xc0, 0, 0x30, 0, 0x0c, 0, 0x03, 0], 0x92cf - 0x100);
    pokeWord(0x586e, 0); // XBLT
    pokeWord(0x5863, 1); // YBLT: the top row
    pokeWord(0x5892, 3); // WBLT
    pokeWord(0x5887, 2); // LBLT
    pokeWord(0x58aa, 0x0192); // BLTSEG
    pokeWord(0x589d, 0x7000); // ABLT
    pokeWord(0x7000, 0b1011100000000000); // rows 101 and 110, MSB first
    pokeWord(0x5738, clipLeft); // ILEFT
    pokeWord(0x5745, 159); // IRIGHT
    pokeWord(0x5752, 0); // IBELOW
    pokeWord(0x575f, 199); // IABOVE
    const result = runImage([lores, blit, entry], image);
    assert.equal(result.stopReason, 'Forth returned from the entry word.', result.trace.join('\n'));
    const row = (y: number) => Array.from({ length: 4 }, (_, x) => result.graphics!.pixels[y * 320 + x * 2].toString(16)).join('');
    return [row(1), row(0)];
  };
  assert.deepEqual(draw(0), ['9090', '9900']);
  assert.deepEqual(draw(1), ['0090', '0900']); // column 0 clipped; the remaining bits stay aligned
});

test('LLINE walks from (x2, y2) to (x1, y1) with the driver\'s Bresenham steps', () => {
  const lores = word('>LORES', 0x8d89, 0x8d8b);
  const line = word('LLINE', 0x903d, 0x903f);
  const lit = (addr: number, value: number): ForthToken => ({ addr, addrHex: `0x${addr.toString(16)}`, cfa: 0, cfaHex: '0x0000', name: String(value), kind: 'lit', arg: value });
  const call = (addr: number, target: ForthWord): ForthToken => ({ addr, addrHex: `0x${addr.toString(16)}`, cfa: target.cfa, cfaHex: target.cfaHex, name: target.name, kind: 'call' });
  // 0 0 4 2 LLINE: from (4, 2) to (0, 0), x major (4), minor 2, threshold 1
  const entry = word('TEST', 0x0937, CODE_CALL, [
    call(0x1000, lores), lit(0x1002, 0), lit(0x1006, 0), lit(0x100a, 4), lit(0x100e, 2), call(0x1012, line),
    { addr: 0x1014, addrHex: '0x1014', cfa: CFA_EXIT1, cfaHex: '0x1690', name: ';', kind: 'exit' }
  ]);
  const image = new Uint8Array(0x9400);
  const pokeWord = (address: number, value: number) => image.set([value & 0xff, value >> 8], address - 0x100);
  pokeWord(0x584a, 3); // MONITOR = RGB
  pokeWord(0x55f2, 9); // COLOR
  pokeWord(0x5648, 0xa000); // BUF-SEG
  pokeWord(0x563a, 0x6100); // YTABL
  for (let row = 0; row < 4; row++) pokeWord(0x6100 + row * 2, row * 40);
  image.set([0xc0, 0, 0x30, 0, 0x0c, 0, 0x03, 0], 0x92cf - 0x100);
  pokeWord(0x52a5, 0x0800); // REMSEG for the patched driver bytes
  const result = runImage([lores, line, entry], image);
  assert.equal(result.stopReason, 'Forth returned from the entry word.', result.trace.join('\n'));
  assert.match(result.trace[5], /line 4,2 to 0,0 color 9$/);
  const row = (y: number) => Array.from({ length: 5 }, (_, x) => result.graphics!.pixels[y * 320 + x * 2].toString(16)).join('');
  // x steps every point; the error (+2 each) passes the threshold 1 on steps 1 and 3, stepping y:
  // (4,2) (3,1) (2,1) (1,0) (0,0)
  assert.deepEqual([row(2), row(1), row(0)], ['00009', '00990', '99000']);
});

test('V>DISPLAY copies the packed main view to display rows without changing borders or the stack', () => {
  const lores = word('>LORES', 0x8d89, 0x8d8b);
  const display = word('V>DISPLAY', 0x90ab, 0x90ad);
  const entry = word('TEST', 0x0937, CODE_CALL, [
    { addr: 0x1000, addrHex: '0x1000', cfa: 0, cfaHex: '0x0000', name: '48879', kind: 'lit', arg: 0xbeef },
    { addr: 0x1004, addrHex: '0x1004', cfa: lores.cfa, cfaHex: lores.cfaHex, name: lores.name, kind: 'call' },
    { addr: 0x1006, addrHex: '0x1006', cfa: display.cfa, cfaHex: display.cfaHex, name: display.name, kind: 'call' },
    { addr: 0x1008, addrHex: '0x1008', cfa: CFA_EXIT1, cfaHex: '0x1690', name: ';', kind: 'exit' }
  ]);
  const image = new Uint8Array(0x6800);
  const pokeWord = (address: number, value: number) => image.set([value & 0xff, value >>> 8], address - 0x100);
  pokeWord(0x584a, 3);
  pokeWord(0x55d8, 0xa400);
  pokeWord(0x55e6, 0xa000);
  for (let row = 0; row < 120; row++) pokeWord(0x6598 + row * 2, (127 - row) * 40);
  const runner = new ForthBootRunner(new ForthEngine([lores, display, entry]), image, {
    stara: new Uint8Array(), starb: new Uint8Array()
  });
  runner.start();
  runner.advance(2);
  const checkpoint = runner.saveState();
  const sources = checkpoint.ega.planes.map((plane, index) => {
    plane.fill(0x5a, 0, 0x2000);
    const source = Uint8Array.from({ length: 120 * 18 }, (_, offset) => (offset * 7 + index * 53) & 0xff);
    plane.set(source, 0x4000);
    return source;
  });
  runner.loadState(checkpoint);
  assert.equal(runner.advance(100), 'stopped');
  const result = runner.snapshot();
  assert.equal(result.stopReason, 'Forth returned from the entry word.');
  assert.match(result.trace.at(-2)!, /\[0xbeef\] return$/);
  const ega = runner.saveState().ega;
  ega.planes.forEach((plane, index) => {
    const expected = new Uint8Array(0x2000).fill(0x5a);
    for (let row = 0; row < 120; row++) {
      expected.set(sources[index].subarray(row * 18, (row + 1) * 18), (127 - row) * 40 + 1);
    }
    assert.deepEqual(plane.subarray(0, 0x2000), expected);
    assert.deepEqual(plane.subarray(0x4000, 0x4000 + 120 * 18), sources[index]);
  });
  assert.equal(ega.graphics[5], 0);
});

test('LCOPYBLK copies a block row by row towards its destination, so overlapping copies keep the source', () => {
  const lores = word('>LORES', 0x8d89, 0x8d8b);
  const line = word('LLINE', 0x903d, 0x903f);
  const copy = word('LCOPYBLK', 0x9069, 0x906b);
  const tokens: ForthToken[] = [];
  let addr = 0x1000;
  const lit = (value: number) => { tokens.push({ addr, addrHex: `0x${addr.toString(16)}`, cfa: 0, cfaHex: '0x0000', name: String(value), kind: 'lit', arg: value }); addr += 4; };
  const call = (target: ForthWord) => { tokens.push({ addr, addrHex: `0x${addr.toString(16)}`, cfa: target.cfa, cfaHex: target.cfaHex, name: target.name, kind: 'call' }); addr += 2; };
  call(lores);
  [0, 0, 3, 0].forEach(lit); call(line); // row 0, x 0-3
  [0, 1, 0, 1].forEach(lit); call(line); // row 1, x 0
  [0, 1, 3, 0, 4, 2].forEach(lit); call(copy); // rows 0-1, x 0-3 to x 4, rows 1-2
  tokens.push({ addr, addrHex: `0x${addr.toString(16)}`, cfa: CFA_EXIT1, cfaHex: '0x1690', name: ';', kind: 'exit' });
  const entry = word('TEST', 0x0937, CODE_CALL, tokens);
  const image = new Uint8Array(0x9400);
  const pokeWord = (address: number, value: number) => image.set([value & 0xff, value >> 8], address - 0x100);
  pokeWord(0x584a, 3); // MONITOR = RGB
  pokeWord(0x55f2, 9); // COLOR
  pokeWord(0x5648, 0xa000); // BUF-SEG
  pokeWord(0x563a, 0x6100); // YTABL
  for (let row = 0; row < 4; row++) pokeWord(0x6100 + row * 2, row * 40);
  image.set([0xc0, 0, 0x30, 0, 0x0c, 0, 0x03, 0], 0x92cf - 0x100);
  pokeWord(0x52a5, 0x0800); // REMSEG for the patched driver bytes
  const result = runImage([lores, line, copy, entry], image);
  assert.equal(result.stopReason, 'Forth returned from the entry word.', result.trace.join('\n'));
  const row = (y: number) => Array.from({ length: 8 }, (_, x) => result.graphics!.pixels[y * 320 + x * 2].toString(16)).join('');
  // The destination (high row 2) is above the source's high row 1, so rows go 1 -> 2, then 0 -> 1:
  // row 1's copy reads the original row 0, not the copy of row 1.
  assert.deepEqual([row(0), row(1), row(2)], ['99990000', '90009999', '00009000']);
});

test('(KEY) reads the typed-ahead queue and stops when it is empty', () => {
  const key = word('(KEY)', 0x25d5, 0x25d7);
  const terminal = word('(?TERMINAL)', 0x25ba, 0x25bc);
  const call = (target: ForthWord, index: number): ForthToken => ({
    addr: 0x1000 + index * 2, addrHex: `0x${(0x1000 + index * 2).toString(16)}`,
    cfa: target.cfa, cfaHex: target.cfaHex, name: target.name, kind: 'call'
  });
  const entry = word('TEST', 0x0937, CODE_CALL, [
    call(terminal, 0), call(key, 1), call(key, 2), call(terminal, 3), call(key, 4),
    { addr: 0x100a, addrHex: '0x100a', cfa: CFA_EXIT1, cfaHex: '0x1690', name: ';', kind: 'exit' }
  ]);
  const runner = new ForthBootRunner(new ForthEngine([key, terminal, entry]), new Uint8Array(), {
    stara: new Uint8Array(), starb: new Uint8Array()
  });
  const result = runner.run(0x0937, 100, [biosKey('A')!, biosKey('ArrowUp')!]);
  assert.equal(result.stopReason, 'Waiting for a key at (KEY); the keyboard queue is empty.');
  assert.equal(result.waitingForKey, true);
  // ?TERMINAL saw a key, (KEY) returned 'A' and 100h + scan 48h, then ?TERMINAL saw none.
  assert.match(result.trace[3], /\[0x0001 0x0041 0x0148 0x0000\] no key waiting$/);
  assert.equal(runner.run(0x0937, 100, [0x0d, 0x0d, 0x0d]).waitingForKey, false);
  assert.equal(biosKey('Enter'), 0x1c0d);
  assert.equal(biosKey('Shift'), undefined);
});

test('user-vectored words execute the PFA stored in their user cell', () => {
  const exit: ForthToken = { addr: 0x7000, addrHex: '0x7000', cfa: CFA_EXIT1, cfaHex: '0x1690', name: ';', kind: 'exit' };
  const vector = word('VECTOR', 0x0300, 0x17b7, []);
  const target = word('TARGET', 0x0400, CODE_CALL, [
    { addr: 0x0402, addrHex: '0x0402', cfa: 0, cfaHex: '0x0000', name: '7', kind: 'lit', arg: 7 },
    exit
  ]);
  const entry = word('TEST', 0x0937, CODE_CALL, [
    { addr: 0x1000, addrHex: '0x1000', cfa: vector.cfa, cfaHex: vector.cfaHex, name: vector.name, kind: 'call' },
    exit
  ]);
  const image = new Uint8Array(0x800);
  image[vector.pfa - 0x100] = 0x58; // user offset
  image[0x07e4 - 0x100] = target.pfa & 0xff; // USER_AREA 0x078c + 0x58
  image[0x07e5 - 0x100] = target.pfa >> 8;
  const result = runImage([vector, target, entry], image);
  assert.equal(result.stopReason, 'Forth returned from the entry word.');
  assert.match(result.trace[0], /VECTOR vector 0x7e4 -> TARGET@KERNEL$/);
  assert.match(result.trace.at(-2)!, /\[0x0007\] return$/);
});

test('DOES> words push their PFA and run the threaded body after call DODOES', () => {
  const fetchByte = word('C@', 0x0c92, 0x0c94);
  const offsetBlock = word('DOFFBLK', 0x71db, 0x71dd);
  const field = word('FIELD', 0x0500, 0x0600);
  const entry = word('TEST', 0x0937, CODE_CALL, [
    { addr: 0x1000, addrHex: '0x1000', cfa: 0, cfaHex: '0x0000', name: '97', kind: 'lit', arg: 0x61 },
    { addr: 0x1004, addrHex: '0x1004', cfa: field.cfa, cfaHex: field.cfaHex, name: field.name, kind: 'call' },
    { addr: 0x1006, addrHex: '0x1006', cfa: CFA_EXIT1, cfaHex: '0x1690', name: ';', kind: 'exit' }
  ]);
  const image = new Uint8Array(0x5400);
  const poke = (address: number, ...bytes: number[]) => image.set(bytes, address - 0x100);
  poke(field.pfa, 0x61);
  const rel = (0x1649 - 0x0603) & 0xffff;
  // call DODOES; C@ DOFFBLK ;
  poke(0x0600, 0xe8, rel & 0xff, rel >> 8, 0x92, 0x0c, 0xdb, 0x71, 0x90, 0x16);
  poke(0x535e, 10); // DIRBLK
  const result = runImage([fetchByte, offsetBlock, field, entry], image);
  assert.equal(result.stopReason, 'Forth returned from the entry word.');
  assert.match(result.trace[1], /\[0x0061 0x0502\] DOES> FIELD$/);
  // 0x61 is entry 1 of the third directory block: offset 21, block DIRBLK + 2.
  assert.match(result.trace.at(-2)!, /\[0x0061 0x0015 0x000c\] return$/);
});

test('EXECUTE runs a DOES> word\'s threaded body, like a direct call', () => {
  const fetchByte = word('C@', 0x0c92, 0x0c94);
  const execute = word('EXECUTE', 0x1682, 0x1684);
  const field = word('FIELD', 0x0500, 0x0600);
  const entry = word('TEST', 0x0937, CODE_CALL, [
    { addr: 0x1000, addrHex: '0x1000', cfa: 0, cfaHex: '0x0000', name: String(field.pfa), kind: 'lit', arg: field.pfa },
    { addr: 0x1004, addrHex: '0x1004', cfa: execute.cfa, cfaHex: execute.cfaHex, name: execute.name, kind: 'call' },
    { addr: 0x1006, addrHex: '0x1006', cfa: CFA_EXIT1, cfaHex: '0x1690', name: ';', kind: 'exit' }
  ]);
  const image = new Uint8Array(0x5400);
  const poke = (address: number, ...bytes: number[]) => image.set(bytes, address - 0x100);
  poke(field.pfa, 0x61);
  const rel = (0x1649 - 0x0603) & 0xffff;
  poke(0x0600, 0xe8, rel & 0xff, rel >> 8, 0x92, 0x0c, 0x90, 0x16); // call DODOES; C@ ;
  const result = runImage([fetchByte, execute, field, entry], image);
  assert.equal(result.stopReason, 'Forth returned from the entry word.', result.trace.join('\n'));
  assert.match(result.trace[1], /\[0x0502\] EXECUTE DOES> FIELD@KERNEL$/);
  assert.match(result.trace.at(-2)!, /\[0x0061\] return$/);
});

test('BVSA>OFFBLK splits paragraphs above 3E80h into a byte offset and a 1,024-byte block', () => {
  const split = word('BVSA>OFFBLK', 0x7293, 0x7295);
  const entry = word('TEST', 0x0937, CODE_CALL, [
    { addr: 0x1000, addrHex: '0x1000', cfa: 0, cfaHex: '0x0000', name: '16071', kind: 'lit', arg: 0x3ec7 },
    { addr: 0x1004, addrHex: '0x1004', cfa: split.cfa, cfaHex: split.cfaHex, name: split.name, kind: 'call' },
    { addr: 0x1006, addrHex: '0x1006', cfa: 0, cfaHex: '0x0000', name: '16000', kind: 'lit', arg: 0x3e7f },
    { addr: 0x100a, addrHex: '0x100a', cfa: split.cfa, cfaHex: split.cfaHex, name: split.name, kind: 'call' },
    { addr: 0x100c, addrHex: '0x100c', cfa: CFA_EXIT1, cfaHex: '0x1690', name: ';', kind: 'exit' }
  ]);
  const result = runImage([split, entry], new Uint8Array(0x5400));
  assert.equal(result.stopReason, 'Forth returned from the entry word.', result.trace.join('\n'));
  // 47h paragraphs: block 1, offset 7 * 16; one paragraph below 3E80h wraps to FFFFh.
  assert.match(result.trace.at(-2)!, /\[0x0070 0x0001 0x03f0 0x03ff\] return$/);
});

test('a call to ICLOSE (0x79c9) runs the colon word instead of returning', () => {
  const close = word('ICLOSE', 0x79c9, CODE_CALL, [
    { addr: 0x79cb, addrHex: '0x79cb', cfa: 0, cfaHex: '0x0000', name: '5', kind: 'lit', arg: 5 },
    { addr: 0x79cf, addrHex: '0x79cf', cfa: CFA_EXIT1, cfaHex: '0x1690', name: ';', kind: 'exit' }
  ]);
  const entry = word('TEST', 0x0937, CODE_CALL, [
    { addr: 0x1000, addrHex: '0x1000', cfa: close.cfa, cfaHex: close.cfaHex, name: close.name, kind: 'call' },
    { addr: 0x1002, addrHex: '0x1002', cfa: 0, cfaHex: '0x0000', name: '7', kind: 'lit', arg: 7 },
    { addr: 0x1006, addrHex: '0x1006', cfa: CFA_EXIT1, cfaHex: '0x1690', name: ';', kind: 'exit' }
  ]);
  const result = runImage([close, entry], new Uint8Array(0x8000));
  assert.equal(result.stopReason, 'Forth returned from the entry word.', result.trace.join('\n'));
  assert.match(result.trace.at(-2)!, /\[0x0005 0x0007\] return$/);
});

test('S->D sign-extends a cell into a double', () => {
  const extend = word('S->D', 0x1506, 0x1508);
  const entry = word('TEST', 0x0937, CODE_CALL, [
    { addr: 0x1000, addrHex: '0x1000', cfa: 0, cfaHex: '0x0000', name: '-2', kind: 'lit', arg: 0xfffe },
    { addr: 0x1004, addrHex: '0x1004', cfa: extend.cfa, cfaHex: extend.cfaHex, name: extend.name, kind: 'call' },
    { addr: 0x1006, addrHex: '0x1006', cfa: 0, cfaHex: '0x0000', name: '32767', kind: 'lit', arg: 0x7fff },
    { addr: 0x100a, addrHex: '0x100a', cfa: extend.cfa, cfaHex: extend.cfaHex, name: extend.name, kind: 'call' },
    { addr: 0x100c, addrHex: '0x100c', cfa: CFA_EXIT1, cfaHex: '0x1690', name: ';', kind: 'exit' }
  ]);
  const result = runImage([extend, entry], new Uint8Array(0x5400));
  assert.equal(result.stopReason, 'Forth returned from the entry word.', result.trace.join('\n'));
  assert.match(result.trace.at(-2)!, /\[0xfffe 0xffff 0x7fff 0x0000\] return$/);
});

test('DOES> bodies may branch: C@ IF 7 THEN', () => {
  const fetchByte = word('C@', 0x0c92, 0x0c94);
  const off = word('FLAG-OFF', 0x0500, 0x0600);
  const on = word('FLAG-ON', 0x0510, 0x0600);
  const call = (addr: number, target: ForthWord): ForthToken => ({ addr, addrHex: `0x${addr.toString(16)}`, cfa: target.cfa, cfaHex: target.cfaHex, name: target.name, kind: 'call' });
  const entry = word('TEST', 0x0937, CODE_CALL, [
    call(0x1000, off), call(0x1002, on),
    { addr: 0x1004, addrHex: '0x1004', cfa: CFA_EXIT1, cfaHex: '0x1690', name: ';', kind: 'exit' }
  ]);
  const image = new Uint8Array(0x800);
  const poke = (address: number, ...bytes: number[]) => image.set(bytes, address - 0x100);
  const rel = (0x1649 - 0x0603) & 0xffff;
  // call DODOES; C@ 0BRANCH (+6: to EXIT) LIT 7 ;
  poke(0x0600, 0xe8, rel & 0xff, rel >> 8, 0x92, 0x0c, 0xfa, 0x15, 0x06, 0x00, 0x5d, 0x17, 0x07, 0x00, 0x90, 0x16);
  poke(off.pfa, 0);
  poke(on.pfa, 1);
  const result = runImage([fetchByte, off, on, entry], image);
  assert.equal(result.stopReason, 'Forth returned from the entry word.', result.trace.join('\n'));
  assert.match(result.trace.at(-2)!, /\[0x0007\] return$/); // only FLAG-ON pushes 7
});

test('inline 2LIT in a DOES> body pushes the low cell, then the high cell', () => {
  const field = word('DOUBLE', 0x0500, 0x0600);
  const entry = word('TEST', 0x0937, CODE_CALL, [
    { addr: 0x1000, addrHex: '0x1000', cfa: field.cfa, cfaHex: field.cfaHex, name: field.name, kind: 'call' },
    { addr: 0x1002, addrHex: '0x1002', cfa: CFA_EXIT1, cfaHex: '0x1690', name: ';', kind: 'exit' }
  ]);
  const image = new Uint8Array(0x800);
  const rel = (0x1649 - 0x0603) & 0xffff;
  // call DODOES; 2LIT 0001E240h (123456) ;
  image.set([0xe8, rel & 0xff, rel >> 8, 0x16, 0x16, 0x40, 0xe2, 0x01, 0x00, 0x90, 0x16], 0x0600 - 0x100);
  const result = runImage([field, entry], image);
  assert.equal(result.stopReason, 'Forth returned from the entry word.', result.trace.join('\n'));
  assert.match(result.trace[1], /DOES> DOUBLE 123456\. \(low\)  \[0x0502 0xe240\] literal$/);
  assert.match(result.trace.at(-2)!, /\[0x0502 0xe240 0x0001\] return$/);
});

test('TIME derives a double millisecond counter from the step count', () => {
  const time = word('TIME', 0x2a98, 0x2a9a);
  const fetchDouble = word('2@', 0x0e00, 0x0e02);
  const tokens: ForthToken[] = [];
  let addr = 0x1000;
  const emit = (target: ForthWord | number) => {
    tokens.push(typeof target === 'number'
      ? { addr, addrHex: `0x${addr.toString(16)}`, cfa: 0, cfaHex: '0x0000', name: String(target), kind: 'lit', arg: target }
      : { addr, addrHex: `0x${addr.toString(16)}`, cfa: target.cfa, cfaHex: target.cfaHex, name: target.name, kind: 'call' });
    addr += 4;
  };
  for (let index = 0; index < 4 * STEPS_PER_MILLISECOND - 1; index++) emit(index); // TIME runs at step 4 ms * rate
  emit(time);
  emit(fetchDouble);
  tokens.push({ addr, addrHex: `0x${addr.toString(16)}`, cfa: CFA_EXIT1, cfaHex: '0x1690', name: ';', kind: 'exit' });
  const result = runImage([time, fetchDouble, word('TEST', 0x0937, CODE_CALL, tokens)], new Uint8Array(0x200));
  assert.equal(result.stopReason, 'Forth returned from the entry word.');
  assert.match(result.trace.at(-4)!, /TIME  \[.*0x0188\] time 4 ms$/);
  assert.match(result.trace.at(-2)!, /0x0004 0x0000\] return$/); // low, high
});

test('changing the step rate keeps TIME continuous, through checkpoints at other rates', () => {
  const tokens: ForthToken[] = Array.from({ length: 2000 }, (_, index) => ({
    addr: 0x1000 + index * 4, addrHex: `0x${(0x1000 + index * 4).toString(16)}`, cfa: 0, cfaHex: '0x0000', name: '1', kind: 'lit', arg: 1
  }));
  const engine = new ForthEngine([word('TEST', 0x0937, CODE_CALL, tokens)]);
  const disks = { stara: new Uint8Array(), starb: new Uint8Array() };
  const runner = new ForthBootRunner(engine, new Uint8Array(0x200), disks);
  runner.start(0x0937);
  runner.advance(100);
  assert.equal(runner.milliseconds, 100 / STEPS_PER_MILLISECOND);
  runner.setStepsPerMillisecond(200);
  runner.advance(400);
  const expected = 100 / STEPS_PER_MILLISECOND + 2;
  assert.equal(runner.milliseconds, expected);

  const checkpoint = runner.saveState();
  const other = new ForthBootRunner(engine, new Uint8Array(0x200), disks, { stepsPerMillisecond: 400 });
  other.loadState(checkpoint);
  assert.equal(other.milliseconds, expected);
  other.advance(400);
  assert.equal(other.milliseconds, expected + 1);

  const { clock, ...legacy } = checkpoint.session; // saved before the rate was adjustable: the default rate
  other.loadState({ ...checkpoint, session: legacy });
  assert.ok(clock);
  assert.equal(other.milliseconds, 500 / STEPS_PER_MILLISECOND);
});

// A runner idling in `BEGIN AGAIN` after `prefix`, with `setup` applied to its memory after start().
function idleRunner(prefix: ForthToken[], words: ForthWord[], setup?: (memory: Uint8Array) => void) {
  const loop = 0x1000 + prefix.length * 4;
  const tokens = [...prefix, { addr: loop, addrHex: `0x${loop.toString(16)}`, cfa: 0x1660, cfaHex: '0x1660', name: 'AGAIN', kind: 'branch' as const, arg: loop }];
  const runner = new ForthBootRunner(new ForthEngine([...words, word('TEST', 0x0937, CODE_CALL, tokens)]), new Uint8Array(0x200), { stara: new Uint8Array(), starb: new Uint8Array() });
  runner.start(0x0937);
  if (setup) {
    const checkpoint = runner.saveState();
    setup(checkpoint.physicalMemory);
    runner.loadState(checkpoint);
    runner.takeSpeakerEvents(); // the restored (silent) state
  }
  return runner;
}

test('TONE, BEEPON and BEEPOFF report timed speaker changes', () => {
  const tone = word('TONE', 0x2616, 0x2618), on = word('BEEPON', 0x2636, 0x2638), off = word('BEEPOFF', 0x2651, 0x2653);
  const call = (target: ForthWord, index: number): ForthToken => ({
    addr: 0x1000 + index * 4, addrHex: `0x${(0x1000 + index * 4).toString(16)}`, cfa: target.cfa, cfaHex: target.cfaHex, name: target.name, kind: 'call'
  });
  const runner = idleRunner([
    { addr: 0x1000, addrHex: '0x1000', cfa: 0, cfaHex: '0x0000', name: '1193', kind: 'lit', arg: 1193 },
    call(tone, 1), call(on, 2), call(off, 3)
  ], [tone, on, off]);
  runner.advance(10);
  const events = runner.takeSpeakerEvents();
  assert.deepEqual(events.map(event => [Math.round(event.milliseconds * STEPS_PER_MILLISECOND), Math.round(event.frequency)]), [[3, 1000], [4, 0]]);
  assert.equal(runner.speakerTone, 0);
  assert.deepEqual(runner.takeSpeakerEvents(), []);
});

test('INT 1Ch runs the MUSIC player each timer tick: notes, staccato gaps, rests and phrase repeats', () => {
  const tick = 0x10000 * 1000 / 1193182;
  const runner = idleRunner([], [], memory => {
    const base = 0x50000;
    memory.set([0xff, 0x00, 0x00, 0x50], 0x70); // INT 1Ch -> 5000:00FF
    memory.set([0x56, 0x57, 0x1e, 0x52, 0x51, 0x53, 0x50, 0x0e, 0x1f], base + 0xff);
    memory.set([1, 0, 0, 0x40, 0x01, 0x60, 0x01, 2, 1, 0, 0, 1], base + 2); // ?MUSIC, phrase 140h, notes 160h, 2 repeats
    memory.set([0xa9, 0x04, 0x52, 0x09], base + 0x24); // SCALE: 1193 (1000 Hz), 2386 (500 Hz)
    memory.set([2, 0x60, 0x01, 0], base + 0x140); // play the phrase at 160h twice, then stop
    memory.set([0x02, 0, 0x42, 1, 0x01, 0xff, 0x00], base + 0x160); // 2 ticks, 2 ticks staccato, a 1-tick rest
  });
  runner.advance(Math.ceil(13 * tick * STEPS_PER_MILLISECOND));
  const events = runner.takeSpeakerEvents().map(event => [Math.round(event.milliseconds / tick), Math.round(event.frequency)]);
  assert.deepEqual(events, [[1, 1000], [3, 500], [4, 0], [6, 1000], [8, 500], [9, 0]]);
  assert.equal(runner.readMemory(0x5000, 2, 1)[0], 0); // the song ended
});

test('an unknown INT 1Ch handler stops the run instead of being skipped', () => {
  const runner = idleRunner([], [], memory => memory.set([0x00, 0x01, 0x00, 0x60], 0x70));
  runner.advance(Math.ceil(60 * STEPS_PER_MILLISECOND));
  assert.match(runner.snapshot().stopReason, /INT 1Ch handler at 6000:100 has no TypeScript translation/);
});

test('CASE: words run as DOES> children and EXECUTE the matching or default entry', () => {
  const execute = word('EXECUTE', 0x1682, 0x1684);
  const caseWord: ForthWord = { ...word('(.DOOR)', 0x0500, 0x4a4f), type: 'case' };
  const exit = (addr: number): ForthToken => ({ addr, addrHex: `0x${addr.toString(16)}`, cfa: CFA_EXIT1, cfaHex: '0x1690', name: ';', kind: 'exit' });
  const lit = (addr: number, value: number): ForthToken => ({ addr, addrHex: `0x${addr.toString(16)}`, cfa: 0, cfaHex: '0x0000', name: String(value), kind: 'lit', arg: value });
  const one = word('ONE', 0x0600, CODE_CALL, [lit(0x0602, 111), exit(0x0606)]);
  const other = word('OTHER', 0x0610, CODE_CALL, [lit(0x0612, 999), exit(0x0616)]);
  const entry = word('TEST', 0x0937, CODE_CALL, [
    lit(0x1000, 6), { addr: 0x1004, addrHex: '0x1004', cfa: caseWord.cfa, cfaHex: caseWord.cfaHex, name: caseWord.name, kind: 'call' },
    lit(0x1006, 7), { addr: 0x100a, addrHex: '0x100a', cfa: caseWord.cfa, cfaHex: caseWord.cfaHex, name: caseWord.name, kind: 'call' },
    exit(0x100c)
  ]);
  const image = new Uint8Array(0x4b00);
  const poke = (address: number, ...bytes: number[]) => image.set(bytes, address - 0x100);
  const rel = (0x1649 - 0x4a52) & 0xffff;
  poke(0x4a4f, 0xe8, rel & 0xff, rel >> 8, 0x13, 0x4a, 0x82, 0x16, 0x90, 0x16); // call DODOES; 4A13h EXECUTE ;
  poke(0x4a13, 0x15, 0x4a); // headerless CODE: code field = PFA
  // PFA table: 1 entry, default OTHER; 6 -> ONE (PFAs)
  poke(caseWord.pfa, 1, 0, other.pfa & 0xff, other.pfa >> 8, 6, 0, one.pfa & 0xff, one.pfa >> 8);
  const result = runImage([execute, caseWord, one, other, entry], image);
  assert.equal(result.stopReason, 'Forth returned from the entry word.', result.trace.join('\n'));
  assert.ok(result.trace.some(line => /case 6: match 0x602$/.test(line)), result.trace.join('\n'));
  assert.ok(result.trace.some(line => /case 7: default 0x612$/.test(line)));
  assert.match(result.trace.at(-2)!, /\[0x006f 0x03e7\] return$/);
});

test('the trace keeps the most recent lines and counts the dropped ones', () => {
  const lit = (index: number): ForthToken => ({
    addr: 0x1000 + index * 4, addrHex: `0x${(0x1000 + index * 4).toString(16)}`, cfa: 0, cfaHex: '0x0000', name: String(index), kind: 'lit', arg: index
  });
  const tokens = Array.from({ length: 10 }, (_, index) => lit(index));
  tokens.push({ addr: 0x1100, addrHex: '0x1100', cfa: CFA_EXIT1, cfaHex: '0x1690', name: ';', kind: 'exit' });
  const engine = new ForthEngine([word('TEST', 0x0937, CODE_CALL, tokens)]);
  const disks = { stara: new Uint8Array(), starb: new Uint8Array() };
  const bounded = new ForthBootRunner(engine, new Uint8Array(), disks, { traceLines: 4 }).run();
  // 10 literals, the return, and the STOP line: 12 lines, the last 4 kept.
  assert.equal(bounded.droppedTraceLines, 8);
  assert.deepEqual(bounded.trace.map(line => line.trim().split(' ')[0]), ['9', '10', '11', 'STOP']);
  const full = new ForthBootRunner(engine, new Uint8Array(), disks, { traceLines: Infinity }).run();
  assert.equal(full.droppedTraceLines, 0);
  assert.equal(full.trace.length, 12);
});

test('a started run advances in slices, pauses in (KEY), and resumes when a key is pressed', () => {
  const key = word('(KEY)', 0x25d5, 0x25d7);
  const call = (index: number): ForthToken => ({
    addr: 0x1000 + index * 2, addrHex: `0x${(0x1000 + index * 2).toString(16)}`, cfa: key.cfa, cfaHex: key.cfaHex, name: key.name, kind: 'call'
  });
  const entry = word('TEST', 0x0937, CODE_CALL, [
    { addr: 0x0ff0, addrHex: '0x0ff0', cfa: 0, cfaHex: '0x0000', name: '7', kind: 'lit', arg: 7 },
    call(0), call(1),
    { addr: 0x1004, addrHex: '0x1004', cfa: CFA_EXIT1, cfaHex: '0x1690', name: ';', kind: 'exit' }
  ]);
  const runner = new ForthBootRunner(new ForthEngine([key, entry]), new Uint8Array(), { stara: new Uint8Array(), starb: new Uint8Array() });
  runner.start();
  assert.equal(runner.advance(1), 'running'); // the literal
  assert.equal(runner.advance(100), 'waiting'); // the first (KEY)
  assert.equal(runner.advance(100), 'waiting'); // still no key
  assert.equal(runner.snapshot().steps, 1);
  assert.equal(runner.snapshot().waitingForKey, true);
  runner.pressKey(biosKey('A')!);
  assert.equal(runner.advance(100), 'waiting'); // the second (KEY)
  runner.pressKey(biosKey('B')!);
  assert.equal(runner.advance(100), 'stopped');
  const result = runner.snapshot();
  assert.equal(result.stopReason, 'Forth returned from the entry word.');
  assert.equal(result.waitingForKey, false);
  assert.match(result.trace.at(-2)!, /\[0x0007 0x0041 0x0042\] return$/);
});

test('pressKey keeps at most 15 keys waiting, like the BIOS keyboard buffer', () => {
  const runner = new ForthBootRunner(new ForthEngine([word('TEST', 0x0937, CODE_CALL, [])]), new Uint8Array(), { stara: new Uint8Array(), starb: new Uint8Array() });
  runner.start();
  const accepted = Array.from({ length: 20 }, () => runner.pressKey(biosKey('ArrowUp')!));
  assert.equal(accepted.filter(Boolean).length, 15);
  assert.equal(runner.pendingKeys, 15);
  assert.equal(accepted[15], false);
});

test('run() presses timed keys at their step, or as soon as (KEY) waits for one', () => {
  const key = word('(KEY)', 0x25d5, 0x25d7);
  const terminal = word('(?TERMINAL)', 0x25ba, 0x25bc);
  const call = (target: ForthWord, index: number): ForthToken => ({
    addr: 0x1000 + index * 2, addrHex: `0x${(0x1000 + index * 2).toString(16)}`, cfa: target.cfa, cfaHex: target.cfaHex, name: target.name, kind: 'call'
  });
  // ?TERMINAL ?TERMINAL ?TERMINAL (KEY) ;
  const entry = word('TEST', 0x0937, CODE_CALL, [
    call(terminal, 0), call(terminal, 1), call(terminal, 2), call(key, 3),
    { addr: 0x1008, addrHex: '0x1008', cfa: CFA_EXIT1, cfaHex: '0x1690', name: ';', kind: 'exit' }
  ]);
  const runner = new ForthBootRunner(new ForthEngine([key, terminal, entry]), new Uint8Array(), { stara: new Uint8Array(), starb: new Uint8Array() });
  // 'A' arrives once two steps have run: only the third ?TERMINAL sees it, and (KEY) then reads it.
  const midRun = runner.run(0x0937, 100, [], [{ step: 2, key: biosKey('A')! }]);
  assert.equal(midRun.stopReason, 'Forth returned from the entry word.', midRun.trace.join('\n'));
  assert.match(midRun.trace.at(-2)!, /\[0x0000 0x0000 0x0001 0x0041\] return$/);
  // 'B' is due at step 50, but (KEY) is already waiting at step 3, so it is pressed then.
  const early = runner.run(0x0937, 100, [], [{ step: 50, key: biosKey('B')! }]);
  assert.equal(early.stopReason, 'Forth returned from the entry word.');
  assert.match(early.trace.at(-2)!, /\[0x0000 0x0000 0x0000 0x0042\] return$/);
});

test('breakpoints pause advance() before each call to the word, and the next advance() makes the call', () => {
  const lit = (addr: number, value: number): ForthToken => ({ addr, addrHex: `0x${addr.toString(16)}`, cfa: 0, cfaHex: '0x0000', name: String(value), kind: 'lit', arg: value });
  const exit = (addr: number): ForthToken => ({ addr, addrHex: `0x${addr.toString(16)}`, cfa: CFA_EXIT1, cfaHex: '0x1690', name: ';', kind: 'exit' });
  const inner = word('INNER', 0x2000, CODE_CALL, [lit(0x2002, 5), exit(0x2006)]);
  const call = (addr: number): ForthToken => ({ addr, addrHex: `0x${addr.toString(16)}`, cfa: inner.cfa, cfaHex: inner.cfaHex, name: inner.name, kind: 'call' });
  const entry = word('TEST', 0x0937, CODE_CALL, [lit(0x1000, 1), call(0x1004), call(0x1006), exit(0x1008)]);
  const runner = new ForthBootRunner(new ForthEngine([inner, entry]), new Uint8Array(), { stara: new Uint8Array(), starb: new Uint8Array() });
  runner.setBreakpoint('KERNEL', inner.cfa);
  runner.start();
  assert.equal(runner.advance(100), 'break'); // before the first call, after the literal
  assert.equal(runner.snapshot().steps, 1);
  assert.equal(runner.advance(100), 'break'); // the first call ran; paused before the second
  assert.equal(runner.snapshot().steps, 4);
  assert.equal(runner.advance(100), 'stopped');
  assert.match(runner.snapshot().trace.at(-2)!, /\[0x0001 0x0005 0x0005\] return$/);
  // run() passes breakpoints without pausing.
  assert.equal(runner.run().stopReason, 'Forth returned from the entry word.');
});

test('0> is true for positive cells, and for 8000h as on the 8086', () => {
  const positive = word('0>', 0x129f, 0x12a1);
  const tokens: ForthToken[] = [];
  [5, 0, 0xffff, 0x8000].forEach((value, index) => {
    tokens.push({ addr: 0x1000 + index * 6, addrHex: '0x1000', cfa: 0, cfaHex: '0x0000', name: String(value), kind: 'lit', arg: value });
    tokens.push({ addr: 0x1004 + index * 6, addrHex: '0x1004', cfa: positive.cfa, cfaHex: positive.cfaHex, name: positive.name, kind: 'call' });
  });
  tokens.push({ addr: 0x1100, addrHex: '0x1100', cfa: CFA_EXIT1, cfaHex: '0x1690', name: ';', kind: 'exit' });
  const result = runImage([positive, word('TEST', 0x0937, CODE_CALL, tokens)], new Uint8Array());
  assert.match(result.trace.at(-2)!, /\[0x0001 0x0000 0x0000 0x0001\] return$/);
});

test('U* multiplies unsigned cells into a double, low cell first', () => {
  const multiply = word('U*', 0x11d6, 0x11d8);
  const lit = (addr: number, value: number): ForthToken => ({ addr, addrHex: `0x${addr.toString(16)}`, cfa: 0, cfaHex: '0x0000', name: String(value), kind: 'lit', arg: value });
  const entry = word('TEST', 0x0937, CODE_CALL, [
    lit(0x1000, 0xffff), lit(0x1004, 0xffff),
    { addr: 0x1008, addrHex: '0x1008', cfa: multiply.cfa, cfaHex: multiply.cfaHex, name: multiply.name, kind: 'call' },
    { addr: 0x100a, addrHex: '0x100a', cfa: CFA_EXIT1, cfaHex: '0x1690', name: ';', kind: 'exit' }
  ]);
  const result = runImage([multiply, entry], new Uint8Array());
  assert.match(result.trace.at(-2)!, /\[0x0001 0xfffe\] return$/); // FFFFh * FFFFh = FFFE0001h
});

test('the context stack keeps 3-byte entries below CXSP: >C, CDEPTH, CI, C>', () => {
  const toContext = word('>C', 0x753d, 0x753f);
  const fromContext = word('C>', 0x7558, 0x755a);
  const top = word('CI', 0x7575, 0x7577);
  const depth = word('CDEPTH', 0x75d5, 0x75d7);
  let addr = 0x1000;
  const step = (target: ForthWord | number): ForthToken => {
    const token: ForthToken = typeof target === 'number'
      ? { addr, addrHex: `0x${addr.toString(16)}`, cfa: 0, cfaHex: '0x0000', name: String(target), kind: 'lit', arg: target }
      : { addr, addrHex: `0x${addr.toString(16)}`, cfa: target.cfa, cfaHex: target.cfaHex, name: target.name, kind: 'call' };
    addr += 4;
    return token;
  };
  // 1234h 56h >C CDEPTH CI C> CDEPTH
  const entry = word('TEST', 0x0937, CODE_CALL, [
    step(0x1234), step(0x56), step(toContext), step(depth), step(top), step(fromContext), step(depth),
    { addr, addrHex: `0x${addr.toString(16)}`, cfa: CFA_EXIT1, cfaHex: '0x1690', name: ';', kind: 'exit' }
  ]);
  const image = new Uint8Array(0x6400);
  image.set([0x98, 0x63], 0x54b0 - 0x100); // CXSP = 6398h, the empty stack
  const runner = new ForthBootRunner(new ForthEngine([toContext, fromContext, top, depth, entry]), image, { stara: new Uint8Array(), starb: new Uint8Array() });
  const result = runner.run();
  assert.equal(result.stopReason, 'Forth returned from the entry word.', result.trace.join('\n'));
  assert.match(result.trace.at(-2)!, /\[0x0001 0x1234 0x0056 0x1234 0x0056 0x0000\] return$/);
  assert.deepEqual(Array.from(runner.readMemory(0x0192, 0x6398, 3)), [0x34, 0x12, 0x56]);
});

test('1.5! and 1.5@ store and fetch a cell plus a byte', () => {
  const store = word('<1.5!>', 0x4c08, 0x49ae);
  const fetch = word('1.5@', 0x4995, 0x4997);
  const lit = (addr: number, value: number): ForthToken => ({ addr, addrHex: `0x${addr.toString(16)}`, cfa: 0, cfaHex: '0x0000', name: String(value), kind: 'lit', arg: value });
  const call = (addr: number, target: ForthWord): ForthToken => ({ addr, addrHex: `0x${addr.toString(16)}`, cfa: target.cfa, cfaHex: target.cfaHex, name: target.name, kind: 'call' });
  // 1234h 1FFh 6000h <1.5!>  6000h 1.5@
  const entry = word('TEST', 0x0937, CODE_CALL, [
    lit(0x1000, 0x1234), lit(0x1004, 0x01ff), lit(0x1008, 0x6000), call(0x100c, store), lit(0x100e, 0x6000), call(0x1012, fetch),
    { addr: 0x1014, addrHex: '0x1014', cfa: CFA_EXIT1, cfaHex: '0x1690', name: ';', kind: 'exit' }
  ]);
  const runner = new ForthBootRunner(new ForthEngine([store, fetch, entry]), new Uint8Array(), { stara: new Uint8Array(), starb: new Uint8Array() });
  const result = runner.run();
  assert.match(result.trace.at(-2)!, /\[0x1234 0x00ff\] return$/); // only the low byte of the high part is kept
  assert.deepEqual(Array.from(runner.readMemory(0x0192, 0x6000, 3)), [0x34, 0x12, 0xff]);
});

test('PRIORIT swaps an instance-cache entry with the one before it in all three tables', () => {
  const priority = word('PRIORIT', 0x7682, 0x7684);
  const ioff = word('@[IOFF]', 0x7638, 0x763a);
  const lit = (addr: number, value: number): ForthToken => ({ addr, addrHex: `0x${addr.toString(16)}`, cfa: 0, cfaHex: '0x0000', name: String(value), kind: 'lit', arg: value });
  const call = (addr: number, target: ForthWord): ForthToken => ({ addr, addrHex: `0x${addr.toString(16)}`, cfa: target.cfa, cfaHex: target.cfaHex, name: target.name, kind: 'call' });
  const entry = word('TEST', 0x0937, CODE_CALL, [
    lit(0x1000, 4), call(0x1004, priority), lit(0x1006, 0), call(0x100a, priority), call(0x100c, ioff),
    { addr: 0x100e, addrHex: '0x100e', cfa: CFA_EXIT1, cfaHex: '0x1690', name: ';', kind: 'exit' }
  ]);
  const image = new Uint8Array(0x5600);
  const poke = (address: number, ...bytes: number[]) => image.set(bytes, address - 0x100);
  // Tables inside the image: LOISEG = CS:0400h, LOCSEC = CS:0500h (words), HIISEG = CS:0600h (bytes)
  poke(0x54ea, 0xd2, 0x01);
  poke(0x54f2, 0xe2, 0x01);
  poke(0x54ee, 0xf2, 0x01);
  poke(0x0400, 0xa0, 0, 0xa1, 0, 0xa2, 0);
  poke(0x0500, 0xb0, 0, 0xb1, 0, 0xb2, 0);
  poke(0x0600, 0xc0, 0xc1, 0xc2);
  poke(0x558c, 0x34, 0x12); // [IOFF]
  const runner = new ForthBootRunner(new ForthEngine([priority, ioff, entry]), image, { stara: new Uint8Array(), starb: new Uint8Array() });
  const result = runner.run();
  assert.equal(result.stopReason, 'Forth returned from the entry word.', result.trace.join('\n'));
  assert.match(result.trace.at(-2)!, /\[0x0002 0x0000 0x1234\] return$/);
  assert.deepEqual(Array.from(runner.readMemory(0x0192, 0x0400, 6)), [0xa0, 0, 0xa2, 0, 0xa1, 0]);
  assert.deepEqual(Array.from(runner.readMemory(0x0192, 0x0500, 6)), [0xb0, 0, 0xb2, 0, 0xb1, 0]);
  assert.deepEqual(Array.from(runner.readMemory(0x0192, 0x0600, 3)), [0xc0, 0xc2, 0xc1]);
});

test('instance-field words (DOES> IFLDADR) address their offset in the record at 63EFh', () => {
  const fieldAddress = word('IFLDADR', 0x7423, 0x7425);
  const field = { ...word('INST-X', 0x0500, 0x744d), type: 'afield' as const };
  const entry = word('TEST', 0x0937, CODE_CALL, [
    { addr: 0x1000, addrHex: '0x1000', cfa: field.cfa, cfaHex: field.cfaHex, name: field.name, kind: 'call' },
    { addr: 0x1002, addrHex: '0x1002', cfa: CFA_EXIT1, cfaHex: '0x1690', name: ';', kind: 'exit' }
  ]);
  const image = new Uint8Array(0x7500);
  const poke = (address: number, ...bytes: number[]) => image.set(bytes, address - 0x100);
  const rel = (0x1649 - 0x7450) & 0xffff;
  poke(0x744d, 0xe8, rel & 0xff, rel >> 8, 0x23, 0x74, 0x90, 0x16); // call DODOES; IFLDADR ;
  poke(field.pfa, 0x00, 0x0b, 0x02); // descriptor: offset 0Bh
  const result = runImage([fieldAddress, field, entry], image);
  assert.equal(result.stopReason, 'Forth returned from the entry word.', result.trace.join('\n'));
  assert.match(result.trace.at(-2)!, /\[0x63fa\] return$/); // 63EFh + 0Bh
});

test('>V, VI, and V> push, peek, and pop the V stack at VSP', () => {
  const toV = word('>V', 0x7ae5, 0x7ae7);
  const fromV = word('V>', 0x7afc, 0x7afe);
  const peek = word('VI', 0x7b13, 0x7b15);
  const lit = (addr: number, value: number): ForthToken => ({ addr, addrHex: `0x${addr.toString(16)}`, cfa: 0, cfaHex: '0x0000', name: String(value), kind: 'lit', arg: value });
  const call = (addr: number, target: ForthWord): ForthToken => ({ addr, addrHex: `0x${addr.toString(16)}`, cfa: target.cfa, cfaHex: target.cfaHex, name: target.name, kind: 'call' });
  const entry = word('TEST', 0x0937, CODE_CALL, [
    lit(0x1000, 0x1111), call(0x1004, toV), lit(0x1006, 0x2222), call(0x100a, toV), call(0x100c, peek), call(0x100e, fromV), call(0x1010, peek),
    { addr: 0x1012, addrHex: '0x1012', cfa: CFA_EXIT1, cfaHex: '0x1690', name: ';', kind: 'exit' }
  ]);
  const image = new Uint8Array(0x6400);
  image.set([0xdf, 0x63], 0x54b4 - 0x100); // VSP as shipped (63DFh)
  const runner = new ForthBootRunner(new ForthEngine([toV, fromV, peek, entry]), image, { stara: new Uint8Array(), starb: new Uint8Array() });
  const result = runner.run();
  assert.equal(result.stopReason, 'Forth returned from the entry word.', result.trace.join('\n'));
  assert.match(result.trace.at(-2)!, /\[0x2222 0x2222 0x1111\] return$/);
  assert.deepEqual(Array.from(runner.readMemory(0x0192, 0x54b4, 2)), [0xdd, 0x63]); // one entry left
});

test('headerless DOES> words are inferred from a code field that calls DODOES', () => {
  const fieldAddress = word('IFLDADR', 0x7423, 0x7425);
  const entry = word('TEST', 0x0937, CODE_CALL, [
    { addr: 0x1000, addrHex: '0x1000', cfa: 0x0500, cfaHex: '0x0500', name: '[.', kind: 'call' }, // not in the dictionary
    { addr: 0x1002, addrHex: '0x1002', cfa: CFA_EXIT1, cfaHex: '0x1690', name: ';', kind: 'exit' }
  ]);
  const image = new Uint8Array(0x7500);
  const poke = (address: number, ...bytes: number[]) => image.set(bytes, address - 0x100);
  const rel = (0x1649 - 0x7450) & 0xffff;
  poke(0x744d, 0xe8, rel & 0xff, rel >> 8, 0x23, 0x74, 0x90, 0x16); // call DODOES; IFLDADR ;
  poke(0x0500, 0x4d, 0x74, 0x11, 0x11, 0x12); // like CHKFLIGHT-OV's [. at F1B9h: offset 11h
  const result = runImage([fieldAddress, entry], image);
  assert.equal(result.stopReason, 'Forth returned from the entry word.', result.trace.join('\n'));
  assert.match(result.trace.at(-2)!, /\[0x6400\] return$/); // 63EFh + 11h
});

test('headerless colon words are decoded from memory, including code after an early EXIT', () => {
  const entry = word('TEST', 0x0937, CODE_CALL, [
    { addr: 0x1000, addrHex: '0x1000', cfa: 0x0500, cfaHex: '0x0500', name: 'W_0x0500', kind: 'call' }, // not in the dictionary
    { addr: 0x1002, addrHex: '0x1002', cfa: 0x0600, cfaHex: '0x0600', name: 'W_0x0600', kind: 'call' },
    { addr: 0x1004, addrHex: '0x1004', cfa: CFA_EXIT1, cfaHex: '0x1690', name: ';', kind: 'exit' }
  ]);
  const image = new Uint8Array(0x800);
  const poke = (address: number, ...bytes: number[]) => image.set(bytes, address - 0x100);
  poke(0x0500, 0x4c, 0x22, 0x5d, 0x17, 0x07, 0x00, 0x90, 0x16); // : 7 ;
  // : 0 IF ; THEN 9 ;  -- 0BRANCH at 0606h skips the EXIT at 060Ah to 060Ch
  poke(0x0600, 0x4c, 0x22, 0x5d, 0x17, 0x00, 0x00, 0xfa, 0x15, 0x04, 0x00, 0x90, 0x16, 0x5d, 0x17, 0x09, 0x00, 0x90, 0x16);
  const result = runImage([entry], image);
  assert.equal(result.stopReason, 'Forth returned from the entry word.', result.trace.join('\n'));
  assert.match(result.trace.at(-2)!, /\[0x0007 0x0009\] return$/);
});

test('FRND steps SEED with SEED * 7ABDh + 1B0Fh', () => {
  const random = word('FRND', 0x4ab9, 0x4abb);
  const call = (index: number): ForthToken => ({
    addr: 0x1000 + index * 2, addrHex: `0x${(0x1000 + index * 2).toString(16)}`, cfa: random.cfa, cfaHex: random.cfaHex, name: random.name, kind: 'call'
  });
  const entry = word('TEST', 0x0937, CODE_CALL, [call(0), call(1), { addr: 0x1004, addrHex: '0x1004', cfa: CFA_EXIT1, cfaHex: '0x1690', name: ';', kind: 'exit' }]);
  const image = new Uint8Array(0x4c00);
  image.set([14820 & 0xff, 14820 >> 8], 0x4ab0 - 0x100); // SEED as shipped
  const result = runImage([random, entry], image);
  // 14820 * 31421 + 6927 = 465666147 = 0x1BC18063; then 0x8063 * 0x7ABD + 0x1B0F, low 16 bits
  const second = (Math.imul(0x8063, 0x7abd) + 0x1b0f) & 0xffff;
  assert.match(result.trace.at(-2)!, new RegExp(`\\[0x8063 0x${second.toString(16).padStart(4, '0')}\\] return$`));
});

test('CAPSON sets the BIOS keyboard flags at 0040:0017 to Caps Lock', () => {
  const capsOn = word('CAPSON', 0x4890, 0x4892);
  const entry = word('TEST', 0x0937, CODE_CALL, [
    { addr: 0x1000, addrHex: '0x1000', cfa: capsOn.cfa, cfaHex: capsOn.cfaHex, name: capsOn.name, kind: 'call' },
    { addr: 0x1002, addrHex: '0x1002', cfa: CFA_EXIT1, cfaHex: '0x1690', name: ';', kind: 'exit' }
  ]);
  const runner = new ForthBootRunner(new ForthEngine([capsOn, entry]), new Uint8Array(), { stara: new Uint8Array(), starb: new Uint8Array() });
  assert.equal(runner.run().stopReason, 'Forth returned from the entry word.');
  assert.equal(runner.readMemory(0x0040, 0x0017, 1)[0], 0x40);
});

test('BEXTENT pushes the blit box from XBLT, YBLT, WBLT, and LBLT', () => {
  const extent = word('BEXTENT', 0x93af, 0x93b1);
  const entry = word('TEST', 0x0937, CODE_CALL, [
    { addr: 0x1000, addrHex: '0x1000', cfa: extent.cfa, cfaHex: extent.cfaHex, name: extent.name, kind: 'call' },
    { addr: 0x1002, addrHex: '0x1002', cfa: CFA_EXIT1, cfaHex: '0x1690', name: ';', kind: 'exit' }
  ]);
  const image = new Uint8Array(0x5900);
  const pokeWord = (address: number, value: number) => image.set([value & 0xff, value >> 8], address - 0x100);
  pokeWord(0x586e, 60); // XBLT
  pokeWord(0x5863, 199); // YBLT
  pokeWord(0x5892, 3); // WBLT
  pokeWord(0x5887, 5); // LBLT
  const result = runImage([extent, entry], image);
  assert.match(result.trace.at(-2)!, /\[0x003c 0x00c3 0x003e 0x00c7\] return$/); // 60 195 62 199
});

test('?EXTENTX outcodes the box corners against the clip window', () => {
  const extent = word('?EXTENTX', 0x938e, 0x9390);
  const lit = (addr: number, value: number): ForthToken => ({ addr, addrHex: `0x${addr.toString(16)}`, cfa: 0, cfaHex: '0x0000', name: String(value), kind: 'lit', arg: value });
  // left bottom right top = -2 100 10 205: the left edge is past ILEFT, the top past IABOVE
  const entry = word('TEST', 0x0937, CODE_CALL, [
    lit(0x1000, 0xfffe), lit(0x1004, 100), lit(0x1008, 10), lit(0x100c, 205),
    { addr: 0x1010, addrHex: '0x1010', cfa: extent.cfa, cfaHex: extent.cfaHex, name: extent.name, kind: 'call' },
    { addr: 0x1012, addrHex: '0x1012', cfa: CFA_EXIT1, cfaHex: '0x1690', name: ';', kind: 'exit' }
  ]);
  const image = new Uint8Array(0x6200);
  const pokeWord = (address: number, value: number) => image.set([value & 0xff, value >> 8], address - 0x100);
  pokeWord(0x569b, 0x6000); // VIN
  pokeWord(0x56b0, 0x6100); // OIN
  pokeWord(0x5738, 0); // ILEFT
  pokeWord(0x5745, 159); // IRIGHT
  pokeWord(0x5752, 0); // IBELOW
  pokeWord(0x575f, 199); // IABOVE
  const runner = new ForthBootRunner(new ForthEngine([extent, entry]), image, { stara: new Uint8Array(), starb: new Uint8Array() });
  const result = runner.run();
  assert.equal(result.stopReason, 'Forth returned from the entry word.', result.trace.join('\n'));
  // Corners (top, right) = (205, 10): above; (bottom, left) = (100, -2): left.
  assert.deepEqual(Array.from(runner.readMemory(0x0192, 0x6000, 8)), [205, 0, 10, 0, 100, 0, 0xfe, 0xff]);
  assert.deepEqual(Array.from(runner.readMemory(0x0192, 0x6100, 2)), [8, 1]);
  assert.match(result.trace[4], /box outcodes: TRJCT 0 TACCPT 9$/);
});

test('R/W wraps physical transfers at the 20-bit real-mode boundary', () => {
  const stara = Uint8Array.from({ length: BLOCK_SIZE }, (_, index) => index & 0xff);
  const result = createRunner([
    ...transfer(0xffff, 8, 1500),
    0xffff, 8, 'LC@',
    0, 0, 'LC@',
    0, BLOCK_SIZE - 9, 'LC@'
  ], stara, new Uint8Array(BLOCK_SIZE)).run();
  assert.equal(result.stopReason, 'Forth returned from the entry word.');
  assert.match(result.trace.at(-2)!, /\[0x0000 0x0008 0x00ff\] return$/);
});
test('planet densities and gravity follow PLAN-RUL: PLANET records above species 17, the game\'s arrival roll below', async () => {
  const [stara, starb, starflt] = await Promise.all(['STARA.COM', 'STARB.COM', 'STARFLT.COM']
    .map(name => readFile(new URL(`../public/${name}`, import.meta.url)).then(bytes => Uint8Array.from(bytes))));
  const dictionary = await readFile(new URL('../public/forth-dict.json', import.meta.url), 'utf8');
  const engine = await createForthEngine(stara.slice().buffer, starb.slice().buffer, starflt.slice().buffer, JSON.parse(dictionary));
  const plset = engine.overlays.get('PLSET-OV')!.memory;
  const table = (name: string) => {
    const pfa = engine.words.find(word => word.name === name && word.module === 'PLSET-OV')!.pfa;
    return (planetClass: number) => plset[pfa + planetClass * 2] | (plset[pfa + planetClass * 2 + 1] << 8);
  };
  const fs = createStarflightFS(stara.buffer, starb.buffer);
  const planetFile = fs.get('PLANET')!;
  const systems = extractStarSystems(fs.starb, {
    planetRecord: species => fs.getRecord(planetFile, species), starflt, massTables: { low: table('LO-MASS'), high: table('HI-MASS') }
  });
  const planet = (x: number, y: number, orbit: number) => {
    const found = systems.find(system => system.x === x && system.y === y)!.planets.find(p => p.orbit === orbit)!;
    return [found.minerals, found.bio, found.gravity, found.rolled];
  };
  // Values checked against the emulated game: SCIENCE's MIN/BIO fields and .GRAV's mass after PLSET-OV's setup.
  assert.deepEqual(planet(125, 100, 3), [39, 100, 1.08, undefined]); // Arth, species 58
  assert.deepEqual(planet(2, 34, 2), [52, 0, 0.9, true]); // species 7
  assert.deepEqual(planet(2, 206, 3), [50, 0, 13.8, true]); // species 17, above the 800 mass knee
  assert.deepEqual(planet(4, 34, 7), [7, 0, 0.91, true]);
  const all = systems.flatMap(system => system.planets);
  assert.equal(all.length, 811);
  assert.equal(all.filter(p => p.minerals === undefined || p.bio === undefined || p.gravity === undefined).length, 0);
});

test('continuum fluxes come from the 64 FLUX-NODE instances, in mirrored pairs', async () => {
  const [stara, starb] = await Promise.all(['STARA.COM', 'STARB.COM']
    .map(name => readFile(new URL(`../public/${name}`, import.meta.url)).then(bytes => Uint8Array.from(bytes))));
  const fluxes = extractFluxes(createStarflightFS(stara.buffer, starb.buffer).starb).map(f => `${f.x},${f.y}>${f.destX},${f.destY}`);
  assert.equal(fluxes.length, 64);
  for (const flux of fluxes) {
    const [from, to] = flux.split('>');
    assert.ok(fluxes.includes(`${to}>${from}`), `${flux} has a way back`);
  }
  // starflt.com lists 56,142 - 40,146; the game's node goes to 60,146.
  assert.ok(fluxes.includes('56,142>60,146') && fluxes.includes('69,66>98,79') && fluxes.includes('55,99>248,1'));
});

test('creditBalance books MU as a committed BONUS transaction at the next keyboard poll, leaving the game as it was', async () => {
  const { engine, image, disks, checkpoint } = await realNativeFixture();
  const runner = new ForthBootRunner(engine, image, disks);
  runner.loadState(structuredClone(checkpoint));
  type Internals = { session: { frames: unknown[]; dataStack: { pointer: number }; returnStack: unknown[] }; pendingCalls: unknown[] };
  const internals = runner as unknown as Internals;
  const session = internals.session;
  const overlay = () => [...runner.readMemory(0x0192, 0x55a5, 2)];
  const state = () => [session.frames.length, session.dataStack.pointer, session.returnStack.length, ...overlay()];
  const scratch = 0x0110; // COM startup code, unused once booted
  const balance = () => {
    const depth = session.frames.length;
    runner.queueCall([engine.words.find(word => word.name === 'OVD@BALANCE')!.pfa, 'MODULE', scratch, '2!']);
    for (let steps = 0; session.frames.length > depth && steps < 1_000_000; steps++) runner.advance(1);
    const [lowLow, lowHigh, highLow, highHigh] = runner.readMemory(0x0192, scratch, 4);
    return (highLow | (highHigh << 8)) + (lowLow | (lowHigh << 8)) * 0x10000; // 2! stores the high cell first
  };
  const before = balance();
  assert.ok(runner.creditBalance(100000));
  // It waits for a keyboard poll, then runs as a call there and returns to the poll.
  let atPoll: number[] | undefined;
  for (let steps = 0; !atPoll && steps < 2_000_000; steps++) {
    const current = state();
    runner.advance(1);
    if (internals.pendingCalls.length === 0) atPoll = current;
  }
  assert.ok(atPoll, 'the credit ran at a keyboard poll');
  for (let steps = 0; session.frames.length > atPoll[0] && steps < 1_000_000; steps++) runner.advance(1);
  assert.deepEqual(state(), atPoll);
  assert.equal(balance() - before, 100000);
  // Committed: the Bank screen's INIT-BALANCE resets the balance to the committed one, which now includes it.
  const depth = session.frames.length;
  runner.queueCall([engine.words.find(word => word.name === 'OVINIT-BALANCE')!.pfa, 'MODULE']);
  for (let steps = 0; session.frames.length > depth && steps < 1_000_000; steps++) runner.advance(1);
  assert.equal(balance() - before, 100000);
});

test('save files round-trip a checkpoint exactly and refuse other game programs', async () => {
  const { engine, image, disks, checkpoint } = await realNativeFixture();
  const game = { machine: checkpoint, keysTyped: 3, fastForward: false, autoEga: true, skipIntro: false, cpuSpeed: 170 };
  const file = await encodeSaveFile(game, image);
  assert.deepEqual([...new Uint8Array(await file.slice(0, 2).arrayBuffer())], [0x1f, 0x8b]); // gzip
  const restored = await decodeSaveFile(file, image) as typeof game;
  assert.deepEqual(restored, game);
  assert.ok(restored.machine.physicalMemory instanceof Uint8Array);

  // Both runs continue identically.
  const [original, reloaded] = [checkpoint, restored.machine].map(state => {
    const runner = new ForthBootRunner(engine, image, disks);
    runner.loadState(structuredClone(state));
    runner.advance(50_000);
    return runner.snapshot();
  });
  assert.equal(reloaded.steps, original.steps);
  assert.deepEqual(reloaded.trace.slice(-20), original.trace.slice(-20));

  const otherProgram = image.slice();
  otherProgram[0x200] ^= 1;
  await assert.rejects(decodeSaveFile(file, otherProgram), /different STARFLT\.COM/);
  await assert.rejects(decodeSaveFile(new Blob(['hello']), image), /not a Starflight save file/);
});

test('BYE reports the return to DOS, as after saving the game', async () => {
  const fixture = await realNativeFixture();
  const runner = new ForthBootRunner(fixture.engine, fixture.image, fixture.disks);
  const result = runner.run(0x085b, 1_000); // BYE_2: FREEZE (RESTORE) 0 GO
  assert.equal(result.stopReason, 'The game exited to DOS.', result.trace.join('\n'));
  assert.equal(result.exitedToDos, true);
  assert.equal(runner.run(0x0937, 10).exitedToDos, false);
});
