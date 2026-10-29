import { type ApiTarget, request } from "./client.ts";
import { gatewayJsonValueSchema } from "./gateway-json-contracts.ts";
import {
	governanceLayersSchema,
	governanceLockedFieldsSchema,
	governanceReasonSchema,
	governanceRecordSchema,
	governanceRevisionSchema,
	governanceScopeSchema,
	governanceWritableSchema,
	parseGovernanceValues,
} from "./governance-wire-contracts.ts";

export type GovernanceScope = "node" | "organization" | "team" | "user";

export interface GovernanceLayer<Value> {
	scope: GovernanceScope;
	value: Value | undefined;
}

export interface ResolvedGovernanceField<Value> {
	scope: GovernanceScope;
	value: Value;
}

export type GitMergeMethod = "merge" | "squash";
export type ReviewDelivery = "inline" | "detached";

export interface HookPolicyOverride {
	enabled?: boolean;
	trusted?: boolean;
}

export interface GitGovernanceSettings {
	alwaysForcePush?: boolean;
	autoAddressPullRequestComments?: boolean;
	autoArchiveClosedPullRequestChats?: boolean;
	autoMergeWhenReady?: boolean;
	branchPrefix?: string;
	commitInstructions?: string;
	createDraftPullRequests?: boolean;
	mergeMethod?: GitMergeMethod;
	pullRequestInstructions?: string;
	reviewDelivery?: ReviewDelivery;
	watchInstructions?: string;
}

export interface WorktreeGovernanceSettings {
	autoDelete?: boolean;
	autoDeleteLimit?: number;
	fetchUpstream?: boolean;
	root?: string;
}

export interface GatewayGovernanceValues {
	git?: GitGovernanceSettings;
	hooks?: Record<string, HookPolicyOverride>;
	worktrees?: WorktreeGovernanceSettings;
}

export interface GatewayGovernanceLayer {
	/**
	 * Field paths this layer cannot change (`git.branchPrefix`,
	 * `worktrees.autoDelete`, `hooks.<key>`). On the user layer this is every
	 * organization/team lock, which the settings UI renders read-only.
	 */
	lockedFields?: string[];
	revision: number;
	scope: GovernanceScope;
	unavailableReason?: string;
	values: GatewayGovernanceValues;
	writable: boolean;
}

export interface GatewayGovernanceSnapshot {
	layers: GatewayGovernanceLayer[];
	schemaVersion: 1;
}

export const parseGatewayGovernanceSnapshot = (
	value: Parameters<typeof governanceRecordSchema.parse>[0]
): GatewayGovernanceSnapshot => {
	const root = governanceRecordSchema.safeParse(value);
	if (!root.success || root.data.schemaVersion !== 1) {
		throw new Error("invalid gateway governance snapshot");
	}
	const layerInputs = governanceLayersSchema.safeParse(root.data.layers);
	if (!layerInputs.success) {
		throw new Error("invalid gateway governance snapshot");
	}
	const layers = layerInputs.data.map((rawLayer): GatewayGovernanceLayer => {
		const parsed = governanceRecordSchema.safeParse(rawLayer);
		if (!parsed.success) {
			throw new Error("invalid governance layer");
		}
		const revision = governanceRevisionSchema.safeParse(parsed.data.revision);
		if (!revision.success) {
			throw new Error("invalid governance revision");
		}
		const writable = governanceWritableSchema.safeParse(parsed.data.writable);
		if (!writable.success) {
			throw new Error("invalid governance writable state");
		}
		const scope = governanceScopeSchema.safeParse(parsed.data.scope);
		if (!scope.success) {
			throw new Error("invalid governance scope");
		}
		const layer: GatewayGovernanceLayer = {
			revision: revision.data,
			scope: scope.data,
			values: parseGovernanceValues(parsed.data.values),
			writable: writable.data,
		};
		const lockedFields = governanceLockedFieldsSchema.parse(
			parsed.data.lockedFields
		);
		if (lockedFields.length > 0) {
			layer.lockedFields = lockedFields;
		}
		const unavailableReason = governanceReasonSchema.parse(
			parsed.data.unavailableReason
		);
		if (unavailableReason !== undefined) {
			layer.unavailableReason = unavailableReason;
		}
		return layer;
	});
	return { layers, schemaVersion: 1 };
};

export const fetchGatewayGovernance = async (
	target: ApiTarget,
	signal?: AbortSignal
): Promise<GatewayGovernanceSnapshot> => {
	const raw = await request<unknown>(
		target,
		"/api/gateway/governance",
		{
			signal,
		},
		gatewayJsonValueSchema
	);
	return parseGatewayGovernanceSnapshot(raw);
};

interface GovernanceKindValues {
	git: GitGovernanceSettings;
	hooks: Record<string, HookPolicyOverride>;
	worktrees: WorktreeGovernanceSettings;
}

export const updateGatewayGovernance = async <
	Kind extends keyof GovernanceKindValues,
>(
	target: ApiTarget,
	kind: Kind,
	scope: "node" | "user",
	values: GovernanceKindValues[Kind]
): Promise<GatewayGovernanceSnapshot> => {
	const raw = await request<unknown>(
		target,
		`/api/gateway/governance/${kind}`,
		{
			body: { scope, values },
			method: "PUT",
		},
		gatewayJsonValueSchema
	);
	return parseGatewayGovernanceSnapshot(raw);
};

/**
 * Whether an organization or team administrator locked a governance field, so
 * the user layer cannot override it. Node-scope edits are unaffected because
 * the organization layer already outranks the node fallback.
 */
export const isGovernanceFieldLocked = (
	snapshot: GatewayGovernanceSnapshot | undefined,
	path: string
): boolean =>
	snapshot?.layers.some(
		(layer) =>
			(layer.scope === "organization" ||
				layer.scope === "team" ||
				layer.scope === "user") &&
			(layer.lockedFields ?? []).includes(path)
	) ?? false;

const scopeRank = (scope: GovernanceScope): number => {
	switch (scope) {
		case "node":
			return 0;
		case "organization":
			return 1;
		case "team":
			return 2;
		case "user":
			return 3;
	}
};

/**
 * Resolve one field without collapsing an explicit false into absence.
 * Callers may pass layers in any order; scope rank is the single authority.
 */
export const resolveGovernanceField = <Value>(
	layers: readonly GovernanceLayer<Value>[]
): ResolvedGovernanceField<Value> | null => {
	let resolved: ResolvedGovernanceField<Value> | null = null;
	for (const layer of layers) {
		if (layer.value === undefined) {
			continue;
		}
		if (resolved && scopeRank(resolved.scope) > scopeRank(layer.scope)) {
			continue;
		}
		resolved = { scope: layer.scope, value: layer.value };
	}
	return resolved;
};
