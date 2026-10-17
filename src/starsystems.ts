/**
 * Starflight Star System & Planet Extractor
 *
 * Extracts all 270 star systems and their planets directly from the
 * INSTANCE tree in STARB.COM (starting from IROOT 0x1006).
 */

import type { ColonyInfo } from './colonizable.ts';
import type { LocationInfo } from './locations.ts';

export interface PlanetInfo {
  addr: number;
  addrHex: string;
  orbit: number;           // 1 to 8
  species: number;         // Planet classification code
  typeName: string;        // Human-readable type (e.g. Terrestrial, Gas Giant, Molten)
  category: string;
  color: string;
  radius: number;
  isArth: boolean;
  hasStarport: boolean;
  childAddr: number;
  // Mineral and life density as the science officer's sensors show them (MIN and BIO, 0-100), and the surface
  // gravity in G as the analysis screen shows it; undefined without the game data they come from. `rolled` marks a
  // planet whose mass and minerals the game rolls when the ship arrives.
  minerals?: number;
  bio?: number;
  gravity?: number;
  rolled?: boolean;
  // Set for the planets on the community list of colonizable worlds (see colonizable.ts).
  colony?: ColonyInfo;
  // Named places on this planet from the community locations list (see locations.ts).
  locations?: LocationInfo[];
}

export interface StarSystemInfo {
  addr: number;
  addrHex: string;
  spectralType: string;    // 'O', 'B', 'A', 'F', 'G', 'K', 'M'
  spectralName: string;
  spectralColor: string;
  starColor: string;
  species: number;
  x: number;               // 0 to 250
  y: number;               // 0 to 250
  flaredate: number;       // Days relative to game start
  flareStatus: 'flared' | 'critical' | 'stable';
  orbitmask: number;
  loggedmask: number;
  nplanets: number;
  planets: PlanetInfo[];
  isHomeSystem: boolean;
}

function read24(buf: Uint8Array, offset: number): number {
  return buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16);
}

function countSetBits(n: number): number {
  let count = 0;
  let val = n;
  while (val > 0) {
    if ((val & 1) === 1) count++;
    val >>= 1;
  }
  return count;
}

export function getSpectralDetails(spectralType: string): { name: string; color: string; starGlow: string } {
  switch (spectralType.toUpperCase()) {
    case 'O':
      return { name: 'Class O (Blue Supergiant)', color: '#689dff', starGlow: 'rgba(104, 157, 255, 0.4)' };
    case 'B':
      return { name: 'Class B (Blue-White)', color: '#9ac2ff', starGlow: 'rgba(154, 194, 255, 0.4)' };
    case 'A':
      return { name: 'Class A (White Star)', color: '#ffffff', starGlow: 'rgba(255, 255, 255, 0.4)' };
    case 'F':
      return { name: 'Class F (Yellow-White)', color: '#fff1a8', starGlow: 'rgba(255, 241, 168, 0.4)' };
    case 'G':
      return { name: 'Class G (Yellow Dwarf)', color: '#ffdc47', starGlow: 'rgba(255, 220, 71, 0.4)' };
    case 'K':
      return { name: 'Class K (Orange Dwarf)', color: '#ffa043', starGlow: 'rgba(255, 160, 67, 0.4)' };
    case 'M':
      return { name: 'Class M (Red Dwarf)', color: '#ff5454', starGlow: 'rgba(255, 84, 84, 0.4)' };
    default:
      return { name: `Class ${spectralType}`, color: '#ffcb6b', starGlow: 'rgba(255, 203, 107, 0.4)' };
  }
}

