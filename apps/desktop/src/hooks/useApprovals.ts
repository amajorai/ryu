import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { sileo } from "sileo";
import {
	type ApprovalRequest,
	approveApproval,
	listApprovals,
	rejectApproval,
} from "@/src/lib/api/approvals.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { useActiveNode } from "./useActiveNode.ts";

export interface UseApprovalsResult {
	approvals: ApprovalRequest[];
	approve: (id: string, note?: string) => Promise<ApprovalRequest>;
	deciding: string | null;
	error: string | null;
	loading: boolean;
	reject: (id: string, note?: string) => Promise<ApprovalRequest>;
}

export function useApprovals(): UseApprovalsResult {
	const node = useActiveNode();
	const target: ApiTarget = { url: node.url, token: node.token ?? null };
	const qc = useQueryClient();

	const listKey = ["approvals", "list", target.url] as const;

	const listQuery = useQuery({
		queryKey: listKey,
		queryFn: () => listApprovals(target),
	});

	const invalidate = useCallback(() => {
		Promise.resolve(qc.invalidateQueries({ queryKey: ["approvals"] })).catch(
			() => undefined
		);
	}, [qc]);

	const onError = useCallback((error: unknown) => {
		const message = error instanceof Error ? error.message : "request failed";
		sileo.error({ title: "Approvals", description: message });
	}, []);

	const approveMutation = useMutation({
		mutationFn: ({ id, note }: { id: string; note?: string }) =>
			approveApproval(target, id, note),
		onSuccess: invalidate,
		onError,
	});

	const rejectMutation = useMutation({
		mutationFn: ({ id, note }: { id: string; note?: string }) =>
			rejectApproval(target, id, note),
		onSuccess: invalidate,
		onError,
	});

	let deciding: string | null = null;
	if (approveMutation.isPending && approveMutation.variables) {
		deciding = approveMutation.variables.id;
	} else if (rejectMutation.isPending && rejectMutation.variables) {
		deciding = rejectMutation.variables.id;
	}

	return {
		approvals: listQuery.data ?? [],
		loading: listQuery.isLoading,
		error: listQuery.error instanceof Error ? listQuery.error.message : null,
		approve: (id, note) => approveMutation.mutateAsync({ id, note }),
		reject: (id, note) => rejectMutation.mutateAsync({ id, note }),
		deciding,
	};
}
