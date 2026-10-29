import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
import { Item, ItemActions, ItemTitle } from "@ryu/ui/components/item.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { sileo } from "sileo";
import { settingsApi } from "../utils/api-client.ts";
import {
	SETTINGS_SECTION_HEADER_CLASS,
	SettingsCard,
	SettingsGroup,
	SettingsSection,
} from "./shared/settings-rows.tsx";

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
		onError: (e) =>
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

	const intro =
		"Let Ryu support temporarily act on your account to help you. Off by default, scoped to what you choose, auto-expires within an hour, and revocable any time. Every support session is logged below.";

	return (
		<div className="space-y-6">
			{isActive && grant ? (
				<SettingsSection caption={intro}>
					<SettingsGroup>
						<Item purpose="settings-row" size="sm">
							<div className="flex w-full items-center justify-between gap-3">
								<div className="flex min-w-0 flex-1 items-center gap-2">
									<ShieldCheck className="size-4 shrink-0 text-status-warning" />
									<ItemTitle typography="settings-label">
										Support access is active
									</ItemTitle>
									{grant.activeSession && (
										<Badge variant="secondary">Session in progress</Badge>
									)}
								</div>
								<ItemActions className="shrink-0">
									<Button
										disabled={revokeMutation.isPending}
										onClick={() => revokeMutation.mutate()}
										size="sm"
										variant="destructive"
									>
										Revoke access now
									</Button>
								</ItemActions>
							</div>
							<p className="text-muted-foreground text-xs leading-snug">
								Scopes: {grant.scopes.join(", ") || "none"}. Expires{" "}
								{formatDistanceToNow(new Date(grant.expiresAt), {
									addSuffix: true,
								})}
								.
							</p>
						</Item>
					</SettingsGroup>
				</SettingsSection>
			) : (
				<>
					<SettingsSection
						as="fieldset"
						caption={intro}
						className="min-w-0"
						headerAction={
							<Button
								disabled={
									grantMutation.isPending || selectedScopes.length === 0
								}
								onClick={() => grantMutation.mutate()}
								size="sm"
							>
								Grant support access
							</Button>
						}
						title="Choose what support can access"
						titleId="support-access-scopes"
					>
						<SettingsGroup>
							{SCOPE_OPTIONS.map((scope) => (
								<Item
									className="cursor-pointer"
									key={scope.id}
									purpose="settings-row"
									render={<label htmlFor={`scope-${scope.id}`} />}
									size="sm"
								>
									<div className="flex w-full items-center justify-between gap-3">
										<div className="flex min-w-0 flex-1 flex-col gap-0.5">
											<ItemTitle typography="settings-label">
												{scope.label}
											</ItemTitle>
											<span className="text-muted-foreground text-xs leading-snug">
												{scope.description}
											</span>
										</div>
										<Checkbox
											checked={selectedScopes.includes(scope.id)}
											id={`scope-${scope.id}`}
											onCheckedChange={(checked) =>
												toggleScope(scope.id, checked === true)
											}
										/>
									</div>
								</Item>
							))}
						</SettingsGroup>
					</SettingsSection>

					<div className="space-y-1.5">
						<Label
							className={SETTINGS_SECTION_HEADER_CLASS}
							htmlFor="support-note"
						>
							Note for support (optional)
						</Label>
						<Textarea
							id="support-note"
							maxLength={500}
							onChange={(e) => setNote(e.target.value)}
							placeholder="What do you need help with?"
							value={note}
						/>
					</div>
				</>
			)}

			<SettingsSection
				as="section"
				title="Support session log"
				titleId="support-session-log"
			>
				{audit.length === 0 ? (
					<SettingsCard>
						<p className="text-muted-foreground text-sm">
							No support sessions yet.
						</p>
					</SettingsCard>
				) : (
					<SettingsGroup>
						{audit.map((entry) => (
							<Item key={entry.id} purpose="settings-row" size="sm">
								<div className="flex w-full items-center justify-between gap-3">
									<ItemTitle typography="settings-label">
										{entry.actorEmail}
									</ItemTitle>
									<Badge variant={entry.endedAt ? "outline" : "secondary"}>
										{entry.endedAt ? (entry.endedReason ?? "ended") : "active"}
									</Badge>
								</div>
								<div className="space-y-0.5 text-muted-foreground text-xs leading-snug">
									<p>{entry.reason}</p>
									<p>
										Scopes: {entry.scopes.join(", ") || "none"} ·{" "}
										{formatDistanceToNow(new Date(entry.startedAt), {
											addSuffix: true,
										})}
									</p>
								</div>
							</Item>
						))}
					</SettingsGroup>
				)}
			</SettingsSection>
		</div>
	);
}
