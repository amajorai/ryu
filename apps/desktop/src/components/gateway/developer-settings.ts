import {
	type GatewayGovernanceSnapshot,
	type GitGovernanceSettings,
	resolveGovernanceField,
	type WorktreeGovernanceSettings,
} from "@/src/lib/api/governance.ts";

export const DEFAULT_GIT_SETTINGS: Required<GitGovernanceSettings> = {
	alwaysForcePush: false,
	autoAddressPullRequestComments: false,
	autoArchiveClosedPullRequestChats: false,
	autoMergeWhenReady: false,
	branchPrefix: "codex/",
	commitInstructions: "",
	createDraftPullRequests: true,
	mergeMethod: "merge",
	pullRequestInstructions: "",
	reviewDelivery: "inline",
	watchInstructions: "",
};

export const DEFAULT_WORKTREE_SETTINGS: Required<WorktreeGovernanceSettings> = {
	autoDelete: true,
	autoDeleteLimit: 15,
	fetchUpstream: false,
	root: "",
};

export const resolveGitSetting = <Key extends keyof GitGovernanceSettings>(
	snapshot: GatewayGovernanceSnapshot,
	key: Key
) =>
	resolveGovernanceField(
		snapshot.layers.map((layer) => ({
			scope: layer.scope,
			value: layer.values.git?.[key],
		}))
	);

export const resolveWorktreeSetting = <
	Key extends keyof WorktreeGovernanceSettings,
>(
	snapshot: GatewayGovernanceSnapshot,
	key: Key
) =>
	resolveGovernanceField(
		snapshot.layers.map((layer) => ({
			scope: layer.scope,
			value: layer.values.worktrees?.[key],
		}))
	);
