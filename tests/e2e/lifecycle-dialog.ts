import type { MessageBoxOptions } from "electron";
import type { TerminaE2EFixtures } from "./fixtures.ts";

/** Replace only the native OS dialog in the test-owned Electron process. */
export async function mockLifecycleDialogs(app: TerminaE2EFixtures["electronApp"], response = 1, hold = false): Promise<void> {
  await app.evaluate(({ dialog }, { response, hold }) => {
    const state = globalThis as unknown as {
      __lifecycleDialogs: MessageBoxOptions[];
      __lifecycleResponse: number;
      __lifecycleHold: boolean;
      __lifecycleAnswer?: (response: number) => void;
    };
    state.__lifecycleDialogs = [];
    state.__lifecycleResponse = response;
    state.__lifecycleHold = hold;
    dialog.showMessageBox = async (...args: unknown[]) => {
      const options = args[args.length - 1] as MessageBoxOptions;
      state.__lifecycleDialogs.push(options);
      const response = state.__lifecycleHold
        ? await new Promise<number>((resolve) => { state.__lifecycleAnswer = resolve; })
        : state.__lifecycleResponse;
      return { response, checkboxChecked: false };
    };
  }, { response, hold });
}

export async function lifecycleDialogs(app: TerminaE2EFixtures["electronApp"]): Promise<MessageBoxOptions[]> {
  return app.evaluate(() => (globalThis as unknown as { __lifecycleDialogs: MessageBoxOptions[] }).__lifecycleDialogs);
}

export async function answerLifecycleDialog(app: TerminaE2EFixtures["electronApp"], response: number): Promise<void> {
  await app.evaluate((_electron, response) => {
    const state = globalThis as unknown as { __lifecycleResponse: number; __lifecycleHold: boolean; __lifecycleAnswer?: (response: number) => void };
    state.__lifecycleResponse = response;
    state.__lifecycleHold = false;
    state.__lifecycleAnswer?.(response);
    delete state.__lifecycleAnswer;
  }, response);
}
