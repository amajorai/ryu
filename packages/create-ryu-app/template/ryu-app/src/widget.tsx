/**
 * __APP_DISPLAY_NAME__ widget — the in-chat surface `ryu pack` bundles into a
 * single, self-contained HTML document (inline CSS + one inline module script).
 *
 * IMPORTANT — sandbox contract:
 *   - Mounts inside a null-origin `sandbox="allow-scripts"` iframe under a
 *     hard-pinned CSP: `connect-src 'none'`, `img-src data:`, no eval. So NEVER
 *     `fetch`, load a CDN script, or reference a remote URL — the frame is offline
 *     by construction. All host access goes through `window.openai`.
 *   - Read your inputs from `window.openai.toolInput` (the model's arguments) and
 *     `window.openai.toolOutput` (the structured content Core echoed back).
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

/** The minimal slice of the Apps bridge this widget reads (installed
 *  synchronously by the host before this module runs). */
interface RyuWidgetBridge {
	toolInput?: { title?: string; items?: string[] };
	toolOutput?: { title?: string; items?: string[] };
}

declare global {
	interface Window {
		openai?: RyuWidgetBridge;
	}
}

function Widget() {
	const bridge = window.openai ?? {};
	const data = bridge.toolOutput ?? bridge.toolInput ?? {};
	const title = data.title ?? "__APP_DISPLAY_NAME__";
	const items = data.items ?? [];

	return (
		<main className="ryu-app">
			<h1>{title}</h1>
			{items.length === 0 ? (
				<p className="empty">No rows yet.</p>
			) : (
				<ul>
					{items.map((item, index) => (
						<li key={`${index}-${item}`}>{item}</li>
					))}
				</ul>
			)}
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
