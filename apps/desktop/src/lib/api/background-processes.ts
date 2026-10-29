import { z } from "zod";
import { type ApiTarget, request } from "./client.ts";

const processesResponseSchema = z.looseObject({
	command: z.string(),
	cwd: z.string(),
	description: z.union([z.null(), z.string()]).optional(),
	elapsed_ms: z.number(),
	exit_code: z.union([z.null(), z.number()]).optional(),
	exit_signal: z.union([z.null(), z.string()]).optional(),
	kind: z.string(),
	label: z.union([z.null(), z.string()]).optional(),
	pid: z.union([z.null(), z.number()]).optional(),
	process_id: z.string(),
	producer: z.string(),
	running: z.boolean(),
	shell_id: z.union([z.null(), z.string()]).optional(),
	started_at: z.number(),
});
const listBackgroundProcessesResponseSchema = z.looseObject({
	processes: z.array(processesResponseSchema).optional(),
});
const requestStopBackgroundProcessResponseSchema = z.looseObject({
	ok: z.boolean(),
	process_id: z.string(),
	requested: z.boolean(),
});

export interface BackgroundProcess {
	command: string;
	cwd: string;
	description?: string | null;
	elapsed_ms: number;
	exit_code?: number | null;
	exit_signal?: string | null;
	kind: string;
	label?: string | null;
	pid?: number | null;
	process_id: string;
	producer: string;
	running: boolean;
	shell_id?: string | null;
	started_at: number;
}

interface BackgroundProcessStopResponse {
	ok: boolean;
	process_id: string;
	requested: boolean;
}

export async function listBackgroundProcesses(
	target: ApiTarget,
	runningOnly = true
): Promise<BackgroundProcess[]> {
	const response = await request(
		target,
		`/api/background/processes?running_only=${runningOnly ? "true" : "false"}`,
		undefined,
		listBackgroundProcessesResponseSchema
	);
	return Array.isArray(response.processes) ? response.processes : [];
}

export function requestStopBackgroundProcess(
	target: ApiTarget,
	processId: string
): Promise<BackgroundProcessStopResponse> {
	return request(
		target,
		`/api/background/processes/${encodeURIComponent(processId)}/stop`,
		{ method: "POST", body: {} },
		requestStopBackgroundProcessResponseSchema
	);
}
