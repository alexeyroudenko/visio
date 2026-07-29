/**
 * Validates every built-in preset: parsePatch + node types + edge port types.
 * Run: npx vite-node scripts/check-presets.ts
 */
import { NODE_DEFS } from "../src/nodes/registry";
import { BUILTIN_PRESETS, listPresets } from "../src/presets";
import { parsePatch } from "../src/store/persistence";

let failed = 0;

function fail(msg: string): void {
  console.error(`  FAIL  ${msg}`);
  failed += 1;
}

function ok(msg: string): void {
  console.log(`  ok    ${msg}`);
}

console.log(`Built-in presets: ${BUILTIN_PRESETS.length}`);
console.log(`listPresets(): ${listPresets().length} (builtin + user)\n`);

for (const preset of BUILTIN_PRESETS) {
  console.log(`• ${preset.id} — ${preset.label}`);
  const raw = preset.build();
  const parsed = parsePatch(raw);
  if (!parsed) {
    fail("parsePatch returned null");
    continue;
  }
  if (parsed.nodes.length === 0) {
    fail("no nodes after parse");
    continue;
  }
  if (parsed.width <= 0 || parsed.height <= 0) {
    fail(`bad resolution ${parsed.width}×${parsed.height}`);
  }

  const byId = new Map(parsed.nodes.map((n) => [n.id, n]));
  for (const node of parsed.nodes) {
    if (!NODE_DEFS[node.data.defType]) {
      fail(`unknown node type ${node.data.defType} (${node.id})`);
    }
  }

  for (const edge of parsed.edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source) {
      fail(`edge ${edge.id}: missing source ${edge.source}`);
      continue;
    }
    if (!target) {
      fail(`edge ${edge.id}: missing target ${edge.target}`);
      continue;
    }
    const sDef = NODE_DEFS[source.data.defType];
    const tDef = NODE_DEFS[target.data.defType];
    if (!sDef || !tDef) continue;

    const out = sDef.outputs.find((p) => p.id === edge.sourceHandle);
    const inn = tDef.inputs.find((p) => p.id === edge.targetHandle);
    if (!out) {
      fail(
        `edge ${edge.id}: ${source.data.defType} has no output “${edge.sourceHandle}”`,
      );
      continue;
    }
    if (!inn) {
      fail(
        `edge ${edge.id}: ${target.data.defType} has no input “${edge.targetHandle}”`,
      );
      continue;
    }
    if (out.type !== inn.type) {
      fail(
        `edge ${edge.id}: type mismatch ${out.type} → ${inn.type} (${edge.source}.${edge.sourceHandle} → ${edge.target}.${edge.targetHandle})`,
      );
    }
  }

  ok(
    `${parsed.nodes.length} nodes, ${parsed.edges.length} edges, ${parsed.width}×${parsed.height}`,
  );
}

console.log("");
if (failed > 0) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
console.log("All built-in presets load cleanly.");
