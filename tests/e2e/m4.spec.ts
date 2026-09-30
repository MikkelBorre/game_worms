import { expect, test } from '@playwright/test';
import { openGame } from './helpers';

test('turns: startMatch hands control to the turn worm; endTurn passes it to the other team', async ({
  page,
}) => {
  const errors = await openGame(page, 1234);
  const r = await page.evaluate(async () => {
    const g = window.__game!;
    g.pause(true);
    g.spawnTeams(2, 2);
    g.advance(60);
    const before = g.state().turn;
    g.startMatch({ turnSeconds: 30 });
    g.advance(1);
    const s1 = g.state();
    const worm1 = s1.worms.find((w) => w.id === s1.turn.wormId)!;
    // A worm of the other team refuses commands.
    const other = s1.worms.find((w) => w.team !== s1.turn.team)!;
    g.command({ type: 'move', wormId: other.id, dir: [1, 0] });
    g.advance(30);
    const otherMoved = Math.hypot(
      g.state().worms.find((w) => w.id === other.id)!.pos[0] - other.pos[0],
      g.state().worms.find((w) => w.id === other.id)!.pos[2] - other.pos[2],
    );
    g.endTurn();
    await g.advanceAsync(120);
    const s2 = g.state();
    return {
      before,
      t1: s1.turn,
      active1: s1.activeWormId,
      team1: worm1.team,
      otherMoved,
      t2: s2.turn,
      active2: s2.activeWormId,
      team2: s2.worms.find((w) => w.id === s2.activeWormId)!.team,
    };
  });
  expect(r.before.enabled).toBe(false);
  expect(r.t1).toMatchObject({ enabled: true, phase: 'move', turn: 1, team: 0 });
  expect(r.active1).toBe(r.t1.wormId);
  expect(r.team1).toBe(0);
  expect(r.otherMoved).toBeLessThan(0.05);
  expect(r.t2).toMatchObject({ phase: 'move', turn: 2, team: 1 });
  expect(r.active2).toBe(r.t2.wormId);
  expect(r.team2).toBe(1);
  expect(errors).toEqual([]);
});
