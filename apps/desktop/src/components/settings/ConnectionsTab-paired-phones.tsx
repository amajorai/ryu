import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { sileo } from "sileo";
import { useSession } from "@/lib/auth-client.ts";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { type ApiTarget, toTarget } from "@/src/lib/api/client.ts";
import {
	approvePairedPhone,
	forgetPairedPhone,
	isForbidden,
	isRouteMissing,
	jwtSubject,
	listPairedPhones,
	type PairedDevice,
	renamePairedPhone,
	revokePairedPhoneGrants,
	userIdFromPrincipal,
} from "@/src/lib/api/paired-phones.ts";
import { isLocalNode } from "@/src/store/useNodeStore.ts";
import { AppDelegationsPanel } from "./ConnectionsTab-app-delegations.tsx";
import {
	type PairedPhoneActions,
	PairedPhoneRow,
} from "./ConnectionsTab-paired-phone-row.tsx";
import {
	SettingsCard,
	SettingsGroup,
	SettingsSection,
} from "./shared/settings-items.tsx";

type PhoneAction =
	| { device: PairedDevice; kind: "approve" }
	| { device: PairedDevice; kind: "forget" }
	| { device: PairedDevice; kind: "rename"; label: string }
	| { device: PairedDevice; kind: "revoke"; tool: string };

/**
 * Query key for one node's paired phones. Core scopes the list to the caller's
 * principal, so the key carries the credential and a non-secret identity (the
 * signed-in user and the delegation's subject): another account on the same
 * node never reads this account's cached phones.
 */
export const pairedPhonesQueryKey = (
	target: ApiTarget,
	selfUserId: string | null = null
) =>
	[
		"paired-phones",
		target.url,
		target.token,
		selfUserId,
		jwtSubject(target.userJwt),
	] as const;

async function runPhoneAction(target: ApiTarget, action: PhoneAction) {
	switch (action.kind) {
		case "approve":
			await approvePairedPhone(target, action.device.device_id);
			return;
		case "forget":
			await forgetPairedPhone(target, action.device.device_id);
			return;
		case "rename":
			await renamePairedPhone(target, action.device.device_id, action.label);
			return;
		default:
			await revokePairedPhoneGrants(target, action.device.device_id, [
				action.tool,
			]);
	}
}

/**
 * Paired phones on one node: pending pairings (approve / deny) and active
 * phones (rename, revoke an "Always allow" grant, forget). Renders nothing when
 * the node predates the device-tools routes.
 */
export function PairedPhonesPanel({
	canApprove,
	selfUserId,
	target,
}: {
	/** Approval works only against the desktop's own (loopback) Core. */
	canApprove: boolean;
	/** The signed-in account's user id, offered as the default member. */
	selfUserId: string | null;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const queryClient = useQueryClient();
	const queryKey = pairedPhonesQueryKey(target, selfUserId);
	const query = useQuery({
		queryKey,
		queryFn: ({ signal }) => listPairedPhones(target, signal),
		enabled: Boolean(target.url),
		refetchInterval: 15_000,
		retry: false,
	});
	const mutation = useMutation({
		mutationFn: (action: PhoneAction) => runPhoneAction(target, action),
		onError: (error, action) => {
			sileo.error({
				title:
					action.kind === "approve" && isForbidden(error)
						? tl("Approve this phone from the computer that runs this node.")
						: tl("Couldn't update {name}", { name: action.device.label }),
				description: error instanceof Error ? error.message : undefined,
			});
		},
		onSuccess: (_result, action) => {
			if (action.kind === "approve") {
				sileo.success({
					title: tl("{name} can now be used by Ryu", {
						name: action.device.label,
					}),
				});
			}
		},
		onSettled: () => queryClient.invalidateQueries({ queryKey }),
	});

	if (query.error && isRouteMissing(query.error)) {
		return null;
	}
	const actions: PairedPhoneActions = {
		approve: (device) => mutation.mutate({ device, kind: "approve" }),
		forget: (device) => mutation.mutate({ device, kind: "forget" }),
		rename: (device, label) =>
			mutation.mutate({ device, kind: "rename", label }),
		revokeGrant: (device, tool) =>
			mutation.mutate({ device, kind: "revoke", tool }),
	};
	const devices = query.data?.devices ?? [];
	const pendingCount = devices.filter(
		(device) => device.state === "pending"
	).length;
	const memberUserId =
		userIdFromPrincipal(query.data?.principal_id ?? "") ?? selfUserId;

	return (
		<>
			<SettingsSection
				caption={
					pendingCount > 0 && !canApprove
						? "Phones waiting for approval can only be approved on the computer that runs this node."
						: "Phones that let Ryu use their apps. A phone that pairs with this node's token waits here until you approve it."
				}
				title="Paired phones"
			>
				{query.isLoading ? (
					<SkeletonRows label="Checking paired phones…" spacing="panel" />
				) : null}
				{query.error ? (
					<SettingsCard className="flex items-center justify-between gap-3">
						<p
							className="text-muted-foreground text-sm"
							title={query.error.message}
						>
							Paired phones are unavailable on this node.
						</p>
						<Button
							aria-label="Retry paired phones"
							disabled={query.isFetching}
							onClick={() => void query.refetch()}
							size="sm"
							variant="outline"
						>
							{query.isFetching ? "Retrying…" : "Retry"}
						</Button>
					</SettingsCard>
				) : null}
				{query.data && devices.length === 0 ? (
					<SettingsCard>
						<p className="text-center text-muted-foreground text-sm">
							No phones are paired with this node.
						</p>
					</SettingsCard>
				) : null}
				{devices.length > 0 ? (
					<SettingsGroup>
						{devices.map((device) => (
							<PairedPhoneRow
								actions={actions}
								busy={mutation.isPending}
								canApprove={canApprove}
								device={device}
								key={device.device_id}
							/>
						))}
					</SettingsGroup>
				) : null}
			</SettingsSection>
			{query.isLoading ? null : (
				// Revoking app sign-ins does not depend on device tools: keep it
				// available when the device list fails (503, or 403 without a
				// principal) so the control is there when other things break.
				<AppDelegationsPanel
					defaultUserId={memberUserId}
					key={`${target.url}|${memberUserId ?? ""}`}
					target={target}
				/>
			)}
		</>
	);
}

/** The active node's paired phones, wired to the node store and session. */
export function PairedPhonesSection() {
	const activeNode = useActiveNode();
	const { data: session } = useSession();
	const target = toTarget(activeNode);
	return (
		<PairedPhonesPanel
			canApprove={isLocalNode(activeNode)}
			selfUserId={session?.user.id ?? null}
			target={target}
		/>
	);
}
