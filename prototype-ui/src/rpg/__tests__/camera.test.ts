import { describe, it, expect } from "vitest";
import { stepCamera } from "../engine";

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
