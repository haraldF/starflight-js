import assert from 'node:assert/strict';
import test from 'node:test';
import { ForthBootRunner, STEPS_PER_MILLISECOND, biosKey, screenLines } from '../src/forth-boot.ts';
import { CODE_CALL, CFA_EXIT1, ForthEngine, type ForthToken, type ForthWord } from '../src/forth-decompiler.ts';
import { BLOCK_SIZE } from '../src/starflight-fs.ts';
import { EgaAdapter } from '../src/ega.ts';

type Operation = number | string;

const CODE_POINTERS: Record<string, number> = { 'LC@': 0x2ecd, 'C!': 0x0c60 };

function createRunner(operations: Operation[], stara: Uint8Array, starb: Uint8Array): ForthBootRunner {
  const names = ['R/W', 'LC@', 'LC!', 'C@', 'C!'];
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

test('PLOT draws on the hidden EGA page and the latch copy moves all planes to the visible page', () => {
  const lores = word('>LORES', 0x8d89, 0x8d8b);
  const plot = word('PLOT', 0x9365, 0x9367);
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
  const result = runImage([lores, plot, copy, fetchByte, entry], image);
  assert.equal(result.stopReason, 'Forth returned from the entry word.', result.trace.join('\n'));
  assert.match(result.trace[3], /plot 7,4 color 9$/);
  assert.match(result.trace[8], /EGA latch copy 2000h bytes a200:0 -> a000:0$/);
  assert.match(result.trace.at(-2)!, /\[0x0003\] return$/); // x = 7 is the last pair of bits in its byte
  // The snapshot shows logical pixel 7 as hardware pixels 14 and 15 of row 4 in color 9.
  const pixel = (x: number, y: number) => result.graphics!.pixels[y * result.graphics!.width + x];
  assert.deepEqual([pixel(13, 4), pixel(14, 4), pixel(15, 4), pixel(16, 4)], [0, 9, 9, 0]);
});

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