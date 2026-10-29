// apps/desktop/src/lib/api/warmup.ts
//
// The shell side of the `warmup:crud` bridge capability, for the `@ryu/warmup`
// companion. Each verb calls Core's app host bridge (`POST /api/plugins/:id/host`)
// with the `warmup.*` kernel operation of the same name, so Core checks the app's
// approved grant, runs the scheduler's own `agent.view` / `agent.edit` checks for
// the signed-in user, and scopes every job to the calling app. The sandboxed frame
// never fetches anything itself, and the owner is never a value it supplies.
//
// The replies reach the host as untyped JSON, so each one is zod-checked here
// before it is forwarded to the frame.

import type { WarmupJobInput, WarmupRunNowPayload } from "@ryu/app-host/rpc";
import { z } from "zod";
import type { ApiTarget } from "./client.ts";
import { pluginHostInvoke } from "./plugins.ts";
import { scheduledRunResponseSchema } from "./schedule-wire-contracts.ts";
import { type ScheduledJob, toScheduledJobs } from "./schedules.ts";

/** One model an agent advertises (the ACP `availableModels` entry). */
export interface WarmupModel {
	description: string | null;
	modelId: string;
	name: string;
}

/** One rolling window an agent reports. */
export interface WarmupWindow {
	label: string;
	/** The model this window limits; `null` = account-wide. */
	model: string | null;
	resetsAt: string | null;
	usedPercent: number;
	windowSeconds: number | null;
}

/** A subscription agent, with everything needed to schedule a warmup for it. */
export interface WarmupAgent {
	available: boolean;
	id: string;
	models: WarmupModel[];
	name: string;
	plan: string | null;
	reason: string | null;
	windows: WarmupWindow[];
}

/** One saved login of a provider pool, with its own live usage windows. */
export interface WarmupAccount {
	available: boolean;
	id: string;
	label: string;
	/** Core blocked this login until the user signs in again. */
	needsReauth: boolean;
	plan: string | null;
	reason: string | null;
	windows: WarmupWindow[];
}

/** A subscription provider whose saved accounts can each be pinged. */
export interface WarmupProvider {
	accounts: WarmupAccount[];
	id: string;
	models: WarmupModel[];
	name: string;
}

/** What {@link detectWarmupAgents} reports. */
export interface WarmupDetection {
	agents: WarmupAgent[];
	providers: WarmupProvider[];
	tz: string;
}

const warmupModelWireSchema = z.object({
	description: z.string().nullable(),
	modelId: z.string(),
	name: z.string(),
});
// `model` is absent from older Core; absent means account-wide.
const warmupWindowWireSchema = z.object({
	label: z.string(),
	model: z
		.string()
		.nullable()
		.optional()
		.transform((model) => model ?? null),
	resetsAt: z.string().nullable(),
	usedPercent: z.number(),
	windowSeconds: z.number().nullable(),
});

/** Runtime shape of the `warmup.detect` kernel operation's reply. */
export const warmupDetectionWireSchema = z.object({
	agents: z.array(
		z.object({
			available: z.boolean(),
			id: z.string(),
			models: z.array(warmupModelWireSchema),
			name: z.string(),
			plan: z.string().nullable(),
			reason: z.string().nullable(),
			windows: z.array(warmupWindowWireSchema),
		})
	),
	// Older Core reports agents only.
	providers: z
		.array(
			z.object({
				accounts: z.array(
					z.object({
						available: z.boolean(),
						id: z.string(),
						label: z.string(),
						needsReauth: z.boolean(),
						plan: z.string().nullable(),
						reason: z.string().nullable(),
						windows: z.array(warmupWindowWireSchema),
					})
				),
				id: z.string(),
				models: z.array(warmupModelWireSchema),
				name: z.string(),
			})
		)
		.optional()
		.transform((providers) => providers ?? []),
	tz: z.string(),
});

/**
 * The desktop's IANA zone. The times the user picks are wall-clock times where
 * they are sitting, which is this machine, not necessarily the node. `Intl`
 * returns exactly the name Core's `chrono-tz` parses; `fallback` (the node's own
 * zone from Core) is used when it is unavailable.
 */
function desktopTimeZone(fallback: string): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || fallback;
	} catch {
		return fallback;
	}
}

/** Check a `warmup.detect` reply; the zone is the desktop's (see above). */
export function toWarmupDetection(value: unknown): WarmupDetection {
	const detection = warmupDetectionWireSchema.parse(value);
	return { ...detection, tz: desktopTimeZone(detection.tz) };
}

/** Check a `warmup.runNow` reply. A job that ran and failed is a 200 with
 *  `success: false`; it surfaces as an error carrying Core's message. */
export function assertWarmupRunSucceeded(value: unknown): void {
	const run = scheduledRunResponseSchema.parse(value);
	if (run.success === false) {
		throw new Error(run.error ?? "The ping failed to run.");
	}
}

/** Check a `warmup.apply` reply (`{ jobs }`: what Core created). */
export function toAppliedWarmupJobs(value: unknown): ScheduledJob[] {
	return toScheduledJobs(value);
}

/** Subscription agents with their live usage windows and advertised models. */
export async function detectWarmupAgents(
	target: ApiTarget,
	pluginId: string
): Promise<WarmupDetection> {
	return toWarmupDetection(
		await pluginHostInvoke(target, pluginId, "warmup.detect", {})
	);
}

/** The calling app's scheduled jobs (Core narrows the list to the owner). */
export async function listWarmupJobs(
	target: ApiTarget,
	pluginId: string
): Promise<ScheduledJob[]> {
	return toScheduledJobs(
		await pluginHostInvoke(target, pluginId, "warmup.list", {})
	);
}

/**
 * Replace the calling app's scheduled jobs with `jobs`. Core validates every
 * job before deleting anything, so a bad cron or zone leaves the existing plan
 * in place and surfaces Core's own message.
 */
export async function applyWarmupJobs(
	target: ApiTarget,
	pluginId: string,
	jobs: WarmupJobInput[]
): Promise<void> {
	toAppliedWarmupJobs(
		await pluginHostInvoke(target, pluginId, "warmup.apply", { jobs })
	);
}

/** Run one of the calling app's pings now; Core refuses a job it does not own. */
export async function runWarmupJobNow(
	target: ApiTarget,
	pluginId: string,
	{ jobId }: WarmupRunNowPayload
): Promise<void> {
	assertWarmupRunSucceeded(
		await pluginHostInvoke(target, pluginId, "warmup.runNow", { jobId })
	);
}
