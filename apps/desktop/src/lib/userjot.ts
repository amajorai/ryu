// UserJot feedback widget bootstrap.
//
// We load the SDK lazily on first use (no CDN request until the user actually
// opens feedback) instead of eagerly in index.html. The `$ujq` proxy queue
// buffers calls made before `uj.js` finishes loading, so `showWidget()` works
// even on the very first click. The widget is configured with
// `trigger: "custom"` so no floating launcher appears — it only opens when we
// call it from the settings dialog.
//
// Note: the Tauri webview enforces a strict CSP (`script-src 'self'`), so
// `https://cdn.userjot.com` must be allowlisted in `script-src` in
// `src-tauri/tauri.conf.json` for this to load inside the packaged app.

const USERJOT_PROJECT_ID = "cmp9rhltx08u30inhdw6t71nt";
const USERJOT_SDK_URL = "https://cdn.userjot.com/sdk/v2/uj.js";

type Theme = "dark" | "light";

interface UserJot {
	init: (projectId: string, options: Record<string, unknown>) => void;
	setTheme?: (theme: Theme) => void;
	showWidget?: () => void;
}

type UserJotWindow = Window & {
	uj?: UserJot;
	$ujq?: unknown[];
};

// How long to wait for the SDK script before treating it as a failed load. The
// widget is remote (CDN), so a blocked CSP, offline machine, or an ad blocker
// can leave the request hanging forever without ever firing `onerror`.
const LOAD_TIMEOUT_MS = 10_000;

// Resolves once the SDK script has loaded; rejects on network error, blocked
// request, or timeout. `null` until the first attempt, and reset back to `null`
// on failure so a later attempt (e.g. the user clicking "Send feedback" again)
// re-injects the script instead of replaying the same rejected promise.
let loadPromise: Promise<void> | null = null;

// Wire up the proxy queue + `init` exactly once. The `$ujq` proxy buffers calls
// made before `uj.js` finishes loading, so `showWidget()` still works on the
// first click.
function ensureInitialized(w: UserJotWindow): void {
	if (w.uj) {
		return;
	}
	w.$ujq = w.$ujq ?? [];
	w.uj = new Proxy({} as UserJot, {
		get:
			(_target, prop) =>
			(...args: unknown[]) =>
				(w.$ujq as unknown[]).push([prop, ...args]),
	});
	w.uj.init(USERJOT_PROJECT_ID, {
		widget: true,
		position: "right",
		theme: "auto",
		trigger: "custom",
	});
}

// Load the SDK on first use and resolve with the (possibly buffered) `uj`
// handle. Rejects with a plain Error if the script can't load so callers can
// surface a friendly fallback instead of silently doing nothing.
function ensureLoaded(): Promise<UserJot> {
	if (typeof window === "undefined") {
		return Promise.reject(
			new Error("Feedback is only available in the app window.")
		);
	}

	const w = window as UserJotWindow;
	ensureInitialized(w);

	if (!loadPromise) {
		loadPromise = new Promise<void>((resolve, reject) => {
			const script = Object.assign(document.createElement("script"), {
				src: USERJOT_SDK_URL,
				type: "module",
				async: true,
			});
			const timeout = setTimeout(() => {
				loadPromise = null;
				script.remove();
				reject(new Error("The feedback widget took too long to load."));
			}, LOAD_TIMEOUT_MS);
			script.onload = () => {
				clearTimeout(timeout);
				resolve();
			};
			script.onerror = () => {
				clearTimeout(timeout);
				loadPromise = null;
				script.remove();
				reject(new Error("The feedback widget failed to load."));
			};
			document.head.appendChild(script);
		});
	}

	// Re-read `w.uj` after the load resolves: the SDK replaces the proxy with the
	// real object once it drains the queue.
	return loadPromise.then(() => (window as UserJotWindow).uj as UserJot);
}

// Open the feedback widget, matching it to the app's resolved theme so it does
// not flash the wrong appearance. Rejects if the widget can't be loaded so the
// caller can fall back to a plain-English message.
export async function openFeedbackWidget(theme: Theme): Promise<void> {
	const uj = await ensureLoaded();
	uj.setTheme?.(theme);
	uj.showWidget?.();
}
