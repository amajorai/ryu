// apps/desktop/src/lib/api/shadow-computer-use.ts

import { z } from "zod";
import { shadowFetch } from "./shadow-fetch.ts";

export type ComputerUsePlanner = "native" | "jev" | "laya" | "local";

export interface ShadowComputerUseConfig {
	applied: boolean;
	jevApiKeyConfigured: boolean;
	jevModel: string;
	jevUrl: string;
	layaUrl: string;
	localModelId: string;
	localPluginId: string;
	maxSteps: number;
	planner: ComputerUsePlanner;
}

export interface ShadowComputerUseConfigUpdate
	extends Omit<ShadowComputerUseConfig, "applied" | "jevApiKeyConfigured"> {}

export interface ShadowComputerUseStep {
	operation: string;
	outcome: string;
	target: string | null;
}

export interface ShadowComputerUseResult {
	message: string;
	planner: ComputerUsePlanner;
	status: "completed" | "blocked" | "step_limit";
	steps: ShadowComputerUseStep[];
}

const computerUsePlannerSchema = z.enum(["native", "jev", "laya", "local"]);
const computerUseConfigSchema = z.object({
	applied: z.boolean(),
	planner: computerUsePlannerSchema,
	jevUrl: z.string(),
	jevModel: z.string(),
	layaUrl: z.string(),
	maxSteps: z.number(),
	jevApiKeyConfigured: z.boolean(),
	localPluginId: z.string().catch(""),
	localModelId: z.string().catch(""),
});

/** Validate a computer-use settings payload; `null` when it is malformed. */
function parseComputerUseConfig(
	value: unknown
): ShadowComputerUseConfig | null {
	const parsed = computerUseConfigSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

const shadowErrorSchema = z.object({
	error: z.union([
		z.string().refine((value) => Boolean(value.trim())),
		z
			.object({ message: z.string().refine((value) => Boolean(value.trim())) })
			.transform((value) => value.message),
	]),
});
const computerUseResultSchema = z.object({
	planner: computerUsePlannerSchema,
	status: z.enum(["completed", "blocked", "step_limit"]),
	message: z.string(),
	steps: z.array(z.json()),
});
const computerUseStepSchema = z.object({
	operation: z.string(),
	outcome: z.string(),
	target: z.json().optional(),
});

async function shadowError(
	response: Response,
	fallback: string
): Promise<Error> {
	try {
		const parsed = shadowErrorSchema.safeParse(await response.json());
		if (parsed.success) {
			return new Error(parsed.data.error);
		}
	} catch {
		// Use the HTTP status below when the sidecar returned a non-JSON error.
	}
	return new Error(`${fallback} (${response.status})`);
}

/** Strict settings reader: preserve failure rather than substituting defaults. */
export async function getShadowComputerUseConfigStrict(): Promise<ShadowComputerUseConfig> {
	const response = await shadowFetch("/computer-use/config", {
		headers: { Accept: "application/json" },
	});
	if (!response.ok) {
		throw await shadowError(
			response,
			"Could not load Shadow computer-use settings"
		);
	}
	const parsed = computerUseConfigSchema.safeParse(await response.json());
	if (!parsed.success) {
		throw new Error("Core returned invalid Shadow computer-use settings");
	}
	return parsed.data;
}

export async function getShadowComputerUseConfig(): Promise<ShadowComputerUseConfig | null> {
	try {
		const response = await shadowFetch("/computer-use/config", {
			headers: { Accept: "application/json" },
		});
		if (!response.ok) {
			return null;
		}
		return parseComputerUseConfig(await response.json());
	} catch {
		return null;
	}
}

export async function setShadowComputerUseConfig(
	update: ShadowComputerUseConfigUpdate
): Promise<ShadowComputerUseConfig> {
	const response = await shadowFetch("/computer-use/config", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify(update),
	});
	if (!response.ok) {
		throw await shadowError(
			response,
			"Could not save Shadow computer-use settings"
		);
	}
	const parsed = computerUseConfigSchema.safeParse(await response.json());
	if (!parsed.success) {
		throw new Error("Shadow returned invalid computer-use settings");
	}
	return parsed.data;
}

export async function runShadowComputerUse(
	goal: string
): Promise<ShadowComputerUseResult> {
	const response = await shadowFetch("/computer-use/run", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify({ goal }),
	});
	if (!response.ok) {
		throw await shadowError(response, "Shadow computer use failed");
	}
	const parsed = computerUseResultSchema.safeParse(await response.json());
	if (!parsed.success) {
		throw new Error("Shadow returned an invalid computer-use result");
	}
	const steps = parsed.data.steps.map((item) => {
		const step = computerUseStepSchema.safeParse(item);
		if (!step.success) {
			throw new Error("Shadow returned an invalid computer-use step");
		}
		const target = z.string().nullable().safeParse(step.data.target);
		if (!target.success) {
			throw new Error("Shadow returned an invalid computer-use target");
		}
		return { ...step.data, target: target.data };
	});
	return { ...parsed.data, steps };
}
