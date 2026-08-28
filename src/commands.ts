/**
 * Renderer-side command dispatcher for Termina.
 * Maintains registration of handlers for commands triggered by the application
 * menu, keyboard shortcuts, or UI elements.
 */
import type { CommandId } from "../shared/types";

export type CommandHandler = () => void | Promise<void>;

export class CommandDispatcher {
  private readonly handlers = new Map<CommandId, CommandHandler>();

  register(command: CommandId, handler: CommandHandler): () => void {
    this.handlers.set(command, handler);
    return () => {
      if (this.handlers.get(command) === handler) {
        this.handlers.delete(command);
      }
    };
  }


  execute(command: CommandId): void {
    const handler = this.handlers.get(command);
    if (handler) {
      try {
        const result = handler();
        if (result instanceof Promise) {
          result.catch((err) => {
            console.error(`Command ${command} failed:`, err);
          });
        }
      } catch (err) {
        console.error(`Command ${command} threw:`, err);
      }
    }
  }

  has(command: CommandId): boolean {
    return this.handlers.has(command);
  }
}
