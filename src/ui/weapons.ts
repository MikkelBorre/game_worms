/**
 * HUD-side weapon catalogue: display names + whether the weapon exists in the sim yet.
 * Purely presentational – the sim weapon registry (src/sim/weapons/) stays the source of truth for
 * behaviour/ammo; once it exists the HUD should be fed from it instead of this list.
 */
export interface WeaponMenuItem {
  id: string;
  name: string;
  /** False = shown greyed out as "coming later" and not selectable. */
  available: boolean;
}

export const DEFAULT_WEAPON_MENU: readonly WeaponMenuItem[] = [
  { id: 'bazooka', name: 'Bazooka', available: true },
  { id: 'grenade', name: 'Granat', available: true },
  { id: 'shotgun', name: 'Haglgevær', available: false },
  { id: 'dynamite', name: 'Dynamit', available: false },
  { id: 'cluster', name: 'Klyngebombe', available: false },
  { id: 'banana', name: 'Bananbombe', available: false },
  { id: 'airstrike', name: 'Luftangreb', available: false },
  { id: 'homing', name: 'Målsøgende missil', available: false },
  { id: 'sheep', name: 'Får', available: false },
];

export const weaponDisplayName = (id: string): string =>
  DEFAULT_WEAPON_MENU.find((w) => w.id === id)?.name ?? id;