export function getPlanetTypeInfo(species: number, isArth: boolean): { name: string; category: string; color: string; radius: number } {
  if (isArth) {
    return { name: 'Arth (Homeworld)', category: 'Terrestrial', color: '#4ecdc4', radius: 9 };
  }
  if (species >= 1 && species <= 8) {
    return { name: `Gas Giant (${species})`, category: 'Gas Giant', color: '#e0a96d', radius: 11 };
  } else if (species >= 9 && species <= 12) {
    return { name: `Glaciated / Ice (${species})`, category: 'Ice World', color: '#88d8f7', radius: 6 };
  } else if (species >= 13 && species <= 16) {
    return { name: `Molten / Volcanic (${species})`, category: 'Volcanic', color: '#f75a38', radius: 6 };
  } else if (species >= 17 && species <= 24) {
    return { name: `Rocky / Mineral (${species})`, category: 'Rocky', color: '#9e978e', radius: 5 };
  } else if (species >= 25 && species <= 35) {
    return { name: `Acidic / Toxic (${species})`, category: 'Toxic', color: '#a3d944', radius: 6 };
  } else if (species >= 36 && species <= 45) {
    return { name: `Oceanic / Water (${species})`, category: 'Oceanic', color: '#38a3f7', radius: 7 };
  } else if (species >= 46 && species <= 60) {
    return { name: `Terrestrial / Biosphere (${species})`, category: 'Terrestrial', color: '#68d391', radius: 7 };
  } else {
    return { name: `Exotic (${species})`, category: 'Exotic', color: '#c792ea', radius: 6 };
  }
}

interface InstanceNode {
  addr: number;
  next: number;
  prev: number;
  child: number;
  cls: number;
  species: number;
}

// A planet instance (class 20h, PLANET) reads its attributes from PLANET record `species` (SET-CURRENT sets FILE# to the
// class and RECORD# to the species). SCIENCE's sensor readout (0xF169) prints the byte at offset 4 (plan-life) under
// "BIO" and the byte at offset 9 under "MIN", each as `value 100 255 */`.
const PLANET_LIFE_DENSITY = 4;
const PLANET_MINERAL_DENSITY = 9;
const sensorPercent = (value: number) => Math.floor(value * 100 / 255);

// PLSET-OV's PLAN-RUL sets up a planet when the ship arrives. For species 1-17 it overwrites the record's densities:
// BIO becomes 0 and MIN is rolled from a seed of the system's coordinates and the planet's orbit, so it is fixed per
// planet. The steps, with the kernel's FRND (SEED * 7ABDh + 1B0Fh):
//   W_0xed8c  !XYSEED: SEED = FRND(SEED = y) ^ FRND(SEED = x) ^ GLOBALSEED, where GLOBALSEED is the orbit (1-8)
//   W_0xede0  the planet's mass: RRND between LO-MASS and HI-MASS for its class (record byte 0), one FRND
//   W_0xf06c  MIN = 0 255 BEGIN 0 256 RRND (SLIPPER) UNTIL with PEAK 30: draw FRND >> 8 until the kernel's bell-shaped
//             (SLIPPER) bitmap, FILTER (4C4Ch, which the game never changes) masked by the table at 4C5Bh, accepts it
const ROLLED_SPECIES_MAX = 17;
const PEAK = 30;

// The arrival roll for species 1-17: the planet's mass (W_0xede0), then its mineral density (W_0xf06c), both raw.
function rollPlanet(starflt: Uint8Array, mass: MassTables, planetClass: number, x: number, y: number, orbit: number) {
  const kernel = (address: number) => starflt[address - 0x100];
  const filter = kernel(0x4c4c) | (kernel(0x4c4d) << 8);
  let seed = 0;
  const frnd = () => (seed = (Math.imul((seed << 16) >> 16, 0x7abd) + 0x1b0f) & 0xffff);
  const rrnd = (low: number, high: number) => (low + Math.floor(frnd() * ((high - low) & 0xffff) / 0x10000)) & 0xffff;
  seed = y;
  const first = frnd();
  seed = x;
  seed = first ^ frnd() ^ orbit;
  const rolledMass = rrnd(mass.low(planetClass), mass.high(planetClass));
  for (let draws = 0; draws < 0x10000; draws++) {
    const value = frnd() >>> 8;
    const relative = (value - PEAK + 0x80) & 0xffff;
    if (relative < 256 && ((filter >>> (relative & 7)) & kernel(0x4c5b + (relative >>> 3))) !== 0) return { mass: rolledMass, minerals: value };
  }
  return { mass: rolledMass, minerals: 0 }; // never reached with the game's table
}

