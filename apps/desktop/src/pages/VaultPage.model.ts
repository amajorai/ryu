import type { LiteralMessage } from "@ryu/i18n/react";
import type { VaultScope } from "@/src/lib/api/vault.ts";
import { formatDateTime } from "@/src/lib/timezone.ts";

export const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export const SCOPE_COPY = {
	user: {
		label: "User",
		description: "Only your verified chat sessions",
	},
	node: {
		label: "Node",
		description: "Every governed session on this node",
	},
	team: {
		label: "Team",
		description: "Verified members of one team",
	},
	org: {
		label: "Organization",
		description: "Verified members of this organization",
	},
} satisfies Record<VaultScope, { description: string; label: string }>;

export const MCP_EXAMPLE = [
	"{",
	'  "headers": {',
	'    "Authorization": "Bearer secret:GITHUB_TOKEN"',
	"  },",
	'  "env": {',
	'    "GITHUB_TOKEN": "secret:GITHUB_TOKEN"',
	"  }",
	"}",
].join("\n");

export type VaultTab = "secrets" | "broker" | "audit";

export const VAULT_TABS: readonly VaultTab[] = ["secrets", "broker", "audit"];

export function vaultTab(value: string): VaultTab {
	return VAULT_TABS.find((tab) => tab === value) ?? "secrets";
}

export function scopeLabel(scope: VaultScope): string {
	return SCOPE_COPY[scope].label;
}

export function formatUpdatedAt(value: string): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? "recently" : formatDateTime(value);
}

export function scopeIdLabel(scope: VaultScope, scopeId: string): string {
	if (scope === "user") {
		return "your user scope";
	}
	if (scope === "node") {
		return "this node";
	}
	return scopeId;
}

/** Where a saved secret will resolve, as one sentence per scope. */
export function vaultSavedForCopy(
	tl: LiteralMessage,
	{
		environment,
		nodeId,
		orgId,
		scope,
		scopeId,
	}: {
		environment: string;
		nodeId: string | null | undefined;
		orgId: string | null | undefined;
		scope: VaultScope;
		scopeId: string;
	}
): string {
	if (scope === "user") {
		return tl("Saved for your verified sessions in {environment}.", {
			environment,
		});
	}
	if (scope === "node") {
		return nodeId == null
			? tl("Saved for this node in {environment}.", { environment })
			: tl("Saved for {node} in {environment}.", {
					node: nodeId,
					environment,
				});
	}
	if (scope === "team") {
		return tl("Saved for team {team} in {environment}.", {
			team: scopeId || "…",
			environment,
		});
	}
	return orgId == null
		? tl("Saved for this organization in {environment}.", { environment })
		: tl("Saved for {organization} in {environment}.", {
				organization: orgId,
				environment,
			});
}
