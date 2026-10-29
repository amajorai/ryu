// Pending change requests for protected environments. Core lists a request to
// its requester and to principals with `approve`; anything not the caller's
// own was therefore listed because they may approve it.

import {
	Cancel01Icon,
	CheckmarkCircle02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { sileo } from "sileo";
import {
	SettingsCard,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	decideVaultChangeRequest,
	listVaultChangeRequests,
	type VaultChangeRequest,
} from "@/src/lib/api/vault.ts";
import { formatDateTime } from "@/src/lib/timezone.ts";
import { vaultErrorMessage } from "./vault-errors.ts";
import { ROOT_FOLDER } from "./vault-view.ts";

type Decision = "approve" | "reject" | "cancel";

const DECISION_TOAST = {
	approve: "Approved",
	reject: "Rejected",
	cancel: "Request canceled",
} satisfies Record<Decision, string>;

function describe(request: VaultChangeRequest): string {
	const { coords } = request;
	const where =
		coords.path === ROOT_FOLDER
			? coords.environment
			: `${coords.environment} · ${coords.path}`;
	const what =
		request.operation === "delete"
			? "Delete"
			: request.hasValue
				? "New value"
				: "Details";
	return `${what} · ${where}`;
}

function whenLabel(value: string): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : formatDateTime(value);
}

export function VaultChangeRequests({
	callerSubject,
	target,
}: {
	callerSubject: string;
	target: ApiTarget;
}) {
	const queryClient = useQueryClient();
	const requestsQuery = useQuery({
		queryKey: ["vault", "change-requests", target.url, "pending"],
		queryFn: () => listVaultChangeRequests(target, "pending"),
	});
	const decideMutation = useMutation({
		mutationFn: ({ decision, id }: { decision: Decision; id: string }) =>
			decideVaultChangeRequest(target, id, decision),
		onSuccess: async (_, { decision }) => {
			await queryClient.invalidateQueries({ queryKey: ["vault"] });
			sileo.success({ title: DECISION_TOAST[decision] });
		},
		onError: (error) => {
			sileo.error({
				title: "Could not update the request",
				description: vaultErrorMessage(error, "Try again."),
			});
		},
	});

	const requests = requestsQuery.data ?? [];
	if (requests.length === 0) {
		return null;
	}

	return (
		<SettingsSection
			caption="Changes to protected environments wait here until enough people approve them."
			title="Pending approvals"
		>
			<SettingsCard className="divide-y p-0">
				{requests.map((request) => {
					const mine = request.requestedBy === callerSubject;
					const busy =
						decideMutation.isPending &&
						decideMutation.variables?.id === request.id;
					return (
						<div
							className="flex items-center justify-between gap-4 px-4 py-3"
							key={request.id}
						>
							<div className="min-w-0">
								<div className="flex flex-wrap items-center gap-2">
									<code className="font-medium font-mono text-sm">
										{request.coords.name}
									</code>
									<Badge variant="outline">
										{request.approvals.length}/{request.requiredApprovals}{" "}
										approvals
									</Badge>
								</div>
								<p className="mt-1 truncate text-muted-foreground text-xs">
									{describe(request)} · {mine ? "you" : request.requestedBy} ·{" "}
									{whenLabel(request.requestedAt)}
								</p>
							</div>
							<div className="flex shrink-0 gap-1">
								{mine ? (
									<Button
										disabled={busy}
										onClick={() =>
											decideMutation.mutate({
												decision: "cancel",
												id: request.id,
											})
										}
										size="sm"
										variant="ghost"
									>
										Cancel request
									</Button>
								) : (
									<>
										<Button
											disabled={busy}
											onClick={() =>
												decideMutation.mutate({
													decision: "reject",
													id: request.id,
												})
											}
											size="sm"
											variant="ghost"
										>
											<HugeiconsIcon className="size-4" icon={Cancel01Icon} />
											Reject
										</Button>
										<Button
											disabled={busy}
											onClick={() =>
												decideMutation.mutate({
													decision: "approve",
													id: request.id,
												})
											}
											size="sm"
											variant="outline"
										>
											<HugeiconsIcon
												className="size-4"
												icon={CheckmarkCircle02Icon}
											/>
											Approve
										</Button>
									</>
								)}
							</div>
						</div>
					);
				})}
			</SettingsCard>
		</SettingsSection>
	);
}
