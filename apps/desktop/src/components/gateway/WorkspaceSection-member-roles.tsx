import { Shield01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { sileo } from "sileo";
import type { useStepUp } from "@/src/components/StepUpDialog.tsx";
import {
	getMemberRoles,
	type OrgRoleDef,
	setMemberRoles,
} from "@/src/lib/api/org.ts";

/**
 * Per-member custom-role assignment. Shows the member's assigned custom roles as
 * badges; when the caller holds `roles.manage`, a popover toggles the assignment
 * set. Built-in tier is unaffected (that lives on the Better Auth membership row);
 * this only layers custom roles on top.
 */
export function MemberRolesControl({
	orgId,
	userId,
	customRoles,
	canManage,
	stepUp,
}: {
	orgId: string;
	userId: string;
	customRoles: OrgRoleDef[];
	canManage: boolean;
	stepUp: ReturnType<typeof useStepUp>;
}) {
	const queryClient = useQueryClient();
	const assignedQuery = useQuery({
		enabled: customRoles.length > 0,
		queryKey: ["workspace-member-roles", orgId, userId],
		queryFn: () => getMemberRoles(orgId, userId),
	});
	const assigned = assignedQuery.data ?? [];

	const setMutation = useMutation({
		mutationFn: (roleKeys: string[]) => setMemberRoles(orgId, userId, roleKeys),
		onSuccess: async () => {
			await queryClient.invalidateQueries({
				queryKey: ["workspace-member-roles", orgId, userId],
			});
		},
		onError: (e) => {
			sileo.error({
				title: e instanceof Error ? e.message : "Failed to update assignment",
			});
		},
	});

	const toggle = (roleKey: string, checked: boolean) => {
		const next = checked
			? [...assigned, roleKey]
			: assigned.filter((k) => k !== roleKey);
		void stepUp
			.guard("org.members", () => setMutation.mutateAsync(next))
			.catch(() => undefined);
	};

	if (customRoles.length === 0) {
		return null;
	}

	const assignedRoles = customRoles.filter((r) => assigned.includes(r.key));

	return (
		<div className="flex items-center gap-1.5">
			{assignedRoles.map((r) => (
				<span className="text-muted-foreground text-sm" key={r.key}>
					{r.name}
				</span>
			))}
			{canManage ? (
				<Popover>
					<PopoverTrigger
						render={
							<Button size="sm" variant="ghost">
								<HugeiconsIcon className="size-3.5" icon={Shield01Icon} />
								Roles
							</Button>
						}
					/>
					<PopoverContent align="end" className="w-64">
						<div className="flex flex-col gap-1">
							<p className="px-1 pb-1 font-medium text-sm">Custom roles</p>
							{assignedQuery.isLoading ? (
								<div className="flex items-center gap-2 px-2 py-1.5 text-muted-foreground text-sm">
									<Spinner className="size-3.5" />
									Loading assigned roles…
								</div>
							) : assignedQuery.isError ? (
								<div className="space-y-2 px-2 py-1.5">
									<p className="text-sm text-status-destructive" role="alert">
										Couldn’t load this member’s custom roles.
									</p>
									<Button
										onClick={() => void assignedQuery.refetch()}
										size="sm"
										variant="outline"
									>
										Retry assigned roles
									</Button>
								</div>
							) : (
								customRoles.map((r) => (
									<label
										className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-muted/50"
										key={r.key}
									>
										<Checkbox
											checked={assigned.includes(r.key)}
											disabled={setMutation.isPending}
											onCheckedChange={(checked) =>
												toggle(r.key, checked === true)
											}
										/>
										<span>{r.name}</span>
									</label>
								))
							)}
						</div>
					</PopoverContent>
				</Popover>
			) : null}
		</div>
	);
}
