import type { SerializedPatch } from "../store/persistence";

/** Saved patch 2026-08-08 — video glitch reel with Features Tracking → Points Noise. */
export function trackNoiseGlitch(): SerializedPatch {
  return {
  "format": 1,
  "width": 1080,
  "height": 1920,
  "nodes": [
    {
      "id": "image-1",
      "type": "source.media",
      "position": {
        "x": 247.82787724225457,
        "y": 109.5212275774549
      },
      "params": {
        "mode": "video",
        "facing": "user",
        "playing": true,
        "muted": false,
        "volume": 1,
        "speed": 1,
        "syncTimeline": true,
        "mirror": false,
        "fit": "cover",
        "zoom": 1
      }
    },
    {
      "id": "sliceShift-6",
      "type": "fx.sliceShift",
      "position": {
        "x": 1210.9690475560406,
        "y": -102.07684777347399
      },
      "params": {
        "count": 95,
        "maxH": 187,
        "amount": 100,
        "animate": false,
        "resetAtFirst": false,
        "seed": 0
      }
    },
    {
      "id": "screen-1",
      "type": "output.screen",
      "position": {
        "x": 2011.9445257486395,
        "y": 156.8555724824064
      },
      "params": {
        "background": "#000000"
      }
    },
    {
      "id": "pixelSort-5",
      "type": "fx.pixelSort",
      "position": {
        "x": 839.4937670041419,
        "y": -3.0629081751828267
      },
      "params": {
        "thresh": 0,
        "vert": true,
        "scale": 1,
        "interval": 1,
        "asyncRead": false,
        "worker": true
      }
    },
    {
      "id": "features-1",
      "type": "tracking.features",
      "position": {
        "x": 861.1333271197564,
        "y": 250.7824773389155
      },
      "params": {
        "downscale": 4,
        "block": 5,
        "maxCorners": 600,
        "quality": 0.19,
        "minDistance": 7,
        "interval": 8,
        "worker": true
      }
    },
    {
      "id": "featuresGrid-2",
      "type": "draw.featuresGrid",
      "position": {
        "x": 1397.657197598955,
        "y": 177.7119985454271
      },
      "params": {
        "color": "#f5f0e6",
        "maxDepth": 5,
        "minSize": 64,
        "stroke": 1,
        "opacity": 1,
        "useContentEdge": true,
        "edgeInterval": 4,
        "labels": false,
        "labelSize": 13,
        "labelText": "Element",
        "effectChance": 1,
        "effectMinArea": 0,
        "effectMaxArea": 0.16,
        "effectSeed": 42,
        "rectMatch": 0.35,
        "rectHold": 3
      }
    },
    {
      "id": "colorCorrection-4",
      "type": "fx.colorCorrection",
      "position": {
        "x": 1460.7550639041585,
        "y": -115.99414174388771
      },
      "params": {
        "hue": 0,
        "saturation": 1,
        "value": 1,
        "gamma": 1,
        "brightness": 0,
        "contrast": 1,
        "alpha": 1
      }
    },
    {
      "id": "blend-5",
      "type": "fx.blend",
      "position": {
        "x": 1690.612781007887,
        "y": 117.39622499761896
      },
      "params": {
        "mode": "over",
        "opacity": 0
      }
    },
    {
      "id": "featuresTrack-1",
      "type": "tracking.featuresTrack",
      "position": {
        "x": 865.213938395199,
        "y": 333.3882675936419
      },
      "params": {
        "downscale": 4,
        "block": 15,
        "maxCorners": 130,
        "quality": 0.49,
        "minDistance": 25,
        "winSize": 13,
        "maxLevel": 2,
        "maxIters": 10,
        "fbError": 2,
        "minAge": 6,
        "maxTrail": 108,
        "maxTracks": 400,
        "detectInterval": 5
      }
    },
    {
      "id": "connectors-2",
      "type": "draw.connectors",
      "position": {
        "x": 1403.553557867599,
        "y": 275.18660470430433
      },
      "params": {
        "color": "#ffffff",
        "maxDist": 600,
        "width": 1,
        "opacity": 0.5,
        "fade": true,
        "blend": "normal"
      }
    },
    {
      "id": "pointsNoise-1",
      "type": "generate.pointsNoise",
      "position": {
        "x": 1082.7477122569496,
        "y": 347.48960125420984
      },
      "params": {
        "count": 160,
        "layout": "random",
        "frequency": 1.5000000000000002,
        "octaves": 2,
        "amount": 1,
        "animate": true,
        "speed": 0.15000000000000002,
        "driftX": 0,
        "driftY": 0,
        "edges": "wrap",
        "size": 0.7,
        "sizeNoise": 0.4,
        "seed": 11
      }
    }
  ],
  "edges": [
    {
      "id": "e-c1b6ef87-0b69-4c50-b588-7c15509e1a57",
      "source": "image-1",
      "sourceHandle": "out",
      "target": "pixelSort-5",
      "targetHandle": "src"
    },
    {
      "id": "e-4e885c46-e408-45ea-8dc5-f64bf49925ba",
      "source": "pixelSort-5",
      "sourceHandle": "out",
      "target": "sliceShift-6",
      "targetHandle": "src"
    },
    {
      "id": "e-e53f287a-7faf-405d-8848-11a7b96b9a26",
      "source": "image-1",
      "sourceHandle": "frame",
      "target": "features-1",
      "targetHandle": "frame"
    },
    {
      "id": "e-0ac174d3-a062-4654-9067-42c81e8804b5",
      "source": "pixelSort-5",
      "sourceHandle": "out",
      "target": "featuresGrid-2",
      "targetHandle": "bg"
    },
    {
      "id": "e-85a05353-31af-4a49-985c-654c83e82bb4",
      "source": "image-1",
      "sourceHandle": "frame",
      "target": "featuresGrid-2",
      "targetHandle": "frame"
    },
    {
      "id": "e-8abf2144-7d00-4a48-8ea4-80affdafba79",
      "source": "sliceShift-6",
      "sourceHandle": "out",
      "target": "colorCorrection-4",
      "targetHandle": "src"
    },
    {
      "id": "e-7894b938-37c8-4734-82c7-47179c5934cb",
      "source": "blend-5",
      "sourceHandle": "out",
      "target": "screen-1",
      "targetHandle": "src"
    },
    {
      "id": "e-ccd4b436-54f2-4e99-85ee-1a390f4f8770",
      "source": "colorCorrection-4",
      "sourceHandle": "out",
      "target": "blend-5",
      "targetHandle": "top"
    },
    {
      "id": "e-b3c7d200-05c7-4224-8490-aba631c26451",
      "source": "image-1",
      "sourceHandle": "frame",
      "target": "featuresTrack-1",
      "targetHandle": "frame"
    },
    {
      "id": "e-a89041bd-32c8-40a3-89ab-96887e62db74",
      "source": "pixelSort-5",
      "sourceHandle": "out",
      "target": "connectors-2",
      "targetHandle": "bg"
    },
    {
      "id": "e-72974bac-ba8c-48f3-9923-686357dbd420",
      "source": "featuresTrack-1",
      "sourceHandle": "points",
      "target": "pointsNoise-1",
      "targetHandle": "points"
    },
    {
      "id": "e-b9a21fb7-56ee-4934-b635-0e88afda1324",
      "source": "pointsNoise-1",
      "sourceHandle": "out",
      "target": "connectors-2",
      "targetHandle": "points"
    },
    {
      "id": "e-1d973452-d9cc-4062-ba6c-f0fb7384560b",
      "source": "pointsNoise-1",
      "sourceHandle": "out",
      "target": "featuresGrid-2",
      "targetHandle": "points"
    },
    {
      "id": "e-b6022ca4-291b-4c20-ad5b-99c676e9ec39",
      "source": "featuresGrid-2",
      "sourceHandle": "out",
      "target": "blend-5",
      "targetHandle": "base"
    }
  ],
  "timeline": {
    "fps": 30,
    "durationInFrames": 244,
    "keyframes": {
      "sliceShift-6:maxH": [
        {
          "frame": 25,
          "value": 1
        },
        {
          "frame": 73,
          "value": 1
        },
        {
          "frame": 74,
          "value": 1
        },
        {
          "frame": 153,
          "value": 320
        },
        {
          "frame": 209,
          "value": 187
        }
      ],
      "sliceShift-6:amount": [
        {
          "frame": 25,
          "value": 0
        },
        {
          "frame": 73,
          "value": 0
        },
        {
          "frame": 74,
          "value": 0
        },
        {
          "frame": 153,
          "value": 20
        },
        {
          "frame": 181,
          "value": 100
        },
        {
          "frame": 209,
          "value": 100
        }
      ],
      "pixelSort-5:thresh": [
        {
          "frame": 1,
          "value": 0
        },
        {
          "frame": 25,
          "value": 0
        },
        {
          "frame": 153,
          "value": 80
        }
      ],
      "colorCorrection-4:alpha": [
        {
          "frame": 1,
          "value": 1
        },
        {
          "frame": 25,
          "value": 1
        },
        {
          "frame": 73,
          "value": 1
        },
        {
          "frame": 74,
          "value": 0
        },
        {
          "frame": 151,
          "value": 0
        },
        {
          "frame": 153,
          "value": 1
        },
        {
          "frame": 181,
          "value": 1
        },
        {
          "frame": 209,
          "value": 1
        },
        {
          "frame": 244,
          "value": 1
        }
      ]
    },
    "reelZones": {
      "cutsSec": [
        0.8666666666666667,
        2.433333333333333,
        4.866666666666666,
        6.966666666666667
      ],
      "dirty": true
    },
    "cueZoneTick": true,
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
        "freq": 109.3,
        "gain": 0.05,
        "type": "sawtooth",
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
        "freq": 163.8,
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
