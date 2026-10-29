import type { RyuJsonValue } from "@ryu/app-host/rpc";
import { type ApiTarget, request } from "./client.ts";
import { gatewayJsonValueSchema } from "./gateway-json-contracts.ts";
import type { GovernanceScope, HookPolicyOverride } from "./governance.ts";
import { hookInventorySchema } from "./hook-wire-contracts.ts";

export type HookSource = "config" | "plugin";
export type HookHandlerKind = "command" | "sandbox_js" | "unknown";

export interface HookHandlerSummary {
	display: string;
	kind: HookHandlerKind;
	path?: string;
}

export interface HookInventoryItem {
	effectiveEnabled: boolean;
	enabled: boolean;
	handler: HookHandlerSummary;
	hookKey: string;
	id: string;
	localOverrides: Partial<
		Record<Extract<GovernanceScope, "node" | "user">, HookPolicyOverride>
	>;
	matcher?: Record<string, RyuJsonValue>;
	ownerId: string;
	ownerName: string;
	phase: string;
	pluginEnabled: boolean;
	priority: number;
	reviewRequired: boolean;
	source: HookSource;
	trusted: boolean;
}

export interface HookInventory {
	hooks: HookInventoryItem[];
}

export const parseHookInventory = (
	value: Parameters<typeof hookInventorySchema.parse>[0]
): HookInventory => {
	const parsed = hookInventorySchema.safeParse(value);
	if (parsed.success) {
		return parsed.data;
	}
	const issue = parsed.error.issues[0];
	if (!issue || issue.path.length < 2) {
		throw new Error("invalid hook inventory");
	}
	if (issue.path.length === 2) {
		throw new Error("invalid hook inventory item");
	}
	const field = issue.path[2];
	if (field === "source" || field === "priority") {
		throw new Error(`invalid hook ${String(field)}`);
	}
	if (field === "handler") {
		if (issue.path[3] === "display") {
			throw new Error("invalid hook display");
		}
		throw new Error("invalid hook handler");
	}
	throw new Error(`invalid hook ${String(field)}`);
};

export const fetchHookInventory = async (
	target: ApiTarget,
	signal?: AbortSignal
): Promise<HookInventory> => {
	const raw = await request(
		target,
		"/api/hooks/management",
		{
			signal,
		},
		gatewayJsonValueSchema
	);
	return parseHookInventory(raw);
};

export interface HookOverrideUpdate {
	hookKey: string;
	policy: HookPolicyOverride;
	scope: Extract<GovernanceScope, "node" | "user">;
}

export const updateHookOverride = async (
	target: ApiTarget,
	update: HookOverrideUpdate
): Promise<HookInventory> => {
	const raw = await request(
		target,
		"/api/hooks/overrides",
		{
			body: update,
			method: "PUT",
		},
		gatewayJsonValueSchema
	);
	return parseHookInventory(raw);
};
