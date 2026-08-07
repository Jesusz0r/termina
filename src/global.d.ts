import type { PiBridge } from "../shared/types";

declare global {
  interface Window {
    pi: PiBridge;
  }
}

export {};