/**
 * Default team / worm names until the start menu (M4) lets players pick their own.
 * Danish names on purpose – the game UI is Danish.
 */

export const DEFAULT_TEAM_NAMES: readonly string[] = ['Hold 1', 'Hold 2', 'Hold 3', 'Hold 4'];

/** One list per team (index = team % length). Worms beyond the list get "<name> 2", "<name> 3", … */
export const DEFAULT_WORM_NAMES: readonly (readonly string[])[] = [
  ['Konrad', 'Viktoria', 'Aksel', 'Janni', 'Mikkel', 'Freja'],
  ['Bent', 'Olga', 'Sigurd', 'Lærke', 'Holger', 'Tove'],
  ['Egon', 'Ingrid', 'Rasmus', 'Dagmar', 'Knud', 'Sofie'],
  ['Palle', 'Gudrun', 'Viggo', 'Karen', 'Svend', 'Alma'],
];

const wrap = (i: number, n: number) => ((i % n) + n) % n;

export function teamName(team: number): string {
  return DEFAULT_TEAM_NAMES[team] ?? `Hold ${team + 1}`;
}

/** Name of the `index`-th worm (spawn order) of a team. */
export function wormName(team: number, index: number): string {
  const list = DEFAULT_WORM_NAMES[wrap(team, DEFAULT_WORM_NAMES.length)]!;
  const base = list[index % list.length]!;
  const lap = Math.floor(index / list.length);
  return lap === 0 ? base : `${base} ${lap + 1}`;
}
