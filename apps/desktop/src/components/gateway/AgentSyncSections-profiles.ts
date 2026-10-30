import { useCallback, useEffect, useState } from "react";
import {
	type AgentSyncProfile,
	type AgentSyncStatus,
	getAgentSyncStatus,
	listAgentSyncProfiles,
	type SyncProvider,
	saveAgentSyncProfile,
} from "@/src/lib/api/agent-sync.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";

export interface ProfileDraft {
	exportEnabled: boolean;
	id?: string;
	importEnabled: boolean;
	/** Omitted keeps the stored choice; a new profile starts without transcripts. */
	includeConversations?: boolean;
	provider: SyncProvider;
	root: string;
}

/** Profiles carry `includeConversations` from Core; older Cores omit it (off). */
export function profileIncludesConversations(
	profile: AgentSyncProfile
): boolean {
	return (
		(profile as AgentSyncProfile & { includeConversations?: unknown })
			.includeConversations === true
	);
}

export function useAgentSyncProfiles(target: ApiTarget) {
	const [profiles, setProfiles] = useState<AgentSyncProfile[]>([]);
	const [status, setStatus] = useState<AgentSyncStatus | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const [profileResult, statusResult] = await Promise.all([
				listAgentSyncProfiles(target),
				getAgentSyncStatus(target),
			]);
			setProfiles(profileResult.profiles);
			setStatus(statusResult);
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Could not load sync state"
			);
		} finally {
			setLoading(false);
		}
	}, [target]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const save = useCallback(
		async (draft: ProfileDraft) => {
			const saved = await saveAgentSyncProfile(target, draft);
			setProfiles((current) => {
				const next = current.filter((profile) => profile.id !== saved.id);
				return [...next, saved].sort((a, b) => a.root.localeCompare(b.root));
			});
			return saved;
		},
		[target]
	);

	return { error, loading, profiles, refresh, save, status };
}
