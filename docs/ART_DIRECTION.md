# Art direction – WormWorld

Referencer: `docs/art/reference-collage.png`, `docs/art/reference-hero.png` (kun inspiration – brug **aldrig**
"Worms"-navnet, Team17-logoer eller deres grafik i spillet).

Mål: moderne, varm, legetøjsagtig cartoon-look á la de nyere 3D-Worms/Fortnite-agtige spil – men alt
procedural og inden for performance-budgettet i `CLAUDE.md` (60 fps på integreret GPU).

## Lys og stemning
- **Golden hour som standard**: lav sol (15–25° over horisonten), varm orange/gul sollys-farve, blå-lilla
  skyggefyld fra himlen, stærk sol-refleks-sti på havet mod solen.
- Himmel: varm gradient ved horisonten (fersken → lyseblå), skyer med solbelyste kanter.
- Let atmosfærisk dis (fog) i varm farve, ikke grå.
- Senere: dag/nat-presets (kun kosmetisk).

## Terræn og øen
- Græs: mættet grøn med variation (gul-grønne toppe, mørkere lavninger). **Instancerede græstotter** og
  små blomster (hvide/gule) på flade græsflader nær kameraet (LOD/afstandsfade).
- Sten: **instancerede klippeblokke** (low-poly, facetterede) på skråninger og strand.
- Stier: lysebrun jord-farve langs "veje" mellem landsby og fyrtårn (vertex-farve, senere).
- Kulisser (M5, voxel-strukturer eller meshes): fyrtårn (rød/hvid), træbro, hytter i landsbyen,
  vindmølle, kasser, røde TNT-tønder, skilte ("Base Camp", "Harbor", "Beach").
- Vegetation: palmer/buske som simple low-poly instancer.

## Ormene
- Lang, blød **S-formet krop** (lyserød/fersken), tydelige segmenter nederst, tyk hale.
- Store øjne med **øjenlåg og bryn** → udtryk: bestemt/vred ved sigte, glad idle, bange ved lavt HP.
- Standard-hjelm: **army-hjelm med goggles**; holdfarve vises som bånd/stribe på hjelmen + navneskilt.
- Våbnet holdes synligt (bazooka på skulderen i sigte-mode).
- Outline (tynd, mørk) beholdes – giver cartoon-læsbarhed.

## HUD-layout (plain DOM/CSS)
```
┌────────────────────────────────────────────────────────────┐
│ [portræt] Konrad   ████████░░      (vind-pil)   ◯ minimap │
│ [portræt] Viktoria ██████░░░░                    m. kompas │
│ [portræt] Aksel    ███████░░░                    N Ø S V   │
│                                                            │
│                  ▼ Navn                                    │
│                  (orm)                                     │
│                                                            │
│ ┌──────────────┐           ⏱ 0:45                          │
│ │ 🚀 Bazooka   │                                           │
│ │    2 / 3     │                                           │
│ └──────────────┘                                           │
└────────────────────────────────────────────────────────────┘
```
- **Øverst venstre:** holdliste – rundt portræt (orm-ansigt i holdfarve), navn, HP-bar i holdfarve. Aktiv orm fremhævet.
- **Øverst højre:** rund minimap (top-down heightmap-render) med kompasring (N/Ø/S/V), spillerpil der
  roterer med kameraet, prikker for orme i holdfarver, senere markører for kasser/mål.
- **Nederst venstre:** våbenkort – ikon, navn, ammo "2 / 3".
- **Nederst midt/top midt:** turtimer + vindindikator.
- **Over ormene:** navneskilt + HP + lille trekant-markør i holdfarve (skaleret efter afstand, skjult bag terræn).
- **Våbenmenu (Q):** mørkt, semi-transparent panel med afrundede hjørner, faner (Våben / Udstyr / Skins /
  Emotes – kun Våben i MVP), 3-kolonne ikon-grid, valgt våben med gul kant.
- Stil: mørke paneler `rgba(15, 20, 30, 0.75)`, 10–14 px radius, blød skygge, hvid tekst, gule accenter,
  fed afrundet sans-serif til tal/navne; tegneserie-agtig titel-font til logo og store beskeder.
- Store "kommentator"-beskeder (fx "Double kill!", "Teamwork... or total chaos!") i tegneserie-font med
  let rotation.

## Logo / titel
- "WormWorld" i tyk, afrundet, orange/gul display-font med mørk kontur og let 3D-skygge; undertekst i
  hvid pensel-font ("Same chaos. Bigger world.").

## Standardnavne
- Standard-ormenavne kan sættes pr. hold i startmenuen (M4). Eksempel fra referencen: Konrad, Viktoria, Aksel.

## Idéer til senere (ikke på roadmap endnu)
Køretøjer (jeep med speedometer), missioner/mål-panel, XP/level og kosmetiske skins, luftskib/helikoptere
som ambient pynt.
