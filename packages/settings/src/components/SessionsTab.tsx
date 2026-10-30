import { ComputerIcon, Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
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
import { settingsApi } from "../utils/api-client.ts";
import {
	SETTINGS_ROW_REVEAL_CLASS,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-rows.tsx";

export function SessionsTab() {
	const queryClient = useQueryClient();

	const { data, isLoading } = useQuery({
		queryKey: ["sessions"],
		queryFn: settingsApi.sessions.list,
		staleTime: 5 * 60 * 1000, // 5 minutes
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
		return <SkeletonRows label="Loading sessions" />;
	}

	const sessions = data?.sessions ?? [];

	return (
		<div>
			<SettingsSection
				caption="Revoke any device you don't recognize."
				headerAction={
					sessions.length > 1 &&
					(confirmRevokeAll ? (
						<div className="flex flex-wrap items-center justify-end gap-2">
							<span className="text-detail text-muted-foreground">
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
				{sessions.length === 0 ? (
					<p className="py-3 text-muted-foreground text-sm">
						No active sessions.
					</p>
				) : (
					<SettingsGroup>
						{sessions.map((session) => {
							const isCurrent = session.isCurrent === true;

							return (
								// A block wrapper, not `display: contents`: the flush group
								// draws its hairlines on its direct children, and a
								// `contents` box paints no border.
								<div data-testid="session-row" key={session.id}>
									<SettingsItem
										actions={
											isCurrent ? null : (
												<Button
													aria-label="Revoke session"
													className={SETTINGS_ROW_REVEAL_CLASS}
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
										description={
											<>
												{session.ipAddress && `${session.ipAddress} · `}
												Created{" "}
												{formatDistanceToNow(new Date(session.createdAt), {
													addSuffix: true,
												})}
											</>
										}
										title={
											<span className="flex min-w-0 items-center gap-2">
												<HugeiconsIcon
													className="shrink-0 text-muted-foreground"
													icon={ComputerIcon}
													size={16}
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
									/>
								</div>
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
								? `${pendingRevoke.label} will be signed out and must sign in again to use your account.`
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
