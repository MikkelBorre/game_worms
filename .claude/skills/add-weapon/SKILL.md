---
name: add-weapon
description: Add a new weapon or tool to WormWorld end to end (sim module, registry, icon, HUD, FX, test). Use whenever the user asks for a new weapon, utility (rope, jetpack, teleport) or changes how a weapon behaves.
---

# Add a weapon

1. **Spec first.** Write 3–6 lines: what it does, damage/radius, ammo, usesPower, usesTimer, affectedByWind, special behavior. Show it to the user if it's a new idea; pick sensible defaults if they already described it.
2. **Sim module** `src/sim/weapons/<id>.ts` implementing `Weapon` from `registry.ts`:
   - `fire(ctx)` spawns projectile(s) or applies an effect via `ctx.world`, `ctx.rng`, `ctx.emit`.
   - Use `onTick` for guided/walking weapons (sheep, homing), `onImpact` for explode-on-contact.
   - Reuse `explosion.ts` (`explode(ctx, pos, radius, maxDamage)`) – never reimplement damage.
   - Only seeded RNG. No `three` imports.
3. **Register** in `registry.ts` with ammo default and crate drop weight.
4. **Visuals** in `src/render/fx.ts` / a projectile view: a procedural mesh (no external assets), trail if it flies, impact FX.
5. **Icon**: a small inline SVG in `src/ui/icons/<id>.svg` in the same flat style as existing icons.
6. **Test** `tests/unit/weapons/<id>.test.ts`: headless sim, fixed seed, fire at a known target, assert damage / crater / behavior after N ticks.
7. Run `npm run typecheck && npm test`, then the `playtest` skill with a scenario that fires the new weapon, and look at the screenshot.
8. Commit: `feat(weapon): <name>`.
