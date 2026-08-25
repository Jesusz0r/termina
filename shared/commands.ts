/**
 * Canonical command registry for Termina.
 * Defines all application commands, their default shortcuts, and metadata.
 */

export type CommandCategory = "File" | "Edit" | "Terminal" | "View" | "Settings";
export type CommandScope = "main" | "renderer";

export interface CommandDefinition {
  command: string;
  label: string;
  category: CommandCategory;
  description: string;
  defaultShortcut: string;
  scope: CommandScope;
}

export const COMMAND_DEFINITIONS = [
  { command: "open-folder", label: "Open folder", category: "File", description: "Choose a project folder", defaultShortcut: "CmdOrCtrl+O", scope: "main" },
  { command: "new-file", label: "New file", category: "File", description: "Create a file in the explorer", defaultShortcut: "CmdOrCtrl+Alt+N", scope: "renderer" },
  { command: "new-folder", label: "New folder", category: "File", description: "Create a folder in the explorer", defaultShortcut: "CmdOrCtrl+Alt+Shift+N", scope: "renderer" },
  { command: "rename", label: "Rename", category: "File", description: "Rename the selected explorer entry", defaultShortcut: "F2", scope: "renderer" },
  { command: "delete", label: "Delete", category: "File", description: "Delete the selected explorer entry", defaultShortcut: "", scope: "renderer" },
  { command: "refresh", label: "Refresh explorer", category: "File", description: "Reload the file tree", defaultShortcut: "", scope: "renderer" },
  { command: "save-all", label: "Save all", category: "File", description: "Save every dirty editor", defaultShortcut: "CmdOrCtrl+Alt+S", scope: "renderer" },
  { command: "close-window", label: "Close window", category: "File", description: "Close the application window", defaultShortcut: "CmdOrCtrl+W", scope: "main" },
  { command: "undo", label: "Undo", category: "Edit", description: "Undo in the focused surface", defaultShortcut: "CmdOrCtrl+Z", scope: "renderer" },
  { command: "redo", label: "Redo", category: "Edit", description: "Redo in the focused surface", defaultShortcut: "Shift+CmdOrCtrl+Z", scope: "renderer" },
  { command: "select-all", label: "Select all", category: "Edit", description: "Select all in the focused surface", defaultShortcut: "CmdOrCtrl+A", scope: "renderer" },
  { command: "new-terminal", label: "New terminal", category: "Terminal", description: "Open a shell or Pi terminal", defaultShortcut: "CmdOrCtrl+T", scope: "renderer" },
  { command: "close-terminal", label: "Close terminal", category: "Terminal", description: "Close the active terminal", defaultShortcut: "CmdOrCtrl+Shift+W", scope: "main" },
  { command: "abort-terminal", label: "Abort terminal", category: "Terminal", description: "Send an interrupt to the active terminal", defaultShortcut: "CmdOrCtrl+.", scope: "main" },
  { command: "next-terminal", label: "Next terminal", category: "Terminal", description: "Activate the next terminal tab", defaultShortcut: "Ctrl+Tab", scope: "renderer" },
  { command: "previous-terminal", label: "Previous terminal", category: "Terminal", description: "Activate the previous terminal tab", defaultShortcut: "Ctrl+Shift+Tab", scope: "renderer" },
  { command: "fullscreen", label: "Terminal fullscreen", category: "View", description: "Show only the terminal", defaultShortcut: "CmdOrCtrl+Shift+F", scope: "renderer" },
  { command: "layout-terminal-left", label: "Terminal left", category: "View", description: "Place the terminal on the left", defaultShortcut: "", scope: "renderer" },
  { command: "layout-terminal-right", label: "Terminal right", category: "View", description: "Place the terminal on the right", defaultShortcut: "", scope: "renderer" },
  { command: "layout-terminal-top", label: "Terminal top", category: "View", description: "Place the terminal on the top", defaultShortcut: "", scope: "renderer" },
  { command: "layout-terminal-bottom", label: "Terminal bottom", category: "View", description: "Place the terminal on the bottom", defaultShortcut: "", scope: "renderer" },
  { command: "toggle-explorer", label: "Toggle explorer", category: "View", description: "Minimize or restore the file explorer", defaultShortcut: "CmdOrCtrl+B", scope: "renderer" },
  { command: "toggle-terminal", label: "Toggle terminal", category: "View", description: "Minimize or restore the terminal", defaultShortcut: "CmdOrCtrl+Shift+E", scope: "renderer" },
  { command: "toggle-editor", label: "Toggle editor", category: "View", description: "Minimize or restore the editor", defaultShortcut: "CmdOrCtrl+E", scope: "renderer" },
  { command: "toggle-modified", label: "Toggle modified panel", category: "View", description: "Show or hide changed files", defaultShortcut: "", scope: "renderer" },
  { command: "next-project", label: "Next project", category: "View", description: "Activate the next project tab", defaultShortcut: "CmdOrCtrl+Shift+]", scope: "renderer" },
  { command: "previous-project", label: "Previous project", category: "View", description: "Activate the previous project tab", defaultShortcut: "CmdOrCtrl+Shift+[", scope: "renderer" },
  { command: "project-1", label: "Project 1", category: "View", description: "Activate the first project tab", defaultShortcut: "Ctrl+1", scope: "renderer" },
  { command: "project-2", label: "Project 2", category: "View", description: "Activate the second project tab", defaultShortcut: "Ctrl+2", scope: "renderer" },
  { command: "project-3", label: "Project 3", category: "View", description: "Activate the third project tab", defaultShortcut: "Ctrl+3", scope: "renderer" },
  { command: "project-4", label: "Project 4", category: "View", description: "Activate the fourth project tab", defaultShortcut: "Ctrl+4", scope: "renderer" },
  { command: "project-5", label: "Project 5", category: "View", description: "Activate the fifth project tab", defaultShortcut: "Ctrl+5", scope: "renderer" },
  { command: "project-6", label: "Project 6", category: "View", description: "Activate the sixth project tab", defaultShortcut: "Ctrl+6", scope: "renderer" },
  { command: "project-7", label: "Project 7", category: "View", description: "Activate the seventh project tab", defaultShortcut: "Ctrl+7", scope: "renderer" },
  { command: "project-8", label: "Project 8", category: "View", description: "Activate the eighth project tab", defaultShortcut: "Ctrl+8", scope: "renderer" },
  { command: "project-9", label: "Project 9", category: "View", description: "Activate the ninth project tab", defaultShortcut: "Ctrl+9", scope: "renderer" },
  { command: "session-search", label: "Search sessions", category: "View", description: "Search previous Pi sessions", defaultShortcut: "CmdOrCtrl+Shift+P", scope: "renderer" },
  { command: "open-settings", label: "Open settings", category: "Settings", description: "Open this preferences window", defaultShortcut: "CmdOrCtrl+,", scope: "renderer" },
] as const;

export type CommandId = (typeof COMMAND_DEFINITIONS)[number]["command"];
export type ShortcutCommand = CommandId;
export type MenuCommand = CommandId;

export type ShortcutMap = Record<CommandId, string>;

export const DEFAULT_SHORTCUTS: ShortcutMap = Object.fromEntries(
  COMMAND_DEFINITIONS.map((def) => [def.command, def.defaultShortcut]),
) as ShortcutMap;
