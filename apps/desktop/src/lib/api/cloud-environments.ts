import {
	type CloudEnvironment,
	type CloudEnvironmentState,
	type CloudEnvironmentWrite,
	type CloudVaultEntry,
	type CloudVaultEntryWrite,
	parseCloudEnvironmentLaunchResult,
	parseCloudEnvironmentState,
} from "@ryuhq/protocol/cloud-environments";
import { z } from "zod";
import { gatewayJsonValueSchema } from "@/src/lib/api/gateway-json-contracts.ts";
import { invokeWhenReady, isTauriReady } from "../tauri-ready.ts";
import { type ApiTarget, request } from "./client.ts";

export type CloudVaultKind = "variable" | "networkSecret";
export type {
	CloudEnvironment,
	CloudEnvironmentWrite,
	CloudVaultEntry,
	CloudVaultEntryWrite,
};
export type CloudEnvironmentsSnapshot = CloudEnvironmentState;

const importVariableNamesSchema = z.object({ names: z.array(z.string()) });
const sharedEnvironmentsSchema = z.object({ environments: z.json() });
export const parseCloudEnvironments = parseCloudEnvironmentState;

export async function fetchCloudEnvironments(
	target: ApiTarget,
	signal?: AbortSignal
) {
	return parseCloudEnvironments(
		await request(
			target,
			"/api/cloud-environments",
			{ signal },
			gatewayJsonValueSchema
		)
	);
}
export async function saveCloudEnvironments(
	target: ApiTarget,
	snapshot: CloudEnvironmentWrite
) {
	return parseCloudEnvironments(
		await request(
			target,
			"/api/cloud-environments",
			{
				method: "PUT",
				body: snapshot,
			},
			gatewayJsonValueSchema
		)
	);
}
export async function runCloudEnvironmentSetup(target: ApiTarget, id: string) {
	return parseCloudEnvironmentLaunchResult(
		await request(
			target,
			`/api/cloud-environments/${encodeURIComponent(id)}/launch`,
			{ method: "POST" },
			gatewayJsonValueSchema
		)
	);
}
export async function fetchImportVariableNames(target: ApiTarget) {
	if (isTauriReady()) {
		return invokeWhenReady<string[]>("cloud_environment_variable_names");
	}
	const value = await request(
		target,
		"/api/cloud-environments/import",
		undefined,
		gatewayJsonValueSchema
	);
	const parsed = importVariableNamesSchema.safeParse(value);
	if (!parsed.success) {
		throw new Error("Invalid variable import response");
	}
	return parsed.data.names;
}
export async function importCloudVariables(
	target: ApiTarget,
	input: {
		keys: string[];
		kind: CloudVaultKind;
		environmentIds: string[];
		domains: string[];
		revision: number;
	}
) {
	return parseCloudEnvironments(
		await request(
			target,
			"/api/cloud-environments/import",
			{
				method: "POST",
				body: input,
			},
			gatewayJsonValueSchema
		)
	);
}
export function invokeCloudEnvironmentSelectedVariables(keys: string[]) {
	return invokeWhenReady<{ key: string; value: string }[]>(
		"cloud_environment_selected_variables",
		{ keys }
	);
}
export function isLocalCloudVariableImport() {
	return isTauriReady();
}
export async function fetchSharedCloudEnvironments(target: ApiTarget) {
	const value = await request(
		target,
		"/api/cloud-environments/shared",
		undefined,
		gatewayJsonValueSchema
	);
	const parsed = sharedEnvironmentsSchema.safeParse(value);
	if (!parsed.success) {
		throw new Error("Invalid shared environment response");
	}
	return parseCloudEnvironments({
		schemaVersion: 1,
		revision: 0,
		environments: parsed.data.environments,
		vault: [],
	}).environments;
}
export async function importSharedCloudEnvironment(
	target: ApiTarget,
	id: string,
	revision: number
) {
	return parseCloudEnvironments(
		await request(
			target,
			`/api/cloud-environments/shared/${encodeURIComponent(id)}/import`,
			{ method: "POST", body: { revision } },
			gatewayJsonValueSchema
		)
	);
}

export { parseEnvironmentPaste } from "./cloud-environment-input.ts";
