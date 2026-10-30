// apps/desktop/src/lib/api/shadow.ts
//
// Typed client for Shadow's context endpoints, reached through the LOCAL
// Core's authenticated `/api/shadow/*` proxy (`apps/core/src/server/
// shadow_proxy.rs`). Shadow is a standalone Rust sidecar that captures the
// active window, selection, and on-screen text via OCR; its own HTTP surface
// (:3030) is bearer-gated and rejects every browser (Origin-bearing) request
// outright, so the webview can no longer fetch it directly — Desktop presents
// its local node bearer to Core, which stamps Shadow's shared-secret bearer on
// the proxied hop. This module exposes
// typed `getCurrentContext()`, `getProactive()`, `getCaptureControl()`, and
// `setCaptureControl()` that the companion overlay and consent settings use.
// If Shadow (or the local Core) is not running, calls resolve to `null` so
// callers can degrade gracefully rather than crash.

import {
	fetchSpeechHistory,
	type SpeechHistoryInput,
} from "@ryuhq/core-client/shadow.ts";
import { z } from "zod";
import { DEFAULT_CORE_URL } from "@/lib/core-url.ts";
import { isLocalNode, useNodeStore } from "@/src/store/useNodeStore.ts";
import { shadowFetch } from "./shadow-fetch.ts";
import {
	captureControlSchema,
	proactiveSuggestionSchema,
	shadowContextSchema,
	shadowSearchResultSchema,
} from "./shadow-schemas.ts";
import type {
	CaptureControl,
	CaptureControlUpdate,
	FeedbackRequest,
	ProactiveSuggestion,
	ShadowContext,
	ShadowSearchResult,
} from "./shadow-types.ts";

export {
	type ActivityChatMessage,
	streamActivityChat,
} from "./shadow-activity-chat.ts";
export {
	type ComputerUsePlanner,
	getShadowComputerUseConfig,
	getShadowComputerUseConfigStrict,
	runShadowComputerUse,
	type ShadowComputerUseConfig,
	type ShadowComputerUseConfigUpdate,
	type ShadowComputerUseResult,
	type ShadowComputerUseStep,
	setShadowComputerUseConfig,
} from "./shadow-computer-use.ts";
export { getJournal, getTimeline, getWeeklyReview } from "./shadow-journal.ts";
export type { ShadowActivityEvent } from "./shadow-schemas.ts";
export type {
	CaptureControl,
	CaptureControlUpdate,
	CardDistraction,
	DailyRollup,
	FeedbackKind,
	FeedbackRequest,
	FocusStats,
	JournalApp,
	JournalCard,
	JournalSnapshot,
	JournalStandup,
	JournalStat,
	ProactiveSuggestion,
	ShadowContext,
	ShadowSearchResult,
	SuggestionDisposition,
	TimelineEvent,
	WeeklyReview,
} from "./shadow-types.ts";

/** Speech is always from this physical computer, independently of the selected node. */
export function getSpeechHistory(input: SpeechHistoryInput) {
	return fetchSpeechHistory(
		{
			url: DEFAULT_CORE_URL,
			token: useNodeStore.getState().nodes.find(isLocalNode)?.token ?? null,
		},
		input
	);
}

/**
 * URL of the nearest recorded keyframe at `tsMicros` (Unix microseconds) for an
 * optional `display`. Drop this straight into an `<img src>`; Shadow returns a
 * JPEG when a keyframe exists near that moment and 404s otherwise, so the caller
 * should render a fallback on the image's `onError`. Shadow records JPEG
 * keyframes out of the box (pure-Rust, no ffmpeg), so frames normally exist;
 * requests 404 only when frame capture is toggled off, capture is paused, or
 * none was recorded near that moment yet.
 */
export async function getShadowFrame(
	tsMicros: number,
	display?: number,
	signal?: AbortSignal
): Promise<Blob | null> {
	const params = new URLSearchParams({ ts: String(Math.round(tsMicros)) });
	if (display !== undefined) {
		params.set("display", String(display));
	}
	try {
		const response = await shadowFetch(`/frame?${params.toString()}`, {
			signal,
			headers: { Accept: "image/*" },
		});
		return response.ok ? await response.blob() : null;
	} catch {
		return null;
	}
}

/**
 * Full-text search across captured context (app/window, clipboard, filesystem,
 * git, terminal, OCR, transcripts). Returns `null` when Shadow is unreachable.
 */
