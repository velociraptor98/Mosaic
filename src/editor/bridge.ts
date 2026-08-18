import Phaser from "phaser";

/**
 * A tiny event channel for things that happen 60 times a second and must NOT
 * become React state: cursor position, live drag readouts, playtest ticks.
 *
 * Durable state lives in the ProjectStore, which the Phaser scene reads and
 * writes directly. This bus only carries transient canvas chatter.
 */
export interface CanvasEvents {
  cursor: { x: number; y: number; col: number; row: number };
  /** Emitted on every frame of a drag; the committed value lands in the store. */
  transformPreview: { id: string; x: number; y: number };
  bodyPreview: { id: string; width: number; height: number; offsetX: number; offsetY: number };
  snapHit: { x: number | null; y: number | null };
  playtest: { playing: boolean; paused: boolean; frame: number };
  runtimeSelection: string | null;
  /** A script threw during the play-test and was switched off. */
  scriptError: { script: string; message: string };
  requestFocus: undefined;
}

export class EditorBridge extends Phaser.Events.EventEmitter {
  send<K extends keyof CanvasEvents>(event: K, payload: CanvasEvents[K]): void {
    this.emit(event as string, payload);
  }
}
