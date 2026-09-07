import { api } from "./api";
import { FEATURE_META, GOAL_DIMS, type FeatureKey, type Goal, type GoalDim } from "./metricsCalc";

// Curation state and view state, kept in the data folder rather than the webview.
//
// These used to live in localStorage, which put real work — the mood goals especially — inside
// a browser profile that the uninstaller offers to delete, and that no `git push` ever backed
// up. Goals now sit in a committed `goals.json`; view state sits in gitignored
// `cache/ui-state.json`. Both follow the library rather than the machine, so opening a
// different data folder gives you that library's columns and goals rather than the last one's.
//
// Both stores load once at startup and are cached here. Reads stay synchronous, which is what
// lets the callers keep their shape — they run during render. Writes update the cache and fire
// a save without waiting: losing a column toggle to a failed write is not worth an await, and
// the next successful write carries it anyway, since each save writes the whole store.
//
// That self-healing holds for a write that fails once. It does not hold for a data folder that
// has stopped being writable — deleted, unmounted, gone read-only — where every save fails and
// the argument above quietly becomes "your work only exists in this window until you close it".
// So a failed save is remembered and published (see `subscribeSaveError`); the topbar shows it
// for as long as it lasts, and the next save that succeeds clears it.
//
// The theme is deliberately NOT here. It describes the machine you're looking at, not the
// library you're editing, so it stays in localStorage (see theme.tsx).

type Goals = Record<string, Goal>;

type UiState = {
  cols?: Record<string, FeatureKey[]>;
  outlierMode?: string;
  simBasis?: unknown;
  hubRepo?: string;
};

let goals: Goals = {};
let ui: UiState = {};
let loaded = false;

/** Load both stores. Call before rendering anything that reads them, whenever the data folder
 *  changes, and after anything that can rename a playlist file: renaming re-keys both stores
 *  on disk, and a write from a stale cache would put the old key straight back. Failure leaves
 *  the defaults in place — an unconfigured data folder is the normal first-run state, not an
 *  error. */
export async function loadPrefs(): Promise<void> {
  try {
    const [g, u] = await Promise.all([api.getGoals(), api.getUiState()]);
    goals = (g ?? {}) as Goals;
    ui = u ?? {};
    loaded = true;
    // A different data folder (or a retry of the same one) gets a clean verdict — the previous
    // folder's failure says nothing about this one.
    goalsError = null;
    uiError = null;
    publishSaveError();
    importFromLocalStorage();
  } catch {
    goals = {};
    ui = {};
    loaded = false;
  }
}

// --- save failures ----------------------------------------------------------

// Tracked per store, so a working `cache/ui-state.json` write can't clear a real failure to
// write `goals.json`. `saveError` is the cached combination the UI subscribes to: a plain
// string, so `useSyncExternalStore` can compare snapshots by value.
let goalsError: string | null = null;
let uiError: string | null = null;
let saveError: string | null = null;
const saveErrorListeners = new Set<() => void>();

function publishSaveError() {
  const next = goalsError ?? uiError;
  if (next === saveError) return;
  saveError = next;
  for (const listener of saveErrorListeners) listener();
}

/** The current save failure, or null while saves are working. */
export function getSaveError(): string | null {
  return saveError;
}

/** Subscribe to changes in `getSaveError()`. Returns an unsubscribe function. */
export function subscribeSaveError(listener: () => void): () => void {
  saveErrorListeners.add(listener);
  return () => {
    saveErrorListeners.delete(listener);
  };
}

/** Fire a write and record whether it worked. Deliberately not awaited by callers — the point
 *  is to report a persistent failure, not to make every column toggle wait on disk. */
function save(what: string, write: Promise<void>, assign: (msg: string | null) => void) {
  void write.then(
    () => {
      assign(null);
      publishSaveError();
    },
    (e: unknown) => {
      assign(
        `Couldn't save your ${what} to the data folder: ${String(e)}. They're still in this ` +
          `window and the next successful save will include them, but closing Setlist loses ` +
          `them. Check the data folder still exists and is writable.`
      );
      publishSaveError();
    }
  );
}

