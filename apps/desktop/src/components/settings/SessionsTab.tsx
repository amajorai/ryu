import { ComputerIcon, Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { settingsApi } from "@ryu/settings";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ryu/ui/components/alert-dialog.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { useState } from "react";
import { sileo } from "sileo";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

// Row actions stay hidden until the row is hovered or focused, matching the
// web settings rows (@ryu/settings SETTINGS_ROW_REVEAL_CLASS). Touch screens,
// which cannot hover, always show them.
const ROW_REVEAL_CLASS =
	"opacity-0 transition-opacity duration-150 focus-visible:opacity-100 group-focus-within/item:opacity-100 group-hover/item:opacity-100 group-hover/item:duration-0 [@media(hover:none)]:opacity-100";

export function SessionsTab() {
	const tl = useLiteralMessages();
	const queryClient = useQueryClient();

	const { data, isLoading, isError, refetch } = useQuery({
		queryKey: ["sessions"],
		queryFn: settingsApi.sessions.list,
	});

	const revokeMutation = useMutation({
		mutationFn: settingsApi.sessions.revoke,
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["sessions"] });
			sileo.success({ title: "Session revoked" });
		},
		onError: () => sileo.error({ title: "Failed to revoke session" }),
	});

	const revokeAllMutation = useMutation({
		mutationFn: settingsApi.sessions.revokeAllOthers,
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["sessions"] });
			sileo.success({ title: "All other sessions revoked" });
		},
		onError: () => sileo.error({ title: "Failed to revoke sessions" }),
	});

	const [confirmRevokeAll, setConfirmRevokeAll] = useState(false);
	const [pendingRevoke, setPendingRevoke] = useState<{
		id: string;
		label: string;
	} | null>(null);

	if (isLoading) {
		return <SkeletonRows spacing="section" />;
	}

	const sessions = data?.sessions ?? [];

	return (
		<div className="space-y-6">
			<SettingsSection
				caption="Every device signed in to your account. Revoke any you don't recognize."
				headerAction={
					sessions.length > 1 &&
					(confirmRevokeAll ? (
						<div className="flex items-center gap-2">
							<span className="text-muted-foreground text-xs">
								Revoke all other sessions?
							</span>
							<Button
								disabled={revokeAllMutation.isPending}
								onClick={() => {
									revokeAllMutation.mutate();
									setConfirmRevokeAll(false);
								}}
								size="sm"
								variant="destructive"
							>
								Confirm
							</Button>
							<Button
								onClick={() => setConfirmRevokeAll(false)}
								size="sm"
								variant="ghost"
							>
								Cancel
							</Button>
						</div>
					) : (
						<Button
							onClick={() => setConfirmRevokeAll(true)}
							size="sm"
							variant="ghost"
						>
							Revoke all others
						</Button>
					))
				}
				title="Active sessions"
			>
				{isError ? (
					<SettingsCard className="flex items-center justify-between gap-3">
						<p className="text-muted-foreground text-sm">
							We couldn't load your sessions. Check your connection and try
							again.
						</p>
						<Button
							className="shrink-0"
							onClick={() => refetch()}
							size="sm"
							variant="outline"
						>
							Retry
						</Button>
					</SettingsCard>
				) : sessions.length === 0 ? (
					<SettingsCard>
						<p className="text-center text-muted-foreground text-sm">
							You're signed in on this device, but the app's sign-in doesn't
							appear in the browser-session list. Sessions created by signing in
							on the web show up here.
						</p>
					</SettingsCard>
				) : (
					<SettingsGroup>
						{sessions.map((session) => {
							const isCurrent = session.isCurrent === true;

							return (
								<SettingsItem
									actions={
										!isCurrent && (
											<Button
												aria-label="Revoke session"
												className={ROW_REVEAL_CLASS}
												disabled={revokeMutation.isPending}
												onClick={() =>
													setPendingRevoke({
														id: session.id,
														label: session.userAgent
															? parseUserAgent(session.userAgent)
															: "Unknown device",
													})
												}
												size="icon-sm"
												variant="ghost-muted"
											>
												<HugeiconsIcon icon={Delete02Icon} size={16} />
											</Button>
										)
									}
									key={session.id}
									title={
										<span className="flex items-center gap-2">
											<HugeiconsIcon
												className="size-4 shrink-0 text-muted-foreground"
												icon={ComputerIcon}
											/>
											<span className="truncate">
												{session.userAgent
													? parseUserAgent(session.userAgent)
													: "Unknown device"}
											</span>
											{isCurrent && (
												<span className="shrink-0 font-normal text-detail text-muted-foreground">
													This device
												</span>
											)}
										</span>
									}
								>
									{/* Inline meta, not a `description`: a description would
									    close the card after every session and split one list
									    into a stack of single-row cards. */}
									<p className="text-muted-foreground text-xs">
										{session.ipAddress && `${session.ipAddress} · `}
										{tl("Created {timeAgo}", {
											timeAgo: formatDistanceToNow(
												new Date(session.createdAt),
												{
													addSuffix: true,
												}
											),
										})}
									</p>
								</SettingsItem>
							);
						})}
					</SettingsGroup>
				)}
			</SettingsSection>
			<AlertDialog
				onOpenChange={(open) => {
					if (!open) {
						setPendingRevoke(null);
					}
				}}
				open={pendingRevoke !== null}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Revoke this session?</AlertDialogTitle>
						<AlertDialogDescription>
							{pendingRevoke
								? tl(
										"{label} will be signed out and must sign in again to use your account.",
										{ label: pendingRevoke.label }
									)
								: ""}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							disabled={revokeMutation.isPending}
							onClick={() => {
								if (pendingRevoke) {
									revokeMutation.mutate(pendingRevoke.id);
								}
								setPendingRevoke(null);
							}}
							variant="destructive"
						>
							Revoke session
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}

function parseUserAgent(ua: string): string {
	if (ua.includes("Chrome")) {
		return "Chrome";
	}
	if (ua.includes("Firefox")) {
		return "Firefox";
	}
	if (ua.includes("Safari")) {
		return "Safari";
	}
	if (ua.includes("Edge")) {
		return "Edge";
	}
	return ua.slice(0, 40);
}
