/**
 * Colonizable planets in Starflight I, as listed by the Starflight Resource Pages:
 * http://www.starflt.com/tables/index.php/starflight1/colonizable-planets/
 *
 * Each entry names a system by its starmap coordinates and a planet by its position from the star (P1 is the
 * innermost planet, not orbit 1: every entry resolves to a planet that way, all within the list's 2 G limit), with the
 * bonus the game pays for recommending it.
 */

import type { StarSystemInfo } from './starsystems.ts';

export interface ColonyInfo {
  // P1, P2, ...: the planet's position counted outward from the star.
  position: number;
  // Bonus in MU for recommending the planet.
  bonus: number;
  // The system is guarded.
  guarded: boolean;
  // Bold on the source page: not listed in the game's clue book.
  notInClueBook: boolean;
}

// x, y, position, bonus, flags: 'g' guarded, 'c' not in the clue book.
const COLONIZABLE: readonly [number, number, number, number, string?][] = [
  [12, 112, 2, 35000], [14, 5, 1, 35000], [16, 163, 3, 35000], [17, 108, 1, 30000, 'c'], [17, 213, 1, 35000],
  [18, 50, 4, 30000], [33, 6, 1, 30000], [65, 99, 2, 30000], [68, 66, 1, 55000, 'g'], [69, 163, 1, 40000],
  [78, 123, 1, 40000], [81, 98, 1, 50000], [86, 80, 1, 35000], [87, 40, 2, 35000], [88, 78, 1, 35000, 'c'],
  [90, 8, 2, 35000], [91, 86, 4, 35000], [94, 118, 3, 30000], [98, 82, 1, 35000], [103, 185, 3, 35000],
  [104, 71, 1, 35000], [105, 165, 4, 35000], [112, 200, 3, 40000, 'c'], [114, 138, 2, 30000, 'c'],
  [118, 146, 4, 40000], [121, 158, 2, 30000, 'c'], [123, 101, 1, 35000, 'c'], [125, 189, 2, 30000],
  [128, 187, 1, 35000], [128, 124, 1, 30000, 'g'], [129, 33, 2, 35000], [137, 153, 1, 30000], [143, 115, 1, 35000, 'g'],
  [145, 107, 4, 50000, 'g'], [145, 168, 1, 35000], [149, 133, 4, 40000], [149, 133, 5, 40000], [149, 173, 2, 40000],
  [151, 68, 1, 35000], [160, 48, 2, 30000], [163, 46, 3, 35000], [163, 46, 4, 35000], [164, 85, 8, 50000],
  [169, 2, 1, 35000], [175, 94, 1, 35000], [188, 74, 2, 35000], [199, 181, 2, 35000], [209, 80, 4, 35000, 'c'],
  [211, 93, 2, 30000], [215, 86, 2, 35000], [215, 86, 3, 35000], [217, 88, 4, 50000], [221, 109, 2, 35000],
  [226, 167, 2, 40000], [234, 20, 2, 30000], [247, 81, 1, 40000]
];

// Attach ColonyInfo to the listed planets; returns the systems that have any, in list order.
export function markColonizablePlanets(systems: StarSystemInfo[]): StarSystemInfo[] {
  const marked: StarSystemInfo[] = [];
  for (const [x, y, position, bonus, flags = ''] of COLONIZABLE) {
    const system = systems.find(candidate => candidate.x === x && candidate.y === y);
    const planet = system && [...system.planets].sort((a, b) => a.orbit - b.orbit)[position - 1];
    if (!system || !planet) {
      console.warn(`Colonizable planet P${position} at ${x}, ${y} is not in the game data.`);
      continue;
    }
    planet.colony = { position, bonus, guarded: flags.includes('g'), notInClueBook: flags.includes('c') };
    if (!marked.includes(system)) marked.push(system);
  }
  return marked;
}
