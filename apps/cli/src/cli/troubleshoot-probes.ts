// Options, Core probes, and formatting helpers shared by the troubleshoot checks.

import { ApiError, type ApiTarget } from "@ryuhq/core-client/client";
import {
	redactDiagnosticText,
	type TroubleshootCheck,
} from "@ryuhq/core-client/troubleshoot";
import { z } from "zod";
import {
	CORE_TIMEOUT_MS,
	GIB,
	INSTALL_PS1,
	INSTALL_SH,
	MAX_LOG_LINE_CHARS,
	MAX_LOG_LINES,
} from "./troubleshoot-constants.ts";
import type { TroubleshootHost } from "./troubleshoot-host.ts";
import type { CliContext } from "./types.ts";

// ── Options ──────────────────────────────────────────────────────────────────

export interface TroubleshootOptions {
	description: string;
	dryRun: boolean;
	fix: boolean;
	json: boolean;
	offline: boolean;
	open: boolean;
}

export function parseOptions(ctx: CliContext): TroubleshootOptions {
	return {
		description: ctx.args.join(" ").trim(),
		dryRun: ctx.flags.dryRun,
		fix: ctx.flags.fix,
		json: ctx.flags.json,
		offline: ctx.rawArgs.includes("--offline"),
		open: ctx.rawArgs.includes("--open"),
	};
}

// ── Core probes ──────────────────────────────────────────────────────────────

export const healthSchema = z.object({
	channel: z.string().optional(),
	gatewayVersion: z.string().nullish(),
	requiredRuntimeReady: z.boolean().optional(),
	status: z.string().optional(),
	version: z.string().optional(),
});
export const statusSchema = z.object({
	engine: z
		.object({ active: z.string().nullish(), running: z.boolean().optional() })
		.optional(),
	gateway: z.object({ reachable: z.boolean().optional() }).optional(),
});
export const sidecarSchema = z.object({
	missing_binaries: z
		.array(
			z.object({
				expected_asset: z.string().optional(),
				name: z.string(),
			})
		)
		.optional(),
});
export const doctorCountsSchema = z.object({
	counts: z.object({
		errors: z.number().catch(0),
		warnings: z.number().catch(0),
	}),
	findings: z
		.array(z.object({ canAutoFix: z.boolean().optional() }))
		.catch(() => []),
});
export const doctorResponseSchema = z.object({
	appliedFixes: z.array(z.unknown()).catch(() => []),
	plannedFixes: z.array(z.unknown()).catch(() => []),
	report: doctorCountsSchema.optional(),
});
export const systemInfoSchema = z.object({
	gpu_name: z.string().nullish(),
	vram_human: z.string().optional(),
});
export const githubReleaseSchema = z.object({
	html_url: z.string().optional(),
	tag_name: z.string(),
});

export type CoreFailure = "auth" | "timeout" | "unreachable" | "http";

export interface CoreProbe<T> {
	failure: CoreFailure | null;
	message: string;
	value: T | null;
}

export function classifyCoreError(error: unknown): {
	failure: CoreFailure;
	message: string;
} {
	if (error instanceof ApiError) {
		return error.status === 401 || error.status === 403
			? { failure: "auth", message: `HTTP ${error.status}` }
			: { failure: "http", message: error.message };
	}
	const message = error instanceof Error ? error.message : String(error);
	const name = error instanceof Error ? error.name : "";
	if (name === "TimeoutError" || name === "AbortError") {
		return { failure: "timeout", message: "timed out" };
	}
	return { failure: "unreachable", message };
}

export async function probeCore<T>(
	ctx: CliContext,
	target: ApiTarget,
	path: string,
	schema: z.ZodType<T>
): Promise<CoreProbe<T>> {
	if (!ctx.api.call) {
		return { failure: "unreachable", message: "no Core client", value: null };
	}
	try {
		const raw = await ctx.api.call(target, path, {
			method: "GET",
			signal: AbortSignal.timeout(CORE_TIMEOUT_MS),
		});
		const parsed = schema.safeParse(raw);
		return parsed.success
			? { failure: null, message: "", value: parsed.data }
			: { failure: "http", message: "unexpected response", value: null };
	} catch (error) {
		return { ...classifyCoreError(error), value: null };
	}
}

// ── Formatting helpers ───────────────────────────────────────────────────────

export function gib(bytes: number): string {
	return `${(bytes / GIB).toFixed(1)} GB`;
}

export function majorMinor(version: string): string {
	return version.replace(/^v/, "").split(".").slice(0, 2).join(".");
}

export function portOf(url: string): number | null {
	try {
		const parsed = new URL(url);
		if (parsed.port) {
			return Number(parsed.port);
		}
		return parsed.protocol === "https:" ? 443 : 80;
	} catch {
		return null;
	}
}

export function hostOf(url: string): string {
	try {
		return new URL(url).hostname.replace(/^\[|\]$/g, "");
	} catch {
		return "127.0.0.1";
	}
}

export function tokenFix(host: TroubleshootHost): string {
	return `Set RYU_CORE_TOKEN to the node's token, or pick a saved node with \`${host.commandName} node use <name>\`.`;
}

export function installCommand(host: TroubleshootHost): string {
	return host.platform === "win32" ? INSTALL_PS1 : INSTALL_SH;
}

export function portOwnerHint(host: TroubleshootHost, port: number): string {
	return host.platform === "win32"
		? `netstat -ano | findstr :${port}`
		: `lsof -nP -iTCP:${port} -sTCP:LISTEN`;
}

/** Terminal colour codes (`ESC[…m`) that tracing writes into log files. */
export const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");
export const ERROR_LINE = /\b(ERROR|FATAL|CRITICAL)\b|panicked at|\bpanic:/;

/** The newest error lines across the given log tails, redacted. */
export function extractLogErrors(
	tails: readonly string[],
	homeDir: string
): string[] {
	const lines: string[] = [];
	for (const tail of tails) {
		for (const raw of tail.split(/\r?\n/)) {
			const line = raw.replace(ANSI, "").trim();
			if (line && ERROR_LINE.test(line)) {
				lines.push(
					redactDiagnosticText(
						line.length > MAX_LOG_LINE_CHARS
							? `${line.slice(0, MAX_LOG_LINE_CHARS)}…`
							: line,
						{ homeDir }
					)
				);
			}
		}
	}
	return lines.slice(-MAX_LOG_LINES);
}

// ── The run ──────────────────────────────────────────────────────────────────

export interface RunState {
	checks: TroubleshootCheck[];
	fixes: string[];
	machine: [string, string][];
}

export interface CoreSnapshot {
	health: z.infer<typeof healthSchema> | null;
	reachable: boolean;
}

export function add(state: RunState, check: TroubleshootCheck): void {
	state.checks.push(check);
}
