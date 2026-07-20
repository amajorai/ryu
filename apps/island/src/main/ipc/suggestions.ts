// IPC bridge for the suggestion engine (Island U3).
//
// Owns a single `SuggestionEngine` instance and wires its emit callbacks to the
// live renderer window via `webContents.send`. The engine's outbound calls are
// bound here to the existing main-process Core and Shadow clients (do NOT create
// new clients). start/stop/status/feedback are invoke/return; new + cleared are
// pushed events keyed by the channel names in `IPC.suggestions`.

import { type BrowserWindow, ipcMain } from "electron";
import {
	agentIdOrUndefined,
	DEFAULT_AGENT_ID,
	ISLAND_AGENTS_PREF_KEY,
	parseIslandAgentPrefs,
} from "../../shared/agents.ts";
import {
	type FeedbackKind,
	IPC,
	type SuggestionFeedbackRequest,
	type SuggestionFeedbackResult,
} from "../../shared/ipc.ts";
import type { buildSuggestionMessages } from "../engine/prompt.ts";
import { SuggestionEngine } from "../engine/suggestions.ts";
import { onConsentChanged, shouldRunEngine } from "../services/consent.ts";
import { completions, runAgentText } from "../services/core.ts";
import {
	getPreferenceRaw,
	subscribePreferenceChanges,
} from "../services/preferences.ts";
import {
	getCurrentContext,
	getProactive,
	postFeedback,
} from "../services/shadow.ts";

let engine: SuggestionEngine | null = null;

// ── Browser page-context bridge ──────────────────────────────────────────────
// The Chrome extension writes the page the user is viewing to this Core
// preference (full text, including content scrolled off-screen that screen
// capture/OCR can never see). We cache the latest value (one-shot read + SSE)
// and fold it into the suggestion prompt — but only while it is FRESH, so a page
// from a long-closed browser tab does not linger as stale context forever.
const PAGE_CONTEXT_PREF_KEY = "browser.page-context";
const PAGE_CONTEXT_FRESHNESS_MS = 120_000;

interface BridgedPage {
	content: string;
	ts: number;
	url: string;
}

let latestBrowserPage: BridgedPage | null = null;

function parseBrowserPage(raw: string | null): BridgedPage | null {
	if (!raw) {
		return null;
	}
	try {
		const obj = JSON.parse(raw) as Partial<BridgedPage>;
		if (typeof obj.url === "string" && typeof obj.content === "string") {
			return { url: obj.url, content: obj.content, ts: obj.ts ?? Date.now() };
		}
	} catch {
		// Malformed blob: ignore.
	}
	return null;
}

/** Track the bridged page: read once, then follow live changes via SSE. */
function watchBrowserContext(): void {
	getPreferenceRaw(PAGE_CONTEXT_PREF_KEY)
		.then((raw) => {
			latestBrowserPage = parseBrowserPage(raw);
		})
		.catch(() => {
			// Keep null on a read failure.
		});
	subscribePreferenceChanges(PAGE_CONTEXT_PREF_KEY, (value) => {
		latestBrowserPage = parseBrowserPage(value);
	});
}

/** The bridged page if it is still fresh, else null. */
function readBrowserContext(): { content: string; url: string } | null {
	const page = latestBrowserPage;
	if (!page) {
		return null;
	}
	if (Date.now() - page.ts > PAGE_CONTEXT_FRESHNESS_MS) {
		return null;
	}
	return { url: page.url, content: page.content };
}

// The agent the proactive engine routes through, kept current via the
// `island-agents` pref (one-shot read on start + SSE updates). Defaults to the
// flagship `ryu`; an empty string falls back to Core's fast local completion.
let proactiveAgent = DEFAULT_AGENT_ID;

/** Track the configured proactive agent: read once, then follow live changes. */
function watchProactiveAgent(): void {
	getPreferenceRaw(ISLAND_AGENTS_PREF_KEY)
		.then((raw) => {
			proactiveAgent = parseIslandAgentPrefs(raw).proactiveAgent;
		})
		.catch(() => {
			// Keep the default on a read failure.
		});
	subscribePreferenceChanges(ISLAND_AGENTS_PREF_KEY, (value) => {
		proactiveAgent = parseIslandAgentPrefs(value).proactiveAgent;
	});
}

function buildEngine(getWindow: () => BrowserWindow | null): SuggestionEngine {
	const send = (channel: string, payload?: unknown): void => {
		const win = getWindow();
		if (win && !win.isDestroyed()) {
			win.webContents.send(channel, payload);
		}
	};
	return new SuggestionEngine({
		getContext: () => getCurrentContext(),
		getProactive: () => getProactive(),
		getBrowserContext: () => Promise.resolve(readBrowserContext()),
		complete: async (messages: ReturnType<typeof buildSuggestionMessages>) => {
			// Route through the configured agent (default `ryu`) when set; fall back
			// to Core's fast local completion when the agent is the empty "local
			// model" sentinel. Either way a failure resolves to null (logged, never
			// fatal) so the engine just skips that suggestion.
			const agent = agentIdOrUndefined(proactiveAgent);
			const result = agent
				? await runAgentText(agent, messages)
				: await completions({ messages });
			return result.available ? result.text : null;
		},
		postFeedback: async (kind: FeedbackKind, suggestionType: string) => {
			await postFeedback({ kind, suggestion_type: suggestionType });
		},
		emit: (suggestion) => send(IPC.suggestions.new, suggestion),
		emitCleared: () => send(IPC.suggestions.cleared),
		log: (message: string) => {
			// Quiet by default; surfaced only when ISLAND_DEBUG is set.
			if (process.env.ISLAND_DEBUG) {
				process.stdout.write(`${message}\n`);
			}
		},
	});
}

/**
 * Register suggestion-engine IPC handlers. `getWindow` returns the live renderer
 * window so emitted events always reach the current window. Safe to call once.
 */
export function registerSuggestionsIpc(
	getWindow: () => BrowserWindow | null
): void {
	watchProactiveAgent();
	watchBrowserContext();
	engine = buildEngine(getWindow);

	// Consent gate (U6): the engine reads screen context then suggests, so it may
	// only run when both `contextRead` and `proactive` are granted. Honour the
	// current grant immediately and react to later toggles from any surface.
	const syncEngineToConsent = (): void => {
		if (!engine) {
			return;
		}
		if (shouldRunEngine()) {
			if (!engine.status().running) {
				engine.start();
			}
		} else if (engine.status().running) {
			engine.stop();
		}
	};
	onConsentChanged(syncEngineToConsent);
	syncEngineToConsent();

	// `start` still honours the gate so a renderer cannot bypass consent.
	ipcMain.handle(IPC.suggestions.start, () => {
		if (!shouldRunEngine()) {
			return engine?.status();
		}
		return engine?.start();
	});
	ipcMain.handle(IPC.suggestions.stop, () => engine?.stop());
	ipcMain.handle(IPC.suggestions.status, () => engine?.status());
	ipcMain.handle(
		IPC.suggestions.feedback,
		async (
			_event,
			req: SuggestionFeedbackRequest
		): Promise<SuggestionFeedbackResult> => {
			if (!engine) {
				return { ok: false, reason: "engine not initialized" };
			}
			try {
				await engine.feedback(req.id, req.kind);
				return { ok: true };
			} catch (error) {
				return {
					ok: false,
					reason: error instanceof Error ? error.message : "feedback failed",
				};
			}
		}
	);
}
