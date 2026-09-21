/**
 * Registry of page parameters for an external MIDI bridge (userscript or
 * browser extension). The page only declares what it has; who turns those
 * knobs is none of its business — nothing here mentions MIDI.
 *
 * Shared contract across the AA projects. The bridge reads
 * `window.__midiParams`, sorts the entries left to right by `el` and calls
 * `setNorm`. In visio only the published mixer registers, so the mapping
 * follows what the user published with ↑ rather than whatever inspector
 * happens to be open.
 */
export interface MidiParam {
  /** Label as shown on screen. */
  label: string;
  /** Control wrapper: the bridge reads its position and draws the overlay. */
  el: HTMLElement;
  /** Current value, 0..1. */
  getNorm(): number;
  /** Set the value (0..1) the same way a mouse drag would. */
  setNorm(t: number): void;
}

export interface MidiParamRegistry {
  version: 1;
  params: MidiParam[];
  /** The bridge subscribes to survive controls coming and going. */
  subscribe(listener: () => void): () => void;
}

declare global {
  interface Window {
    __midiParams?: MidiParamRegistry;
  }
}

const listeners = new Set<() => void>();
let notifyQueued = false;

function registry(): MidiParamRegistry {
  let reg = window.__midiParams;
  if (!reg) {
    reg = {
      version: 1,
      params: [],
      subscribe(listener: () => void): () => void {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
    window.__midiParams = reg;
  }
  return reg;
}

/**
 * Declare a parameter. Returns the unregister function — nodes appear and
 * disappear, so every registration is expected to be undone.
 */
export function registerMidiParam(param: MidiParam): () => void {
  const reg = registry();
  reg.params.push(param);
  notify();
  return () => {
    const i = reg.params.indexOf(param);
    if (i >= 0) reg.params.splice(i, 1);
    notify();
  };
}

/** A whole mixer mounts at once — collapse the notifications into one. */
function notify(): void {
  if (notifyQueued) return;
  notifyQueued = true;
  queueMicrotask(() => {
    notifyQueued = false;
    for (const listener of listeners) listener();
  });
}

// Create the registry at load time, before any control: its presence tells
// the bridge "this page has the contract", and an empty list means "nothing
// to turn right now". Otherwise the bridge would treat the page as foreign
// and go looking for input[type=range] instead.
registry();