// PLSET-OV's LO-MASS and HI-MASS: a planet class's mass range for the arrival roll.
export interface MassTables {
  low(planetClass: number): number;
  high(planetClass: number): number;
}

export interface PlanetDataSources {
  // The PLANET file record for a species.
  planetRecord?: (species: number) => Uint8Array | undefined;
  // STARFLT.COM, for the kernel's random generator tables.
  starflt?: Uint8Array;
  massTables?: MassTables;
}

// ANALYZE-OV's .GRAV: the mass (record word at offset 2) is the gravity in hundredths of a G up to 800, and grows
// with the square root beyond: 800 + 10 * isqrt(mass - 800).
const PLANET_CLASS = 0;
const PLANET_MASS = 2;
function gravity(mass: number): number {
  const hundredths = mass > 800 ? Math.floor(Math.sqrt(mass - 800)) * 10 + 800 : mass;
  return hundredths / 100;
}

/**
 * Extracts and reconstructs all star systems from STARB.COM instance graph. `sources` supply the planets' mineral and
 * life densities.
 */
export function extractStarSystems(starb: Uint8Array, sources: PlanetDataSources = {}): StarSystemInfo[] {
  const visited = new Set<number>();
  const nodeMap = new Map<number, InstanceNode>();
  const queue: number[] = [0x1006]; // IROOT address

  // Breadth-first traversal of the entire instance tree
  while (queue.length > 0) {
    const addr = queue.shift()!;
    if (visited.has(addr) || addr === 0 || addr >= starb.length - 16) continue;
    visited.add(addr);

    const next = read24(starb, addr);
    const prev = read24(starb, addr + 3);
    const child = read24(starb, addr + 6);
    const cls = starb[addr + 9];
    const species = starb[addr + 10];

    nodeMap.set(addr, { addr, next, prev, child, cls, species });

    if (next !== 0 && !visited.has(next)) queue.push(next);
    if (child !== 0 && !visited.has(child)) queue.push(child);
  }

  const systems: StarSystemInfo[] = [];

  // Parse all STARSYSTEM nodes (cls === 0x17)
  for (const [addr, node] of nodeMap) {
    if (node.cls !== 0x17) continue;

    const spectralType = String.fromCharCode(node.species) || '?';
    const spectralInfo = getSpectralDetails(spectralType);

    // Signed 16-bit flare date
    const rawFlare = (starb[addr + 11] | (starb[addr + 12] << 8));
    const flaredate = (rawFlare << 16) >> 16;

    let flareStatus: 'flared' | 'critical' | 'stable' = 'stable';
    if (flaredate <= 0) {
      flareStatus = 'flared';
    } else if (flaredate < 200) {
      flareStatus = 'critical';
    }

    const rawX = starb[addr + 13] | (starb[addr + 14] << 8); // INST-X and INST-Y
    const rawY = starb[addr + 15] | (starb[addr + 16] << 8);
    const x = rawX >> 3;
    const y = rawY >> 3;
    const rawOrbitMask = starb[addr + 17];
    const loggedmask = starb[addr + 18];
    const nplanets = countSetBits(rawOrbitMask);

    const planets: PlanetInfo[] = [];
    let orbitmask = rawOrbitMask;

    if (nplanets > 0 && node.child !== 0) {
      let nextAddr = node.child;
      let orbit = 0;

      for (let j = 0; j < nplanets; j++) {
        // Advance orbit counter until bit is 1
        while ((orbitmask & 1) === 0 && orbit < 8) {
          orbitmask >>= 1;
          orbit++;
        }
        orbitmask >>= 1;
        orbit++;

        const pNode = nodeMap.get(nextAddr);
        if (!pNode) break;

        let actualPlanetAddr = nextAddr;
        let actualNode = pNode;

        // In Starflight, system contents are wrapped in BOX (cls 0x0b)
        if (pNode.cls === 0x0b) {
          const boxChild = nodeMap.get(pNode.child);
          if (boxChild && boxChild.cls === 0x18) { // Central Star
            const sib = nodeMap.get(pNode.next);
            if (sib) {
              actualNode = nodeMap.get(sib.child) || sib;
              actualPlanetAddr = actualNode.addr;
              nextAddr = sib.next;
            }
          } else if (boxChild) {
            actualNode = boxChild;
            actualPlanetAddr = actualNode.addr;
            nextAddr = pNode.next;
          }
        } else {
          nextAddr = pNode.next;
        }

        const pSpecies = actualNode.species;
        const hasStarport = actualNode.child !== 0 && nodeMap.get(actualNode.child)?.cls === 0x0c;
        const isArth = hasStarport || (x === 125 && y === 100 && orbit === 3);
        const typeInfo = getPlanetTypeInfo(pSpecies, isArth);
        let record: Uint8Array | undefined;
        try {
          record = sources.planetRecord?.(pSpecies);
        } catch {
          record = undefined; // a species outside the PLANET file
        }
        let densities: Pick<PlanetInfo, 'minerals' | 'bio' | 'gravity' | 'rolled'> = {};
        if (record && record.length > PLANET_MINERAL_DENSITY) {
          if (pSpecies > ROLLED_SPECIES_MAX) {
            densities = {
              minerals: sensorPercent(record[PLANET_MINERAL_DENSITY]),
              bio: sensorPercent(record[PLANET_LIFE_DENSITY]),
              gravity: gravity(record[PLANET_MASS] | (record[PLANET_MASS + 1] << 8))
            };
          } else if (sources.starflt && sources.massTables) {
            const rolled = rollPlanet(sources.starflt, sources.massTables, record[PLANET_CLASS], rawX, rawY, orbit);
            densities = { minerals: sensorPercent(rolled.minerals), bio: 0, gravity: gravity(rolled.mass), rolled: true };
          }
        }

        planets.push({
          addr: actualPlanetAddr,
          addrHex: `0x${actualPlanetAddr.toString(16).padStart(4, '0')}`,
          orbit,
          species: pSpecies,
          typeName: typeInfo.name,
          category: typeInfo.category,
          color: typeInfo.color,
          radius: typeInfo.radius,
          isArth,
          hasStarport,
          childAddr: actualNode.child,
          ...densities
        });
      }
    }

    const isHomeSystem = x === 125 && y === 100;

    systems.push({
      addr,
      addrHex: `0x${addr.toString(16).padStart(4, '0')}`,
      spectralType,
      spectralName: spectralInfo.name,
      spectralColor: spectralInfo.color,
      starColor: spectralInfo.starGlow,
      species: node.species,
      x,
      y,
      flaredate,
      flareStatus,
      orbitmask: rawOrbitMask,
      loggedmask,
      nplanets,
      planets,
      isHomeSystem
    });
  }

  // Sort: Home system first, then by coordinates (x, y)
  systems.sort((a, b) => {
    if (a.isHomeSystem) return -1;
    if (b.isHomeSystem) return 1;
    if (a.x !== b.x) return a.x - b.x;
    return a.y - b.y;
  });

  return systems;
}

