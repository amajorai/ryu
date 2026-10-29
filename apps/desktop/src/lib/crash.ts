// apps/desktop/src/lib/crash.ts
//
// Crash reporting tier for the desktop renderer (P3 of
// docs/observability-analytics-support-access.md). This is a SEPARATE consent tier
// from product analytics (analytics.ts) — the Zed/VS Code/Cursor split — gated on
// the canonical `crash-reports-enabled` pref, not `product-analytics-enabled`.
//
// What it captures: unhandled renderer errors (React error boundary +
// window.onerror / unhandledrejection). NOT product events, NOT prompts, NOT agent
// content. The Rust panic tier (Core + Gateway) is the sibling; see
// apps/core/src/crash.rs.
//
// Privacy posture (the load-bearing AC — the leak vector is Sentry's DEFAULT
// integrations, not the top-level event fields):
//   - sendDefaultPii: false, and beforeSend drops event.request / event.user /
//     event.server_name (Sentry captures the machine hostname by default).
//   - beforeBreadcrumb drops console / fetch / xhr breadcrumbs — console.* and
//     fetch URLs can carry content. No Session Replay, no profiling, no tracing.
//   - A home-dir-ish scrub on the message + frame paths (defense in depth; the
//     renderer rarely has absolute home paths, but scrub anyway).
//   - Anonymous: the random, account-unlinked install id from analytics.ts is the
//     only id; setUser is never called.
//
// Opt-out gate (matches analytics.ts exactly):
//   - emit/report is a no-op unless BOTH a DSN is configured AND the in-memory
//     enabled flag is true. The flag is flipped live by setCrashReportingEnabled()
//     from the Privacy toggle, which beforeSend honors immediately (returns null
//     when off) so toggling off stops egress without an async Core re-read.
//   - Seeded synchronously from a localStorage mirror of `crash-reports-enabled`.
//
// Nothing hardcoded: the DSN comes from VITE_SENTRY_DSN. With no DSN the whole
// module is a graceful no-op (no vendor wired).
//
// The SDK is downloaded after initCrashReporting(), once the main thread is idle,
// so it never delays the first render. Reports made meanwhile (the error
// boundary, the preflight report) wait in a small queue that the opt-out clears
// and that beforeSend gates again on delivery. Until the SDK's own
// window.onerror / unhandledrejection handlers are installed, small early
// listeners queue those errors the same way (gated, capped, cleared by the
// opt-out), so a window started hidden or a boot-time error is not lost.
// Sentry's Breadcrumbs integration is left out: beforeBreadcrumb already drops
// every crumb, so it only patched console / fetch / xhr / DOM / history for
// nothing.

import type { ErrorEvent as SentryErrorEvent } from "@sentry/react";
import { getInstallId } from "./analytics.ts";
import { runWhenIdle } from "./idle.ts";

type SentryModule = typeof import("@sentry/react");

// --- Config (swappable, env-driven) -----------------------------------------

const SENTRY_DSN = import.meta.env.VITE_SENTRY_DSN;

// localStorage key mirroring the canonical kebab pref name, under the `ryu:`
// namespace — synchronous seed before the async Core read resolves.
const ENABLED_MIRROR_KEY = "ryu:crash-reports-enabled";

// --- Runtime state + gate ---------------------------------------------------

let initialized = false;
let enabled = readEnabledMirror();
// The SDK once loaded, and the one in-flight load.
let sdk: SentryModule | null = null;
let loading: Promise<SentryModule | null> | null = null;

type PendingReport =
	| { context?: CrashContext; error: unknown; kind: "error" }
	| { context?: CrashContext; kind: "event"; message: string };
// Reports made after initCrashReporting() but before the SDK arrived.
const pending: PendingReport[] = [];
const MAX_PENDING_REPORTS = 20;
// Removes the early window listeners once the SDK (or its failure) settles.
let stopEarlyCapture: (() => void) | null = null;

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

/** Whether a Sentry DSN is configured at all. */
export function isCrashReportingConfigured(): boolean {
	return Boolean(SENTRY_DSN);
}

/** The current effective gate. */
export function isCrashReportingEnabled(): boolean {
	return enabled;
}

// --- PII scrub --------------------------------------------------------------

