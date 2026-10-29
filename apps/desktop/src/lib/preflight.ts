import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
// apps/desktop/src/lib/preflight.ts
//
// The preflight/health page's diagnostics bundle + issue reporter. Assembles one
// human-readable snapshot of the components (Core, Gateway, Desktop) plus
// versions, sidecars, and the recent console buffer, then either copies it to the
// clipboard or — respecting the EXISTING privacy toggles — ships it via the wired
// crash (Sentry) tier and records a content-free analytics signal. Nothing new is
// networked here: `reportError`/`track` are the same gated sinks the rest of the
// app uses, so "no telemetry by default" still holds.

import { getVersion } from "@tauri-apps/api/app";
import { track } from "@/src/lib/analytics.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { fetchHealth, fetchSystemStatus } from "@/src/lib/api/system.ts";
import { getVersionInfo } from "@/src/lib/api/update.ts";
import { getConsoleBufferText } from "@/src/lib/console-buffer.ts";
import {
	crashReportingReady,
	isCrashReportingConfigured,
	isCrashReportingEnabled,
	reportError,
} from "@/src/lib/crash.ts";
import { getDevMetricsText } from "@/src/lib/dev-metrics.ts";
import { fetchCatalog } from "@/src/lib/services-api.ts";

/** Run a labelled probe, degrading a failure to a note instead of throwing. */
async function section<T>(
	label: string,
	fn: () => Promise<T>
): Promise<string> {
	try {
		const value = await fn();
		const body = isNativeText(value) ? value : JSON.stringify(value, null, 2);
		return `## ${label}\n${body}`;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return `## ${label}\n(unavailable: ${reason})`;
	}
}

/**
 * Build the full diagnostics text for the active node. Every probe fails soft, so
 * this resolves even when Core is down (each section reports "unavailable").
 */
export async function collectDiagnostics(
	target: ApiTarget,
	options: { includeConsole?: boolean } = {}
): Promise<string> {
	const desktopVersion = await getVersion().catch(() => "unknown");
	const sections = await Promise.all([
		Promise.resolve(
			`## Desktop\nversion ${desktopVersion}\nplatform ${navigator.platform}\nuserAgent ${navigator.userAgent}`
		),
		section("Health (/api/health)", () => fetchHealth(target)),
		section("Versions (/api/version)", () => getVersionInfo(target)),
		section("System status (/api/system/status)", () =>
			fetchSystemStatus(target)
		),
		section("Sidecars (/api/catalog)", async () => {
			const items = await fetchCatalog(
				target.url,
				target.token,
				undefined,
				target.userJwt
			);
			return items
				.map(
					(item) =>
						`${item.name}: ${item.installState} (installed ${item.installedVersion ?? "-"} / latest ${item.latestVersion ?? "-"})`
				)
				.join("\n");
		}),
	]);
	// Console capture can contain user prompts, tool results, and provider output.
	// It remains available for explicit local copy, but issue reports must not send
	// it to the crash sink as part of an otherwise consented diagnostics bundle.
	const consoleText =
		options.includeConsole === false ? "" : getConsoleBufferText();
	// Timings only exist when the same gate that fills the console buffer is on,
	// so an empty string here means "not recording", not "everything was fast".
	// Omit the section rather than print a table of zeroes that reads as a result.
	const metricsText = getDevMetricsText();
	return [
		`# Ryu diagnostics — ${new Date().toISOString()}`,
		`node ${target.url}`,
		...sections,
		...(metricsText ? [`## Performance\n${metricsText}`] : []),
		...(options.includeConsole === false
			? []
			: [
					`## Recent console\n${consoleText || "(empty — console capture is DEV-only)"}`,
				]),
	].join("\n\n");
}

/** Collect diagnostics and copy them to the clipboard. Returns the text. */
export async function copyDiagnostics(target: ApiTarget): Promise<string> {
	const text = await collectDiagnostics(target);
	await navigator.clipboard.writeText(text);
	return text;
}

/**
 * Report the diagnostics bundle through the already-wired, privacy-gated sinks:
 * the crash tier (Sentry, PII-scrubbed, gated by `crash-reports-enabled`) carries
 * the bundle; a content-free analytics signal (gated by `product-analytics-enabled`)
 * records that a report was queued. A receipt confirms local queueing only,
 * not delivery to the reporting service. Unavailable reporting rejects visibly.
 */
export async function reportIssue(target: ApiTarget): Promise<void> {
	if (!isCrashReportingEnabled()) {
		throw new Error(
			"Crash reporting is off. Enable it in Settings, Privacy, or copy diagnostics to share manually."
		);
	}
	if (!isCrashReportingConfigured()) {
		throw new Error(
			"Crash reporting is unavailable in this build. Copy diagnostics to share manually."
		);
	}
	// The SDK loads at idle after startup; a report made before then waits for
	// it, so the receipt below is real (null when it could not load).
	await crashReportingReady();
	const text = await collectDiagnostics(target, { includeConsole: false });
	const eventId = reportError(new Error(`[preflight-report]\n${text}`));
	if (!eventId) {
		throw new Error(
			"The issue report could not be queued. Copy diagnostics to share manually."
		);
	}
	track({ event: "error_shown", code: "preflight_report" });
}
