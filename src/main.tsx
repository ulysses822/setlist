import ReactDOM from "react-dom/client";
import App from "./App";
import { GitProvider } from "./git";
import { PlayerProvider } from "./player";
import { RateLimitProvider } from "./rateLimit";
import { applyTheme, storedTheme } from "./theme";

// Stamp <html data-theme> before React mounts. Waiting for the ThemeToggle to render
// would paint one dark frame at somebody who asked for light.
applyTheme(storedTheme());

// Note: no React.StrictMode — its double-mount tears down and re-registers the
// Spotify Web Playback SDK device, which can leave a stale/offline device id.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <RateLimitProvider>
    <PlayerProvider>
      <GitProvider>
        <App />
      </GitProvider>
    </PlayerProvider>
  </RateLimitProvider>
);