// A continuum flux: entering at (x, y) jumps the ship to (destX, destY). Each FLUX-NODE is one way; most come in
// mirrored pairs.
export interface FluxInfo {
  addr: number;
  x: number;
  y: number;
  destX: number;
  destY: number;
}

// FLUX-NODE instances (class 2Dh) in STARB.COM: INST-X/INST-Y (offsets 13/15) are the entry, HYPER-OV's DEST-X and
// DEST-Y (offsets 11/17) the exit, in the same 1/8 units as star positions.
export function extractFluxes(starb: Uint8Array): FluxInfo[] {
  const word = (address: number) => starb[address] | (starb[address + 1] << 8);
  const fluxes: FluxInfo[] = [];
  const visited = new Set<number>();
  const queue = [0x1006]; // IROOT
  while (queue.length > 0) {
    const addr = queue.shift()!;
    if (visited.has(addr) || addr === 0 || addr >= starb.length - 20) continue;
    visited.add(addr);
    if (starb[addr + 9] === 0x2d) {
      fluxes.push({ addr, x: word(addr + 13) >> 3, y: word(addr + 15) >> 3, destX: word(addr + 11) >> 3, destY: word(addr + 17) >> 3 });
    }
    queue.push(read24(starb, addr), read24(starb, addr + 6));
  }
  return fluxes;
}
