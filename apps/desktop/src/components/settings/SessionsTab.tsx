import { ComputerIcon, Delete01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { settingsApi } from "@ryu/settings";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import { Spinner } from "@ryu/ui/components/spinner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { useState } from "react";
import { sileo } from "sileo";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";
export function SessionsTab() {
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

	if (isLoading) {
		return (
			<div className="flex items-center justify-center py-8">
				<Spinner className="size-5" />
			</div>
		);
	}

	const sessions = data?.sessions ?? [];

	return (
		<div className="space-y-6">
			<SettingsSection
				caption="Manage where you're signed in."
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
					<div className="flex flex-col items-center gap-3 px-3 py-6 text-center">
						<p className="text-muted-foreground text-sm">
							We couldn't load your sessions. Check your connection and try
							again.
						</p>
						<Button onClick={() => refetch()} size="sm" variant="outline">
							Retry
						</Button>
					</div>
				) : sessions.length === 0 ? (
					<p className="px-3 py-4 text-center text-muted-foreground text-sm">
						You're signed in on this device, but the app's sign-in doesn't
						appear in the browser-session list. Sessions created by signing in
						on the web show up here.
					</p>
				) : (
					<SettingsGroup>
						{sessions.map((session) => {
							// Heuristic: the current session is the one whose userId matches and is the most recently used
							// We identify it by checking the stored bearer token against session IDs isn't possible,
							// so we mark the first/most-recent one as current.
							const isCurrent = session.id === sessions[0]?.id;

							return (
								<SettingsItem
									actions={
										!isCurrent && (
											<Button
												aria-label="Revoke session"
												className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
												disabled={revokeMutation.isPending}
												onClick={() => revokeMutation.mutate(session.id)}
												size="icon"
												variant="ghost"
											>
												<HugeiconsIcon className="size-4" icon={Delete01Icon} />
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
												<Badge className="shrink-0 text-xs" variant="secondary">
													This device
												</Badge>
											)}
										</span>
									}
								/>
							);
						})}
					</SettingsGroup>
				)}
			</SettingsSection>
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
