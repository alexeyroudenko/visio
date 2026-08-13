import { DEFAULT_IMAGE_FILE } from "../nodes/shared/fileParam";
import type { SerializedPatch } from "../store/persistence";

/** Points Noise → Features Grid (Element) → Points → Connectors (from Screenshot render). */
export function noiseElementGrid(): SerializedPatch {
  return {
  "format": 1,
  "width": 1080,
  "height": 1920,
  "source": "Screenshot 2026-08-05 110238.png",
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
        "playing": true,
        "muted": false,
        "volume": 1,
        "speed": 1,
        "syncTimeline": false,
        "mirror": false,
        "fit": "cover",
        "zoom": 1,
        "file": DEFAULT_IMAGE_FILE
      }
    },
    {
      "id": "pointsNoise-1",
      "type": "generate.pointsNoise",
      "position": {
        "x": 184.81835610701273,
        "y": 581.133962371136
      },
      "params": {
        "count": 52,
        "layout": "random",
        "frequency": 15.4,
        "octaves": 1,
        "amount": 0.12,
        "animate": true,
        "speed": 0.05,
        "driftX": -0.5800000000000001,
        "driftY": 0.79,
        "edges": "wrap",
        "size": 0.04,
        "sizeNoise": 1,
        "seed": 11
      }
    },
    {
      "id": "featuresGrid-1",
      "type": "draw.featuresGrid",
      "position": {
        "x": 464.70237058236506,
        "y": 105.2595563055169
      },
      "params": {
        "color": "#f5f0e6",
        "maxDepth": 5,
        "minSize": 256,
        "stroke": 1,
        "opacity": 0.7000000000000001,
        "filledOnly": false,
        "useContentEdge": false,
        "edgeMinFill": 0,
        "edgeInterval": 3,
        "labels": true,
        "labelSize": 18,
        "labelText": "Element",
        "effectChance": 1,
        "effectMinArea": 1,
        "effectMaxArea": 0.08,
        "effectSeed": 0,
        "rectMatch": 0.75,
        "rectHold": 0
      }
    },
    {
      "id": "screen-1",
      "type": "output.screen",
      "position": {
        "x": 1264.8777604146903,
        "y": 112.2710035908105
      },
      "params": {
        "background": "#000000"
      }
    },
    {
      "id": "pointsNoise-5",
      "type": "generate.pointsNoise",
      "position": {
        "x": 450.3843572147324,
        "y": 429.065425128918
      },
      "params": {
        "count": 24,
        "layout": "random",
        "frequency": 9.4,
        "octaves": 2,
        "amount": 0,
        "animate": true,
        "speed": 0.2,
        "driftX": -0.37,
        "driftY": 1,
        "edges": "wrap",
        "size": 0.5,
        "sizeNoise": 0.1,
        "seed": 6847
      },
      "bypass": true,
      "debug": true
    },
    {
      "id": "features-6",
      "type": "tracking.features",
      "position": {
        "x": 249.43456901754521,
        "y": 270.6167328290694
      },
      "params": {
        "downscale": 2,
        "block": 7,
        "maxCorners": 260,
        "quality": 0.5,
        "minDistance": 2,
        "interval": 1,
        "worker": true
      },
      "debug": true
    },
    {
      "id": "points-7",
      "type": "draw.points",
      "position": {
        "x": 749.2669128180162,
        "y": 421.4248247495549
      },
      "params": {
        "style": "point",
        "color": "#ffffff",
        "size": 7.5,
        "sizeByScore": 1.9000000000000001,
        "minRadius": 100,
        "maxRadius": 200,
        "stroke": 4,
        "centerDot": true,
        "opacity": 0.9,
        "linkRadius": 0,
        "linkWidth": 1,
        "blend": "normal"
      }
    },
    {
      "id": "connectors-8",
      "type": "draw.connectors",
      "position": {
        "x": 935.3472429993001,
        "y": 117.32312704667163
      },
      "params": {
        "color": "#ffffff",
        "maxDist": 600,
        "width": 4,
        "opacity": 0.85,
        "fade": false,
        "blend": "normal"
      }
    }
  ],
  "edges": [
    {
      "id": "e-a0a6addf-97e9-45de-9839-889d1b1ec2ff",
      "source": "pointsNoise-5",
      "sourceHandle": "out",
      "target": "featuresGrid-1",
      "targetHandle": "points"
    },
    {
      "id": "e-c71f47f3-0ead-45a9-a7c5-7e5ba44b4c6d",
      "source": "image-1",
      "sourceHandle": "frame",
      "target": "features-6",
      "targetHandle": "frame"
    },
    {
      "id": "e-cff096dc-3c38-49a5-9a51-71466320da3f",
      "source": "pointsNoise-1",
      "sourceHandle": "out",
      "target": "pointsNoise-5",
      "targetHandle": "points"
    },
    {
      "id": "e-864bba6a-ed13-4031-99f1-5d6fe61a4504",
      "source": "pointsNoise-1",
      "sourceHandle": "out",
      "target": "points-7",
      "targetHandle": "points"
    },
    {
      "id": "e-d3fd9f6f-c546-4483-89d2-e62ec1c07f9c",
      "source": "featuresGrid-1",
      "sourceHandle": "out",
      "target": "points-7",
      "targetHandle": "bg"
    },
    {
      "id": "e-fe0d98a5-9a93-4147-a73a-fc90537719f8",
      "source": "image-1",
      "sourceHandle": "out",
      "target": "featuresGrid-1",
      "targetHandle": "bg"
    },
    {
      "id": "e-118a6a9c-884f-4a16-bf63-840658c5d99f",
      "source": "image-1",
      "sourceHandle": "frame",
      "target": "featuresGrid-1",
      "targetHandle": "frame"
    },
    {
      "id": "e-9d772bac-fecc-4e19-b779-b3304d1c7efc",
      "source": "points-7",
      "sourceHandle": "out",
      "target": "connectors-8",
      "targetHandle": "bg"
    },
    {
      "id": "e-060d0395-c9b6-4726-9efd-54f6e0526e71",
      "source": "connectors-8",
      "sourceHandle": "out",
      "target": "screen-1",
      "targetHandle": "src"
    },
    {
      "id": "e-6f72bad5-05d1-4077-9e3a-1505aebdec70",
      "source": "featuresGrid-1",
      "sourceHandle": "points",
      "target": "connectors-8",
      "targetHandle": "points"
    }
  ],
  "timeline": {
    "fps": 30,
    "durationInFrames": 429,
    "keyframes": {},
    "reelZones": {
      "cutsSec": [
        1,
        1.2,
        8.533333333333333,
        11.533333333333333
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
  }
} as SerializedPatch;
}