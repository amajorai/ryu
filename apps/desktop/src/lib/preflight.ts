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
import { reportError } from "@/src/lib/crash.ts";
import { fetchCatalog } from "@/src/lib/services-api.ts";

/** Run a labelled probe, degrading a failure to a note instead of throwing. */
async function section<T>(
	label: string,
	fn: () => Promise<T>
): Promise<string> {
	try {
		const value = await fn();
		const body =
			typeof value === "string" ? value : JSON.stringify(value, null, 2);
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
export async function collectDiagnostics(target: ApiTarget): Promise<string> {
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
			const items = await fetchCatalog(target.url, target.token);
			return items
				.map(
					(item) =>
						`${item.name}: ${item.installState} (installed ${item.installedVersion ?? "-"} / latest ${item.latestVersion ?? "-"})`
				)
				.join("\n");
		}),
	]);
	const consoleText = getConsoleBufferText();
	return [
		`# Ryu diagnostics — ${new Date().toISOString()}`,
		`node ${target.url}`,
		...sections,
		`## Recent console\n${consoleText || "(empty — console capture is DEV-only)"}`,
	].join("\n\n");
}

/** Collect diagnostics and copy them to the clipboard. Returns the text. */
export async function copyDiagnostics(target: ApiTarget): Promise<string> {
	const text = await collectDiagnostics(target);
	await navigator.clipboard.writeText(text).catch(() => undefined);
	return text;
}

/**
 * Report the diagnostics bundle through the already-wired, privacy-gated sinks:
 * the crash tier (Sentry, PII-scrubbed, gated by `crash-reports-enabled`) carries
 * the bundle; a content-free analytics signal (gated by `product-analytics-enabled`)
 * records that a report happened. Both are no-ops when their consent is off or no
 * DSN/key is configured.
 */
export async function reportIssue(target: ApiTarget): Promise<void> {
	const text = await collectDiagnostics(target);
	reportError(new Error(`[preflight-report]\n${text}`));
	track({ event: "error_shown", code: "preflight_report" });
}
