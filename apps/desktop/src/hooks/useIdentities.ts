import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	beginLogin,
	type Connection,
	type CreateConnectionInput,
	createConnection,
	deleteConnection,
	importConnection,
	type LoginFlow,
	listIdentities,
	type Profile,
	pollConnection,
} from "@/src/lib/api/identities.ts";

export interface UseIdentitiesResult {
	create: (input: CreateConnectionInput) => Promise<Connection>;
	creating: boolean;
	deleting: string | null;
	error: string | null;
	importing: boolean;
	importState: (id: string, state: string) => Promise<void>;
	loading: boolean;
	loggingIn: string | null;
	login: (id: string) => Promise<LoginFlow>;
	/** Poll one connection's status, then refresh the list so its badge updates. */
	poll: (id: string) => Promise<void>;
	polling: string | null;
	/** Distinct profile ids across every connection (for the agent picker). */
	profileIds: string[];
	profiles: Profile[];
	refetch: () => void;
	remove: (id: string) => Promise<void>;
}

export function useIdentities(): UseIdentitiesResult {
	const node = useActiveNode();
	const target: ApiTarget = { url: node.url, token: node.token ?? null };
	const qc = useQueryClient();

	const listKey = ["identities", "list", target.url] as const;

	const listQuery = useQuery({
		queryKey: listKey,
		queryFn: () => listIdentities(target),
	});

	const invalidate = useCallback(() => {
		Promise.resolve(qc.invalidateQueries({ queryKey: listKey })).catch(
			() => undefined
		);
	}, [qc, listKey]);

	const createMutation = useMutation({
		mutationFn: (input: CreateConnectionInput) =>
			createConnection(target, input),
		onSuccess: invalidate,
	});

	const deleteMutation = useMutation({
		mutationFn: (id: string) => deleteConnection(target, id),
		onSuccess: invalidate,
	});

	const loginMutation = useMutation({
		mutationFn: (id: string) => beginLogin(target, id),
		onSuccess: invalidate,
	});

	const importMutation = useMutation({
		mutationFn: ({ id, state }: { id: string; state: string }) =>
			importConnection(target, id, state),
		onSuccess: invalidate,
	});

	const pollMutation = useMutation({
		mutationFn: (id: string) => pollConnection(target, id),
		onSuccess: invalidate,
	});

	const profiles = listQuery.data ?? [];
	const profileIds = profiles.map((p) => p.profile_id);

	return {
		profiles,
		profileIds,
		loading: listQuery.isLoading,
		error: listQuery.error instanceof Error ? listQuery.error.message : null,
		refetch: invalidate,
		create: (input) => createMutation.mutateAsync(input),
		creating: createMutation.isPending,
		remove: (id) => deleteMutation.mutateAsync(id),
		deleting: deleteMutation.isPending
			? (deleteMutation.variables ?? null)
			: null,
		login: (id) => loginMutation.mutateAsync(id),
		loggingIn: loginMutation.isPending
			? (loginMutation.variables ?? null)
			: null,
		importState: async (id, state) => {
			await importMutation.mutateAsync({ id, state });
		},
		importing: importMutation.isPending,
		poll: async (id) => {
			await pollMutation.mutateAsync(id);
		},
		polling: pollMutation.isPending ? (pollMutation.variables ?? null) : null,
	};
}
