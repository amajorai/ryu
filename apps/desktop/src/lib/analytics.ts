import { z } from "zod";
// apps/desktop/src/lib/analytics.ts
//
// Closed-UI product analytics for the desktop shell (P3 of
// docs/observability-analytics-support-access.md). This is the §4.2 design made
// literal: a TYPED, CONTENT-FREE event enum sent to PostHog, NOT autocapture.
//
// The structural guarantee: AnalyticsEvent is a discriminated union whose every
// variant carries scalars only (ids, enum literals, counts, booleans). There is
// no free-text / content field anywhere, so the data plane physically cannot feed
// a prompt, a completion, a file path, or any agent content into analytics. If you
// add an event, keep this invariant — no open `string` that is not an id/enum, no
// `Record<string, unknown>`, no catch-all.
//
// Privacy posture (matches the web provider + the §6 defaults):
//   - Anonymous: a RANDOM install id (crypto.randomUUID) persisted in localStorage,
//     NEVER linked to the account. identify() is never called.
//   - Opt-out gate (the load-bearing AC): emit() is a no-op unless BOTH a PostHog
//     key is configured AND the in-memory enabled flag is true. The flag is flipped
//     live by setAnalyticsEnabled() from the Privacy settings toggle, which also
//     opt_out/opt_in's the PostHog client — so toggling off stops egress
//     immediately, without waiting on an async Core re-read.
//   - EU Cloud host by default (IP capture off project-side).
//   - A local egress audit log (a small localStorage ring buffer) records exactly
//     what was sent — the Zed "open telemetry log" idea — and is itself
//     content-free since it only holds the typed props.
//
// Nothing hardcoded: the PostHog key/host come from VITE_POSTHOG_KEY /
// VITE_POSTHOG_HOST. With no key the whole module is a graceful no-op.
//
// The SDK is downloaded only when the first event is tracked after
// initAnalytics(), once the main thread is idle, so screens that send nothing
// never load it. The gate above applies before, during and after that import.
// Events tracked meanwhile wait in a small queue that opting out clears, and
// reach the egress log only when they are handed to the client.

import type { PostHog } from "posthog-js";
import { runWhenIdle } from "./idle.ts";

// --- Config (swappable, env-driven) -----------------------------------------

const POSTHOG_KEY = import.meta.env.VITE_POSTHOG_KEY;
const POSTHOG_HOST =
	import.meta.env.VITE_POSTHOG_HOST ?? "https://eu.i.posthog.com";

// localStorage keys (under the repo's `ryu:` namespace).
const INSTALL_ID_KEY = "ryu:analytics-install-id";
const EGRESS_LOG_KEY = "ryu:analytics-egress-log";
// Mirrors the canonical `product-analytics-enabled` pref for an immediate,
// synchronous read on reload (matches the web provider's local gate). Core's KV
// stays the source of truth; this is a cache so egress can be gated before the
// async Core read resolves.
const ENABLED_MIRROR_KEY = "ryu:product-analytics-enabled";

// Cap the egress audit log so it never grows unbounded.
const MAX_EGRESS_LOG_ENTRIES = 200;

// --- The content-free event enum --------------------------------------------

/**
 * Every analytics event the desktop shell may send. Discriminated on `event`.
 * Props are scalars only (ids / enum literals / counts / booleans) — there is no
 * content field, by design.
 */
export type AnalyticsEvent =
	| { event: "onboarding_completed" }
	| { event: "agent_installed"; agent_id: string }
	| { event: "agent_uninstalled"; agent_id: string }
	| { event: "engine_swapped"; engine: string }
	| { event: "sandbox_backend_set"; backend: string }
	| { event: "model_install_started"; model_id: string }
	| { event: "model_install_completed"; model_id: string; ok: boolean }
	| { event: "chat_started" }
	| { event: "feature_enabled"; section: string }
	| { event: "feature_disabled"; section: string }
	| { event: "error_shown"; code: string }
	| {
			event: "onboarding_agent_catalog_failed";
			reason: "unauthorized" | "timeout" | "unreachable";
	  };

/** The set of event names that can ever be sent (powers the inspector catalog). */
export const ANALYTICS_EVENT_NAMES = [
	"onboarding_completed",
	"agent_installed",
	"agent_uninstalled",
	"engine_swapped",
	"sandbox_backend_set",
	"model_install_started",
	"model_install_completed",
	"chat_started",
	"feature_enabled",
	"feature_disabled",
	"error_shown",
	"onboarding_agent_catalog_failed",
] as const;

export type AnalyticsEventName = (typeof ANALYTICS_EVENT_NAMES)[number];

