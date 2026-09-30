# Game Design – WormWorld

## Pitch
Worms, men på en rigtig 3D-ø du kan bevæge dig frit rundt på. Turbaseret kaos med
fjollede våben, ødelæggeligt terræn og et hav, der æder alle der falder i.

## Kerne-loop
1. Aktivt hold får tur. Aktiv orm vælges (rotation pr. hold).
2. **45 sek bevægelsesfase**: gå, hop, backflip, ninja rope, jetpack, samle kasser op.
3. Vælg våben → sigte (3. persons over-skulder-kamera) → skyd. Maks ét skud pr. tur (nogle våben har flere skud).
4. **5 sek retreat** efter skud.
5. Fysik settler (alle legemer i ro, eller max 8 sek) → skade opgøres → næste tur.
6. Hold uden levende orme har tabt.

## Open world-elementer
- **Ø-størrelse:** ca. 160 × 160 m, højde op til 40 m. Bakker, klipper, huler, en lille landsby af ødelæggelige hytter, bro, fyrtårn.
- **Spawn spredt** over hele øen → strategisk bevægelse betyder noget.
- **Minimap + "ping"**: tryk Tab for oversigtskamera, der viser alle orme.
- **Kasser** falder ned med faldskærm: våben, helbred, værktøj (jetpack, teleport, ekstra tid).
- **Vind** varierer i retning (3D-vektor i XZ) og styrke; vises som vindpil i HUD.
- **Sudden death:** efter N runder stiger havet 1 m pr. tur.
- **Dag/nat-kosmetik** (senere): kun visuelt.

## Styring (keyboard + mus)
| Handling | Tast |
|---|---|
| Gå | WASD (kamera-relativ) |
| Hop / backflip | Space / dobbelt-Space |
| Kamera | Mus (pointer lock) |
| Sigte-mode | Højre museknap |
| Skyd (hold = kraft) | Venstre museknap |
| Våbenmenu | Q eller hjul |
| Timer (granat) | 1–5 |
| Oversigt | Tab |
Gamepad-support er nice-to-have (Gamepad API).

## Våben (MVP → senere)
**MVP:** Bazooka, Granat, Shotgun, Ninja Rope, Dynamite.
**Fase 2:** Banana Bomb, Cluster Bomb, Air Strike (markér på minimap), Sheep (løber fremad, hopper, eksploderer), Homing Missile, Jetpack, Teleport, Baseball Bat, Girder (placér bjælke i 3D).
**Fase 3 (fjollet):** Super Sheep (styrbar flyvning), Holy Hand Grenade, Concrete Donkey, Old Woman.

Alle våben defineres i `src/sim/weapons/*` med fælles interface:
`id, name, icon, ammo, usesPower, usesTimer, affectedByWind, fire(ctx), onTick?, onImpact?`

## Skade
- Eksplosion: radius R, skade falder lineært fra centrum (max D).
- Knockback-impuls ∝ skade, retning fra centrum + lidt op.
- Faldskade over 6 m fald.
- Vand = øjeblikkelig død.
- Orm med 0 HP eksploderer lille (radius 2 m) og bliver en gravsten.

## Visuel stil
**Se `docs/ART_DIRECTION.md`** (golden hour, orm v2, HUD-layout, referencebilleder i `docs/art/`).

Stiliseret low-poly/cartoon. Flad shading med let toon-ramp, mættede farver, blød tåge mod horisonten,
animeret vandshader (enkle bølger + skum ved kysten). Ormene er procedurale (kapsel-krop + øjne + hjelm i holdfarve)
– ingen eksterne assets nødvendige i MVP.

## Lyd
Procedural/gratis CC0-effekter (fx fra Kenney.nl). Korte, fjollede stemmer er fase 3.

## Multiplayer
- **MVP:** hotseat 2–4 hold, 1–4 orme pr. hold.
- **Fase 2:** CPU-bots (simpel: find nærmeste fjende med sigtelinje, prøv N skud-simulationer, vælg bedste).
- **Fase 3:** online via Supabase Realtime: kun aktiv spillers `Command`s broadcastes; alle klienter kører samme deterministiske sim fra samme seed. Hash af world-state sammenlignes hvert turslut for at opdage desync.
