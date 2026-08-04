export interface PixelSortRequest {
  id: number;
  nodeId: string;
  words: Uint32Array;
  width: number;
  height: number;
  thresh: number;
  vert: boolean;
}

export interface PixelSortResponse {
  id: number;
  nodeId: string;
  words: Uint32Array;
  width: number;
  height: number;
  sortMs: number;
}
