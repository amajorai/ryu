import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import { type ApiTarget, request } from "@ryuhq/core-client/client";
import { fetchSidecarStatus } from "@ryuhq/core-client/system";
import { z } from "zod";

const setupListSchema = z.object({
	installed: z.array(z.string().nullable().catch(null)).catch([]),
});
const setupStateSchema = z.object({
	state: z.string().optional().catch(undefined),
});
const setupStatusSchema = z.object({
	states: z
		.record(z.string(), setupStateSchema.nullable().catch(null))
		.catch({}),
});

export interface ServicesSnapshot {
	installed: Set<string>;
	installStates: Record<string, string>;
	offline: boolean;
	running: Set<string>;
}

/** Independent probes share one view lifetime and retain partial failure semantics. */
export async function loadServices(
	target: ApiTarget,
	signal?: AbortSignal
): Promise<ServicesSnapshot> {
	signal?.throwIfAborted();
	const [runningResult, installedResult, statesResult] =
		await Promise.allSettled([
			fetchSidecarStatus(target, signal),
			request(
				target,
				"/api/setup/list",
				{ signal },
				appResponseValueSchema
			).then((value) => setupListSchema.parse(value)),
			request(
				target,
				"/api/setup/status",
				{ signal },
				appResponseValueSchema
			).then((value) => setupStatusSchema.parse(value)),
		]);
	signal?.throwIfAborted();
	const running = new Set<string>();
	if (runningResult.status === "fulfilled") {
		for (const [name, isRunning] of Object.entries(runningResult.value)) {
			if (isRunning) {
				running.add(name);
			}
		}
	}
	const listed =
		installedResult.status === "fulfilled"
			? installedResult.value?.installed
			: undefined;
	const installed = new Set(
		Array.isArray(listed)
			? listed.flatMap((name) => (name === null ? [] : [name]))
			: []
	);
	const installStates: Record<string, string> = {};
	if (statesResult.status === "fulfilled") {
		for (const [name, value] of Object.entries(
			statesResult.value?.states ?? {}
		)) {
			if (value?.state) {
				installStates[name] = value.state;
			}
		}
	}
	return {
		running,
		installed,
		installStates,
		offline: runningResult.status === "rejected" && installed.size === 0,
	};
}
