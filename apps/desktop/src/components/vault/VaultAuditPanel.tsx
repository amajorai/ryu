// Recent vault audit rows (never values) with a tamper-evidence check of the
// HMAC chain. Both routes need the vault `admin` capability.

import { SecurityCheckIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
	SettingsCard,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	listVaultAudit,
	type VaultAuditEvent,
	verifyVaultAudit,
} from "@/src/lib/api/vault.ts";
import { formatDateTime } from "@/src/lib/timezone.ts";
import { isForbidden, vaultErrorMessage } from "./vault-errors.ts";
import { ROOT_FOLDER } from "./vault-view.ts";

const AUDIT_PAGE_SIZE = 100;

function actorLabel(event: VaultAuditEvent): string {
	return event.actor.id
		? `${event.actor.kind} ${event.actor.id}`
		: event.actor.kind;
}

function subjectLabel(event: VaultAuditEvent): string {
	const parts: string[] = [];
	if (event.environment) {
		parts.push(event.environment);
	}
	if (event.path && event.path !== ROOT_FOLDER) {
		parts.push(event.path);
	}
	if (event.name) {
		parts.push(event.name);
	}
	return parts.join(" · ");
}

function whenLabel(value: string): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : formatDateTime(value);
}

export function VaultAuditPanel({ target }: { target: ApiTarget }) {
	const tl = useLiteralMessages();
	const auditQuery = useQuery({
		queryKey: ["vault", "audit", target.url],
		queryFn: () => listVaultAudit(target, { limit: AUDIT_PAGE_SIZE }),
	});
	const verifyMutation = useMutation({
		mutationFn: () => verifyVaultAudit(target),
	});
	const report = verifyMutation.data;

	if (isForbidden(auditQuery.error)) {
		return (
			<SettingsCard className="p-6 text-center">
				<p className="font-medium text-sm">Admins only</p>
				<p className="mt-1 text-muted-foreground text-sm">
					Ask a vault admin to review the audit log.
				</p>
			</SettingsCard>
		);
	}

	return (
		<SettingsSection
			caption="Every reveal, export, write, and runtime use is recorded without the value. Each row is chained to the one before it, so an edited or removed row breaks the check."
			headerAction={
				<Button
					disabled={verifyMutation.isPending}
					loading={verifyMutation.isPending}
					onClick={() => verifyMutation.mutate()}
					size="sm"
					variant="ghost"
				>
					<HugeiconsIcon className="size-4" icon={SecurityCheckIcon} />
					Verify chain
				</Button>
			}
			title="Recent activity"
		>
			{report ? (
				<p
					className={
						report.ok
							? "px-3.5 text-muted-foreground text-xs"
							: "px-3.5 text-status-destructive text-xs"
					}
					role="status"
				>
					{report.ok
						? tl("Chain intact across {rows} rows.", { rows: report.rows })
						: tl("Chain broken at row {row}.", {
								row: report.firstBadSeq ?? "?",
							})}
				</p>
			) : null}
			{verifyMutation.error ? (
				<p className="px-3.5 text-status-destructive text-xs" role="status">
					{vaultErrorMessage(verifyMutation.error, "Could not verify.")}
				</p>
			) : null}
			<SettingsCard className="divide-y p-0">
				{auditQuery.isLoading ? (
					<SkeletonRows inset="panel" rows={4} />
				) : auditQuery.error ? (
					<p className="p-4 text-sm text-status-destructive">
						{vaultErrorMessage(
							auditQuery.error,
							"Could not load the audit log."
						)}
					</p>
				) : auditQuery.data?.events.length ? (
					<ul className="divide-y">
						{auditQuery.data.events.map((event) => (
							<li
								className="flex items-start justify-between gap-4 px-4 py-3"
								key={event.seq}
							>
								<div className="min-w-0">
									<p className="flex flex-wrap items-center gap-2 text-sm">
										<code className="font-mono">{event.action}</code>
										{event.outcome === "ok" ? null : (
											<Badge variant="destructive">{event.outcome}</Badge>
										)}
									</p>
									<p className="mt-0.5 truncate text-muted-foreground text-xs">
										{[actorLabel(event), subjectLabel(event)]
											.filter(Boolean)
											.join(" · ")}
									</p>
								</div>
								<span className="shrink-0 text-muted-foreground text-xs">
									{whenLabel(event.at)}
								</span>
							</li>
						))}
					</ul>
				) : (
					<p className="p-6 text-center text-muted-foreground text-sm">
						No vault activity yet.
					</p>
				)}
			</SettingsCard>
		</SettingsSection>
	);
}
