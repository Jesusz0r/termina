import type { TerminaBridge } from "../shared/types";

declare global {
  interface Window {
    termina: TerminaBridge;
  }
}

export {};