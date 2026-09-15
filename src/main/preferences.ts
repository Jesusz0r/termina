/**
 * Preferences boot / paint / persist.
 * Owns the generation fence, sticky load banner, and SettingsView callbacks.
 * Main wires editors, terminals, and the settings button; the validator
 * stays shared/preferences.ts — this is not a second prefs store.
 */
import { stickyToast, toast } from "../components/modals";
import { loadPreferencesWithRetry } from "../preferences-boot";
import { SettingsView } from "../settings";
import { emptyShortcuts } from "../settings-shortcuts";
import { cssFontFamily, defaultAppPreferences, type AppPreferences, type UserPreferencePatch } from "../../shared/types";
import { normalizeAppPreferences } from "../../shared/preferences";

export interface PreferenceEditor {
  setTheme(theme: AppPreferences["theme"]): void;
  setFontSize(size: number): void;
  setFontFamily(family: AppPreferences["fontFamily"]): void;
  setWordWrap(wrap: boolean): void;
  setMinimap(minimap: boolean): void;
}

export interface PreferenceReview {
  setTheme(theme: AppPreferences["theme"]): void;
  setFontSize(size: number): void;
  setFontFamily(family: AppPreferences["fontFamily"]): void;
  setWordWrap(wrap: boolean): void;
}

export interface PreferenceTerminal {
  setTheme(theme: AppPreferences["theme"]): void;
  setFontSize(size: number): void;
  setFontFamily(family: AppPreferences["fontFamily"]): void;
}

interface PreferencesBindings {
  getBaseEditor(): PreferenceEditor | null;
  forEachProjectEditor(fn: (editor: PreferenceEditor) => void): void;
  getReviewView(): PreferenceReview | null;
  forEachTerminal(fn: (view: PreferenceTerminal) => void): void;
}

export function userPatch(prev: AppPreferences, next: AppPreferences): UserPreferencePatch {
  const patch: UserPreferencePatch = {};
  if (prev.theme !== next.theme) patch.theme = next.theme;
  if (prev.editorFontSize !== next.editorFontSize) patch.editorFontSize = next.editorFontSize;
  if (prev.terminalFontSize !== next.terminalFontSize) patch.terminalFontSize = next.terminalFontSize;
  if (prev.fontFamily !== next.fontFamily) patch.fontFamily = next.fontFamily;
  if (prev.wordWrap !== next.wordWrap) patch.wordWrap = next.wordWrap;
  if (prev.minimap !== next.minimap) patch.minimap = next.minimap;
  if (JSON.stringify(prev.shortcuts) !== JSON.stringify(next.shortcuts)) patch.shortcuts = next.shortcuts;
  if (prev.showThinking !== next.showThinking) patch.showThinking = next.showThinking;
  if (prev.autoOpenAgentFiles !== next.autoOpenAgentFiles) patch.autoOpenAgentFiles = next.autoOpenAgentFiles;
  return patch;
}

export function applyEditorPreferences(editor: PreferenceEditor, prefs: AppPreferences): void {
  editor.setTheme(prefs.theme);
  editor.setFontSize(prefs.editorFontSize);
  editor.setFontFamily(prefs.fontFamily);
  editor.setWordWrap(prefs.wordWrap);
  editor.setMinimap(prefs.minimap);
}

export function applyTerminalPreferences(view: PreferenceTerminal, prefs: AppPreferences): void {
  view.setTheme(prefs.theme);
  view.setFontSize(prefs.terminalFontSize);
  view.setFontFamily(prefs.fontFamily);
}

export function applyReviewPreferences(view: PreferenceReview, prefs: AppPreferences): void {
  view.setTheme(prefs.theme);
  view.setFontSize(prefs.editorFontSize);
  view.setFontFamily(prefs.fontFamily);
  view.setWordWrap(prefs.wordWrap);
}

export function paintPreferences(prefs: AppPreferences, bindings: PreferencesBindings): void {
  document.documentElement.dataset.theme = prefs.theme;
  // The app chrome (explorer, tabs, menus) inherits this token; canvases
  // set their own families directly below.
  document.documentElement.style.setProperty("--font-chrome", cssFontFamily(prefs.fontFamily));
  const base = bindings.getBaseEditor();
  if (base) applyEditorPreferences(base, prefs);
  bindings.forEachProjectEditor((editor) => applyEditorPreferences(editor, prefs));
  const review = bindings.getReviewView();
  if (review) applyReviewPreferences(review, prefs);
  bindings.forEachTerminal((view) => applyTerminalPreferences(view, prefs));
}

