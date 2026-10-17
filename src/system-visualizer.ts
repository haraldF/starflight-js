/**
 * Starflight Star System & Galaxy Visualizer
 *
 * Provides an interactive 2D Galaxy Map (250x250 coordinate space)
 * and an animated Solar System Orbital View for inspecting stars and planets.
 */

import { type StarSystemInfo, type PlanetInfo, type FluxInfo } from './starsystems';
import type { ColonyInfo } from './colonizable';
import { REGIONS, type LocationInfo } from './locations';

// The heaviest gravity the terrain vehicle can safely land in.
const MAX_SAFE_GRAVITY = 7;
const COLONY_COLOR = '#c3e88d';

const hasColony = (system: StarSystemInfo) => system.planets.some(planet => planet.colony);
const LOCATION_COLOR = '#89ddff';
const MAX_ZOOM = 12;
const FLUX_COLOR = '#c792ea';

// A flux drawn on the map: both ends, and whether only a → b exists.
interface FluxLink {
  a: [number, number];
  b: [number, number];
  oneWay: boolean;
}

// Fold the one-way FLUX-NODEs into links, one per mirrored pair.
function fluxLinks(fluxes: FluxInfo[]): FluxLink[] {
  const links: FluxLink[] = [];
  for (const flux of fluxes) {
    const back = fluxes.some(other => other.x === flux.destX && other.y === flux.destY && other.destX === flux.x && other.destY === flux.y);
    if (back && (flux.x > flux.destX || (flux.x === flux.destX && flux.y > flux.destY))) continue; // its mirror adds it
    links.push({ a: [flux.x, flux.y], b: [flux.destX, flux.destY], oneWay: !back });
  }
  return links;
}
// From this zoom on, every place name and region label is drawn; below it only the selected or hovered system's.
const LABEL_ZOOM = 2;
const locationNames = (system: StarSystemInfo) => system.planets.flatMap(planet => planet.locations ?? []).map(location => location.name);
// "Star (215, 86)", with the names of known places in the system.
const systemTitle = (system: StarSystemInfo) => {
  if (system.isHomeSystem) return 'Arth System (Home)';
  const names = locationNames(system);
  return `Star (${system.x}, ${system.y})${names.length ? ` \u2014 ${names.join(', ')}` : ''}`;
};
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);

export class SystemVisualizer {
  private systems: StarSystemInfo[];
  private selectedSystem: StarSystemInfo;
  private selectedPlanet: PlanetInfo | null = null;
  private container: HTMLElement | null = null;
  private galaxyCanvas: HTMLCanvasElement | null = null;
  private orbitCanvas: HTMLCanvasElement | null = null;
  private animFrameId: number | null = null;
  private orbitAngles: number[] = [0, 0.8, 2.1, 3.4, 4.2, 5.1, 1.2, 2.7];
  private hoveredSystem: StarSystemInfo | null = null;
  // The starmap's zoom (1 = whole sector) and pan offset in CSS pixels, kept across tab switches.
  private view = { zoom: 1, x: 0, y: 0 };
  // The starmap's CSS size when the view was last fitted, to keep the same area in view across resizes.
  private galaxySize = 0;
  // Keeps both canvases' backing stores at their on-screen size (times the device pixel ratio).
  private resizeObserver: ResizeObserver | null = null;
  private filterType: string = 'all';
  // Continuum fluxes from the game data, and whether the map shows them.
  private fluxes: FluxLink[];
  private showFluxes = true;
  private hoveredFlux: FluxLink | null = null;
  // Systems with a planet on the colonizable list, by coordinates.
  private colonySystems: StarSystemInfo[];
  // Systems with a named place, in list order of their first one.
  private locationSystems: StarSystemInfo[];
  private searchQuery: string = '';

  constructor(systems: StarSystemInfo[], fluxes: FluxInfo[] = []) {
    this.systems = systems;
    this.fluxes = fluxLinks(fluxes);
    // Default selected system: Arth (125, 100)
    this.selectedSystem = systems.find(s => s.isHomeSystem) ?? systems[0];
    this.colonySystems = systems.filter(hasColony).sort((a, b) => a.x - b.x || a.y - b.y);
    this.locationSystems = systems.filter(system => locationNames(system).length > 0)
      .sort((a, b) => locationNames(a)[0].localeCompare(locationNames(b)[0]));
  }

  mount(target: HTMLElement) {
    this.destroy();
    this.container = target;
    this.renderLayout();
    this.initGalaxyCanvas();
    this.initOrbitCanvas();
    this.observeCanvasSizes();
    this.startAnimation();
  }