/** A human-readable description of each event type, shown in the inspector. */
export const ANALYTICS_EVENT_CATALOG = {
	onboarding_completed: {
		description: "Sent once when first-run onboarding finishes.",
		props: [],
	},
	agent_installed: {
		description: "An agent was added from the catalog.",
		props: ["agent_id"],
	},
	agent_uninstalled: {
		description: "An agent was removed.",
		props: ["agent_id"],
	},
	engine_swapped: {
		description: "The active Chat was switched.",
		props: ["engine"],
	},
	sandbox_backend_set: {
		description: "The default code-execution sandbox backend was changed.",
		props: ["backend"],
	},
	model_install_started: {
		description: "A model download/install began.",
		props: ["model_id"],
	},
	model_install_completed: {
		description: "A model install finished (success or failure).",
		props: ["model_id", "ok"],
	},
	chat_started: {
		description: "A chat turn was sent (count only, never the text).",
		props: [],
	},
	feature_enabled: {
		description: "A feature/section was enabled.",
		props: ["section"],
	},
	feature_disabled: {
		description: "A feature/section was disabled.",
		props: ["section"],
	},
	error_shown: {
		description: "An error surfaced to the user (by stable code, no message).",
		props: ["code"],
	},
	onboarding_agent_catalog_failed: {
		description:
			"Onboarding could not read the agent catalog, so the 'Add your agents' step fell back to its curated list.",
		props: ["reason"],
	},
} satisfies Record<
	AnalyticsEventName,
	{ description: string; props: string[] }
>;

// --- Egress audit log -------------------------------------------------------

/** One recorded egress: the typed props plus a timestamp. Content-free. */
export interface EgressLogEntry {
	at: number;
	event: AnalyticsEventName;
	props: Record<string, string | number | boolean>;
}

function readEgressLog(): EgressLogEntry[] {
	try {
		const raw = localStorage.getItem(EGRESS_LOG_KEY);
		if (!raw) {
			return [];
		}
		return z
			.array(
				z.object({
					at: z.number(),
					event: z.enum(ANALYTICS_EVENT_NAMES),
					props: z.record(
						z.string(),
						z.union([z.string(), z.number(), z.boolean()])
					),
				})
			)
			.parse(JSON.parse(raw));
	} catch {
		return [];
	}
}

function appendEgressLog(entry: EgressLogEntry): void {
	try {
		const log = readEgressLog();
		log.push(entry);
		// Keep only the most recent entries.
		const trimmed = log.slice(-MAX_EGRESS_LOG_ENTRIES);
		localStorage.setItem(EGRESS_LOG_KEY, JSON.stringify(trimmed));
	} catch {
		// Inaccessible localStorage: drop the log entry, never throw on the
		// analytics path.
	}
}

/** Read the local egress audit log (newest last). For the inspector. */
export function getEgressLog(): EgressLogEntry[] {
	return readEgressLog();
}

/** Clear the local egress audit log. */
export function clearEgressLog(): void {
	try {
		localStorage.removeItem(EGRESS_LOG_KEY);
	} catch {
		// no-op
	}
}

// --- Install id (random, account-unlinked) ----------------------------------

/** Read or mint the random install id. Persisted in localStorage, not the account. */
export function getInstallId(): string {
	try {
		const existing = localStorage.getItem(INSTALL_ID_KEY);
		if (existing && existing.length > 0) {
			return existing;
		}
		const id = crypto.randomUUID();
		localStorage.setItem(INSTALL_ID_KEY, id);
		return id;
	} catch {
		// localStorage unavailable: a per-session ephemeral id, still unlinked.
		return crypto.randomUUID();
	}
}

// --- Runtime state + gate ---------------------------------------------------

let initialized = false;
// The live client once the SDK has loaded, and the one in-flight load.
let client: PostHog | null = null;
let loading: Promise<PostHog | null> | null = null;
let loadScheduled = false;
let loadFailed = false;
// Events tracked after initAnalytics() but before the SDK arrived. They reach
// the egress log only when they are actually handed to the client.
const pending: AnalyticsEvent[] = [];
const MAX_PENDING_EVENTS = 50;
// A Privacy toggle made while the SDK was not loaded, replayed on the client.
let toggledBeforeLoad: boolean | null = null;
// In-memory mirror of the opt-out gate. Seeded synchronously from the localStorage
// mirror so egress is gated before the async Core read resolves.
let enabled = readEnabledMirror();

function readEnabledMirror(): boolean {
	try {
		// Default ON (opt-out posture). Only an explicit "false" opts out.
		return localStorage.getItem(ENABLED_MIRROR_KEY) !== "false";
	} catch {
		return true;
	}
}

function writeEnabledMirror(next: boolean): void {
	try {
		localStorage.setItem(ENABLED_MIRROR_KEY, String(next));
	} catch {
		// no-op
	}
}

/** Whether a PostHog project is configured at all. */
export function isAnalyticsConfigured(): boolean {
	return Boolean(POSTHOG_KEY);
}

/** The current effective gate (configured AND enabled). */
export function isAnalyticsEnabled(): boolean {
	return enabled;
}

