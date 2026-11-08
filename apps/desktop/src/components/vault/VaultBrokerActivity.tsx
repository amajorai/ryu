// Broker activity for one environment: hosts agents asked for without a
// matching service (each with Create service, prefilled from the catalog when
// a template matches), and the brokered request log, newest first, refreshed
// while Live is on. Rows carry method, host, path and status only: never
// headers, bodies or credential values. Both need `list` on `sys/broker`.

import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
	SettingsCard,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	listVaultBrokerDiscoveredHosts,
	listVaultBrokerLogs,
	type VaultBrokerLogRow,
	type VaultBrokerStatusBucket,
} from "@/src/lib/api/vault-broker-console.ts";
import {
	type BrokerServiceDraft,
	VaultBrokerServiceDialog,
} from "./VaultBrokerServiceDialog.tsx";
import { serviceFormFromHost } from "./vault-broker-service-form.ts";
import { whenLabel } from "./vault-broker-summary.ts";
import { vaultErrorMessage } from "./vault-errors.ts";

export const LOG_PAGE_SIZE = 50;
export const LOG_LIVE_INTERVAL_MS = 5000;

const BUCKETS: VaultBrokerStatusBucket[] = ["2xx", "3xx", "4xx", "5xx"];

function isBucket(value: string): value is VaultBrokerStatusBucket {
	return BUCKETS.some((bucket) => bucket === value);
}

export function logLine(row: VaultBrokerLogRow): string {
	const port =
		(row.scheme === "https" && row.port === 443) ||
		(row.scheme === "http" && row.port === 80)
			? ""
			: `:${row.port}`;
	return `${row.method} ${row.host}${port}${row.path}`;
}

export function logDetail(row: VaultBrokerLogRow): string {
	return [
		whenLabel(row.at),
		row.service ?? "no service",
		row.outcome,
		`${row.latencyMs} ms`,
	].join(" · ");
}