  destroy() {
    if (this.animFrameId != null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
  }

  // Match each canvas's pixel buffer to its CSS size, so the maps stay sharp at any layout width.
  private observeCanvasSizes() {
    const fit = (canvas: HTMLCanvasElement) => {
      const ratio = window.devicePixelRatio || 1;
      const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
      const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
    };
    this.resizeObserver = new ResizeObserver(() => {
      if (this.galaxyCanvas) {
        fit(this.galaxyCanvas);
        const size = this.galaxyCanvas.clientWidth;
        if (this.galaxySize && size && size !== this.galaxySize) {
          this.view.x *= size / this.galaxySize;
          this.view.y *= size / this.galaxySize;
        }
        if (size) this.galaxySize = size;
        this.clampView(size);
      }
      if (this.orbitCanvas) fit(this.orbitCanvas);
      this.drawGalaxy();
      this.drawSolarSystem();
    });
    for (const canvas of [this.galaxyCanvas, this.orbitCanvas]) if (canvas) this.resizeObserver.observe(canvas);
  }

  // The starmap's layout in CSS pixels: the 0..250 sector square inside a margin, and a star dot size that grows a
  // little with the map.
  private galaxyGeometry(size: number) {
    const padding = Math.max(12, size * 0.035);
    const scale = (size - padding * 2) / 250;
    return { padding, scale, dot: Math.min(1.8, Math.max(1, size / 420)) };
  }

  // How much markers grow with the zoom: a little, so zoomed-in clusters spread out instead of staying crowded.
  private markerScale() {
    return Math.min(2, Math.sqrt(this.view.zoom));
  }

  // Sector coordinates to starmap CSS pixels under the current zoom and pan.
  private toScreen(x: number, y: number, size: number): [number, number] {
    const { padding, scale } = this.galaxyGeometry(size);
    return [(padding + x * scale) * this.view.zoom + this.view.x, (padding + (250 - y) * scale) * this.view.zoom + this.view.y];
  }

  // Keep the zoomed map covering the canvas.
  private clampView(size: number) {
    const view = this.view;
    view.zoom = Math.min(MAX_ZOOM, Math.max(1, view.zoom));
    view.x = Math.min(0, Math.max(size * (1 - view.zoom), view.x));
    view.y = Math.min(0, Math.max(size * (1 - view.zoom), view.y));
    if (this.galaxyCanvas) {
      // Unzoomed, vertical swipes scroll the page; zoomed, drags pan the map.
      this.galaxyCanvas.style.touchAction = view.zoom > 1 ? 'none' : 'pan-y';
      this.galaxyCanvas.style.cursor = view.zoom > 1 ? 'grab' : 'crosshair';
    }
    const label = document.getElementById('galaxy-zoom-level');
    if (label) label.textContent = `${view.zoom.toFixed(1)}\u00d7`;
  }

  // Zoom by `factor`, keeping the point (px, py) of the canvas in place.
  private zoomAt(px: number, py: number, factor: number) {
    const size = this.galaxyCanvas?.clientWidth ?? 0;
    const view = this.view;
    const zoom = Math.min(MAX_ZOOM, Math.max(1, view.zoom * factor));
    view.x = px - (px - view.x) * (zoom / view.zoom);
    view.y = py - (py - view.y) * (zoom / view.zoom);
    view.zoom = zoom;
    this.clampView(size);
    this.drawGalaxy();
  }

  // Pan so that a system is in the middle of the zoomed map.
  private centerOn(system: StarSystemInfo) {
    const size = this.galaxyCanvas?.clientWidth ?? 0;
    if (!size || this.view.zoom <= 1) return;
    const [sx, sy] = this.toScreen(system.x, system.y, size);
    this.view.x += size / 2 - sx;
    this.view.y += size / 2 - sy;
    this.clampView(size);
    this.drawGalaxy();
  }

  private renderLayout() {
    if (!this.container) return;

    this.container.innerHTML = `
      <div style="display: flex; flex-direction: column; gap: 20px;">
        <!-- Top Toolbar -->
        <div style="display: flex; justify-content: space-between; align-items: center; background: #151824; border: 1px solid #232a3d; border-radius: 8px; padding: 12px 18px; flex-wrap: wrap; gap: 12px;">
          <div style="display: flex; align-items: center; gap: 12px;">
            <button class="btn" id="btn-jump-arth" style="background: #1e3a5f; border-color: #388bfd; color: #82aaff; font-weight: bold;">
              &#9678; Jump to Arth (125, 100)
            </button>
            <div style="font-size: 12px; color: #7982a9;">
              Total Stars: <strong style="color: #c792ea;">${this.systems.length}</strong> | 
              Total Planets: <strong style="color: #89ddff;">${this.systems.reduce((acc, s) => acc + s.planets.length, 0)}</strong>
            </div>
          </div>

          <div style="display: flex; gap: 10px; align-items: center;">
            <label style="font-size: 12px; color: #7982a9; display: flex; align-items: center; gap: 4px;" title="Show the ${this.fluxes.length} continuum fluxes">
              <input type="checkbox" id="toggle-fluxes" ${this.showFluxes ? 'checked' : ''}> Fluxes
            </label>
            <select id="filter-spectral" class="btn" style="padding: 4px 8px;">
              <option value="all">All Spectral Classes</option>
              <option value="O">Class O (Blue Supergiant)</option>
              <option value="B">Class B (Blue-White)</option>
              <option value="A">Class A (White)</option>
              <option value="F">Class F (Yellow-White)</option>
              <option value="G">Class G (Yellow Dwarf - Arth)</option>
              <option value="K">Class K (Orange Dwarf)</option>
              <option value="M">Class M (Red Dwarf)</option>
              <option value="flared">Flared / Hazard Stars</option>
              <option value="colonizable">Colonizable Planets</option>
              <option value="locations">Known Locations</option>
            </select>

            <input type="text" id="sys-search" placeholder="Search coords (e.g. 125, 100)..." 
              style="background: #11131c; border: 1px solid #363e58; color: #c3ccdb; padding: 4px 10px; font-family: inherit; font-size: 12px; border-radius: 4px; width: 200px;" />
          </div>
        </div>

        <!-- Main 2-Column Grid: a large starmap beside a narrow star system column -->
        <div class="systems-grid">
          <!-- Left Column: Galaxy Map -->
          <div style="background: #151824; border: 1px solid #232a3d; border-radius: 8px; padding: 16px; min-width: 0;">
            <div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 12px;">
              <h3 style="color: #ffcb6b; margin: 0; font-size: 15px;">Galaxy Sector Starmap</h3>
              <span style="font-size: 11px; color: #7982a9;">Coordinates: 0..250 &times; 0..250 &middot; scroll to zoom, drag to pan</span>
            </div>

            <div class="galaxy-frame">
              <canvas id="galaxy-canvas" width="420" height="420" style="display: block; width: 100%; height: 100%; cursor: crosshair; touch-action: pan-y;"
                aria-label="Galaxy starmap: scroll or pinch to zoom, drag to pan, double-click to zoom in"></canvas>
              <div class="galaxy-zoom" role="group" aria-label="Starmap zoom">
                <button type="button" class="btn" id="galaxy-zoom-in" title="Zoom in" aria-label="Zoom in">+</button>
                <button type="button" class="btn" id="galaxy-zoom-out" title="Zoom out" aria-label="Zoom out">&minus;</button>
                <button type="button" class="btn" id="galaxy-zoom-reset" title="Show the whole sector" aria-label="Show the whole sector">&#10227;</button>
                <span id="galaxy-zoom-level" aria-live="polite">1.0&times;</span>
              </div>
              <div id="galaxy-tooltip" style="position: absolute; pointer-events: none; display: none; background: rgba(18, 22, 34, 0.95); border: 1px solid #82aaff; border-radius: 4px; padding: 6px 10px; font-size: 11px; color: #c3ccdb; white-space: nowrap; z-index: 20; box-shadow: 0 4px 12px rgba(0,0,0,0.5);"></div>
            </div>

            <!-- Spectral Legend -->
            <div style="display: flex; justify-content: space-between; margin-top: 14px; font-size: 10px; color: #7982a9; padding: 0 4px;">
              <span><span style="color: #689dff;">&#9679;</span> O</span>
              <span><span style="color: #9ac2ff;">&#9679;</span> B</span>
              <span><span style="color: #ffffff;">&#9679;</span> A</span>
              <span><span style="color: #fff1a8;">&#9679;</span> F</span>
              <span><span style="color: #ffdc47;">&#9679;</span> G</span>
              <span><span style="color: #ffa043;">&#9679;</span> K</span>
              <span><span style="color: #ff5454;">&#9679;</span> M</span>
              <span><span style="color: #ff3366;">&#9678;</span> Flared</span>
              <span><span style="color: ${COLONY_COLOR};">&#9671;</span> Colonizable</span>
              <span><span style="color: ${LOCATION_COLOR};">&#9633;</span> Location</span>
              <span><span style="color: ${FLUX_COLOR};">&#8212;</span> Flux</span>
            </div>

            <!-- Shortcuts to the named places -->
            <div style="margin-top: 16px; border-top: 1px solid #232a3d; padding-top: 12px;">
              <div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; gap: 8px; flex-wrap: wrap;">
                <h4 style="color: ${LOCATION_COLOR}; margin: 0; font-size: 13px;">Known Locations (${this.locationSystems.length} systems)</h4>
                <span style="font-size: 10px; color: #545c7e;">
                  source: <a href="http://www.starflt.com/tables/index.php/starflight1/locations/" target="_blank" rel="noopener" style="color: #7982a9;">starflt.com</a>
                </span>
              </div>
              <div id="location-shortcuts" style="display: flex; flex-wrap: wrap; gap: 6px;">
                ${this.locationSystems.map(system => `
                  <button type="button" class="btn location-shortcut" data-jump-system="${system.addr}" aria-pressed="false"
                    title="Jump to (${system.x}, ${system.y})">${escapeHtml(locationNames(system).join(' / '))}</button>`).join('')}
              </div>
            </div>

            <!-- Shortcuts to the systems with colonizable planets -->
            <div style="margin-top: 16px; border-top: 1px solid #232a3d; padding-top: 12px;">
              <div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; gap: 8px; flex-wrap: wrap;">
                <h4 style="color: ${COLONY_COLOR}; margin: 0; font-size: 13px;">Colonizable Worlds (${this.colonySystems.length} systems)</h4>
                <span style="font-size: 10px; color: #545c7e;">
                  * guarded &middot; source: <a href="http://www.starflt.com/tables/index.php/starflight1/colonizable-planets/" target="_blank" rel="noopener" style="color: #7982a9;">starflt.com</a>
                </span>
              </div>
              <div id="colony-shortcuts" class="jump-shortcuts" style="display: flex; flex-wrap: wrap; gap: 6px;">
                ${this.colonySystems.map(system => this.colonyShortcutHtml(system)).join('')}
              </div>
            </div>
          </div>

          <!-- Right Column: Solar System Orbital View & Telemetry -->
          <div style="display: flex; flex-direction: column; gap: 20px; min-width: 0;">
            <!-- System Canvas Card -->
            <div style="background: #151824; border: 1px solid #232a3d; border-radius: 8px; padding: 16px;">
              <div style="display: flex; justify-content: space-between; align-items: baseline; border-bottom: 1px solid #232a3d; padding-bottom: 12px; margin-bottom: 16px; flex-wrap: wrap; gap: 10px;">
                <div>
                  <span style="color: #7982a9; font-size: 12px;">Star System:</span>
                  <span id="sys-title" style="color: #c3e88d; font-size: 18px; font-weight: bold; margin-left: 8px;">
                    ${escapeHtml(systemTitle(this.selectedSystem))}
                  </span>
                  <span id="sys-class-badge" style="background: #232a3d; color: ${this.selectedSystem.spectralColor}; font-size: 11px; padding: 2px 8px; border-radius: 4px; margin-left: 8px; border: 1px solid ${this.selectedSystem.spectralColor}44;">
                    ${this.selectedSystem.spectralName}
                  </span>
                </div>
                <div style="font-size: 12px; color: #b2ccd6;" id="sys-stats">
                  Coords: <strong style="color: #82aaff;">(${this.selectedSystem.x}, ${this.selectedSystem.y})</strong> | 
                  Planets: <strong style="color: #c792ea;">${this.selectedSystem.nplanets}</strong> | 
                  Flare Date: <strong style="color: ${this.selectedSystem.flaredate <= 0 ? '#ff5454' : '#ffcb6b'};">${this.selectedSystem.flaredate} days</strong>
                </div>
              </div>

              <!-- Orbit Canvas -->
              <div style="position: relative; width: 100%; aspect-ratio: 1; background: #0c0e17; border: 1px solid #1f2537; border-radius: 6px; overflow: hidden;">
                <canvas id="orbit-canvas" width="400" height="400" style="display: block; width: 100%; height: 100%;"></canvas>
              </div>
            </div>

            <!-- Planets Roster Card -->
            <div style="background: #151824; border: 1px solid #232a3d; border-radius: 8px; padding: 16px;">
              <h4 id="sys-roster-title" style="color: #ffcb6b; margin: 0 0 12px 0; font-size: 14px;">Planetary Roster (${this.selectedSystem.planets.length} bodies)</h4>
              <div id="planet-cards-container" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px;">
                ${this.renderPlanetCardsHtml()}
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    // Event listeners
    for (const id of ['colony-shortcuts', 'location-shortcuts']) {
      document.getElementById(id)?.addEventListener('click', event => {
        const button = (event.target as HTMLElement).closest<HTMLElement>('[data-jump-system]');
        const system = button && this.systems.find(candidate => candidate.addr === Number(button.dataset.jumpSystem));
        if (!system) return;
        this.selectSystem(system);
        this.centerOn(system);
        // In the stacked (narrow) layout the system details sit below the map.
        document.getElementById('sys-title')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
    }

    document.getElementById('btn-jump-arth')?.addEventListener('click', () => {
      const arth = this.systems.find(s => s.isHomeSystem);
      if (arth) this.selectSystem(arth);
    });

    const fluxToggle = document.getElementById('toggle-fluxes') as HTMLInputElement | null;
    fluxToggle?.addEventListener('change', () => {
      this.showFluxes = fluxToggle.checked;
      this.hoveredFlux = null;
      this.drawGalaxy();
    });

    const filterSelect = document.getElementById('filter-spectral') as HTMLSelectElement | null;
    filterSelect?.addEventListener('change', () => {
      this.filterType = filterSelect.value;
      this.drawGalaxy();
    });

    const searchInput = document.getElementById('sys-search') as HTMLInputElement | null;
    searchInput?.addEventListener('input', () => {
      this.searchQuery = searchInput.value.trim().toLowerCase();
      this.drawGalaxy();
    });
  }

  // A density (0-100, as the ship's sensors show it) as a label, number and bar. `rolled` marks a value the game
  // generates for the planet on arrival rather than reading it from the planet type.
  private densityHtml(label: string, value: number | undefined, color: string, rolled = false): string {
    if (value === undefined) return '';
    const title = `${label} density as the science officer's sensors report it (0-100)`
      + (rolled ? '; the game rolls it for this planet when the ship arrives' : '');
    return `
      <div style="display: grid; grid-template-columns: 5.5em 2.5em 1fr; align-items: center; gap: 6px; font-size: 11px; color: #7982a9; margin-top: 3px;"
        title="${title}">
        <span>${label}:</span>
        <span style="color: ${color}; text-align: right;">${value}</span>
        <span style="height: 5px; background: #1f2537; border-radius: 3px; overflow: hidden;">
          <span style="display: block; height: 100%; width: ${value}%; background: ${color};"></span>
        </span>
      </div>`;
  }

  // Surface gravity as the analysis screen shows it; red and bold above the 7 G that is safe for landing.
  private gravityHtml(gravity: number | undefined, rolled = false): string {
    if (gravity === undefined) return '';
    const unsafe = gravity > MAX_SAFE_GRAVITY;
    const title = `Surface gravity${unsafe ? ': above the ' + MAX_SAFE_GRAVITY + ' G safe for landing' : ''}`
      + (rolled ? '; the game rolls the mass for this planet when the ship arrives' : '');
    return `
      <div style="font-size: 11px; color: #7982a9; margin-top: 3px;" title="${title}">
        Gravity: <span style="color: ${unsafe ? '#ff5370' : '#b2ccd6'};${unsafe ? ' font-weight: bold;' : ''}">${gravity.toFixed(2)} G</span>
      </div>`;
  }

  // A named place on a planet card: name, what is there and where on the surface.
  private locationBadgeHtml(location: LocationInfo): string {
    return `
      <div style="background: ${LOCATION_COLOR}1a; border: 1px solid ${LOCATION_COLOR}66; border-radius: 4px; padding: 4px 8px; margin-bottom: 6px; font-size: 11px; color: ${LOCATION_COLOR};">
        <strong>&#9633; ${escapeHtml(location.name)}</strong>${location.homeworldOf ? ` &middot; ${escapeHtml(location.homeworldOf)} homeworld` : ''}
        <div style="color: #b2ccd6; font-size: 10px; margin-top: 2px;">${escapeHtml(location.description)}${location.surface ? ` &middot; at ${escapeHtml(location.surface)}` : ''}</div>
      </div>`;
  }

  // The colonizable highlight on a planet card.
  private colonyBadgeHtml(colony: ColonyInfo): string {
    const notes = [colony.guarded ? 'guarded system' : '', colony.notInClueBook ? 'not in the clue book' : ''].filter(Boolean);
    return `
      <div style="background: ${COLONY_COLOR}22; border: 1px solid ${COLONY_COLOR}66; border-radius: 4px; padding: 4px 8px; margin-bottom: 6px; font-size: 11px; color: ${COLONY_COLOR};">
        <strong>&#9671; Colonizable</strong> &middot; ${colony.bonus.toLocaleString('en-US')} MU bonus
        ${notes.length ? `<div style="color: #ffcb6b; font-size: 10px; margin-top: 2px;">${notes.join(' &middot; ')}</div>` : ''}
      </div>`;
  }

  // A shortcut button to a system with colonizable planets: its coordinates and planet numbers.
  private colonyShortcutHtml(system: StarSystemInfo): string {
    const colonies = system.planets.filter(planet => planet.colony).map(planet => planet.colony!);
    const active = system.addr === this.selectedSystem.addr;
    const label = `${colonies.some(colony => colony.guarded) ? '*' : ''}${system.x}, ${system.y}`;
    const planets = colonies.map(colony => `P${colony.position}`).join(' ');
    const bonus = Math.max(...colonies.map(colony => colony.bonus));
    return `
      <button type="button" class="btn colony-shortcut${active ? ' active' : ''}" data-jump-system="${system.addr}" aria-pressed="${active}"
        title="Jump to (${system.x}, ${system.y}): ${planets}, up to ${bonus.toLocaleString('en-US')} MU">
        ${label} <span style="color: #7982a9;">${planets}</span>
      </button>`;
  }

  private renderPlanetCardsHtml(): string {
    if (this.selectedSystem.planets.length === 0) {
      return `<div style="color: #7982a9; font-style: italic; grid-column: 1 / -1; padding: 8px 0;">No planets detected in this system.</div>`;
    }

    // P1, P2, ...: position from the star, as the colonizable list numbers planets.
    const byOrbit = [...this.selectedSystem.planets].sort((a, b) => a.orbit - b.orbit);
    return byOrbit.map((p, index) => `
      <div class="planet-card ${this.selectedPlanet?.addr === p.addr ? 'selected' : ''}" data-addr="${p.addr}"
        style="background: ${p.colony ? '#141c14' : '#11131c'}; border: ${p.colony ? `2px solid ${COLONY_COLOR}` : `1px solid ${p.isArth ? '#4ecdc4' : '#232a3d'}`}; border-radius: 6px; padding: 12px; cursor: pointer; transition: all 0.15s ease;">
        <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 6px;">
          <div style="width: 14px; height: 14px; border-radius: 50%; background: ${p.color}; box-shadow: 0 0 8px ${p.color}88;"></div>
          <strong style="color: ${p.isArth ? '#4ecdc4' : '#c3e88d'}; font-size: 13px;">
            ${p.isArth ? 'Arth' : `P${index + 1} &middot; Orbit ${p.orbit}`}
          </strong>
        </div>
        ${(p.locations ?? []).map(location => this.locationBadgeHtml(location)).join('')}
        ${p.colony ? this.colonyBadgeHtml(p.colony) : ''}
        <div style="font-size: 11px; color: #7982a9;">Type: <span style="color: #b2ccd6;">${p.typeName}</span></div>
        <div style="font-size: 11px; color: #7982a9;">Category: <span style="color: #89ddff;">${p.category}</span></div>
        ${this.densityHtml('Minerals', p.minerals, '#ffcb6b', p.rolled)}
        ${this.densityHtml('Bio', p.bio, '#c3e88d')}
        ${this.gravityHtml(p.gravity, p.rolled)}
        ${p.hasStarport ? `<div style="font-size: 11px; color: #ffcb6b; margin-top: 4px; font-weight: bold;">&#9733; Starport Colony Facility</div>` : ''}
        <div style="font-size: 10px; color: #545c7e; margin-top: 6px;">STARB Offset: ${p.addrHex}</div>
      </div>
    `).join('');
  }

  private selectSystem(system: StarSystemInfo) {
    this.selectedSystem = system;
    this.selectedPlanet = null;

    // Update DOM headers
    const titleEl = document.getElementById('sys-title');
    if (titleEl) {
      titleEl.innerText = systemTitle(system);
    }

    document.querySelectorAll<HTMLElement>('[data-jump-system]').forEach(button => {
      const active = Number(button.dataset.jumpSystem) === system.addr;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });

    const rosterTitleEl = document.getElementById('sys-roster-title');
    if (rosterTitleEl) rosterTitleEl.innerText = `Planetary Roster (${system.planets.length} bodies)`;

    const badgeEl = document.getElementById('sys-class-badge');
    if (badgeEl) {
      badgeEl.innerText = system.spectralName;
      badgeEl.style.color = system.spectralColor;
      badgeEl.style.borderColor = `${system.spectralColor}44`;
    }

    const statsEl = document.getElementById('sys-stats');
    if (statsEl) {
      statsEl.innerHTML = `
        Coords: <strong style="color: #82aaff;">(${system.x}, ${system.y})</strong> | 
        Planets: <strong style="color: #c792ea;">${system.nplanets}</strong> | 
        Flare Date: <strong style="color: ${system.flaredate <= 0 ? '#ff5454' : '#ffcb6b'};">${system.flaredate} days</strong>
      `;
    }

    // Refresh planet cards
    const container = document.getElementById('planet-cards-container');
    if (container) {
      container.innerHTML = this.renderPlanetCardsHtml();
    }

    this.drawGalaxy();
  }

  private initGalaxyCanvas() {
    this.galaxyCanvas = document.getElementById('galaxy-canvas') as HTMLCanvasElement | null;
    if (!this.galaxyCanvas) return;

    const canvas = this.galaxyCanvas;
    const tooltip = document.getElementById('galaxy-tooltip');

    // The nearest star within reach of the pointer (in CSS pixels), so dense clusters pick the closest one.
    const getSystemAtCoord = (mx: number, my: number): StarSystemInfo | null => {
      const size = canvas.clientWidth;
      const { dot } = this.galaxyGeometry(size);
      let nearest: StarSystemInfo | null = null;
      let nearestDistance = 6 * dot * this.markerScale();
      for (const sys of this.systems) {
        const [sx, sy] = this.toScreen(sys.x, sys.y, size);
        const dist = Math.hypot(mx - sx, my - sy);
        if (dist <= nearestDistance) {
          nearest = sys;
          nearestDistance = dist;
        }
      }
      return nearest;
    };

    // A flux whose end is within reach of the pointer.
    const getFluxAtCoord = (mx: number, my: number): FluxLink | null => {
      if (!this.showFluxes) return null;
      const size = canvas.clientWidth;
      const reach = 6 * this.galaxyGeometry(size).dot * this.markerScale();
      return this.fluxes.find(link => [link.a, link.b].some(([x, y]) => {
        const [sx, sy] = this.toScreen(x, y, size);
        return Math.hypot(mx - sx, my - sy) <= reach;
      })) ?? null;
    };

    canvas.addEventListener('mousemove', (ev) => {
      const rect = canvas.getBoundingClientRect();
      const mx = ev.clientX - rect.left;
      const my = ev.clientY - rect.top;
      const sys = getSystemAtCoord(mx, my);
      const flux = sys ? null : getFluxAtCoord(mx, my);

      this.hoveredSystem = sys;
      this.hoveredFlux = flux;
      this.drawGalaxy();

      if (flux && tooltip) {
        tooltip.style.display = 'block';
        tooltip.style.left = `${Math.max(0, Math.min(mx + 12, canvas.clientWidth - 200))}px`;
        tooltip.style.top = `${Math.max(my - 30, 10)}px`;
        tooltip.innerHTML = `<strong style="color: ${FLUX_COLOR};">Continuum flux</strong><br/>
          (${flux.a[0]}, ${flux.a[1]}) ${flux.oneWay ? '&rarr;' : '&harr;'} (${flux.b[0]}, ${flux.b[1]})`;
      } else if (sys && tooltip) {
        tooltip.style.display = 'block';
        tooltip.style.left = `${Math.max(0, Math.min(mx + 12, canvas.clientWidth - 200))}px`;
        tooltip.style.top = `${Math.max(my - 30, 10)}px`;
        tooltip.innerHTML = `
          <strong style="color: ${sys.spectralColor};">${escapeHtml(systemTitle(sys))}</strong><br/>
          Class: ${sys.spectralType} | Planets: ${sys.nplanets} | Flare: ${sys.flaredate}d
          ${locationNames(sys).length ? `<br/><span style="color: ${LOCATION_COLOR};">&#9633; ${escapeHtml(locationNames(sys).join(', '))}</span>` : ''}
          ${hasColony(sys) ? `<br/><span style="color: ${COLONY_COLOR};">&#9671; Colonizable: ${sys.planets.filter(p => p.colony).map(p => `P${p.colony!.position}`).join(', ')}</span>` : ''}
        `;
      } else if (tooltip) {
        tooltip.style.display = 'none';
      }
    });

    canvas.addEventListener('mouseleave', () => {
      this.hoveredSystem = null;
      this.hoveredFlux = null;
      if (tooltip) tooltip.style.display = 'none';
      this.drawGalaxy();
    });

    // Zoom and pan: wheel or trackpad pinch toward the pointer, drag to pan, two-finger pinch, double-click to zoom in.
    const local = (ev: { clientX: number; clientY: number }): [number, number] => {
      const rect = canvas.getBoundingClientRect();
      return [ev.clientX - rect.left, ev.clientY - rect.top];
    };
    canvas.addEventListener('wheel', ev => {
      ev.preventDefault();
      const delta = ev.deltaMode === 1 ? ev.deltaY * 16 : ev.deltaY; // lines to pixels
      this.zoomAt(...local(ev), Math.exp(-delta * 0.002));
    }, { passive: false });
    canvas.addEventListener('dblclick', ev => this.zoomAt(...local(ev), 2));
    const pointers = new Map<number, [number, number]>();
    let dragged = false;
    let pinchDistance = 0;
    canvas.addEventListener('pointerdown', ev => {
      pointers.set(ev.pointerId, local(ev));
      dragged = false;
      if (pointers.size === 2) {
        const [[ax, ay], [bx, by]] = [...pointers.values()];
        pinchDistance = Math.hypot(ax - bx, ay - by);
      }
    });
    canvas.addEventListener('pointermove', ev => {
      const previous = pointers.get(ev.pointerId);
      if (!previous) return;
      const current = local(ev);
      pointers.set(ev.pointerId, current);
      if (pointers.size === 2) {
        const [[ax, ay], [bx, by]] = [...pointers.values()];
        const distance = Math.hypot(ax - bx, ay - by);
        if (pinchDistance > 0) this.zoomAt((ax + bx) / 2, (ay + by) / 2, distance / pinchDistance);
        pinchDistance = distance;
        dragged = true;
        return;
      }
      if (this.view.zoom <= 1) return;
      const [dx, dy] = [current[0] - previous[0], current[1] - previous[1]];
      if (!dragged && Math.hypot(dx, dy) < 3) {
        pointers.set(ev.pointerId, previous); // below the drag threshold: a click, not a pan
        return;
      }
      if (!dragged) {
        try {
          canvas.setPointerCapture(ev.pointerId); // keep panning when the pointer leaves the map
        } catch {
          // Not an active pointer (e.g. a synthetic event); panning works without the capture.
        }
      }
      dragged = true;
      canvas.style.cursor = 'grabbing';
      this.view.x += dx;
      this.view.y += dy;
      this.clampView(canvas.clientWidth);
      this.drawGalaxy();
    });
    const release = (ev: PointerEvent) => {
      pointers.delete(ev.pointerId);
      pinchDistance = 0;
      this.clampView(canvas.clientWidth);
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);
    const zoomButton = (id: string, factor: number) => document.getElementById(id)?.addEventListener('click', () => {
      const size = canvas.clientWidth;
      this.zoomAt(size / 2, size / 2, factor);
    });
    zoomButton('galaxy-zoom-in', 2);
    zoomButton('galaxy-zoom-out', 0.5);
    document.getElementById('galaxy-zoom-reset')?.addEventListener('click', () => {
      this.view = { zoom: 1, x: 0, y: 0 };
      this.clampView(canvas.clientWidth);
      this.drawGalaxy();
    });
    this.clampView(canvas.clientWidth);

    canvas.addEventListener('click', (ev) => {
      if (dragged) return; // the end of a pan or pinch
      const rect = canvas.getBoundingClientRect();
      const mx = ev.clientX - rect.left;
      const my = ev.clientY - rect.top;
      const sys = getSystemAtCoord(mx, my);
      if (sys) {
        this.selectSystem(sys);
      }
    });

    this.drawGalaxy();
  }

  private drawGalaxy() {
    if (!this.galaxyCanvas) return;
    const ctx = this.galaxyCanvas.getContext('2d');
    if (!ctx) return;

    // Draw in CSS pixels; the backing store is scaled by the device pixel ratio.
    const width = this.galaxyCanvas.clientWidth || this.galaxyCanvas.width;
    const height = this.galaxyCanvas.clientHeight || this.galaxyCanvas.height;
    ctx.setTransform(this.galaxyCanvas.width / width, 0, 0, this.galaxyCanvas.height / height, 0, 0);
    ctx.clearRect(0, 0, width, height);

    // Markers grow a little with the zoom; labels appear once zoomed in.
    const { scale } = this.galaxyGeometry(width);
    const dot = this.galaxyGeometry(width).dot * this.markerScale();
    const zoom = this.view.zoom;
    const showLabels = zoom >= LABEL_ZOOM;

    // Draw background grid lines (every 50 units, every 10 when zoomed in far)
    const step = zoom >= 4 ? 10 : 50;
    const [left, top] = this.toScreen(0, 250, width);
    const [right, bottom] = this.toScreen(250, 0, width);
    ctx.lineWidth = 1;
    for (let c = 0; c <= 250; c += step) {
      ctx.strokeStyle = c % 50 === 0 ? '#1a2030' : '#121620';
      const [px] = this.toScreen(c, 0, width);
      const [, py] = this.toScreen(0, c, width);
      ctx.beginPath();
      ctx.moveTo(px, top);
      ctx.lineTo(px, bottom);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(left, py);
      ctx.lineTo(right, py);
      ctx.stroke();
    }
    if (zoom > 1) { // coordinates along the edges, so the zoomed view stays readable
      ctx.fillStyle = '#545c7e';
      ctx.font = '10px monospace';
      for (let c = 0; c <= 250; c += step) {
        const [px] = this.toScreen(c, 0, width);
        const [, py] = this.toScreen(0, c, width);
        if (px > 14 && px < width - 14) {
          ctx.textAlign = 'center';
          ctx.fillText(String(c), px, height - 4);
        }
        if (py > 10 && py < height - 14) {
          ctx.textAlign = 'left';
          ctx.fillText(String(c), 3, py - 3);
        }
      }
    }

    // Filter systems
    const filtered = this.systems.filter(s => {
      if (this.filterType === 'flared') {
        if (s.flaredate > 0) return false;
      } else if (this.filterType === 'colonizable') {
        if (!hasColony(s)) return false;
      } else if (this.filterType === 'locations') {
        if (locationNames(s).length === 0) return false;
      } else if (this.filterType !== 'all') {
        if (s.spectralType.toUpperCase() !== this.filterType) return false;
      }
      if (this.searchQuery) {
        const coordStr = `${s.x},${s.y}`;
        if (!coordStr.includes(this.searchQuery.replace(/\s+/g, ''))) return false;
      }
      return true;
    });

    // Continuum fluxes, under the stars: a line between the two ends, a ring at each end
    if (this.showFluxes) {
      for (const link of this.fluxes) {
        const hovered = link === this.hoveredFlux;
        const [ax, ay] = this.toScreen(link.a[0], link.a[1], width);
        const [bx, by] = this.toScreen(link.b[0], link.b[1], width);
        ctx.strokeStyle = hovered ? FLUX_COLOR : 'rgba(199, 146, 234, 0.4)';
        ctx.lineWidth = hovered ? 2 : 1;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();
        if (link.oneWay) { // an arrowhead at the exit
          const angle = Math.atan2(by - ay, bx - ax), head = 7 * dot;
          ctx.beginPath();
          ctx.moveTo(bx, by);
          ctx.lineTo(bx - head * Math.cos(angle - 0.4), by - head * Math.sin(angle - 0.4));
          ctx.moveTo(bx, by);
          ctx.lineTo(bx - head * Math.cos(angle + 0.4), by - head * Math.sin(angle + 0.4));
          ctx.stroke();
        }
        ctx.strokeStyle = FLUX_COLOR;
        ctx.lineWidth = 1.5;
        for (const [ex, ey] of [[ax, ay], [bx, by]]) {
          ctx.beginPath();
          ctx.arc(ex, ey, (hovered ? 4 : 3) * dot, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }

    // Draw stars
    for (const sys of filtered) {
      const [sx, sy] = this.toScreen(sys.x, sys.y, width);
      if (sx < -150 || sy < -20 || sx > width + 20 || sy > height + 20) continue; // off the zoomed view
      const isSelected = sys.addr === this.selectedSystem.addr;
      const isHovered = sys.addr === this.hoveredSystem?.addr;

      // Glow if selected or hovered
      if (isSelected || isHovered) {
        ctx.beginPath();
        ctx.arc(sx, sy, (isSelected ? 8 : 6) * dot, 0, Math.PI * 2);
        ctx.fillStyle = isSelected ? 'rgba(130, 170, 255, 0.35)' : 'rgba(255, 255, 255, 0.2)';
        ctx.fill();
        ctx.strokeStyle = isSelected ? '#82aaff' : '#ffffff';
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // Star point
      ctx.beginPath();
      const radius = (sys.spectralType === 'O' || sys.spectralType === 'B' ? 2.5 : 2) * dot;
      ctx.arc(sx, sy, radius, 0, Math.PI * 2);
      ctx.fillStyle = sys.spectralColor;
      ctx.fill();

      // Home system badge
      if (sys.isHomeSystem) {
        ctx.beginPath();
        ctx.arc(sx, sy, 7 * dot, 0, Math.PI * 2);
        ctx.strokeStyle = '#4ecdc4';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      // Known location: a square and the place names
      const names = locationNames(sys);
      if (names.length) {
        const half = 4 * dot;
        ctx.strokeStyle = LOCATION_COLOR;
        ctx.lineWidth = 1.2;
        ctx.strokeRect(sx - half, sy - half, half * 2, half * 2);
        if (showLabels || isSelected || isHovered) {
          ctx.fillStyle = LOCATION_COLOR;
          ctx.font = `${Math.round(Math.min(12, 9 * dot))}px monospace`;
          ctx.textAlign = 'left';
          ctx.fillText(names.join(' / '), sx + 7 * dot, sy + 3 * dot);
        }
      }

      // Colonizable marker: a diamond around the star
      if (hasColony(sys)) {
        const d = 5 * dot;
        ctx.beginPath();
        ctx.moveTo(sx, sy - d);
        ctx.lineTo(sx + d, sy);
        ctx.lineTo(sx, sy + d);
        ctx.lineTo(sx - d, sy);
        ctx.closePath();
        ctx.strokeStyle = COLONY_COLOR;
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }

      // Flared indicator
      if (sys.flaredate <= 0) {
        ctx.strokeStyle = 'rgba(255, 50, 80, 0.5)';
        ctx.lineWidth = 1;
        ctx.strokeRect(sx - 3 * dot, sy - 3 * dot, 6 * dot, 6 * dot);
      }
    }

    // Regions: named star patterns, as a dashed circle and an italic label at the listed coordinates
    if (this.filterType === 'all' || this.filterType === 'locations') {
      ctx.font = `italic ${Math.round(Math.min(13, 10 * dot))}px monospace`;
      ctx.textAlign = 'center';
      const regionRadius = 9 * scale * zoom;
      for (const region of REGIONS) {
        const [rx, ry] = this.toScreen(region.x, region.y, width);
        ctx.beginPath();
        ctx.arc(rx, ry, regionRadius, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(137, 221, 255, 0.35)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
        if (!showLabels) continue;
        ctx.fillStyle = 'rgba(137, 221, 255, 0.7)';
        ctx.fillText(region.name, rx, ry - regionRadius - 4);
      }
    }
  }

  private initOrbitCanvas() {
    this.orbitCanvas = document.getElementById('orbit-canvas') as HTMLCanvasElement | null;
  }

  private startAnimation() {
    const animate = () => {
      this.drawSolarSystem();
      // Slowly advance orbital angles
      for (let i = 0; i < this.orbitAngles.length; i++) {
        // Outer planets move slower: Kepler's 3rd law approximation
        const speed = 0.008 / Math.sqrt(i + 1);
        this.orbitAngles[i] = (this.orbitAngles[i] + speed) % (Math.PI * 2);
      }
      this.animFrameId = requestAnimationFrame(animate);
    };
    this.animFrameId = requestAnimationFrame(animate);
  }

  private drawSolarSystem() {
    if (!this.orbitCanvas) return;
    const ctx = this.orbitCanvas.getContext('2d');
    if (!ctx) return;

    // Draw in CSS pixels, with the scene (laid out for a 460-pixel square, room for the outer labels) scaled to fit.
    const width = this.orbitCanvas.clientWidth || this.orbitCanvas.width;
    const height = this.orbitCanvas.clientHeight || this.orbitCanvas.height;
    ctx.setTransform(this.orbitCanvas.width / width, 0, 0, this.orbitCanvas.height / height, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const zoom = Math.min(width, height) / 460;
    ctx.translate(width / 2, height / 2);
    ctx.scale(zoom, zoom);

    const centerX = 0;
    const centerY = 0;

    // Draw central star
    const starColor = this.selectedSystem.spectralColor;
    const starGlow = ctx.createRadialGradient(centerX, centerY, 5, centerX, centerY, 38);
    starGlow.addColorStop(0, starColor);
    starGlow.addColorStop(0.3, starColor);
    starGlow.addColorStop(1, 'transparent');

    ctx.beginPath();
    ctx.arc(centerX, centerY, 38, 0, Math.PI * 2);
    ctx.fillStyle = starGlow;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(centerX, centerY, 15, 0, Math.PI * 2);
    ctx.fillStyle = starColor;
    ctx.shadowColor = starColor;
    ctx.shadowBlur = 15;
    ctx.fill();
    ctx.shadowBlur = 0;

    // Label star
    ctx.fillStyle = '#ffffff';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(this.selectedSystem.spectralType, centerX, centerY + 3);

    // Orbit radii (8 rings)
    const orbitRadii = [42, 64, 86, 108, 130, 152, 172, 192];

    for (let o = 0; o < 8; o++) {
      const r = orbitRadii[o];
      const hasPlanet = this.selectedSystem.planets.some(p => p.orbit === o + 1);

      ctx.beginPath();
      ctx.arc(centerX, centerY, r, 0, Math.PI * 2);
      ctx.strokeStyle = hasPlanet ? '#2a334d' : '#171b26';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Draw planets
    for (const planet of this.selectedSystem.planets) {
      const orbitIdx = Math.max(0, Math.min(planet.orbit - 1, 7));
      const r = orbitRadii[orbitIdx];
      const angle = this.orbitAngles[orbitIdx];
      const px = centerX + Math.cos(angle) * r;
      const py = centerY + Math.sin(angle) * r;

      // Planet body
      ctx.beginPath();
      ctx.arc(px, py, planet.radius, 0, Math.PI * 2);
      ctx.fillStyle = planet.color;
      ctx.shadowColor = planet.color;
      ctx.shadowBlur = planet.isArth ? 10 : 4;
      ctx.fill();
      ctx.shadowBlur = 0;

      // Colonizable: a dashed ring
      if (planet.colony) {
        ctx.beginPath();
        ctx.arc(px, py, planet.radius + 5, 0, Math.PI * 2);
        ctx.strokeStyle = COLONY_COLOR;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 2]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Special highlight for Arth
      if (planet.isArth) {
        ctx.beginPath();
        ctx.arc(px, py, planet.radius + 4, 0, Math.PI * 2);
        ctx.strokeStyle = '#4ecdc4';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        ctx.fillStyle = '#4ecdc4';
        ctx.font = 'bold 11px monospace';
        ctx.textAlign = 'left';
        ctx.fillText('ARTH (Homeworld)', px + planet.radius + 6, py + 4);
      } else {
        ctx.fillStyle = '#7982a9';
        ctx.font = '10px monospace';
        ctx.textAlign = 'left';
        ctx.fillStyle = planet.locations ? LOCATION_COLOR : '#7982a9';
        ctx.fillText(planet.locations ? planet.locations.map(location => location.name).join(' / ') : `Orbit ${planet.orbit}`, px + planet.radius + 5, py + 3);
      }
    }
  }
}
