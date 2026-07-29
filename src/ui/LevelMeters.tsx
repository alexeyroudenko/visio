import { useEffect, useRef } from "react";
import { levelsFor } from "../store/levelStore";

/**
 * Two VU columns on a Granular node: Source (dry) and Grains.
 * Reads a plain store from rAF so the graph does not re-render every tick.
 */
export function LevelMeters({ nodeId }: { nodeId: string }) {
  const sourceRef = useRef<HTMLDivElement>(null);
  const grainsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let handle = 0;
    let sourceShown = 0;
    let grainsShown = 0;
    const draw = () => {
      handle = requestAnimationFrame(draw);
      const levels = levelsFor(nodeId);
      // Fast attack, slower fall — readable as a meter rather than a flicker.
      sourceShown =
        levels.source > sourceShown
          ? levels.source
          : sourceShown * 0.88 + levels.source * 0.12;
      grainsShown =
        levels.grains > grainsShown
          ? levels.grains
          : grainsShown * 0.88 + levels.grains * 0.12;

      if (sourceRef.current) {
        sourceRef.current.style.height = `${Math.min(1, sourceShown) * 100}%`;
      }
      if (grainsRef.current) {
        grainsRef.current.style.height = `${Math.min(1, grainsShown) * 100}%`;
      }
    };
    draw();
    return () => cancelAnimationFrame(handle);
  }, [nodeId]);

  return (
    <div className="level-meters" aria-label="Level meters">
      <div className="level-meters__col">
        <div className="level-meters__track">
          <div ref={sourceRef} className="level-meters__bar level-meters__bar--source" />
        </div>
        <span className="level-meters__label">Src</span>
      </div>
      <div className="level-meters__col">
        <div className="level-meters__track">
          <div ref={grainsRef} className="level-meters__bar level-meters__bar--grains" />
        </div>
        <span className="level-meters__label">Grn</span>
      </div>
    </div>
  );
}
