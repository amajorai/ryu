import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import { Checkbox } from "@ryu/ui/components/checkbox";
import { Label } from "@ryu/ui/components/label";
import { Separator } from "@ryu/ui/components/separator";
import { Spinner } from "@ryu/ui/components/spinner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { LifeBuoy, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { sileo } from "sileo";
import { settingsApi } from "../utils/api-client.ts";

// Least-privilege scopes the user can consent to. Labels are user-facing.
const SCOPE_OPTIONS: { id: string; label: string; description: string }[] = [
	{
		id: "billing",
		label: "Billing",
		description: "Invoices, payment status, plan.",
	},
	{
		id: "subscription",
		label: "Subscription",
		description: "Subscription and entitlement state.",
	},
	{
		id: "organization",
		label: "Organization",
		description: "Org membership and roles.",
	},
	{
		id: "sync-status",
		label: "Sync status",
		description: "Sync mirror metadata (no content).",
	},
	{
		id: "channels",
		label: "Channels",
		description: "Bot channel configuration.",
	},
	{
		id: "marketplace",
		label: "Marketplace",
		description: "Your licenses and listings.",
	},
];

export function SupportAccessTab() {
	const queryClient = useQueryClient();
	const [selectedScopes, setSelectedScopes] = useState<string[]>(["billing"]);
	const [note, setNote] = useState("");

	const { data: statusData, isLoading } = useQuery({
		queryKey: ["support-access"],
		queryFn: settingsApi.supportAccess.status,
		// Poll while active so the tab reflects revoke/expiry promptly.
		refetchInterval: 30_000,
	});

	const { data: auditData } = useQuery({
		queryKey: ["support-access-audit"],
		queryFn: settingsApi.supportAccess.audit,
		staleTime: 60_000,
	});

	const grantMutation = useMutation({
		mutationFn: () =>
			settingsApi.supportAccess.grant({
				scopes: selectedScopes,
				note: note || undefined,
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["support-access"] });
			sileo.success({ title: "Support access granted" });
		},
		onError: (e: unknown) =>
			sileo.error({
				title:
					e instanceof Error ? e.message : "Failed to grant support access",
			}),
	});

	const revokeMutation = useMutation({
		mutationFn: settingsApi.supportAccess.revoke,
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["support-access"] });
			queryClient.invalidateQueries({ queryKey: ["support-access-audit"] });
			sileo.success({ title: "Support access revoked" });
		},
		onError: () => sileo.error({ title: "Failed to revoke support access" }),
	});

	if (isLoading) {
		return (
			<div className="flex items-center justify-center py-8">
				<Spinner className="size-5" />
			</div>
		);
	}

	const grant = statusData?.grant ?? null;
	const isActive = grant?.status === "active";
	const audit = auditData?.audit ?? [];

	const toggleScope = (id: string, checked: boolean) => {
		setSelectedScopes((prev) =>
			checked ? [...new Set([...prev, id])] : prev.filter((s) => s !== id)
		);
	};

	return (
		<div className="space-y-6">
			<div>
				<h3 className="flex items-center gap-2 font-medium text-sm">
					<LifeBuoy className="size-4" />
					Support access
				</h3>
				<p className="mt-0.5 text-muted-foreground text-xs">
					Let Ryu support temporarily act on your account to help you. Off by
					default, scoped to what you choose, auto-expires within an hour, and
					revocable any time. Every support session is logged below.
				</p>
			</div>

			<Separator />

			{isActive && grant ? (
				<div className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
					<div className="flex items-center gap-2">
						<ShieldCheck className="size-4 text-amber-600" />
						<p className="font-medium text-sm">Support access is active</p>
						{grant.activeSession && (
							<Badge className="text-xs" variant="secondary">
								Session in progress
							</Badge>
						)}
					</div>
					<p className="text-muted-foreground text-xs">
						Scopes: {grant.scopes.join(", ") || "none"}. Expires{" "}
						{formatDistanceToNow(new Date(grant.expiresAt), {
							addSuffix: true,
						})}
						.
					</p>
					<Button
						disabled={revokeMutation.isPending}
						onClick={() => revokeMutation.mutate()}
						size="sm"
						variant="destructive"
					>
						Revoke access now
					</Button>
				</div>
			) : (
				<div className="space-y-4">
					<fieldset className="space-y-2">
						<legend className="font-medium text-sm">
							Choose what support can access
						</legend>
						{SCOPE_OPTIONS.map((scope) => (
							<label
								className="flex cursor-pointer items-start gap-3 rounded-md border p-3"
								htmlFor={`scope-${scope.id}`}
								key={scope.id}
							>
								<Checkbox
									checked={selectedScopes.includes(scope.id)}
									id={`scope-${scope.id}`}
									onCheckedChange={(checked) =>
										toggleScope(scope.id, checked === true)
									}
								/>
								<span className="min-w-0">
									<span className="block font-medium text-sm">
										{scope.label}
									</span>
									<span className="block text-muted-foreground text-xs">
										{scope.description}
									</span>
								</span>
							</label>
						))}
					</fieldset>

					<div className="space-y-1.5">
						<Label className="text-xs" htmlFor="support-note">
							Note for support (optional)
						</Label>
						<textarea
							className="min-h-16 w-full rounded-md border bg-transparent px-3 py-2 text-sm"
							id="support-note"
							maxLength={500}
							onChange={(e) => setNote(e.target.value)}
							placeholder="What do you need help with?"
							value={note}
						/>
					</div>

					<Button
						disabled={grantMutation.isPending || selectedScopes.length === 0}
						onClick={() => grantMutation.mutate()}
					>
						Grant support access
					</Button>
				</div>
			)}

			<Separator />

			<div className="space-y-2">
				<h4 className="font-medium text-sm">Support session log</h4>
				{audit.length === 0 ? (
					<p className="py-4 text-center text-muted-foreground text-sm">
						No support sessions yet.
					</p>
				) : (
					<div className="space-y-2">
						{audit.map((entry) => (
							<div className="rounded-lg border p-3" key={entry.id}>
								<div className="flex items-center justify-between gap-2">
									<p className="font-medium text-sm">{entry.actorEmail}</p>
									<Badge
										className="text-xs"
										variant={entry.endedAt ? "outline" : "secondary"}
									>
										{entry.endedAt ? (entry.endedReason ?? "ended") : "active"}
									</Badge>
								</div>
								<p className="mt-1 text-muted-foreground text-xs">
									{entry.reason}
								</p>
								<p className="mt-1 text-muted-foreground text-xs">
									Scopes: {entry.scopes.join(", ") || "none"} ·{" "}
									{formatDistanceToNow(new Date(entry.startedAt), {
										addSuffix: true,
									})}
								</p>
							</div>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
