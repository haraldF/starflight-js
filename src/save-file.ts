// Save files: a game checkpoint as gzip-compressed JSON, so it can be downloaded and loaded again in any browser.
// Byte arrays (memory, disk images, EGA planes) are stored as base64. The file names the game program it was made
// with, since the Forth dictionary and the runner's addresses only fit that STARFLT.COM.

const FORMAT = 'starflight-save';
const VERSION = 1;
export const SAVE_FILE_EXTENSION = '.sfsave';

interface SaveFileContents {
  format: typeof FORMAT;
  version: number;
  created: string;
  // FNV-1a of STARFLT.COM, as hex.
  program: string;
  game: unknown;
}

// A short fingerprint of the game program, to recognize save files from other versions.
export function programFingerprint(starflt: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (const byte of starflt) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  return `${starflt.length}-${hash.toString(16).padStart(8, '0')}`;
}

function toBase64(bytes: Uint8Array): string {
  let text = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(text);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function transform(data: Blob, stream: CompressionStream | DecompressionStream): Promise<Blob> {
  return new Response(data.stream().pipeThrough(stream)).blob();
}

// The game state as a save file.
export async function encodeSaveFile(game: unknown, starflt: Uint8Array): Promise<Blob> {
  const contents: SaveFileContents = { format: FORMAT, version: VERSION, created: new Date().toISOString(), program: programFingerprint(starflt), game };
  const json = JSON.stringify(contents, (_key, value: unknown) => value instanceof Uint8Array ? { $bytes: toBase64(value) } : value);
  return transform(new Blob([json], { type: 'application/json' }), new CompressionStream('gzip'));
}

// The game state from a save file; throws a readable error for anything else or a file from another game version.
export async function decodeSaveFile(file: Blob, starflt: Uint8Array): Promise<unknown> {
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  const gzip = head[0] === 0x1f && head[1] === 0x8b;
  let contents: Partial<SaveFileContents>;
  try {
    const json = await (gzip ? await transform(file, new DecompressionStream('gzip')) : file).text();
    contents = JSON.parse(json, (_key, value: unknown) =>
      value !== null && typeof value === 'object' && typeof (value as { $bytes?: unknown }).$bytes === 'string'
        ? fromBase64((value as { $bytes: string }).$bytes) : value);
  } catch {
    throw new Error('This is not a Starflight save file.');
  }
  if (contents?.format !== FORMAT) throw new Error('This is not a Starflight save file.');
  if (contents.version !== VERSION) throw new Error(`This save file has version ${contents.version}; only version ${VERSION} can be loaded.`);
  if (contents.program !== programFingerprint(starflt)) {
    throw new Error('This save file was made with a different STARFLT.COM and cannot be loaded with this one.');
  }
  return contents.game;
}

// A file name for a download, e.g. starflight-2026-10-17-1432.sfsave.
export function saveFileName(date = new Date()): string {
  const two = (value: number) => String(value).padStart(2, '0');
  return `starflight-${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}${SAVE_FILE_EXTENSION}`;
}
