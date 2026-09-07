import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "./api";

// Global Spotify rate-limit cooldown, mirrored from the backend (which is the source of
// truth — it paces requests and records the Retry-After on a 429). Components read this to
// disable actions that would 429 and to show a countdown.
//
// The backend pushes a "rate-limit-cooldown" event whenever a cooldown is recorded (or a
// call is refused during one), so the UI only reads the backend once on startup and then
// counts down locally — no steady-state polling over IPC.
interface RateLimitApi {
  secondsLeft: number;
  blocked: boolean;
  /** Re-read the cooldown from the backend immediately (e.g. right after a failed call). */
  refresh: () => void;
}

const Ctx = createContext<RateLimitApi>({ secondsLeft: 0, blocked: false, refresh: () => {} });
export const useRateLimit = () => useContext(Ctx);

export function RateLimitProvider({ children }: { children: ReactNode }) {
  const [secondsLeft, setSecondsLeft] = useState(0);

  function refresh() {
    api
      .rateLimitStatus()
      .then(setSecondsLeft)
      .catch(() => {});
  }

  useEffect(() => {
    refresh(); // pick up a cooldown that predates this window (e.g. after a reload)
    const unlisten = listen<number>("rate-limit-cooldown", (e) => setSecondsLeft(e.payload));
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  // Local 1s countdown while blocked — pure JS, no IPC. A new 429 (or a refused call)
  // re-emits the event and resets the clock.
  const blocked = secondsLeft > 0;
  useEffect(() => {
    if (!blocked) return;
    const t = window.setInterval(
      () => setSecondsLeft((s) => Math.max(0, s - 1)),
      1000
    );
    return () => window.clearInterval(t);
  }, [blocked]);

  return (
    <Ctx.Provider value={{ secondsLeft, blocked, refresh }}>
      {children}
    </Ctx.Provider>
  );
}
