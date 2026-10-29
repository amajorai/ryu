import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
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

const EMPTY_PROFILES: Profile[] = [];
interface Scoped<T> {
	target: ApiTarget;
	value: T;
}
const identityListKey = (target: ApiTarget) =>
	[
		"identities",
		"list",
		target.url,
		target.token ?? null,
		target.userJwt ?? null,
	] as const;

export function useIdentities(): UseIdentitiesResult {
	const node = useActiveNode();
	const target = useMemo<ApiTarget>(
		() => ({
			url: node.url,
			token: node.token ?? null,
			userJwt: node.userJwt ?? null,
		}),
		[node.url, node.token, node.userJwt]
	);
	const qc = useQueryClient();
	const listKey = useMemo(() => identityListKey(target), [target]);
	const listQuery = useQuery({
		queryKey: listKey,
		queryFn: ({ signal }) => listIdentities(target, signal),
	});
	const invalidate = useCallback(() => {
		void qc.invalidateQueries({ queryKey: listKey }).catch(() => undefined);
	}, [qc, listKey]);
	const invalidateMutation = useCallback(
		<TResult>(_result: TResult, variables: { target: ApiTarget }) => {
			const queryKey = identityListKey(variables.target);
			void qc
				.cancelQueries({ queryKey })
				.then(() => qc.invalidateQueries({ queryKey }))
				.catch(() => undefined);
		},
		[qc]
	);
	const currentTarget = (other?: ApiTarget) =>
		other?.url === target.url &&
		(other?.token ?? null) === target.token &&
		(other?.userJwt ?? null) === target.userJwt;
	const createMutation = useMutation({
		mutationFn: ({ target, value }: Scoped<CreateConnectionInput>) =>
			createConnection(target, value),
		onSuccess: invalidateMutation,
	});
	const deleteMutation = useMutation({
		mutationFn: ({ target, value }: Scoped<string>) =>
			deleteConnection(target, value),
		onSuccess: invalidateMutation,
	});
	const loginMutation = useMutation({
		mutationFn: ({ target, value }: Scoped<string>) =>
			beginLogin(target, value),
		onSuccess: invalidateMutation,
	});
	const importMutation = useMutation({
		mutationFn: ({ target, value }: Scoped<{ id: string; state: string }>) =>
			importConnection(target, value.id, value.state),
		onSuccess: invalidateMutation,
	});
	const pollMutation = useMutation({
		mutationFn: ({ target, value }: Scoped<string>) =>
			pollConnection(target, value),
		onSuccess: invalidateMutation,
	});
	const profiles = listQuery.data ?? EMPTY_PROFILES;
	const profileIds = useMemo(
		() => profiles.map((p) => p.profile_id),
		[profiles]
	);

	return {
		profiles,
		profileIds,
		loading: listQuery.isLoading,
		error: listQuery.error instanceof Error ? listQuery.error.message : null,
		refetch: invalidate,
		create: (input) => createMutation.mutateAsync({ target, value: input }),
		creating:
			createMutation.isPending &&
			currentTarget(createMutation.variables?.target),
		remove: (id) => deleteMutation.mutateAsync({ target, value: id }),
		deleting:
			deleteMutation.isPending &&
			currentTarget(deleteMutation.variables?.target)
				? (deleteMutation.variables?.value ?? null)
				: null,
		login: (id) => loginMutation.mutateAsync({ target, value: id }),
		loggingIn:
			loginMutation.isPending && currentTarget(loginMutation.variables?.target)
				? (loginMutation.variables?.value ?? null)
				: null,
		importState: async (id, state) => {
			await importMutation.mutateAsync({ target, value: { id, state } });
		},
		importing:
			importMutation.isPending &&
			currentTarget(importMutation.variables?.target),
		poll: async (id) => {
			await pollMutation.mutateAsync({ target, value: id });
		},
		polling:
			pollMutation.isPending && currentTarget(pollMutation.variables?.target)
				? (pollMutation.variables?.value ?? null)
				: null,
	};
}
