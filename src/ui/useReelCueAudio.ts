import { useEffect, useRef } from "react";
import { audioContext } from "../lib/audioEngine";
import {
  scheduleTick,
  setDroneZone,
  silenceAllCues,
  startMetronome,
  stopMetronome,
} from "../lib/reelCueAudio";
import { zoneAtSec, type ReelZoneId } from "../lib/reelMarkers";
import { useTimelineStore } from "../store/timelineStore";

/**
 * Drives reel cue audio from the timeline playhead. Mount once under PlaybackControls.
 */
export function useReelCueAudio(): void {
  const currentFrame = useTimelineStore((s) => s.currentFrame);
  const fps = useTimelineStore((s) => s.fps);
  const durationInFrames = useTimelineStore((s) => s.durationInFrames);
  const isPlaying = useTimelineStore((s) => s.isPlaying);
  const cuts = useTimelineStore((s) => s.reelZones.cutsSec);
  const cueZoneTick = useTimelineStore((s) => s.cueZoneTick);
  const cueDevMetronome = useTimelineStore((s) => s.cueDevMetronome);
  const cueDrone = useTimelineStore((s) => s.cueDrone);
  const developmentBpm = useTimelineStore((s) => s.developmentBpm);
  const droneByZone = useTimelineStore((s) => s.droneByZone);

  const lastZone = useRef<ReelZoneId | null>(null);
  const metroOn = useRef(false);
  const zoneRef = useRef<ReelZoneId>("hook");

  useEffect(() => {
    return () => {
      silenceAllCues();
      lastZone.current = null;
      metroOn.current = false;
    };
  }, []);

  // Zone tracking + boundary tick.
  useEffect(() => {
    const durationSec = durationInFrames / Math.max(1, fps);
    const sec = currentFrame / Math.max(1, fps);
    const zone = zoneAtSec(cuts, durationSec, sec);
    zoneRef.current = zone;

    if (cueZoneTick && lastZone.current != null && lastZone.current !== zone) {
      void audioContext();
      scheduleTick(0, { freq: 990, dur: 0.05, gain: 0.11 });
    }
    lastZone.current = zone;
  }, [currentFrame, fps, durationInFrames, cuts, cueZoneTick]);

  // Development metronome.
  useEffect(() => {
    const durationSec = durationInFrames / Math.max(1, fps);
    const sec = currentFrame / Math.max(1, fps);
    const zone = zoneAtSec(cuts, durationSec, sec);
    const wantMetro = isPlaying && cueDevMetronome && zone === "development";
    if (wantMetro && !metroOn.current) {
      void audioContext();
      startMetronome(developmentBpm);
      metroOn.current = true;
    } else if (!wantMetro && metroOn.current) {
      stopMetronome();
      metroOn.current = false;
    }
  }, [
    currentFrame,
    fps,
    durationInFrames,
    cuts,
    isPlaying,
    cueDevMetronome,
    developmentBpm,
  ]);

  useEffect(() => {
    if (!metroOn.current) return;
    startMetronome(developmentBpm);
  }, [developmentBpm]);

  // Drone follows zone / params while playing.
  useEffect(() => {
    if (cueDrone && isPlaying) {
      void audioContext();
      setDroneZone(zoneRef.current, droneByZone, true);
    } else {
      setDroneZone(null, droneByZone, false);
    }
  }, [cueDrone, isPlaying, droneByZone, currentFrame, cuts, fps, durationInFrames]);
}
