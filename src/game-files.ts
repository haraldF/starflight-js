// The three Starflight files the app needs. They are fetched from the server as usual; files the server lacks come
// from this browser's IndexedDB cache, and failing that a landing page lets the user drop or pick them (which are then
// cached). The app starts once all three are there.

export type GameFileName = 'STARA.COM' | 'STARB.COM' | 'STARFLT.COM';
export type GameFiles = Record<GameFileName, ArrayBuffer>;

interface GameFileSpec {
  name: GameFileName;
  size: number;
  description: string;
  // Leading bytes every copy of this version starts with.
  signature: number[];
}

const DIRECTORY = [...'DIRECTORY '].map(character => character.charCodeAt(0));

// The Forth dictionary (forth-dict.json) and the runner's addresses belong to exactly this version of the game.
const GAME_FILES: readonly GameFileSpec[] = [
  { name: 'STARA.COM', size: 256000, description: 'disk image A', signature: DIRECTORY },
  { name: 'STARB.COM', size: 362496, description: 'disk image B', signature: DIRECTORY },
  // CLI; MOV AX,CS; MOV SS,AX: the COM bootstrap.
  { name: 'STARFLT.COM', size: 54183, description: 'the game program', signature: [0xfa, 0x8c, 0xc8, 0x8e, 0xd0] }
];

function matches(spec: GameFileSpec, bytes: ArrayBuffer): boolean {
  const view = new Uint8Array(bytes);
  return view.length === spec.size && spec.signature.every((value, index) => view[index] === value);
}

// Which game file `bytes` are, by size and signature, so renamed or lower-case copies work; or why they are not.
function identify(fileName: string, bytes: ArrayBuffer): { name: GameFileName } | { error: string } {
  const spec = GAME_FILES.find(candidate => matches(candidate, bytes));
  if (spec) return { name: spec.name };
  const named = GAME_FILES.find(candidate => candidate.name === fileName.toUpperCase());
  if (named) {
    return { error: `${fileName} (${bytes.byteLength.toLocaleString()} bytes) is not the expected ${named.name}: this app needs the `
      + `${named.size.toLocaleString()}-byte version.` };
  }
  return { error: `${fileName} (${bytes.byteLength.toLocaleString()} bytes) is not one of STARA.COM, STARB.COM or STARFLT.COM.` };
}

// Fetch the files from the server; those missing, unreachable or not the expected content are left out.
export async function fetchGameFiles(): Promise<Partial<GameFiles>> {
  const found: Partial<GameFiles> = {};
  await Promise.all(GAME_FILES.map(async spec => {
    try {
      const response = await fetch(spec.name);
      if (!response.ok) return;
      const bytes = await response.arrayBuffer();
      if (matches(spec, bytes)) found[spec.name] = bytes;
    } catch {
      // Unreachable: the landing page asks for the file.
    }
  }));
  return found;
}

// The IndexedDB cache of files the user added, keyed by file name. A separate database from the game checkpoints, so
// neither needs the other's schema.
function openCache(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('starflight-files', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('files');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('The file cache is blocked by another tab.'));
  });
}

// Cached files, checked like fetched ones; an unavailable cache (e.g. private browsing) just yields none.
export async function loadCachedGameFiles(): Promise<Partial<GameFiles>> {
  const found: Partial<GameFiles> = {};
  try {
    const database = await openCache();
    try {
      await Promise.all(GAME_FILES.map(spec => new Promise<void>(resolve => {
        const request = database.transaction('files').objectStore('files').get(spec.name);
        request.onsuccess = () => {
          const bytes: unknown = request.result;
          if (bytes instanceof ArrayBuffer && matches(spec, bytes)) found[spec.name] = bytes;
          resolve();
        };
        request.onerror = () => resolve();
      })));
    } finally {
      database.close();
    }
  } catch (error) {
    console.warn('Game file cache unavailable:', error);
  }
  return found;
}

// Remember files the user added, so the next visit needs no landing page. Failing to cache is not an error.
export async function cacheGameFiles(files: Partial<GameFiles>): Promise<void> {
  try {
    const database = await openCache();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction('files', 'readwrite');
        for (const [name, bytes] of Object.entries(files)) transaction.objectStore('files').put(bytes, name);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {
      database.close();
    }
  } catch (error) {
    console.warn('Could not cache the game files:', error);
  }
}

export function hasAllGameFiles(files: Partial<GameFiles>): files is GameFiles {
  return GAME_FILES.every(spec => files[spec.name] !== undefined);
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);

// Show the landing page in `target` until all three files are present (starting from those already `found`), then
// clear it and call `onComplete`.
export function showGameFilesPage(target: HTMLElement, found: Partial<GameFiles>, onComplete: (files: GameFiles) => void): void {
  const files: Partial<GameFiles> = { ...found };
  const added: Partial<GameFiles> = {};
  const listening = new AbortController();
  target.innerHTML = `
    <main class="files-page">
      <h1>STARFLIGHT I — Reverse Engineering Lab</h1>
      <p>The game files could not be loaded from the server. Add your own copies of the three files from the
        Starflight I (1986, PC) game directory; they are kept in this browser for your next visit and are not
        uploaded anywhere.</p>
      <label class="files-drop" tabindex="0">
        <input class="files-input" type="file" multiple accept=".com,.COM">
        <strong>Drop the files here</strong>
        <span>or click to choose them</span>
      </label>
      <ul class="files-list" aria-live="polite"></ul>
      <p class="files-error" role="alert"></p>
    </main>
  `;
  const list = target.querySelector<HTMLUListElement>('.files-list')!;
  const error = target.querySelector<HTMLElement>('.files-error')!;
  const drop = target.querySelector<HTMLLabelElement>('.files-drop')!;
  const input = target.querySelector<HTMLInputElement>('.files-input')!;

  const render = () => {
    list.innerHTML = GAME_FILES.map(spec => {
      const ready = files[spec.name] !== undefined;
      return `<li class="${ready ? 'ready' : ''}"><span aria-hidden="true">${ready ? '✓' : '·'}</span>`
        + `<span>${spec.name}</span><span>${spec.description}, ${spec.size.toLocaleString()} bytes</span>`
        + `<span>${ready ? 'ready' : 'missing'}</span></li>`;
    }).join('');
  };

  const add = async (picked: Iterable<File>) => {
    const problems: string[] = [];
    for (const file of picked) {
      const bytes = await file.arrayBuffer();
      const result = identify(file.name, bytes);
      if ('error' in result) problems.push(result.error);
      else files[result.name] = added[result.name] = bytes;
    }
    error.innerHTML = problems.map(escapeHtml).join('<br>');
    render();
    if (hasAllGameFiles(files)) {
      listening.abort();
      target.innerHTML = '';
      await cacheGameFiles(added);
      onComplete(files);
    }
  };

  input.addEventListener('change', () => {
    if (input.files) void add(Array.from(input.files));
    input.value = '';
  });
  drop.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      input.click();
    }
  });
  drop.addEventListener('dragover', event => {
    event.preventDefault();
    drop.classList.add('dragging');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragging'));
  drop.addEventListener('drop', event => {
    event.preventDefault();
    drop.classList.remove('dragging');
    if (event.dataTransfer?.files) void add(Array.from(event.dataTransfer.files));
  });
  // While the page is up, a file dropped beside the drop zone would otherwise open in the tab and leave the app.
  for (const type of ['dragover', 'drop']) {
    document.addEventListener(type, event => event.preventDefault(), { signal: listening.signal });
  }
  render();
}
