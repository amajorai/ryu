// Main-process client for Shadow (:3030).
//
// Shadow is a standalone Rust sidecar that captures the active window,
// selection, and on-screen OCR text, and emits proactive suggestions. Core's
// (and Shadow's) CORS allowlist excludes Electron origins, so all of this runs
// in the main process. Every method degrades gracefully: when Shadow is not
// running (:3030 unreachable) calls resolve to `{ available: false, reason }`
// rather than rejecting, so the overlay can render a quiet "unavailable" state.

import {
	type SpeechHistory,
	type SpeechHistoryInput,
	speechHistoryQuery,
} from "@ryuhq/core-client/shadow";
import { z } from "zod";
import type {
	CaptureControlResult,
	CaptureControlUpdate,
	FeedbackRequest,
	FeedbackResult,
	ShadowContextResult,
	ShadowProactiveInboxResult,
	ShadowProactiveResult,
} from "../../shared/ipc.ts";
import { forgetShadowApiToken, loadConfig, shadowApiToken } from "./config.ts";
import { isContextReadAllowed } from "./consent.ts";
import {
	captureControlSchema,
	proactiveResponseSchema,
	shadowContextSchema,
	speechHistorySchema,
} from "./shadow-contract.ts";
import {
	fetchWithVerifiedBearer,
	PeerProofCache,
	UnverifiedPeerError,
} from "./shadow-peer-proof.ts";

export async function getSpeechHistory(
	input: SpeechHistoryInput
): Promise<SpeechHistory> {
	if (!isContextReadAllowed()) {
		throw new Error(
			"Allow context reading in Island before reading Shadow speech history."
		);
	}
	const response = await shadowFetch(
		`/transcripts?${speechHistoryQuery(input)}`,
		{ method: "GET" }
	);
	if (!response.ok) {
		throw new Error(
			"Shadow speech history is unavailable. Check that transcription is running."
		);
	}
	return speechHistorySchema.parse(await response.json());
}

/** Shadow probes should be quick; capture runs locally. */
const SHADOW_TIMEOUT_MS = 4000;

/**
 * The privacy HARD GATE reason. When `contextRead` consent is not granted, every
 * Shadow method returns this WITHOUT making any network request to :3030.
 */
const CONSENT_DENIED = "context-read consent not granted";

const shadowFailureSchema = z
	.union([z.instanceof(DOMException), z.instanceof(Error)])
	.catch(new Error("shadow unreachable"));
function reasonFromError(error: z.infer<typeof shadowFailureSchema>): string {
	if (error instanceof DOMException && error.name === "AbortError") {
		return "timeout";
	}
	if (error instanceof Error) {
		return error.message;
	}
	return "shadow unreachable";
}

/**
 * Island's recent Shadow proof, so the poll loop and read-then-write calls do
 * not re-challenge Shadow on every request.
 */
const SHADOW_PEER_PROOF = new PeerProofCache(2000);

async function shadowFetch(path: string, init: RequestInit): Promise<Response> {
	const { shadowBaseUrl } = loadConfig();
	// Shadow's HTTP surface is bearer-gated (everything except /health). The
	// token is attached only after the listener proves it holds it (see
	// shadow-peer-proof.ts); without a token there is nothing to verify, so
	// fail closed rather than calling whatever holds the port.
	const token = shadowApiToken();
	if (!token) {
		throw new Error(
			"No Shadow API token found (SHADOW_API_TOKEN or services/shadow/api-token); nothing was sent to Shadow."
		);
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), SHADOW_TIMEOUT_MS);
	try {
		return await fetchWithVerifiedBearer(
			`${shadowBaseUrl}${path}`,
			{ ...init, signal: controller.signal },
			token,
			SHADOW_PEER_PROOF
		);
	} catch (error) {
		if (error instanceof UnverifiedPeerError) {
			// Core rotates the token when it finds the port squatted, so drop the
			// cached copy and re-read it on the next call.
			forgetShadowApiToken();
		}
		throw error;
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
		const context = shadowContextSchema.parse(await resp.json());
		return { available: true, context };
	} catch (error) {
		return {
			available: false,
			reason: reasonFromError(shadowFailureSchema.parse(error)),
		};
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
		const data = proactiveResponseSchema.parse(await resp.json());
		const suggestion =
			data.suggestions?.find((s) => s.disposition === "push_now") ?? null;
		return { available: true, suggestion };
	} catch (error) {
		return {
			available: false,
			reason: reasonFromError(shadowFailureSchema.parse(error)),
		};
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
		const data = proactiveResponseSchema.parse(await resp.json());
		const suggestions = (data.suggestions ?? []).filter(
			(s) => s.disposition !== "drop"
		);
		return { available: true, suggestions };
	} catch (error) {
		return {
			available: false,
			reason: reasonFromError(shadowFailureSchema.parse(error)),
		};
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
		return {
			available: false,
			reason: reasonFromError(shadowFailureSchema.parse(error)),
		};
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
		const control = captureControlSchema.parse(await resp.json());
		return { available: true, control };
	} catch (error) {
		return {
			available: false,
			reason: reasonFromError(shadowFailureSchema.parse(error)),
		};
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
		const control = captureControlSchema.parse(await resp.json());
		return { available: true, control };
	} catch (error) {
		return {
			available: false,
			reason: reasonFromError(shadowFailureSchema.parse(error)),
		};
	}
}
