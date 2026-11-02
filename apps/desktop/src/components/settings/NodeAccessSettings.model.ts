import { formatLocalDateTime } from "@/src/lib/locale-format.ts";

export interface PairingConstraints {
	agent_id?: string;
	client_id?: string;
	node_id?: string;
	org_id?: string;
	plugin_id?: string;
	resource_id?: string;
	subject_id?: string;
	team_id?: string;
	tool_name?: string;
}

export interface PairedClient {
	active?: boolean;
	constraints?: PairingConstraints;
	created_at: number;
	expires_at?: number | null;
	granted_scopes?: string[];
	id: string;
	last_seen: number;
	name: string;
	revoked_at?: number | null;
	schema_version?: number;
}

const CONSTRAINT_LABELS = [
	{ field: "subject_id", label: "User" },
	{ field: "client_id", label: "Client" },
	{ field: "node_id", label: "Node" },
	{ field: "org_id", label: "Organization" },
	{ field: "team_id", label: "Team" },
	{ field: "agent_id", label: "Agent" },
	{ field: "plugin_id", label: "Plugin" },
	{ field: "resource_id", label: "Resource" },
	{ field: "tool_name", label: "Tool" },
] satisfies ReadonlyArray<{
	field: keyof PairingConstraints;
	label: string;
}>;

export function describePairingConstraints(
	constraints: PairingConstraints | undefined
): string[] {
	if (!constraints) {
		return ["Unbound"];
	}
	const bindings: string[] = [];
	for (const { field, label } of CONSTRAINT_LABELS) {
		const value = constraints[field];
		if (value) {
			bindings.push(`${label}: ${value}`);
		}
	}
	return bindings.length > 0 ? bindings : ["Unbound"];
}

export type PairedClientStatus = "Active" | "Expired" | "Inactive" | "Revoked";

export function formatPairingTimestamp(timestamp: number): string | null {
	if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
		return null;
	}
	const date = new Date(timestamp * 1000);
	if (!Number.isFinite(date.getTime())) {
		return null;
	}
	try {
		return formatLocalDateTime(date);
	} catch {
		return null;
	}
}

export function getPairedClientStatus(
	client: PairedClient,
	nowSeconds = Date.now() / 1000
): PairedClientStatus {
	if (client.revoked_at != null) {
		return "Revoked";
	}
	if (client.expires_at != null && client.expires_at <= nowSeconds) {
		return "Expired";
	}
	return client.active === false ? "Inactive" : "Active";
}

export function canRevokePairedClient(
	client: PairedClient,
	nowSeconds = Date.now() / 1000
): boolean {
	return getPairedClientStatus(client, nowSeconds) === "Active";
}

export function narrowPairingScopes({
	checked,
	requested,
	scope,
	selected,
}: {
	checked: boolean;
	requested: readonly string[];
	scope: string;
	selected: readonly string[];
}): string[] {
	return requested.filter((requestedScope) =>
		requestedScope === scope ? checked : selected.includes(requestedScope)
	);
}
