/**
 * __APP_DISPLAY_NAME__ widget — a companion widget that calls BACK to the host.
 *
 * `ryu pack` bundles this into a single self-contained HTML document. It runs in
 * a null-origin `sandbox="allow-scripts"` iframe under a hard-pinned CSP
 * (`connect-src 'none'`, no eval). NEVER `fetch` or reference a remote URL — the
 * frame is offline; the ONLY channel to the node is `window.openai`.
 *
 * The Save button demonstrates the companion callTool bridge: the host validates
 * the capability, routes the call through the Gateway, and executes it in Core.
 */

import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";

/** The minimal Apps bridge this widget uses (installed synchronously by the host
 *  before this module runs). `callTool` is gated by the app's `tool:call` grant. */
interface RyuWidgetBridge {
	callTool?(name: string, args: unknown): Promise<unknown>;
	toolInput?: { title?: string };
	toolOutput?: { title?: string };
}

declare global {
	interface Window {
		openai?: RyuWidgetBridge;
	}
}

const SAVE_TOOL_ID = "__APP_NAME____save";

function Widget() {
	const bridge = window.openai ?? {};
	const title =
		bridge.toolOutput?.title ??
		bridge.toolInput?.title ??
		"__APP_DISPLAY_NAME__";
	const [note, setNote] = useState("");
	const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">(
		"idle"
	);

	async function save() {
		if (!bridge.callTool) {
			setStatus("error");
			return;
		}
		setStatus("saving");
		try {
			await bridge.callTool(SAVE_TOOL_ID, { state: { note } });
			setStatus("saved");
		} catch {
			setStatus("error");
		}
	}

	return (
		<main className="ryu-app">
			<h1>{title}</h1>
			<textarea
				aria-label="Note"
				onChange={(event) => setNote(event.target.value)}
				placeholder="Type a note to persist…"
				value={note}
			/>
			<button onClick={save} type="button">
				Save
			</button>
			<p className="status">{status}</p>
		</main>
	);
}

const rootEl = document.getElementById("root");
if (rootEl) {
	createRoot(rootEl).render(
		<StrictMode>
			<Widget />
		</StrictMode>
	);
}