function DiscoveredHosts({
	environment,
	target,
}: {
	environment: string;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const [draft, setDraft] = useState<BrokerServiceDraft | null>(null);
	const hostsQuery = useQuery({
		queryKey: ["vault", "broker", "discovered", target.url, environment],
		queryFn: () => listVaultBrokerDiscoveredHosts(target, environment),
	});
	const hosts = hostsQuery.data ?? [];
	return (
		<SettingsSection
			caption="Hosts agents asked for that no service matches. Create a service to broker them."
			title="Discovered hosts"
		>
			<SettingsCard className="divide-y p-0">
				{hostsQuery.isLoading ? (
					<SkeletonRows inset="panel" rows={2} />
				) : hostsQuery.error ? (
					<p className="p-4 text-sm text-status-destructive">
						{vaultErrorMessage(
							hostsQuery.error,
							"Could not load discovered hosts.",
							tl
						)}
					</p>
				) : hosts.length === 0 ? (
					<p className="p-6 text-center text-muted-foreground text-sm">
						No unmatched hosts.
					</p>
				) : (
					<ul className="divide-y">
						{hosts.map((host) => (
							<li
								className="flex items-center justify-between gap-4 px-4 py-3"
								key={`${host.host}:${host.port}`}
							>
								<div className="min-w-0">
									<p className="flex flex-wrap items-center gap-2 text-sm">
										<code className="font-medium font-mono">
											{host.port === 443
												? host.host
												: `${host.host}:${host.port}`}
										</code>
										{host.suggestedTemplate ? (
											<Badge variant="secondary">
												{host.suggestedTemplate}
											</Badge>
										) : null}
									</p>
									<p className="mt-0.5 text-muted-foreground text-xs">
										{tl("{requests} requests · last {when}", {
											requests: host.requests,
											when: whenLabel(new Date(host.lastSeen).toISOString()),
										})}
									</p>
								</div>
								<Button
									onClick={() =>
										setDraft({
											environment: host.environment,
											mode: "create",
											seed: serviceFormFromHost(host),
											template: host.suggestedTemplate,
										})
									}
									size="sm"
									variant="outline"
								>
									Create service
								</Button>
							</li>
						))}
					</ul>
				)}
			</SettingsCard>
			<VaultBrokerServiceDialog
				draft={draft}
				onOpenChange={(open) => {
					if (!open) {
						setDraft(null);
					}
				}}
				target={target}
			/>
		</SettingsSection>
	);
}

function RequestLog({
	environment,
	target,
}: {
	environment: string;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const [live, setLive] = useState(true);
	const [bucket, setBucket] = useState<VaultBrokerStatusBucket | "">("");
	const logsQuery = useInfiniteQuery({
		queryKey: ["vault", "broker", "logs", target.url, environment, bucket],
		queryFn: ({ pageParam }) =>
			listVaultBrokerLogs(target, {
				before: pageParam,
				environment,
				limit: LOG_PAGE_SIZE,
				statusBucket: bucket || undefined,
			}),
		initialPageParam: undefined as number | undefined,
		getNextPageParam: (page) =>
			page.length === LOG_PAGE_SIZE
				? Math.min(...page.map((row) => row.id))
				: undefined,
		refetchInterval: live ? LOG_LIVE_INTERVAL_MS : false,
	});
	const rows = logsQuery.data?.pages.flat() ?? [];
	return (
		<SettingsSection
			caption="Requests agents sent through the broker. Headers, bodies and credentials are never recorded."
			headerAction={
				<div className="flex items-center gap-3">
					<NativeSelect
						aria-label="Status"
						onChange={(event) => {
							const next = event.target.value;
							setBucket(isBucket(next) ? next : "");
						}}
						size="sm"
						value={bucket}
					>
						<NativeSelectOption value="">All statuses</NativeSelectOption>
						{BUCKETS.map((item) => (
							<NativeSelectOption key={item} value={item}>
								{item}
							</NativeSelectOption>
						))}
					</NativeSelect>
					<div className="flex items-center gap-2">
						<Switch
							checked={live}
							id="broker-log-live"
							onCheckedChange={(on: boolean) => setLive(on)}
						/>
						<Label htmlFor="broker-log-live">Live</Label>
					</div>
				</div>
			}
			title="Request log"
		>
			<SettingsCard className="divide-y p-0">
				{logsQuery.isLoading ? (
					<SkeletonRows inset="panel" rows={3} />
				) : logsQuery.error ? (
					<p className="p-4 text-sm text-status-destructive">
						{vaultErrorMessage(
							logsQuery.error,
							"Could not load the request log.",
							tl
						)}
					</p>
				) : rows.length === 0 ? (
					<p className="p-6 text-center text-muted-foreground text-sm">
						No brokered requests yet.
					</p>
				) : (
					<ul className="divide-y">
						{rows.map((row) => (
							<li className="flex items-start gap-3 px-4 py-2" key={row.id}>
								<Badge variant={row.status >= 400 ? "destructive" : "outline"}>
									{row.status || "—"}
								</Badge>
								<div className="min-w-0">
									<p
										className="truncate font-mono text-xs"
										title={logLine(row)}
									>
										{logLine(row)}
									</p>
									<p className="mt-0.5 truncate text-muted-foreground text-xs">
										{logDetail(row)}
									</p>
								</div>
							</li>
						))}
					</ul>
				)}
				{logsQuery.hasNextPage ? (
					<div className="p-2 text-center">
						<Button
							disabled={logsQuery.isFetchingNextPage}
							onClick={() => logsQuery.fetchNextPage()}
							size="sm"
							variant="ghost"
						>
							Load older
						</Button>
					</div>
				) : null}
			</SettingsCard>
		</SettingsSection>
	);
}

export function BrokerActivity({
	environment,
	target,
}: {
	environment: string;
	target: ApiTarget;
}) {
	return (
		<>
			<DiscoveredHosts environment={environment} target={target} />
			<RequestLog environment={environment} target={target} />
		</>
	);
}
