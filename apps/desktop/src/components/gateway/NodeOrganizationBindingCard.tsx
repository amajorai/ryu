import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Field,
	FieldDescription,
	FieldError,
	FieldGroup,
	FieldLabel,
} from "@ryu/ui/components/field.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { InlineErrorRow } from "@/src/components/chat/InlineErrorRow.tsx";
import { StatusText } from "@/src/components/gateway/quiet.tsx";
import { useStepUp } from "@/src/components/StepUpDialog.tsx";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	bindSelfHostedNodeToOrganization,
	FLEET_NODE_NAME_MAX_LENGTH,
	fleetNodeNameError,
	getFleetBindingStatus,
	NodeAlreadyBoundError,
} from "@/src/lib/api/fleet.ts";
import { fetchMyPermissions, type OrgSummary } from "@/src/lib/api/org.ts";

const GATEWAY_CONFIGURE = "gateway.configure";

export function canBindNode(
	permissions: readonly string[] | undefined
): boolean {
	return permissions?.includes(GATEWAY_CONFIGURE) ?? false;
}

export function NodeOrganizationBindingCard({
	organizations,
}: {
	organizations: OrgSummary[];
}) {
	const activeNode = useActiveNode();
	const queryClient = useQueryClient();
	const stepUp = useStepUp();
	const tl = useLiteralMessages();
	const [organizationId, setOrganizationId] = useState("");
	const [nodeName, setNodeName] = useState(
		activeNode.name === "local" ? "My Ryu node" : activeNode.name
	);
	const target = toTarget(activeNode);
	const statusKey = ["fleet-binding-status", target.url, target.token] as const;
	const statusQuery = useQuery({
		queryFn: () => getFleetBindingStatus(target),
		queryKey: statusKey,
	});
	const permissionsQuery = useQuery({
		enabled: organizationId.length > 0,
		queryFn: () => fetchMyPermissions(organizationId),
		queryKey: ["workspace-my-permissions", organizationId],
	});
	const canBind = canBindNode(permissionsQuery.data);
	const bindingMutation = useMutation({
		// The enrollment code makes this node able to resolve members' shared
		// secrets, so the control plane asks for a fresh confirmation first.
		// A dismissed prompt resolves to `null` and binds nothing. A node that
		// is already bound says so before anyone is asked to confirm.
		mutationFn: async () => {
			const current = await getFleetBindingStatus(target);
			if (current.enrolled) {
				throw new NodeAlreadyBoundError(current);
			}
			return await stepUp.guard("org.credentials", () =>
				bindSelfHostedNodeToOrganization({
					name: nodeName,
					organizationId,
					target,
				})
			);
		},
		onSuccess: (status) => {
			if (status) {
				queryClient.setQueryData(statusKey, status);
			}
		},
		onSettled: async () => {
			await queryClient.invalidateQueries({ exact: true, queryKey: statusKey });
		},
	});

	if (statusQuery.isLoading) {
		return <Skeleton className="h-44 w-full" />;
	}

	if (statusQuery.error) {
		return (
			<SettingsSection title="Organization binding">
				<InlineErrorRow
					details={statusQuery.error.message}
					message="Couldn't read this node's binding."
					onRetry={() => statusQuery.refetch()}
				/>
			</SettingsSection>
		);
	}

	const status = statusQuery.data;
	if (status?.enrolled) {
		const organizationName =
			status.organizationName ??
			organizations.find(
				(organization) => organization.id === status.organizationId
			)?.name ??
			status.organizationId;
		return (
			<section
				aria-atomic="true"
				aria-describedby="node-binding-ready-description"
				aria-labelledby="node-binding-ready-title"
				aria-live="polite"
				className="min-w-0 max-w-full"
				data-testid="node-organization-binding-ready"
				role="status"
			>
				<div className="mb-1 flex min-w-0 flex-wrap items-center justify-between gap-2">
					<h3
						className="break-words font-semibold text-sm"
						id="node-binding-ready-title"
					>
						Organization binding
					</h3>
					<StatusText
						tone={status.managedInferenceReady ? "success" : "warning"}
					>
						{status.managedInferenceReady
							? "Managed inference ready"
							: "Binding needs attention"}
					</StatusText>
				</div>
				{/* Values sit under their labels so a long organization name or
				    node id wraps instead of pushing the row wider than the pane. */}
				<SettingsGroup>
					<SettingsItem
						description={
							<span className="break-words" data-testid="bound-organization">
								{organizationName}
							</span>
						}
						title="Organization"
					/>
					<SettingsItem
						description={
							<span className="break-all font-mono text-xs">
								{status.nodeId}
							</span>
						}
						title="Node ID"
					/>
				</SettingsGroup>
				<p
					className="text-(length:--text-detail) mt-2 break-words text-muted-foreground leading-(--text-detail--line-height)"
					id="node-binding-ready-description"
				>
					Moving it to another organization needs an explicit revoke and rebind.
				</p>
			</section>
		);
	}

	const selectedOrganization = organizations.find(
		(organization) => organization.id === organizationId
	);
	const permissionDenied =
		permissionsQuery.isSuccess && !canBindNode(permissionsQuery.data);
	const nodeNameValidationError = fleetNodeNameError(nodeName);

	return (
		<section
			aria-describedby="node-binding-description"
			aria-labelledby="node-binding-title"
			className="min-w-0 max-w-full"
		>
			{stepUp.dialog}
			<h3
				className="mb-1 break-words font-semibold text-sm"
				id="node-binding-title"
			>
				Bind this node to an organization
			</h3>
			<p
				className="text-(length:--text-detail) mb-4 break-words text-muted-foreground leading-(--text-detail--line-height)"
				id="node-binding-description"
			>
				Managed inference uses this organization's subscription and policy.
			</p>
			<FieldGroup>
				<Field>
					<FieldLabel htmlFor="node-binding-organization">
						Organization
					</FieldLabel>
					<Select onValueChange={setOrganizationId} value={organizationId}>
						<SelectTrigger
							aria-label="Organization"
							className="min-w-0 max-w-full"
							id="node-binding-organization"
							variant="default"
						>
							<SelectValue placeholder="Select an organization" />
						</SelectTrigger>
						<SelectContent>
							<SelectGroup>
								{organizations.map((organization) => (
									<SelectItem
										className="min-w-0 max-w-full"
										key={organization.id}
										value={organization.id}
									>
										<span className="min-w-0 whitespace-normal break-words">
											{organization.name}
										</span>
									</SelectItem>
								))}
							</SelectGroup>
						</SelectContent>
					</Select>
				</Field>
				<Field data-invalid={Boolean(nodeNameValidationError)}>
					<FieldLabel htmlFor="node-binding-name">Node name</FieldLabel>
					<Input
						aria-invalid={Boolean(nodeNameValidationError)}
						id="node-binding-name"
						maxLength={FLEET_NODE_NAME_MAX_LENGTH}
						onChange={(event) => setNodeName(event.target.value)}
						value={nodeName}
					/>
					{nodeNameValidationError ? (
						<FieldError>{nodeNameValidationError}</FieldError>
					) : (
						<FieldDescription>
							{tl("Up to {maxLength} characters.", {
								maxLength: String(FLEET_NODE_NAME_MAX_LENGTH),
							})}
						</FieldDescription>
					)}
				</Field>
				{organizationId && permissionsQuery.isLoading ? (
					<p aria-live="polite" className="text-muted-foreground text-sm">
						Checking access…
					</p>
				) : null}
				{organizationId && permissionsQuery.isError ? (
					<InlineErrorRow
						details={permissionsQuery.error.message}
						message="Could not check access."
						onRetry={() => permissionsQuery.refetch()}
						retryLabel="Retry access check"
					/>
				) : null}
				{permissionDenied ? (
					<p className="text-muted-foreground text-sm">
						<span className="text-foreground">Read-only access.</span> Binding
						to <span className="break-words">{selectedOrganization?.name}</span>{" "}
						needs the{" "}
						<span className="font-mono text-xs">gateway.configure</span>{" "}
						permission.
					</p>
				) : null}
				{canBind ? (
					<p className="text-muted-foreground text-sm">
						<span className="text-foreground">One secure enrollment.</span>{" "}
						Desktop sends a 10-minute code straight to Core; no secret copying.
					</p>
				) : null}
				{bindingMutation.error ? (
					<InlineErrorRow
						details={bindingMutation.error.message}
						message="Binding failed. Try again."
					/>
				) : null}
			</FieldGroup>
			<div className="mt-4 flex justify-end">
				<Button
					disabled={
						bindingMutation.isPending ||
						!canBind ||
						!organizationId ||
						Boolean(nodeNameValidationError)
					}
					onClick={() => bindingMutation.mutate()}
					variant="mono"
				>
					{bindingMutation.isPending ? (
						<Spinner data-icon="inline-start" />
					) : null}
					{bindingMutation.isPending ? "Binding node…" : "Bind node"}
				</Button>
			</div>
		</section>
	);
}