/** Hand one event to the live client and record it in the egress log. */
function send(posthog: PostHog, payload: AnalyticsEvent): void {
	const { event, ...props } = payload;
	posthog.capture(event, props);
	appendEgressLog({
		event,
		props: props satisfies EgressLogEntry["props"],
		at: Date.now(),
	});
}

/** Bring the SDK's persisted opt-in state in line with the gate. A toggle made
 *  while the SDK was not loaded never reached its storage, so replay it; with
 *  no toggle, only a stored state that disagrees with the gate is corrected. */
function syncConsent(posthog: PostHog): void {
	if (
		toggledBeforeLoad === null &&
		posthog.has_opted_out_capturing() !== enabled
	) {
		return;
	}
	if (enabled) {
		posthog.opt_in_capturing();
	} else {
		posthog.opt_out_capturing();
	}
}

function loadPostHog(key: string): Promise<PostHog | null> {
	loading ??= import("posthog-js")
		.then(({ default: posthog }) => {
			posthog.init(key, {
				disable_session_recording: true,
				api_host: POSTHOG_HOST,
				// No automatic event collection: we send only the typed enum below.
				autocapture: false,
				capture_pageview: false,
				capture_pageleave: false,
				// Anonymous until an explicit identify() (which this module never calls).
				person_profiles: "identified_only",
				// Random, account-unlinked install id as the distinct id.
				bootstrap: { distinctID: getInstallId() },
				// Respect the opt-out from the very first event (the gate as it is
				// now, after any toggle made before the SDK loaded).
				opt_out_capturing_by_default: !enabled,
			});
			// Tag all events from this surface so we can separate product (desktop) users
			// from marketing (landing page) visitors in PostHog dashboards.
			posthog.register({ $source: "desktop" });
			syncConsent(posthog);
			client = posthog;
			for (const queued of pending.splice(0)) {
				if (!enabled) {
					break;
				}
				try {
					send(posthog, queued);
				} catch {
					// Never let an analytics failure surface to the user.
				}
			}
			return posthog;
		})
		.catch(() => {
			// The queued events were never sent, so they are dropped unlogged.
			loadFailed = true;
			pending.length = 0;
			return null;
		});
	return loading;
}

/** Start the SDK download once, when the main thread is next idle. */
function scheduleLoad(key: string): void {
	if (loadScheduled) {
		return;
	}
	loadScheduled = true;
	runWhenIdle(() => {
		loadPostHog(key).catch(() => undefined);
	});
}

/**
 * Initialize PostHog once. Safe to call when no key is set (graceful no-op). The
 * install id is the bootstrap distinct id, and identify() is never called — events
 * stay anonymous and account-unlinked. The SDK itself loads only when the first
 * event is tracked, once the main thread is idle.
 */
export function initAnalytics(): void {
	if (initialized || !POSTHOG_KEY) {
		return;
	}
	initialized = true;
}

/** Resolves once the SDK is live: false when unconfigured, not initialised, or
 *  when it failed to load. Loads it now instead of waiting for an event. */
export async function analyticsReady(): Promise<boolean> {
	if (!(initialized && POSTHOG_KEY)) {
		return false;
	}
	return (await loadPostHog(POSTHOG_KEY)) !== null;
}

/**
 * Flip the live gate from the Privacy settings toggle. Flips the in-memory flag,
 * mirrors it to localStorage for the next reload, and opt_out/opt_in's the PostHog
 * client so toggling off stops egress immediately (no async Core re-read needed).
 * Before the SDK has loaded, turning it off drops the queued events and the
 * client starts with the gate as it then stands.
 */
export function setAnalyticsEnabled(next: boolean): void {
	enabled = next;
	writeEnabledMirror(next);
	if (!next) {
		pending.length = 0;
	}
	if (!(initialized && POSTHOG_KEY)) {
		return;
	}
	if (!client) {
		toggledBeforeLoad = next;
		return;
	}
	if (next) {
		client.opt_in_capturing();
	} else {
		client.opt_out_capturing();
	}
}

// --- Emit -------------------------------------------------------------------

/**
 * Send one typed, content-free event. A no-op unless a project is configured AND
 * the gate is on. The egress log records an event when it is handed to the
 * client; one queued for the SDK and then dropped (opt-out, queue cap, failed
 * load) is never logged. Before initAnalytics() nothing loads the SDK and the
 * event is logged as it was before the lazy load.
 */
export function track(payload: AnalyticsEvent): void {
	if (!(enabled && POSTHOG_KEY)) {
		return;
	}
	try {
		if (client) {
			send(client, payload);
			return;
		}
		if (!initialized) {
			const { event, ...props } = payload;
			appendEgressLog({
				event,
				props: props satisfies EgressLogEntry["props"],
				at: Date.now(),
			});
			return;
		}
		if (loadFailed || pending.length >= MAX_PENDING_EVENTS) {
			return;
		}
		pending.push(payload);
		scheduleLoad(POSTHOG_KEY);
	} catch {
		// Never let an analytics failure surface to the user.
	}
}
