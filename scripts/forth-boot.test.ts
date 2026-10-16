import assert from 'node:assert/strict';
import test from 'node:test';
import { ForthBootRunner } from '../src/forth-boot.ts';
import { CODE_CALL, CFA_EXIT1, ForthEngine, type ForthToken, type ForthWord } from '../src/forth-decompiler.ts';
import { BLOCK_SIZE } from '../src/starflight-fs.ts';

type Operation = number | string;

function createRunner(operations: Operation[], stara: Uint8Array, starb: Uint8Array): ForthBootRunner {
  const names = ['R/W', 'LC@', 'LC!', 'C@', 'C!'];
  const primitives: ForthWord[] = names.map((name, index) => ({
    name: name === 'C!' ? 'C!_2' : name,
    cfa: 0x200 + index * 2,
    cfaHex: `0x${(0x200 + index * 2).toString(16)}`,
    pfa: 0,
    pfaHex: '0x0000',
    codep: name === 'LC@' ? 0x2ecd : 0,
    codepHex: name === 'LC@' ? '0x2ecd' : '0x0000',
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
  return new ForthBootRunner(new ForthEngine([...primitives, entry]), new Uint8Array(), { stara, starb });
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

test('overlay words run only while OV# names their overlay', () => {
  const overlayWord = word('TEST-OV', 0x0400, 0x83f8); // kernel OVERLAY word; PFA holds the VSA
  const inOverlay: ForthWord = {
    ...word('GREET', 0xe010, CODE_CALL, [
      { addr: 0xe012, addrHex: '0xe012', cfa: 0, cfaHex: '0x0000', name: '42', kind: 'lit', arg: 42 },
      { addr: 0xe016, addrHex: '0xe016', cfa: CFA_EXIT1, cfaHex: '0x1690', name: ';', kind: 'exit' }
    ]),
    module: 'TEST-OV'
  };
  const entry = word('TEST', 0x0937, CODE_CALL, [
    { addr: 0x1000, addrHex: '0x1000', cfa: inOverlay.cfa, cfaHex: inOverlay.cfaHex, name: inOverlay.name, kind: 'call' },
    { addr: 0x1002, addrHex: '0x1002', cfa: CFA_EXIT1, cfaHex: '0x1690', name: ';', kind: 'exit' }
  ]);
  for (const loadedVsa of [0x8f71, 0x1234]) {
    const image = new Uint8Array(0x5600);
    image.set([0x71, 0x8f], overlayWord.pfa - 0x100);
    image.set([loadedVsa & 0xff, loadedVsa >> 8], 0x55a5 - 0x100); // OV#
    const result = runImage([overlayWord, inOverlay, entry], image);
    if (loadedVsa === 0x8f71) {
      assert.equal(result.stopReason, 'Forth returned from the entry word.');
      assert.match(result.trace[1], /^ *2 TEST-OV:GREET 42  \[0x002a\] literal$/);
    } else {
      assert.equal(result.stopReason, 'GREET is in overlay TEST-OV, but OV# = 0x1234 (no known overlay) is loaded.');
    }
  }
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