export async function searchShadow(
	query: string,
	limit = 30,
	signal?: AbortSignal
): Promise<ShadowSearchResult[] | null> {
	if (!query.trim()) {
		return [];
	}
	try {
		const resp = await shadowFetch(
			`/search?q=${encodeURIComponent(query)}&limit=${limit}`,
			{ signal, headers: { Accept: "application/json" } }
		);
		if (!resp.ok) {
			return null;
		}
		const data = z
			.object({ results: z.array(shadowSearchResultSchema).nullish() })
			.parse(await resp.json());
		return data.results ?? [];
	} catch {
		return null;
	}
}

/**
 * Fetch the current screen context from Shadow.
 *
 * Returns `null` when Shadow is not running or the request fails so callers
 * can render a graceful "context unavailable" state rather than throwing.
 */
export async function getCurrentContext(
	signal?: AbortSignal
): Promise<ShadowContext | null> {
	try {
		const resp = await shadowFetch("/context/current", {
			signal,
			headers: { Accept: "application/json" },
		});
		if (!resp.ok) {
			return null;
		}
		return shadowContextSchema.parse(await resp.json());
	} catch {
		return null;
	}
}

/**
 * Fetch the top PushNow proactive suggestion from Shadow.
 *
 * Shadow returns `{ suggestions: ProactiveSuggestion[] }`. This helper picks
 * the first suggestion whose disposition is `push_now`, or `null` when none
 * exists, Shadow is not running, or the request fails.
 *
 * Callers must handle `null` gracefully (no chip shown).
 */
export async function getProactive(
	signal?: AbortSignal
): Promise<ProactiveSuggestion | null> {
	try {
		const resp = await shadowFetch("/proactive", {
			signal,
			headers: { Accept: "application/json" },
		});
		if (!resp.ok) {
			return null;
		}
		const data = z
			.object({ suggestions: z.array(proactiveSuggestionSchema).nullish() })
			.parse(await resp.json());
		const list = data.suggestions ?? [];
		return list.find((s) => s.disposition === "push_now") ?? null;
	} catch {
		return null;
	}
}

/**
 * Fetch the full proactive inbox from Shadow: every non-`drop` suggestion (both
 * `push_now` and `inbox_only`), so the desktop Inbox page can list them for
 * review. Unlike {@link getProactive} (top push_now only), this returns the whole
 * set. Empty on failure or when Shadow is unreachable, so callers degrade quietly.
 */
export async function getProactiveInbox(
	signal?: AbortSignal
): Promise<ProactiveSuggestion[]> {
	try {
		const resp = await shadowFetch("/proactive", {
			signal,
			headers: { Accept: "application/json" },
		});
		if (!resp.ok) {
			return [];
		}
		const data = z
			.object({ suggestions: z.array(proactiveSuggestionSchema).nullish() })
			.parse(await resp.json());
		return (data.suggestions ?? []).filter((s) => s.disposition !== "drop");
	} catch {
		return [];
	}
}

/**
 * Post feedback for a proactive suggestion to Shadow's DeliveryManager.
 *
 * DeliveryManager.record_feedback uses this to calibrate trust scores so the
 * overlay surfaces better suggestions over time. Returns `true` on success,
 * `false` when Shadow is unreachable.
 */
export async function postFeedback(
	req: FeedbackRequest,
	signal?: AbortSignal
): Promise<boolean> {
	try {
		const resp = await shadowFetch("/api/feedback", {
			method: "POST",
			signal,
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify(req),
		});
		return resp.ok;
	} catch {
		return false;
	}
}

/**
 * Fetch the current capture-control state (pause flag + app allowlist).
 *
 * Returns `null` when Shadow is not running or the request fails.
 */
export async function getCaptureControl(
	signal?: AbortSignal
): Promise<CaptureControl | null> {
	try {
		const resp = await shadowFetch("/capture/control", {
			signal,
			headers: { Accept: "application/json" },
		});
		if (!resp.ok) {
			return null;
		}
		return captureControlSchema.parse(await resp.json());
	} catch {
		return null;
	}
}

/**
 * Push updated capture-control settings to Shadow.
 *
 * Only the fields present in `update` are changed; omitted fields are left
 * as-is. Returns the resulting state, or `null` when Shadow is unreachable.
 */
export async function setCaptureControl(
	update: CaptureControlUpdate,
	signal?: AbortSignal
): Promise<CaptureControl | null> {
	try {
		const resp = await shadowFetch("/capture/control", {
			method: "POST",
			signal,
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify(update),
		});
		if (!resp.ok) {
			return null;
		}
		return captureControlSchema.parse(await resp.json());
	} catch {
		return null;
	}
}
