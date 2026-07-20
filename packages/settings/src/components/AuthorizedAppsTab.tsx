import { Button } from "@ryu/ui/components/button";
import { Separator } from "@ryu/ui/components/separator";
import { Spinner } from "@ryu/ui/components/spinner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { AppWindow, Trash2 } from "lucide-react";
import { useState } from "react";
import { sileo } from "sileo";
import { settingsApi } from "../utils/api-client.ts";

export function AuthorizedAppsTab() {
	const queryClient = useQueryClient();

	const { data, isLoading } = useQuery({
		queryKey: ["oauth-apps"],
		queryFn: settingsApi.oauthApps.list,
		staleTime: 5 * 60 * 1000,
	});

	const revokeMutation = useMutation({
		mutationFn: settingsApi.oauthApps.revoke,
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["oauth-apps"] });
			sileo.success({ title: "Access revoked" });
		},
		onError: () => sileo.error({ title: "Failed to revoke access" }),
	});

	const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);

	if (isLoading) {
		return (
			<div className="flex items-center justify-center py-8">
				<Spinner className="size-5" />
			</div>
		);
	}

	const apps = data?.apps ?? [];

	return (
		<div className="space-y-4">
			<div>
				<h3 className="font-medium text-sm">Authorized Apps</h3>
				<p className="mt-0.5 text-muted-foreground text-xs">
					Applications that have been granted access to your account.
				</p>
			</div>

			<Separator />

			<div className="space-y-2">
				{apps.length === 0 && (
					<p className="py-4 text-center text-muted-foreground text-sm">
						No authorized apps.
					</p>
				)}
				{apps.map((app) => {
					const isConfirming = confirmRevoke === app.clientId;
					const scopeList = app.scopes
						.split(/[\s,]+/)
						.filter(Boolean)
						.join(", ");

					return (
						<div
							className="flex items-center gap-3 rounded-lg border p-3"
							key={app.clientId}
						>
							<AppWindow className="size-4 shrink-0 text-muted-foreground" />
							<div className="min-w-0 flex-1">
								<p className="truncate font-medium text-sm">{app.clientName}</p>
								<p className="text-muted-foreground text-xs">
									{scopeList} · Authorized{" "}
									{formatDistanceToNow(new Date(app.grantedAt), {
										addSuffix: true,
									})}
								</p>
							</div>
							{isConfirming ? (
								<div className="flex shrink-0 items-center gap-2">
									<span className="text-muted-foreground text-xs">
										Revoke access?
									</span>
									<Button
										disabled={revokeMutation.isPending}
										onClick={() => {
											revokeMutation.mutate(app.clientId);
											setConfirmRevoke(null);
										}}
										size="sm"
										variant="destructive"
									>
										Revoke
									</Button>
									<Button
										onClick={() => setConfirmRevoke(null)}
										size="sm"
										variant="ghost"
									>
										Cancel
									</Button>
								</div>
							) : (
								<Button
									aria-label="Revoke access"
									className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
									disabled={revokeMutation.isPending}
									onClick={() => setConfirmRevoke(app.clientId)}
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
