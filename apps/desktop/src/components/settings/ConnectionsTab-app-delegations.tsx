import { useLiteralMessages } from "@ryu/i18n/react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@ryu/ui/components/alert-dialog.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { useMutation } from "@tanstack/react-query";
import { useId, useState } from "react";
import { sileo } from "sileo";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	isForbidden,
	isRouteMissing,
	memberUserIdProblem,
	revokeMemberAppDelegations,
} from "@/src/lib/api/paired-phones.ts";
import { SettingsCard, SettingsSection } from "./shared/settings-items.tsx";

function useRevokeError(error: unknown): string | null {
	const tl = useLiteralMessages();
	if (!error) {
		return null;
	}
	if (isRouteMissing(error)) {
		return tl("This node can't revoke app sign-ins yet. Update Ryu on it.");
	}
	if (isForbidden(error)) {
		return tl(
			"Only that member, an admin of this node's organization or the node owner can revoke these sign-ins."
		);
	}
	return error instanceof Error
		? error.message
		: tl("Couldn't revoke app sign-ins.");
}

/**
 * Revoke every outstanding app route delegation of one member on this node.
 * Apps that were handed a delegation for that member stop working until the
 * member opens them again. Defaults to the signed-in member.
 */
export function AppDelegationsPanel({
	defaultUserId,
	target,
}: {
	defaultUserId: string | null;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const inputId = useId();
	const [userId, setUserId] = useState(defaultUserId ?? "");
	const [confirming, setConfirming] = useState(false);
	// A different node or principal must never inherit the previous member: the
	// field resets to the new default whenever either changes.
	const identity = `${target.url}|${defaultUserId ?? ""}`;
	const [shownIdentity, setShownIdentity] = useState(identity);
	if (shownIdentity !== identity) {
		setShownIdentity(identity);
		setUserId(defaultUserId ?? "");
		setConfirming(false);
	}
	const mutation = useMutation({
		mutationFn: (member: string) => revokeMemberAppDelegations(target, member),
		onSuccess: (result) => {
			sileo.success({
				title: tl("App sign-ins revoked for {member}", {
					member: result.user_id,
				}),
			});
		},
	});
	const problem = memberUserIdProblem(userId);
	const errorText = useRevokeError(mutation.error);
	const trimmed = userId.trim();

	return (
		<SettingsSection
			caption="Apps on this node act for a member with a short-lived sign-in. Revoking signs that member out of every app at once; they sign in again the next time they open one."
			title="App sign-ins"
		>
			<SettingsCard className="space-y-3">
				<div className="space-y-1.5">
					<Label htmlFor={inputId}>Member user ID</Label>
					<div className="flex items-center gap-2">
						<Input
							autoCapitalize="off"
							autoCorrect="off"
							disabled={mutation.isPending}
							id={inputId}
							onChange={(event) => {
								setUserId(event.target.value);
								mutation.reset();
							}}
							value={userId}
							variant="code-caption"
						/>
						<AlertDialog onOpenChange={setConfirming} open={confirming}>
							<AlertDialogTrigger
								render={
									<Button
										disabled={problem !== null || mutation.isPending}
										size="sm"
										variant="outline"
									/>
								}
							>
								{mutation.isPending ? "Revoking…" : "Revoke"}
							</AlertDialogTrigger>
							<AlertDialogContent>
								<AlertDialogHeader>
									<AlertDialogTitle>
										{tl("Revoke app sign-ins for {member}?", {
											member: trimmed,
										})}
									</AlertDialogTitle>
									<AlertDialogDescription>
										{tl(
											"Every app on {node} stops acting for this member until they open it again.",
											{ node: target.url }
										)}
									</AlertDialogDescription>
								</AlertDialogHeader>
								<AlertDialogFooter>
									<AlertDialogCancel>Cancel</AlertDialogCancel>
									<AlertDialogAction
										onClick={() => {
											setConfirming(false);
											mutation.mutate(trimmed);
										}}
									>
										Revoke
									</AlertDialogAction>
								</AlertDialogFooter>
							</AlertDialogContent>
						</AlertDialog>
					</div>
					{problem === "too_long" ? (
						<p className="text-status-destructive text-xs" role="alert">
							That user ID is too long.
						</p>
					) : null}
					{errorText ? (
						<p className="text-status-destructive text-xs" role="alert">
							{errorText}
						</p>
					) : null}
				</div>
			</SettingsCard>
		</SettingsSection>
	);
}
