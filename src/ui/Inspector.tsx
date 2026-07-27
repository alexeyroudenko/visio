import type { ParamSpec } from "../engine/types";
import { CATEGORY_LABELS, NODE_DEFS } from "../nodes/registry";
import { useGraphStore } from "../store/graphStore";

function ParamControl({
  spec,
  value,
  onChange,
}: {
  spec: ParamSpec;
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  switch (spec.type) {
    case "range": {
      const current = typeof value === "number" ? value : spec.default;
      return (
        <label className="param">
          <span className="param__label">
            {spec.label}
            <em>{current}</em>
          </span>
          <input
            type="range"
            min={spec.min}
            max={spec.max}
            step={spec.step}
            value={current}
            onChange={(event) => onChange(Number(event.target.value))}
          />
        </label>
      );
    }
    case "toggle": {
      const current = typeof value === "boolean" ? value : spec.default;
      return (
        <label className="param param--row">
          <input
            type="checkbox"
            checked={current}
            onChange={(event) => onChange(event.target.checked)}
          />
          <span className="param__label">{spec.label}</span>
        </label>
      );
    }
    case "color": {
      const current = typeof value === "string" ? value : spec.default;
      return (
        <label className="param param--row">
          <input
            type="color"
            value={current}
            onChange={(event) => onChange(event.target.value)}
          />
          <span className="param__label">{spec.label}</span>
        </label>
      );
    }
    case "select": {
      const current = typeof value === "string" ? value : spec.default;
      return (
        <label className="param">
          <span className="param__label">{spec.label}</span>
          <select value={current} onChange={(event) => onChange(event.target.value)}>
            {spec.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      );
    }
    case "file": {
      const current = value as { name: string; url: string } | null;
      return (
        <label className="param">
          <span className="param__label">{spec.label}</span>
          <input
            type="file"
            accept={spec.accept}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              // Revoke the previous blob so long sessions don't leak.
              if (current?.url) URL.revokeObjectURL(current.url);
              onChange({ name: file.name, url: URL.createObjectURL(file) });
            }}
          />
          {current ? <em className="param__hint">{current.name}</em> : null}
        </label>
      );
    }
    case "text": {
      const current = typeof value === "string" ? value : spec.default;
      return (
        <label className="param">
          <span className="param__label">{spec.label}</span>
          <input type="text" value={current} onChange={(event) => onChange(event.target.value)} />
        </label>
      );
    }
    default:
      return null;
  }
}

export function Inspector() {
  const selectedId = useGraphStore((state) => state.selectedId);
  const node = useGraphStore((state) => state.nodes.find((n) => n.id === state.selectedId));
  const status = useGraphStore((state) => (selectedId ? state.statuses[selectedId] : undefined));
  const setParam = useGraphStore((state) => state.setParam);
  const removeNode = useGraphStore((state) => state.removeNode);

  if (!node) {
    return (
      <aside className="inspector">
        <p className="inspector__empty">Выбери ноду, чтобы править параметры.</p>
      </aside>
    );
  }

  const definition = NODE_DEFS[node.data.defType];
  if (!definition) {
    return (
      <aside className="inspector">
        <p className="inspector__empty">Нода {node.data.defType} не найдена в реестре.</p>
      </aside>
    );
  }

  return (
    <aside className="inspector">
      <header className="inspector__header">
        <div>
          <h2>{definition.label}</h2>
          <span className="inspector__category">{CATEGORY_LABELS[definition.category]}</span>
        </div>
        <button type="button" className="button button--danger" onClick={() => removeNode(node.id)}>
          Удалить
        </button>
      </header>

      <p className="inspector__description">{definition.description}</p>
      {status?.message ? (
        <p className={`inspector__status inspector__status--${status.status}`}>{status.message}</p>
      ) : null}

      <div className="inspector__params">
        {definition.params.map((spec) => (
          <ParamControl
            key={spec.key}
            spec={spec}
            value={node.data.params[spec.key]}
            onChange={(next) => setParam(node.id, spec.key, next)}
          />
        ))}
        {definition.params.length === 0 ? (
          <p className="inspector__empty">Без параметров.</p>
        ) : null}
      </div>
    </aside>
  );
}