type ApplyPreferencesRequest = {
  next: AppPreferences;
  persist: boolean;
  activateShortcuts: boolean;
  confirmReset?: boolean;
};

export interface PreferencesController {
  get current(): AppPreferences;
  get committed(): AppPreferences | null;
  settingsView: SettingsView;
  apply(request: ApplyPreferencesRequest): void;
  retry(): Promise<void>;
  openSettings(): void;
}

export async function createPreferences(bindings: PreferencesBindings): Promise<PreferencesController> {
  const prefsBoot = await loadPreferencesWithRetry(() => window.termina.getPreferences());
  // Visual fallback only. Never treat this as the user's committed prefs.
  let preferences: AppPreferences = prefsBoot.ok ? prefsBoot.preferences : defaultAppPreferences();
  let committedPreferences: AppPreferences | null = prefsBoot.ok ? preferences : null;
  let preferenceGeneration = 0;
  let prefsLoadInFlight = false;
  let prefsLoadBanner: { dismiss: () => void } | null = null;

  function paint(prefs: AppPreferences): void {
    paintPreferences(prefs, bindings);
  }

  function applyPreferences({ next, persist, activateShortcuts, confirmReset = false }: ApplyPreferencesRequest): void {
    if (persist && !committedPreferences) {
      toast("Could not load settings", "error");
      return;
    }
    const generation = ++preferenceGeneration;
    const preview = normalizeAppPreferences(next);
    preferences = preview;
    paint(preferences);
    if (persist) {
      const baseline = committedPreferences;
      if (!baseline) return;
      const patch = userPatch(baseline, preview);
      // A reset always persists, even with an empty patch: that is the write
      // that clears an unreadable prefs file back to defaults.
      if (Object.keys(patch).length > 0 || confirmReset) {
        void window.termina.updatePreferences({ patch, activateShortcuts, ...(confirmReset ? { confirmReset: true } : {}) }).then((saved) => {
          const normalized = normalizeAppPreferences(saved);
          committedPreferences = normalized;
          if (generation !== preferenceGeneration) return;
          preferences = normalized;
          paint(preferences);
        }).catch(() => {
          if (generation !== preferenceGeneration) return;
          preferences = baseline;
          paint(preferences);
          toast("Could not save settings", "error");
        });
      } else if (activateShortcuts) {
        void window.termina.setKeyboardShortcuts(baseline.shortcuts).catch(() => undefined);
      }
    } else {
      committedPreferences = preview;
      if (activateShortcuts) {
        void window.termina.setKeyboardShortcuts(preferences.shortcuts).catch(() => undefined);
      }
    }
  }

  const settingsView = new SettingsView({
    onChange: (next) => applyPreferences({ next, persist: true, activateShortcuts: false }),
    onReset: (next) => applyPreferences({ next, persist: true, activateShortcuts: false, confirmReset: true }),
    onOpen: () => void window.termina.setKeyboardShortcuts(emptyShortcuts()).catch(() => undefined),
    onClose: (next) => applyPreferences({ next, persist: true, activateShortcuts: true }),
    onRetryLoad: () => void retryPreferences(),
  });

  function showPrefsLoadBanner(): void {
    if (prefsLoadBanner) return;
    prefsLoadBanner = stickyToast("Could not load settings", "warning", {
      label: "Retry",
      onClick: () => void retryPreferences(),
    });
  }

  function dismissPrefsLoadBanner(): void {
    prefsLoadBanner?.dismiss();
    prefsLoadBanner = null;
  }

  async function retryPreferences(): Promise<void> {
    if (prefsLoadInFlight || committedPreferences) return;
    prefsLoadInFlight = true;
    try {
      const result = await loadPreferencesWithRetry(() => window.termina.getPreferences());
      if (!result.ok) return;
      applyPreferences({ next: result.preferences, persist: false, activateShortcuts: true });
      dismissPrefsLoadBanner();
      settingsView.setLoaded(result.preferences);
    } finally {
      prefsLoadInFlight = false;
    }
  }

  if (committedPreferences) applyPreferences({ next: preferences, persist: false, activateShortcuts: true });
  else showPrefsLoadBanner();

  return {
    get current() {
      return preferences;
    },
    get committed() {
      return committedPreferences;
    },
    settingsView,
    apply: applyPreferences,
    retry: retryPreferences,
    openSettings: () => settingsView.open(committedPreferences),
  };
}
