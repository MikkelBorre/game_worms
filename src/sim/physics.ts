import RAPIER from '@dimforge/rapier3d-compat';

let ready: Promise<void> | null = null;

/** Initialise Rapier's WASM exactly once. Safe to call repeatedly. */
export function initPhysics(): Promise<void> {
  ready ??= RAPIER.init();
  return ready;
}

export { RAPIER };
