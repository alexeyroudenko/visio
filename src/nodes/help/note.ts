import { defineNode, paramString } from "../defineNode";

/**
 * Sticky note on the canvas. No ports, no GPU — the text lives on the node
 * itself so a patch can carry captions next to the graph.
 */
export const helpNoteNode = defineNode<Record<string, never>>({
  type: "help.note",
  label: "Help",
  category: "help",
  description: "Sticky note — write a caption next to a node, in the graph.",
  inputs: [],
  outputs: [],
  params: [{ key: "text", label: "Note", type: "code", rows: 6, default: "" }],
  createState() {
    return {};
  },
  evaluate({ params }) {
    paramString(params, "text", "");
    return {};
  },
});