function saveGoals() {
  if (!loaded) return;
  save("mood goals", api.setGoals(goals), (msg) => {
    goalsError = msg;
  });
}

function saveUi() {
  if (!loaded) return;
  save("view settings", api.setUiState(ui), (msg) => {
    uiError = msg;
  });
}

// --- goals ------------------------------------------------------------------

export const DEFAULT_COLS: FeatureKey[] = ["valence", "energy", "tempo"];

/** Per-playlist mood goal, or null if unset. Values are clamped on read so a hand-edited
 *  goals.json can't push a bar off the end of its track. */
export function getGoal(file: string): Goal | null {
  const raw = goals[file] as Partial<Record<GoalDim, number>> | undefined;
  if (!raw) return null;
  const goal = {} as Goal;
  for (const k of GOAL_DIMS) goal[k] = Math.max(0, Math.min(1, raw[k] ?? 0.5));
  return goal;
}

export function setGoal(file: string, goal: Goal | null) {
  if (goal) goals[file] = goal;
  else delete goals[file];
  saveGoals();
}

// --- view state -------------------------------------------------------------

/** Feature columns shown for a playlist. Unknown keys are dropped and canonical order is
 *  restored, so an old or hand-edited entry can't produce a table with duplicate columns. */
export function getCols(file: string): FeatureKey[] {
  const saved = ui.cols?.[file];
  if (!saved?.length) return DEFAULT_COLS;
  const cols = FEATURE_META.filter((m) => saved.includes(m.key)).map((m) => m.key);
  return cols.length ? cols : DEFAULT_COLS;
}

export function setCols(file: string, cols: FeatureKey[]) {
  ui.cols = { ...(ui.cols ?? {}), [file]: cols };
  saveUi();
}

export function getOutlierMode(): string {
  return ui.outlierMode === "multivariate" ? "multivariate" : "independent";
}

export function setOutlierMode(mode: string) {
  ui.outlierMode = mode;
  saveUi();
}

export function getSimBasis(): unknown {
  return ui.simBasis ?? null;
}

export function setSimBasis(basis: unknown) {
  ui.simBasis = basis;
  saveUi();
}

export function getHubRepo(): string {
  return ui.hubRepo ?? "";
}

export function setHubRepo(slug: string) {
  ui.hubRepo = slug;
  saveUi();
}

// --- one-time import --------------------------------------------------------

/** Carry across anything still in localStorage from before these moved, then clear it so the
 *  import runs once. Never overwrites: whatever is already in the data folder wins, since the
 *  browser copy is by definition the older one. */
function importFromLocalStorage() {
  let touchedGoals = false;
  let touchedUi = false;
  try {
    for (const key of Object.keys(localStorage)) {
      const goalFile = key.startsWith("setlist.goal.") ? key.slice(13) : null;
      const colsFile = key.startsWith("setlist.cols.") ? key.slice(13) : null;
      const raw = localStorage.getItem(key);
      if (!raw) continue;

      if (goalFile && !(goalFile in goals)) {
        goals[goalFile] = JSON.parse(raw) as Goal;
        touchedGoals = true;
      } else if (colsFile && !ui.cols?.[colsFile]) {
        ui.cols = { ...(ui.cols ?? {}), [colsFile]: JSON.parse(raw) as FeatureKey[] };
        touchedUi = true;
      } else if (key === "setlist.outlierMode" && ui.outlierMode === undefined) {
        ui.outlierMode = raw;
        touchedUi = true;
      } else if (key === "setlist.simBasis" && ui.simBasis === undefined) {
        ui.simBasis = JSON.parse(raw);
        touchedUi = true;
      } else if (key === "setlist.hubRepo" && ui.hubRepo === undefined) {
        ui.hubRepo = raw;
        touchedUi = true;
      } else {
        continue;
      }
      localStorage.removeItem(key);
    }
  } catch {
    // A corrupt entry or an unavailable store just means nothing to import.
  }
  if (touchedGoals) saveGoals();
  if (touchedUi) saveUi();
}
