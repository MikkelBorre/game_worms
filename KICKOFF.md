# WormWorld – sådan starter du i Claude Code

## 0. Arbejd direkte i GitHub (anbefalet)

1. Opret et tomt repo på github.com, fx `wormworld` (privat er fint).
2. Upload indholdet af zip-filen: "Add file → Upload files" og træk alle filer og mapper ind,
   inkl. `.claude/` og `.mcp.json`. **Tjek at de skjulte punktum-mapper kom med.** Ellers så brug
   GitHub Desktop eller `git push`.
3. Gå til **claude.ai/code** → forbind GitHub (installér Claude GitHub App på repoet) → vælg `wormworld`.
4. Indsæt kickoff-prompten fra afsnit 3. Claude arbejder i skyen på en branch, committer, pusher
   og kan åbne pull requests, som du merger. Du kan følge med fra browser eller mobil.
5. `.mcp.json` i repoet giver automatisk Playwright og Context7 i alle sessioner.

Valgfrit: kør `/install-github-app` i Claude Code i terminalen. Så kan du skrive `@claude`
i issues og PR's på GitHub (fx "@claude tilføj Banana Bomb"), og Claude laver en PR via GitHub Actions.

Tilføj denne linje til kickoff-prompten, når du arbejder på GitHub:
`Arbejd på en feature-branch pr. milepæl (m0-skelet, m1-oen ...) og åbn en PR, når milepælen er grøn.`

## 1. Lokal opsætning (alternativ, ca. 5 min)

```bash
mkdir wormworld && cd wormworld
# pak zip-filen ud her, så CLAUDE.md, docs/ og .claude/ ligger i roden
git init && git add . && git commit -m "chore: project brief"
```

Tilføj to MCP-servere (anbefalet):

```bash
# Browser-styring: Claude kan åbne spillet, klikke og tage screenshots
claude mcp add playwright -- npx -y @playwright/mcp@latest

# Opdateret dokumentation for Three.js / Rapier / Vite (undgår forældede API'er)
claude mcp add context7 -- npx -y @upstash/context7-mcp
```

Start Claude Code i mappen med `claude`. Tjek at modellen er Opus (`/model`), og at `/agents` viser de 5 agents.

## 2. Hvad ligger der

| Fil | Rolle |
|---|---|
| `CLAUDE.md` | Projektets "grundlov": stack, arkitektur, regler, kommandoer. Læses automatisk. |
| `docs/GDD.md` | Game design: loop, våben, styring, stil |
| `docs/ROADMAP.md` | Milepæle M0–M8 med "done"-kriterier |
| `.claude/agents/terrain-engineer` | Voxel-terræn, marching cubes, ødelæggelse |
| `.claude/agents/gameplay-engineer` | Tur-system, våben, fysik, skade, bots |
| `.claude/agents/render-engineer` | Three.js, shaders, kamera, HUD, juice |
| `.claude/agents/qa-tester` | Uafhængig test (Sonnet, billigere), retter ikke selv |
| `.claude/agents/netcode-architect` | Determinisme + online (først i M8) |
| `.claude/skills/add-weapon` | Fast opskrift på nye våben |
| `.claude/skills/playtest` | Playwright-scenarier + screenshots som Claude selv kigger på |
| `.claude/skills/perf-check` | Måling mod performance-budget |
| `.claude/skills/deploy` | Cloudflare Pages + CNAME hos e-studio |
| `.claude/settings.json` | Opus som model, tilladelser, `rm` og force-push blokeret |

## 3. Kickoff-prompt (kopiér ind i Claude Code)

```
Læs CLAUDE.md, docs/GDD.md og docs/ROADMAP.md grundigt.

Vi bygger WormWorld: en open world 3D-udgave af Worms i browseren. Start med M0 og M1.

Arbejdsgang:
1. Vis mig først en kort plan for M0+M1: filer du opretter, pakker du installerer
   (med versioner) og hvilke subagents der gør hvad. Vent på mit OK.
2. M0 laver du selv (skelet, tooling, loop, debug-API, playwright-setup).
3. M1: Deleger terræn til terrain-engineer og vand-shader/kamera til render-engineer
   – kør dem parallelt, de rører ikke de samme filer.
4. Når M1 er færdig: kør qa-tester-agenten og derefter playtest-skill.
   Kig selv på screenshots og fortæl mig hvad du ser.
5. Commit efter hver fungerende del. Slet aldrig filer uden at spørge.

Slut af med en kort status på dansk: hvad virker, hvad mangler, perf-tal
vs. budget, og dit forslag til næste skridt (M2).
```

## 4. Senere prompts (én milepæl ad gangen)

**M2+M3:**
```
Fortsæt med M2 og M3 fra ROADMAP. Plan først. gameplay-engineer tager
character controller, skade og våben (brug add-weapon-skill til bazooka og granat).
terrain-engineer tager carveSphere + chunk-rebuild. render-engineer tager orm-model,
kameraer og eksplosions-FX. Afslut med qa-tester, playtest og perf-check.
```

**M4 (første spilbare version):**
```
Lav M4. Når hotseat virker med 2 hold × 3 orme, så kør deploy-skill og
guid mig gennem Cloudflare- og CNAME-opsætningen trin for trin.
```

**Nyt våben når som helst:**
```
/add-weapon Super Sheep: flyver når man trykker Space igen, styres med musen,
eksploderer ved næste klik eller efter 8 sek. Radius 3 m, 60 skade.
```

## 5. Tips
- **Én milepæl pr. session.** Kør `/clear` mellem milepæle. CLAUDE.md og ROADMAP holder konteksten.
- Brug **plan mode** (Shift+Tab) ved store ændringer.
- Hvis noget ser forkert ud: bed om "kør playtest med seed X og vis mig screenshot".
- Justér balance direkte i `src/sim/weapons/*`. Tallene står samlet øverst i hver fil.
