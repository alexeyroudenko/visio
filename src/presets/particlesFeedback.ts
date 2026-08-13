import { DEFAULT_IMAGE_FILE } from "../nodes/shared/fileParam";
import type { SerializedPatch } from "../store/persistence";

/** Corners → Particles → Feedback trails with LFO-breathing zoom (from feedback.json). */
export function particlesFeedback(): SerializedPatch {
  return {
  "format": 1,
  "width": 1080,
  "height": 1920,
  "source": "default-frame.png",
  "nodes": [
    {
      "id": "image-1",
      "type": "source.media",
      "position": {
        "x": 0,
        "y": 140
      },
      "params": {
        "mode": "image",
        "facing": "user",
        "file": DEFAULT_IMAGE_FILE,
        "playing": true,
        "muted": false,
        "volume": 1,
        "speed": 1,
        "syncTimeline": false,
        "mirror": false,
        "fit": "cover",
        "zoom": 0.75
      }
    },
    {
      "id": "features-1",
      "type": "tracking.features",
      "position": {
        "x": 277.4556996575639,
        "y": 67.60019360210524
      },
      "params": {
        "downscale": 4,
        "block": 7,
        "maxCorners": 200,
        "quality": 0.08,
        "minDistance": 12,
        "interval": 1,
        "worker": true
      }
    },
    {
      "id": "particles-1",
      "type": "draw.particles",
      "position": {
        "x": 535.8210576126711,
        "y": 155.8435460474977
      },
      "params": {
        "count": 4000,
        "rate": 2000,
        "life": 2.5,
        "speed": 140,
        "gravity": 0,
        "drag": 0.7,
        "attract": 160,
        "size": 0.5,
        "trail": 0.7,
        "color": "#ffffff",
        "opacity": 1,
        "seed": 7,
        "blend": "add"
      }
    },
    {
      "id": "screen-1",
      "type": "output.screen",
      "position": {
        "x": 1053.0664789030454,
        "y": 130.30770528694535
      },
      "params": {
        "background": "#000000"
      }
    },
    {
      "id": "feedback-5",
      "type": "fx.feedback",
      "position": {
        "x": 780.8362994005298,
        "y": 137.08235463817147
      },
      "params": {
        "decay": 0.9750000000000001,
        "zoom": 1.021,
        "rotate": 0,
        "offsetX": 0,
        "offsetY": 0.006000000000000002,
        "mode": "max",
        "clear": false
      }
    }
  ],
  "edges": [
    {
      "id": "e-frame",
      "source": "image-1",
      "sourceHandle": "frame",
      "target": "features-1",
      "targetHandle": "frame"
    },
    {
      "id": "e-bg",
      "source": "image-1",
      "sourceHandle": "out",
      "target": "particles-1",
      "targetHandle": "bg"
    },
    {
      "id": "e-pts",
      "source": "features-1",
      "sourceHandle": "out",
      "target": "particles-1",
      "targetHandle": "points"
    },
    {
      "id": "e-3a1225c3-9df6-46c3-bca3-ccd7c0a9cf0e",
      "source": "particles-1",
      "sourceHandle": "out",
      "target": "feedback-5",
      "targetHandle": "src"
    },
    {
      "id": "e-8d600439-da7d-48b1-a82a-c8c843b721bd",
      "source": "feedback-5",
      "sourceHandle": "out",
      "target": "screen-1",
      "targetHandle": "src"
    }
  ],
  "timeline": {
    "fps": 30,
    "durationInFrames": 450,
    "keyframes": {},
    "reelZones": {
      "cutsSec": [
        1,
        1.2,
        9,
        12
      ],
      "dirty": false
    },
    "cueZoneTick": false,
    "cueDevMetronome": false,
    "cueDrone": false,
    "developmentBpm": 120,
    "droneByZone": {
      "hook": {
        "enabled": true,
        "freq": 218.5,
        "gain": 0.06,
        "type": "sawtooth",
        "detune": 18,
        "cutoff": 1800,
        "lfoRate": 6.5,
        "lfoDepth": 0.4,
        "subGain": 0.25,
        "ratio": 3.13,
        "fm": 0.35,
        "ring": 0.45,
        "noise": 0.2,
        "crush": 0.4,
        "comb": 0.3,
        "glitch": 0.5,
        "drift": 0.25
      },
      "formwait": {
        "enabled": true,
        "freq": 247.7,
        "gain": 0.05,
        "type": "triangle",
        "detune": 33,
        "cutoff": 1100,
        "lfoRate": 0.7,
        "lfoDepth": 0.6,
        "subGain": 0.1,
        "ratio": 1.41,
        "fm": 0.2,
        "ring": 0.6,
        "noise": 0.35,
        "crush": 0.25,
        "comb": 0.55,
        "glitch": 0.75,
        "drift": 0.5
      },
      "development": {
        "enabled": true,
        "freq": 67,
        "gain": 0.05,
        "type": "square",
        "detune": 12,
        "cutoff": 800,
        "lfoRate": 3.2,
        "lfoDepth": 0.55,
        "subGain": 0.5,
        "ratio": 2.07,
        "fm": 0.15,
        "ring": 0.2,
        "noise": 0.15,
        "crush": 0.55,
        "comb": 0.4,
        "glitch": 0.35,
        "drift": 0.3
      },
      "climax": {
        "enabled": true,
        "freq": 149,
        "gain": 0.085,
        "type": "sawtooth",
        "detune": 26,
        "cutoff": 3200,
        "lfoRate": 8.5,
        "lfoDepth": 0.5,
        "subGain": 0.55,
        "ratio": 5.19,
        "fm": 0.6,
        "ring": 0.5,
        "noise": 0.45,
        "crush": 0.7,
        "comb": 0.25,
        "glitch": 0.2,
        "drift": 0.2
      },
      "cta": {
        "enabled": true,
        "freq": 81.7,
        "gain": 0.055,
        "type": "triangle",
        "detune": 8,
        "cutoff": 700,
        "lfoRate": 0.5,
        "lfoDepth": 0.25,
        "subGain": 0.45,
        "ratio": 1.49,
        "fm": 0.1,
        "ring": 0.15,
        "noise": 0.1,
        "crush": 0.2,
        "comb": 0.65,
        "glitch": 0.1,
        "drift": 0.4
      }
    }
  },
  "modulators": {
    "image-1:zoom": {
      "source": "lfo",
      "shape": "sine",
      "rateHz": 0.05,
      "depth": 0.12,
      "bias": 0.53,
      "phase": 0.49,
      "bandLoHz": 20,
      "bandHiHz": 200
    }
  }
} as SerializedPatch;
}