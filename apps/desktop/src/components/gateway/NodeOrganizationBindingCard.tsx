import { useLiteralMessages } from "@ryu/i18n/react";
import {
	Alert,
	AlertDescription,
	AlertTitle,
} from "@ryu/ui/components/alert.tsx";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@ryu/ui/components/card.tsx";
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
import { useStepUp } from "@/src/components/StepUpDialog.tsx";
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
			<Card>
				<CardHeader>
					<CardTitle>Organization binding</CardTitle>
					<CardDescription>
						Connect this self-hosted node to one organization.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<Alert variant="destructive">
						<AlertTitle>Could not read this node</AlertTitle>
						<AlertDescription>{statusQuery.error.message}</AlertDescription>
					</Alert>
				</CardContent>
				<CardFooter>
					<Button onClick={() => statusQuery.refetch()} variant="outline">
						Retry
					</Button>
				</CardFooter>
			</Card>
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
			<Card
				aria-atomic="true"
				aria-describedby="node-binding-ready-description"
				aria-labelledby="node-binding-ready-title"
				aria-live="polite"
				className="min-w-0 max-w-full"
				data-testid="node-organization-binding-ready"
				role="status"
			>
				<CardHeader>
					<div className="flex min-w-0 flex-col items-start gap-3 md:flex-row md:justify-between">
						<div className="flex w-full min-w-0 flex-1 flex-col gap-1">
							<CardTitle className="break-words" id="node-binding-ready-title">
								Organization binding
							</CardTitle>
							<CardDescription
								className="break-words"
								id="node-binding-ready-description"
							>
								This node is linked to one organization and cannot be moved
								without an explicit revoke-and-rebind flow.
							</CardDescription>
						</div>
						<Badge
							className="max-w-full"
							variant={status.managedInferenceReady ? "secondary" : "outline"}
						>
							{status.managedInferenceReady
								? "Managed inference ready"
								: "Binding needs attention"}
						</Badge>
					</div>
				</CardHeader>
				<CardContent>
					<dl className="grid min-w-0 gap-4 md:grid-cols-2">
						<div className="flex min-w-0 flex-col gap-1">
							<dt className="text-muted-foreground text-sm">Organization</dt>
							<dd
								className="min-w-0 break-words font-medium"
								data-testid="bound-organization"
							>
								{organizationName}
							</dd>
						</div>
						<div className="flex min-w-0 flex-col gap-1">
							<dt className="text-muted-foreground text-sm">Node ID</dt>
							<dd className="break-all font-mono text-sm">{status.nodeId}</dd>
						</div>
					</dl>
				</CardContent>
				<CardFooter>
					<p className="text-muted-foreground text-sm">
						Managed requests use this organization’s live subscription, credits,
						budgets, and policy at request time.
					</p>
				</CardFooter>
			</Card>
		);
	}

	const selectedOrganization = organizations.find(
		(organization) => organization.id === organizationId
	);
	const permissionDenied =
		permissionsQuery.isSuccess && !canBindNode(permissionsQuery.data);
	const nodeNameValidationError = fleetNodeNameError(nodeName);

	return (
		<Card
			aria-describedby="node-binding-description"
			aria-labelledby="node-binding-title"
			className="min-w-0 max-w-full"
		>
			{stepUp.dialog}
			<CardHeader>
				<CardTitle className="break-words" id="node-binding-title">
					Bind this node to an organization
				</CardTitle>
				<CardDescription className="break-words" id="node-binding-description">
					Choose the organization whose live subscription and access policy this
					node should use for managed inference.
				</CardDescription>
			</CardHeader>
			<CardContent>
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
						<FieldDescription>
							The enrollment code derives the organization on the server. The
							node cannot supply or override it.
						</FieldDescription>
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
						<Alert variant="destructive">
							<AlertTitle>Could not check access</AlertTitle>
							<AlertDescription layout="retry-actions">
								<span>{permissionsQuery.error.message}</span>
								<Button
									onClick={() => permissionsQuery.refetch()}
									size="sm"
									variant="outline"
								>
									Retry access check
								</Button>
							</AlertDescription>
						</Alert>
					) : null}
					{permissionDenied ? (
						<Alert>
							<AlertTitle>Read-only access</AlertTitle>
							<AlertDescription>
								You can inspect this node, but binding it to{" "}
								<span className="break-words">
									{selectedOrganization?.name}
								</span>{" "}
								requires the gateway.configure permission. Ask an organization
								owner, admin, or custom-role holder to complete this step.
							</AlertDescription>
						</Alert>
					) : null}
					{canBind ? (
						<Alert variant="info">
							<AlertTitle>One secure enrollment</AlertTitle>
							<AlertDescription>
								Desktop creates a 10-minute code and sends it straight to the
								active Core. It binds Fleet identity and managed inference to{" "}
								<span className="break-words">
									{selectedOrganization?.name}
								</span>
								; no secret copying is required.
							</AlertDescription>
						</Alert>
					) : null}
					{bindingMutation.error ? (
						<Alert variant="destructive">
							<AlertTitle>Binding failed</AlertTitle>
							<AlertDescription>
								{bindingMutation.error.message}
							</AlertDescription>
						</Alert>
					) : null}
				</FieldGroup>
			</CardContent>
			<CardFooter>
				<Button
					disabled={
						bindingMutation.isPending ||
						!canBind ||
						!organizationId ||
						Boolean(nodeNameValidationError)
					}
					onClick={() => bindingMutation.mutate()}
					variant="secondary"
				>
					{bindingMutation.isPending ? (
						<Spinner data-icon="inline-start" />
					) : null}
					{bindingMutation.isPending ? "Binding node…" : "Bind node"}
				</Button>
			</CardFooter>
		</Card>
	);
}
