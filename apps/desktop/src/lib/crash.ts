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

import {
	captureException,
	type ErrorEvent as SentryErrorEvent,
	init as sentryInit,
} from "@sentry/react";
import { getInstallId } from "./analytics.ts";

// --- Config (swappable, env-driven) -----------------------------------------

const SENTRY_DSN = import.meta.env.VITE_SENTRY_DSN as string | undefined;

// localStorage key mirroring the canonical kebab pref name, under the `ryu:`
// namespace — synchronous seed before the async Core read resolves.
const ENABLED_MIRROR_KEY = "ryu:crash-reports-enabled";

// --- Runtime state + gate ---------------------------------------------------

let initialized = false;
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

/**
 * Initialize Sentry once. Safe to call when no DSN is set (graceful no-op). Uses
 * the random, account-unlinked install id; never calls setUser. Disables every
 * content-carrying default (breadcrumbs/replay/tracing) and respects the opt-out
 * from the very first event.
 */
export function initCrashReporting(): void {
	if (initialized || !SENTRY_DSN) {
		return;
	}
	initialized = true;
	sentryInit({
		dsn: SENTRY_DSN,
		release:
			(import.meta.env.VITE_APP_VERSION as string | undefined) ?? undefined,
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
		beforeSend: scrubEvent,
		initialScope: {
			// The only identifier: the random install id (NOT the account).
			tags: { install_id: safeInstallId() },
		},
	});
	// The opt-out is honored from the first event: scrubEvent (beforeSend) returns
	// null whenever `enabled` is false, so no separate client opt-out is needed
	// (@sentry/react has no top-level opt_out anyway).
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
 * every event, so toggling off stops egress immediately.
 */
export function setCrashReportingEnabled(next: boolean): void {
	enabled = next;
	writeEnabledMirror(next);
}

/**
 * Manually report a caught error (e.g. from an error boundary). A no-op unless a
 * DSN is configured AND the gate is on.
 */
export function reportError(error: unknown): void {
	if (!(enabled && SENTRY_DSN)) {
		return;
	}
	try {
		captureException(error);
	} catch {
		// Never let a crash-report failure surface to the user.
	}
}
