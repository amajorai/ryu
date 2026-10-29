import { toast } from "@ryu/ui/components/sileo.tsx";
import {
	type UseMutationOptions,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useCallback } from "react";
import {
	type ApprovalRequest,
	type ApprovalStatus,
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

export interface UseApprovalsOptions {
	/** Ask Core for only this status (e.g. the interfaces' `pending` list).
	 *  Without it the hook lists every approval, as the Inbox does. */
	status?: ApprovalStatus;
}

/** Shared while loading or failed, so consumers' memos stay stable. */
const NO_APPROVALS: ApprovalRequest[] = [];

/** Query key of the approvals list; a status filter keys its own cache entry
 *  under the same `["approvals"]` prefix, so approval events still refresh it. */
export function approvalsListKey(url: string, status?: ApprovalStatus) {
	return status
		? (["approvals", "list", url, status] as const)
		: (["approvals", "list", url] as const);
}

/** The approval inbox list plus approve / reject. */
export function useApprovals(
	options: UseApprovalsOptions = {}
): UseApprovalsResult {
	const { status } = options;
	const node = useActiveNode();
	const target: ApiTarget = {
		url: node.url,
		token: node.token,
		userJwt: node.userJwt ?? null,
	};
	const qc = useQueryClient();

	const listQuery = useQuery({
		queryKey: approvalsListKey(target.url, status),
		queryFn: () => listApprovals(target, status),
	});

	const invalidate = useCallback(() => {
		Promise.resolve(qc.invalidateQueries({ queryKey: ["approvals"] })).catch(
			() => undefined
		);
	}, [qc]);

	const onError = useCallback(
		(error: Parameters<NonNullable<UseMutationOptions["onError"]>>[0]) => {
			const message = error instanceof Error ? error.message : "request failed";
			toast.error({ title: "Approvals", description: message });
		},
		[]
	);

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
		approvals: listQuery.data ?? NO_APPROVALS,
		loading: listQuery.isLoading,
		error: listQuery.error instanceof Error ? listQuery.error.message : null,
		approve: (id, note) => approveMutation.mutateAsync({ id, note }),
		reject: (id, note) => rejectMutation.mutateAsync({ id, note }),
		deciding,
	};
}