// Match an absolute home-style path prefix so it can be replaced with `~`. Covers
// POSIX (/home/<user>, /Users/<user>) and Windows (C:\Users\<user>). Top-level
// regex (not built in a loop) per the repo perf rule.
const HOME_PATH_RE = /(?:[A-Za-z]:\\Users\\[^\\/]+|\/(?:home|Users)\/[^/]+)/g;

function scrubPaths(input: string): string {
	return input.replace(HOME_PATH_RE, "~");
}

/**
 * Strip identifying / content-adjacent fields from an event before it leaves the
 * machine. The DEFAULT integrations are the real leak vector, so this is belt and
 * braces on top of disabling breadcrumbs + replay.
 */
function scrubEvent(event: SentryErrorEvent): SentryErrorEvent | null {
	// Honor the live opt-out gate: when off, drop the event entirely.
	if (!enabled) {
		return null;
	}
	// Remove request data (URLs/headers/cookies), any user identity, and the
	// machine hostname Sentry captures by default.
	event.request = undefined;
	event.user = undefined;
	event.server_name = undefined;
	// Scrub home-dir paths out of exception messages + frame paths.
	for (const ex of event.exception?.values ?? []) {
		if (ex.value) {
			ex.value = scrubPaths(ex.value);
		}
		for (const frame of ex.stacktrace?.frames ?? []) {
			if (frame.filename) {
				frame.filename = scrubPaths(frame.filename);
			}
			if (frame.abs_path) {
				frame.abs_path = scrubPaths(frame.abs_path);
			}
		}
	}
	return event;
}

// --- Init -------------------------------------------------------------------

function sendReport(mod: SentryModule, report: PendingReport): string | null {
	if (report.kind === "error") {
		return mod.captureException(report.error, {
			extra: report.context?.extra,
			tags: report.context?.tags,
		});
	}
	mod.captureMessage(report.message, {
		extra: report.context?.extra,
		level: "info",
		tags: report.context?.tags,
	});
	return null;
}

function loadSentry(dsn: string): Promise<SentryModule | null> {
	loading ??= import("@sentry/react")
		.then((mod) => {
			mod.init({
				dsn,
				release: import.meta.env.VITE_APP_VERSION ?? undefined,
				// No PII, no performance tracing, no profiling, no session replay.
				sendDefaultPii: false,
				tracesSampleRate: 0,
				// Drop ALL breadcrumbs. For a crash tier the stack trace is the value;
				// breadcrumbs are pure leak surface. @sentry/browser's default `breadcrumbs`
				// integration has dom + history on, emitting `ui.click` / `ui.input` (which
				// capture the clicked element's text / aria-label — i.e. conversation titles
				// or rendered agent content), plus `console` / `fetch` / `xhr` / `navigation`
				// (content + URLs). Returning null for every breadcrumb is the clean,
				// strictly-safer answer and honors the AC's "never include agent content".
				beforeBreadcrumb() {
					return null;
				},
				// ...and since every crumb is dropped, do not install the integration
				// that records them (it wraps console, fetch, xhr and DOM listeners).
				integrations: (defaults) =>
					defaults.filter((integration) => integration.name !== "Breadcrumbs"),
				beforeSend: scrubEvent,
				initialScope: {
					// The only identifier: the random install id (NOT the account).
					tags: { install_id: safeInstallId() },
				},
			});
			// The opt-out is honored from the first event: scrubEvent (beforeSend) returns
			// null whenever `enabled` is false, so no separate client opt-out is needed
			// (@sentry/react has no top-level opt_out anyway).
			// Sentry's GlobalHandlers now cover window errors; keeping ours would
			// report each one twice.
			stopEarlyCapture?.();
			sdk = mod;
			for (const report of pending.splice(0)) {
				if (!enabled) {
					break;
				}
				try {
					sendReport(mod, report);
				} catch {
					// Never let a crash-report failure surface to the user.
				}
			}
			return mod;
		})
		.catch(() => {
			stopEarlyCapture?.();
			return null;
		});
	return loading;
}

/** Queue uncaught window errors and rejections raised before the SDK has
 *  loaded. reportError applies the gate and the queue cap; the tag values are
 *  fixed enums, never content. */
