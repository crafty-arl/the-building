import { describe, it, expect } from "vitest";
import {
  type Character,
  type Scene,
  type GameState,
  WALK_SPEED,
  walkTo,
  tickCharacters,
  initialState,
} from "../engine";

function makeScene(): Scene {
  const cols = 20;
  const rows = 10;
  const floor_y = 8;
  const wall = "#".repeat(cols);
  const air = "#" + ".".repeat(cols - 2) + "#";
  const map: string[] = [];
  for (let y = 0; y < rows; y++) {
    if (y === 0 || y === rows - 1) map.push(wall);
    else map.push(air);
  }
  return {
    id: "test",
    name: "test",
    map,
    floor_y,
    anchors: { center: { x: Math.floor(cols / 2), y: floor_y } },
    starts: {} as Scene["starts"],
    schedules: {} as Scene["schedules"],
  };
}

function makeChar(x: number, floorY: number): Character {
  return {
    id: "marrow",
    name: "Marrow",
    description: "",
    pos: { x, y: floorY },
    facing: "right",
    moving: false,
    path: null,
    goal: null,
    palette: { body: "#aaa", cloak: "#333", accent: "#fc0" },
    emote: null,
    speech: null,
    mood: "watchful",
    schedule: [],
    scheduleAnchor: null,
    inventory: [],
    backstory: "",
    objective: "",
    motive: "",
    hp: 3,
    dead: false,
    transient: false,
  };
}

describe("walkTo / tickCharacters", () => {
  it("walks from x=5 to x=15 within an expected tick budget at WALK_SPEED", () => {
    const s: GameState = initialState(0);
    s.scene = makeScene();
    s.characters = [makeChar(5, s.scene.floor_y)];
    const c = s.characters[0];

    const started = walkTo(s.scene, c, 15, 0);
    expect(started).toBe(true);
    expect(c.path?.toX).toBe(15);

    const dt = 1 / 60;
    const maxTicks = Math.ceil((10 / WALK_SPEED) / dt) + 5;
    let now = 0;
    let ticks = 0;
    while (c.path && ticks < maxTicks * 2) {
      now += dt * 1000;
      tickCharacters(s, now, dt);
      ticks++;
    }
    expect(c.path).toBeNull();
    expect(Math.abs(c.pos.x - 15)).toBeLessThan(0.01);
    expect(ticks).toBeLessThanOrEqual(maxTicks);
  });

  it("no-ops when already standing on the target column", () => {
    const s: GameState = initialState(0);
    s.scene = makeScene();
    s.characters = [makeChar(10, s.scene.floor_y)];
    const c = s.characters[0];
    const moved = walkTo(s.scene, c, 10, 0);
    expect(moved).toBe(false);
    expect(c.path).toBeNull();
  });

  it("pins character y to floor_y even if displaced", () => {
    const s: GameState = initialState(0);
    s.scene = makeScene();
    const c = makeChar(8, s.scene.floor_y);
    c.pos.y = 2;
    s.characters = [c];
    tickCharacters(s, 0, 1 / 60);
    expect(c.pos.y).toBe(s.scene.floor_y);
  });
});
