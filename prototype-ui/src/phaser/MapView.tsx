import { useEffect, useRef } from "react";
import * as Phaser from "phaser";
import type { NpcDay, SceneWire } from "../../../app/shared/protocol";
import { MapScene } from "./MapScene";
import { bus, BUS_EVENTS } from "./bus";

interface MapViewProps {
  scene: SceneWire | null;
  npcs: NpcDay[];
}

/**
 * React host for the Phaser map. One Phaser.Game per mount, guarded for
 * React 18 StrictMode's double-mount. Rebuilds the active scene whenever
 * the incoming scene wire changes.
 */
export function MapView({ scene, npcs }: MapViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const gameRef = useRef<Phaser.Game | null>(null);
  const sceneRef = useRef<MapScene | null>(null);
  const pendingRef = useRef<{ scene: SceneWire; npcs: NpcDay[] } | null>(null);

  useEffect(() => {
    if (!hostRef.current) return;
    if (gameRef.current) return;

    const mapScene = new MapScene();
    sceneRef.current = mapScene;
    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: hostRef.current,
      backgroundColor: "#141015",
      pixelArt: true,
      antialias: false,
      scale: {
        mode: Phaser.Scale.RESIZE,
        width: "100%",
        height: "100%",
      },
      scene: [mapScene],
    });
    gameRef.current = game;

    const onReady = () => {
      const pending = pendingRef.current;
      if (pending && sceneRef.current) {
        sceneRef.current.loadScene(pending.scene, pending.npcs);
        pendingRef.current = null;
      }
    };
    bus.once(BUS_EVENTS.sceneReady, onReady);

    return () => {
      bus.off(BUS_EVENTS.sceneReady, onReady);
      gameRef.current?.destroy(true, false);
      gameRef.current = null;
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!scene) return;
    const active = sceneRef.current;
    if (active && active.scene?.isActive?.()) {
      active.loadScene(scene, npcs);
    } else {
      pendingRef.current = { scene, npcs };
    }
  }, [scene, npcs]);

  return (
    <div
      ref={hostRef}
      style={{
        width: "100%",
        height: "100%",
        minHeight: 320,
        background: "#141015",
      }}
    />
  );
}