function captureEarlyWindowErrors(): void {
	if (typeof window === "undefined") {
		return;
	}
	const onError = (event: ErrorEvent) => {
		reportError(event.error ?? event.message, {
			tags: { early_capture: "error" },
		});
	};
	const onRejection = (event: PromiseRejectionEvent) => {
		reportError(event.reason, {
			tags: { early_capture: "unhandledrejection" },
		});
	};
	window.addEventListener("error", onError);
	window.addEventListener("unhandledrejection", onRejection);
	stopEarlyCapture = () => {
		window.removeEventListener("error", onError);
		window.removeEventListener("unhandledrejection", onRejection);
		stopEarlyCapture = null;
	};
}

/**
 * Initialize Sentry once. Safe to call when no DSN is set (graceful no-op). Uses
 * the random, account-unlinked install id; never calls setUser. Disables every
 * content-carrying default (breadcrumbs/replay/tracing) and respects the opt-out
 * from the very first event. The SDK loads when the main thread is idle.
 */
export function initCrashReporting(): void {
	if (initialized || !SENTRY_DSN) {
		return;
	}
	initialized = true;
	const dsn = SENTRY_DSN;
	captureEarlyWindowErrors();
	runWhenIdle(() => {
		loadSentry(dsn).catch(() => undefined);
	});
}

/** Resolves once the SDK is live: false when unconfigured, not initialised, or
 *  when it failed to load. Loads it now instead of waiting for idle time. */
export async function crashReportingReady(): Promise<boolean> {
	if (!(initialized && SENTRY_DSN)) {
		return false;
	}
	return (await loadSentry(SENTRY_DSN)) !== null;
}

function safeInstallId(): string {
	try {
		return getInstallId();
	} catch {
		return "unknown";
	}
}

/**
 * Flip the live gate from the Privacy settings toggle. Flips the in-memory flag and
 * mirrors it to localStorage for the next reload. beforeSend reads `enabled` on
 * every event, so toggling off stops egress immediately (and drops the reports
 * still waiting for the SDK).
 */
export function setCrashReportingEnabled(next: boolean): void {
	enabled = next;
	writeEnabledMirror(next);
	if (!next) {
		pending.length = 0;
	}
}

/**
 * Structured, non-content context attached to a crash report.
 *
 * Tags are indexed by Sentry (searchable/aggregatable), so they carry the small
 * enumerable facts — which retry attempt this was, how the episode ended. `extra`
 * carries the counts. NOTHING here may be user content: callers pass attempt
 * numbers and outcomes, never a route title, prompt, or conversation id. The
 * beforeSend scrub in scrubEvent() does not reach these fields, so the discipline
 * has to live at the call site.
 */
export interface CrashContext {
	extra?: Record<string, number | string | boolean>;
	tags?: Record<string, string>;
}

/**
 * Manually report a caught error (e.g. from an error boundary). A no-op unless a
 * DSN is configured, the client is initialized, and the gate is on. Returns the
 * local event receipt when queued, or null when unavailable (including while the
 * SDK is still loading; the report is then sent once it has). This is not a
 * delivery acknowledgement.
 */
export function reportError(
	error: unknown,
	context?: CrashContext
): string | null {
	if (!(initialized && enabled && SENTRY_DSN)) {
		return null;
	}
	if (!sdk) {
		// Delivered once the SDK loads; there is no receipt yet.
		if (pending.length < MAX_PENDING_REPORTS) {
			pending.push({ context, error, kind: "error" });
		}
		return null;
	}
	try {
		return sendReport(sdk, { context, error, kind: "error" });
	} catch {
		// Never let a crash-report failure surface to the user.
		return null;
	}
}

/**
 * Report a crash-lifecycle event that is NOT itself an exception — specifically
 * "the boundary auto-recovered". This exists so silent self-healing stays visible:
 * a render crash that a remount papered over is still a real bug, and without this
 * message the only trace in Sentry would be the original exception with no signal
 * that the user was (or wasn't) rescued.
 *
 * Sent at `info` level so it never pages, but is still searchable by tag.
 */
export function reportCrashEvent(
	message: string,
	context?: CrashContext
): void {
	if (!(enabled && SENTRY_DSN)) {
		return;
	}
	if (!sdk) {
		// Before initCrashReporting() there is no client to send through.
		if (initialized && pending.length < MAX_PENDING_REPORTS) {
			pending.push({ context, kind: "event", message });
		}
		return;
	}
	try {
		sendReport(sdk, { context, kind: "event", message });
	} catch {
		// Never let a crash-report failure surface to the user.
	}
}
