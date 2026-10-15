import { disassembleX86 } from './x86-disassembler';

const COM_LOAD_ADDRESS = 0x100;
const MAX_DECODE_BYTES = 512;
const MAX_INSTRUCTIONS = 128;

export class KernelDisassembler {
  private bytes: Uint8Array;
  private container: HTMLElement | null = null;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  mount(target: HTMLElement) {
    this.container = target;
    this.render();
  }

  private render() {
    if (!this.container) return;

    this.container.innerHTML = `
      <section style="display: flex; flex-direction: column; gap: 16px;">
        <header style="display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 12px; border-bottom: 1px solid #232a3d; padding-bottom: 12px;">
          <div>
            <h2 style="font-size: 16px; color: #82aaff; margin: 0;">STARFLT.COM x86 Disassembly</h2>
            <div style="font-size: 11px; color: #7982a9; margin-top: 4px;">${this.bytes.length.toLocaleString()} bytes · DOS load address 0x0100 · 16-bit x86</div>
          </div>
        </header>

        <div style="display: flex; align-items: end; flex-wrap: wrap; gap: 12px;">
          <label style="display: flex; flex-direction: column; gap: 4px; color: #7982a9; font-size: 11px;">
            Start address
            <input id="kernel-x86-address" type="text" value="0x0100" spellcheck="false"
              style="background: #151822; border: 1px solid #363e58; color: #c3ccdb; padding: 6px 8px; font: inherit; font-size: 12px; width: 112px;" />
          </label>
          <label style="display: flex; flex-direction: column; gap: 4px; color: #7982a9; font-size: 11px;">
            Bytes
            <input id="kernel-x86-length" type="number" min="1" max="${MAX_DECODE_BYTES}" value="128"
              style="background: #151822; border: 1px solid #363e58; color: #c3ccdb; padding: 6px 8px; font: inherit; font-size: 12px; width: 78px;" />
          </label>
          <button id="kernel-x86-disassemble" class="btn" type="button">Disassemble</button>
          <span id="kernel-x86-status" role="status" style="font-size: 11px; color: #7982a9;"></span>
        </div>

        <p style="margin: 0; color: #7982a9; font-size: 12px; line-height: 1.5;">
          Linear decoding is only a view: STARFLT.COM mixes 8086 code with Forth dictionary and data. Start from a known code pointer; bytes after branches or embedded data may decode as misleading instructions.
        </p>

        <pre id="kernel-x86-output" style="margin: 0; max-height: 68vh; overflow: auto; background: #0c0e17; border: 1px solid #1f2537; border-radius: 6px; padding: 14px 18px; font-family: monospace; font-size: 12px; line-height: 1.5; color: #c3ccdb; white-space: pre;">Enter a runtime address and choose Disassemble.</pre>
      </section>
    `;

    const button = this.container.querySelector<HTMLButtonElement>('#kernel-x86-disassemble');
    button?.addEventListener('click', () => void this.disassembleRange());
    this.container.querySelector<HTMLInputElement>('#kernel-x86-address')?.addEventListener('keydown', event => {
      if (event.key === 'Enter') void this.disassembleRange();
    });
    this.container.querySelector<HTMLInputElement>('#kernel-x86-length')?.addEventListener('keydown', event => {
      if (event.key === 'Enter') void this.disassembleRange();
    });
  }

  private async disassembleRange() {
    const addressInput = this.container?.querySelector<HTMLInputElement>('#kernel-x86-address');
    const lengthInput = this.container?.querySelector<HTMLInputElement>('#kernel-x86-length');
    const output = this.container?.querySelector<HTMLElement>('#kernel-x86-output');
    const status = this.container?.querySelector<HTMLElement>('#kernel-x86-status');
    const button = this.container?.querySelector<HTMLButtonElement>('#kernel-x86-disassemble');
    if (!addressInput || !lengthInput || !output || !status || !button) return;

    const address = Number(addressInput.value);
    const requestedLength = Number(lengthInput.value);
    const fileOffset = address - COM_LOAD_ADDRESS;
    if (!Number.isInteger(address) || !Number.isInteger(requestedLength) || requestedLength < 1 || fileOffset < 0 || fileOffset >= this.bytes.length) {
      status.textContent = 'Address or byte count is out of range.';
      return;
    }

    const length = Math.min(requestedLength, MAX_DECODE_BYTES, this.bytes.length - fileOffset);
    const range = this.bytes.subarray(fileOffset, fileOffset + length);
    button.disabled = true;
    status.textContent = 'Disassembling…';
    output.textContent = 'Loading Capstone and decoding bytes...';

    try {
      const listing = await disassembleX86(range, address, MAX_INSTRUCTIONS);
      output.textContent = listing;
      const instructionCount = listing === 'No x86 instructions decoded.' ? 0 : listing.split('\n').length;
      status.textContent = `${instructionCount} instructions · ${length} bytes · file offset 0x${fileOffset.toString(16).padStart(4, '0')}`;
    } catch (error) {
      status.textContent = 'Disassembly failed.';
      output.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      button.disabled = false;
    }
  }
}