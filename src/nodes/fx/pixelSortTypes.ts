export interface PixelSortRequest {
  id: number;
  nodeId: string;
  words: Uint32Array;
  width: number;
  height: number;
  thresh: number;
  /** Kept for older workers / patches; folded into `rotation` via effectiveSortAngle. */
  vert: boolean;
  /** Degrees from horizontal. 0 defers to `vert`; 90 ≡ vertical. */
  rotation: number;
}

export interface PixelSortResponse {
  id: number;
  nodeId: string;
  words: Uint32Array;
  width: number;
  height: number;
  sortMs: number;
}
