declare module '@alexaltea/capstone-js' {
  interface CapstoneOptions {
    locateFile?: (path: string, prefix: string) => string;
  }

  interface CapstoneInstruction {
    address: bigint;
    bytes: number[];
    mnemonic: string;
    op_str: string;
  }

  interface CapstoneDecoder {
    disasm(bytes: Uint8Array, address: number, max?: number): CapstoneInstruction[];
    close(): void;
  }

  interface CapstoneModule {
    ARCH_X86: number;
    MODE_16: number;
    Capstone: new (architecture: number, mode: number) => CapstoneDecoder;
  }

  function createCapstone(options?: CapstoneOptions): Promise<CapstoneModule>;

  export default createCapstone;
}