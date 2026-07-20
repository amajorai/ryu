import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import { Separator } from "@ryu/ui/components/separator";
import { Spinner } from "@ryu/ui/components/spinner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { Monitor, Trash2 } from "lucide-react";
import { useState } from "react";
import { sileo } from "sileo";
import { settingsApi } from "../utils/api-client.ts";

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

	if (isLoading) {
		return (
			<div className="flex items-center justify-center py-8">
				<Spinner className="size-5" />
			</div>
		);
	}

	const sessions = data?.sessions ?? [];

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between">
				<div>
					<h3 className="font-medium text-sm">Active Sessions</h3>
					<p className="mt-0.5 text-muted-foreground text-xs">
						Manage where you're signed in.
					</p>
				</div>
				{sessions.length > 1 &&
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
							variant="outline"
						>
							Revoke all others
						</Button>
					))}
			</div>

			<Separator />

			<div className="space-y-2">
				{sessions.length === 0 && (
					<p className="py-4 text-center text-muted-foreground text-sm">
						No active sessions.
					</p>
				)}
				{sessions.map((session) => {
					// Heuristic: the current session is the one whose userId matches and is the most recently used
					// We identify it by checking the stored bearer token against session IDs isn't possible,
					// so we mark the first/most-recent one as current.
					const isCurrent = session.id === sessions[0]?.id;

					return (
						<div
							className="flex items-center gap-3 rounded-lg border p-3"
							key={session.id}
						>
							<Monitor className="size-4 shrink-0 text-muted-foreground" />
							<div className="min-w-0 flex-1">
								<div className="flex items-center gap-2">
									<p className="truncate font-medium text-sm">
										{session.userAgent
											? parseUserAgent(session.userAgent)
											: "Unknown device"}
									</p>
									{isCurrent && (
										<Badge className="shrink-0 text-xs" variant="secondary">
											This device
										</Badge>
									)}
								</div>
								<p className="text-muted-foreground text-xs">
									{session.ipAddress && `${session.ipAddress} · `}
									Created{" "}
									{formatDistanceToNow(new Date(session.createdAt), {
										addSuffix: true,
									})}
								</p>
							</div>
							{!isCurrent && (
								<Button
									aria-label="Revoke session"
									className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
									disabled={revokeMutation.isPending}
									onClick={() => revokeMutation.mutate(session.id)}
									size="icon"
									variant="ghost"
								>
									<Trash2 className="size-4" />
								</Button>
							)}
						</div>
					);
				})}
			</div>
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
