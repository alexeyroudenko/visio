import { create } from "zustand";
import type { ParamPath } from "../lib/keyframes";
import { DEFAULT_MODULATOR, type Modulator, type Modulators } from "../lib/modulators";
import { appLog } from "./consoleStore";

interface ModulatorState {
  byPath: Modulators;

  bind: (path: ParamPath, modulator?: Partial<Modulator>) => void;
  unbind: (path: ParamPath) => void;
  update: (path: ParamPath, patch: Partial<Modulator>) => void;
  /** Adopt the set stored in a patch, replacing whatever is bound now. */
  load: (modulators: Modulators) => void;
  clear: () => void;
}

declare global {
  interface Window {
    __visioModulatorStore?: ReturnType<typeof createModulatorStore>;
  }
}

function createModulatorStore() {
  return create<ModulatorState>((set, get) => ({
    byPath: {},

    bind(path, modulator) {
      set({ byPath: { ...get().byPath, [path]: { ...DEFAULT_MODULATOR, ...modulator } } });
      appLog("ok", "modulator", `bound ${path}`);
    },

    unbind(path) {
      const { [path]: removed, ...rest } = get().byPath;
      if (!removed) return;
      set({ byPath: rest });
      appLog("info", "modulator", `released ${path}`);
    },

    update(path, patch) {
      const existing = get().byPath[path];
      if (!existing) return;
      set({ byPath: { ...get().byPath, [path]: { ...existing, ...patch } } });
    },

    load(modulators) {
      set({ byPath: modulators });
      const count = Object.keys(modulators).length;
      if (count > 0) appLog("ok", "modulator", `restored ${count} modulated params`);
    },

    clear() {
      set({ byPath: {} });
    },
  }));
}

export const useModulatorStore =
  typeof window !== "undefined" && window.__visioModulatorStore
    ? window.__visioModulatorStore
    : createModulatorStore();

if (typeof window !== "undefined") {
  window.__visioModulatorStore = useModulatorStore;
}
