// Main-process client for Shadow (:3030).
//
// Shadow is a standalone Rust sidecar that captures the active window,
// selection, and on-screen OCR text, and emits proactive suggestions. Core's
// (and Shadow's) CORS allowlist excludes Electron origins, so all of this runs
// in the main process. Every method degrades gracefully: when Shadow is not
// running (:3030 unreachable) calls resolve to `{ available: false, reason }`
// rather than rejecting, so the overlay can render a quiet "unavailable" state.

import type {
	CaptureControl,
	CaptureControlResult,
	CaptureControlUpdate,
	FeedbackRequest,
	FeedbackResult,
	ProactiveSuggestion,
	ShadowContext,
	ShadowContextResult,
	ShadowProactiveInboxResult,
	ShadowProactiveResult,
} from "../../shared/ipc.ts";
import { loadConfig, shadowApiToken } from "./config.ts";
import { isContextReadAllowed } from "./consent.ts";

/** Shadow probes should be quick; capture runs locally. */
const SHADOW_TIMEOUT_MS = 4000;

/**
 * The privacy HARD GATE reason. When `contextRead` consent is not granted, every
 * Shadow method returns this WITHOUT making any network request to :3030.
 */
const CONSENT_DENIED = "context-read consent not granted";

function reasonFromError(error: unknown): string {
	if (error instanceof DOMException && error.name === "AbortError") {
		return "timeout";
	}
	if (error instanceof Error) {
		return error.message;
	}
	return "shadow unreachable";
}

async function shadowFetch(path: string, init: RequestInit): Promise<Response> {
	const { shadowBaseUrl } = loadConfig();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), SHADOW_TIMEOUT_MS);
	// Shadow's HTTP surface is bearer-gated (everything except /health); attach
	// the shared-secret token the main process resolves from env / token file.
	const token = shadowApiToken();
	const headers: Record<string, string> = {
		...((init.headers as Record<string, string> | undefined) ?? {}),
		...(token ? { Authorization: `Bearer ${token}` } : {}),
	};
	try {
		return await fetch(`${shadowBaseUrl}${path}`, {
			...init,
			headers,
			signal: controller.signal,
		});
	} finally {
		clearTimeout(timer);
	}
}

/** Fetch the current screen context from `GET /context/current`. */
export async function getCurrentContext(): Promise<ShadowContextResult> {
	if (!isContextReadAllowed()) {
		return { available: false, reason: CONSENT_DENIED };
	}
	try {
		const resp = await shadowFetch("/context/current", {
			method: "GET",
			headers: { Accept: "application/json" },
		});
		if (!resp.ok) {
			return { available: false, reason: `shadow responded ${resp.status}` };
		}
		const context = (await resp.json()) as ShadowContext;
		return { available: true, context };
	} catch (error) {
		return { available: false, reason: reasonFromError(error) };
	}
}

/**
 * Fetch the top PushNow proactive suggestion from `GET /proactive`. Shadow
 * returns `{ suggestions: [...] }`; we surface the first `push_now` entry or
 * `null` when there is none.
 */
export async function getProactive(): Promise<ShadowProactiveResult> {
	if (!isContextReadAllowed()) {
		return { available: false, reason: CONSENT_DENIED };
	}
	try {
		const resp = await shadowFetch("/proactive", {
			method: "GET",
			headers: { Accept: "application/json" },
		});
		if (!resp.ok) {
			return { available: false, reason: `shadow responded ${resp.status}` };
		}
		const data = (await resp.json()) as {
			suggestions?: ProactiveSuggestion[];
		};
		const suggestion =
			data.suggestions?.find((s) => s.disposition === "push_now") ?? null;
		return { available: true, suggestion };
	} catch (error) {
		return { available: false, reason: reasonFromError(error) };
	}
}

/**
 * Fetch the proactive INBOX from `GET /proactive`: every stored suggestion the
 * policy engine did NOT drop (`inbox_only` + `push_now`), newest first (Shadow
 * already orders by `created_at DESC`). The transient chip only surfaces the top
 * `push_now` entry via {@link getProactive}, so this is the only path that lets
 * the user review the `inbox_only` items Shadow persists but never pushes.
 */
export async function getProactiveInbox(): Promise<ShadowProactiveInboxResult> {
	if (!isContextReadAllowed()) {
		return { available: false, reason: CONSENT_DENIED };
	}
	try {
		const resp = await shadowFetch("/proactive", {
			method: "GET",
			headers: { Accept: "application/json" },
		});
		if (!resp.ok) {
			return { available: false, reason: `shadow responded ${resp.status}` };
		}
		const data = (await resp.json()) as {
			suggestions?: ProactiveSuggestion[];
		};
		const suggestions = (data.suggestions ?? []).filter(
			(s) => s.disposition !== "drop"
		);
		return { available: true, suggestions };
	} catch (error) {
		return { available: false, reason: reasonFromError(error) };
	}
}

/** Post feedback for a suggestion via `POST /api/feedback`. */
export async function postFeedback(
	req: FeedbackRequest
): Promise<FeedbackResult> {
	if (!isContextReadAllowed()) {
		return { available: false, reason: CONSENT_DENIED };
	}
	try {
		const resp = await shadowFetch("/api/feedback", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify(req),
		});
		return { available: true, ok: resp.ok };
	} catch (error) {
		return { available: false, reason: reasonFromError(error) };
	}
}

/** Read capture-control state via `GET /capture/control`. */
export async function getCaptureControl(): Promise<CaptureControlResult> {
	if (!isContextReadAllowed()) {
		return { available: false, reason: CONSENT_DENIED };
	}
	try {
		const resp = await shadowFetch("/capture/control", {
			method: "GET",
			headers: { Accept: "application/json" },
		});
		if (!resp.ok) {
			return { available: false, reason: `shadow responded ${resp.status}` };
		}
		const control = (await resp.json()) as CaptureControl;
		return { available: true, control };
	} catch (error) {
		return { available: false, reason: reasonFromError(error) };
	}
}

/** Push capture-control settings via `POST /capture/control`. */
export async function setCaptureControl(
	update: CaptureControlUpdate
): Promise<CaptureControlResult> {
	if (!isContextReadAllowed()) {
		return { available: false, reason: CONSENT_DENIED };
	}
	try {
		const resp = await shadowFetch("/capture/control", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify(update),
		});
		if (!resp.ok) {
			return { available: false, reason: `shadow responded ${resp.status}` };
		}
		const control = (await resp.json()) as CaptureControl;
		return { available: true, control };
	} catch (error) {
		return { available: false, reason: reasonFromError(error) };
	}
}
