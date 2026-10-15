import capstoneWasmUrl from '@alexaltea/capstone-js/dist/capstone.wasm?url';

interface X86Instruction {
  address: bigint;
  bytes: number[];
  mnemonic: string;
  op_str: string;
}

let decoderPromise: Promise<{ disasm(bytes: Uint8Array, address: number, max?: number): X86Instruction[] }> | undefined;

export async function disassembleX86(bytes: Uint8Array, address: number, maxInstructions = 32): Promise<string> {
  decoderPromise ??= import('@alexaltea/capstone-js').then(async ({ default: createCapstone }) => {
    const capstone = await createCapstone({
      locateFile: (path, prefix) => path.endsWith('.wasm') ? capstoneWasmUrl : `${prefix}${path}`
    });
    return new capstone.Capstone(capstone.ARCH_X86, capstone.MODE_16);
  });

  const decoder = await decoderPromise;
  const instructions = decoder.disasm(bytes, address, maxInstructions);
  if (instructions.length === 0) return 'No x86 instructions decoded.';

  return instructions.map(instruction => {
    const location = instruction.address.toString(16).padStart(4, '0');
    const encoded = instruction.bytes.map(byte => byte.toString(16).padStart(2, '0')).join(' ').padEnd(20, ' ');
    return `${location}:  ${encoded} ${instruction.mnemonic.padEnd(8, ' ')} ${instruction.op_str}`.trimEnd();
  }).join('\n');
}