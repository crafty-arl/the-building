import { describe, it, expect } from "vitest";
import { stepCamera, computeSceneBand, TILE_PX } from "../engine";

describe("stepCamera", () => {
  const worldW = 1200;
  const viewportW = 400;
  const zoom = 1;

  it("does not scroll while target sits inside the deadzone", () => {
    const cam = { worldX: 400 };
    const viewCenter = cam.worldX + viewportW / 2;
    const targetX = viewCenter + 10;
    const next = stepCamera(cam, targetX, viewportW, worldW, zoom);
    expect(next.worldX).toBe(400);
  });

  it("converges toward target within ~20 frames once outside deadzone", () => {
    let cam = { worldX: 0 };
    const targetX = 700;
    for (let i = 0; i < 40; i++) {
      cam = stepCamera(cam, targetX, viewportW, worldW, zoom);
    }
    const expectedCenter = targetX;
    const finalCenter = cam.worldX + viewportW / 2;
    expect(Math.abs(finalCenter - expectedCenter)).toBeLessThan(80);
  });

  it("clamps worldX to [0, worldW - viewportW]", () => {
    const tooFarLeft = stepCamera({ worldX: 0 }, -5000, viewportW, worldW, zoom);
    expect(tooFarLeft.worldX).toBe(0);
    const tooFarRight = stepCamera({ worldX: 900 }, 99999, viewportW, worldW, zoom);
    expect(tooFarRight.worldX).toBeLessThanOrEqual(worldW - viewportW);
  });

  it("centers the world when it's narrower than the viewport", () => {
    const smallWorld = 300;
    const cam = stepCamera({ worldX: 0 }, 150, viewportW, smallWorld, zoom);
    expect(cam.worldX).toBe((smallWorld - viewportW) / 2);
  });
});

describe("computeSceneBand", () => {
  // AI-generated rooms tend to be wider than tall with a lot of empty air
  // rows above the floor. The band should crop that air so the characters
  // stay anchored near the bottom of the canvas.
  const wideRoom = {
    map: new Array(10).fill("#".repeat(36)),
    floor_y: 7,
  };

  it("crops ceiling rows above the floor", () => {
    const band = computeSceneBand(wideRoom, 600);
    // Default ceilingRows=6 and floor_y=7 → topRow clamped to 1 (not 0).
    expect(band.topRow).toBe(1);
    // bottomRow = floor_y + 1 + foundationRows(=1) = 9
    expect(band.bottomRow).toBe(9);
  });

  it("fits the band height to drawHeight", () => {
    const band = computeSceneBand(wideRoom, 600);
    const expectedRows = 9 - 1;
    expect(band.bandPx).toBe(expectedRows * TILE_PX);
    expect(band.zoom).toBeCloseTo(600 / band.bandPx, 4);
  });

  it("clamps band to map bounds when map is short", () => {
    const short = { map: ["####", "#..#", "#..#", "####"], floor_y: 2 };
    const band = computeSceneBand(short, 400);
    expect(band.topRow).toBe(0);
    expect(band.bottomRow).toBe(4);
  });

  it("always produces a positive zoom", () => {
    const band = computeSceneBand(wideRoom, 0);
    expect(band.zoom).toBeGreaterThan(0);
  });
});
