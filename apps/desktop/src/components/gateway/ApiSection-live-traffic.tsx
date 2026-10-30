import { useLiteralMessages } from "@ryu/i18n/react";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ryu/ui/components/table.tsx";
import { formatNumber } from "@ryu/ui/lib/number-format.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useEffect, useRef, useState } from "react";
import {
	StatGrid,
	StatTile,
	StatusText,
} from "@/src/components/gateway/quiet.tsx";
import { SettingsSection } from "@/src/components/settings/shared/settings-items.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	subscribeGatewayTraffic,
	type TrafficEvent,
} from "@/src/lib/api/gateway.ts";
import { formatTime as formatDisplayTime } from "@/src/lib/timezone.ts";

/** How many traffic rows the dashboard keeps in memory. */
const TRAFFIC_WINDOW = 50;

function trafficSubject(event: TrafficEvent): string {
	if (event.event_type !== "service_call") {
		return event.model ?? "";
	}
	switch (event.command) {
		case "web.search":
			return "Web search";
		case "web.fetch":
			return "Web fetch";
		default:
			return "Web service";
	}
}
// ── Live traffic dashboard ───────────────────────────────────────────────────

/** HTTP status Core returns when the caller lacks `audit.view`. */
const TRAFFIC_FORBIDDEN_STATUS = 403;

export function LiveTraffic({
	canView,
	reachable,
	target,
}: {
	canView: boolean;
	reachable: boolean;
	target: ApiTarget;
}) {
	const [events, setEvents] = useState<TrafficEvent[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [connected, setConnected] = useState(false);
	const [denied, setDenied] = useState(false);
	const unsubscribeRef = useRef<(() => void) | null>(null);
	const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const cancelledRef = useRef(false);
	const tl = useLiteralMessages();

	useEffect(() => {
		setDenied(false);
		if (!(reachable && canView)) {
			setEvents([]);
			setConnected(false);
			return;
		}
		cancelledRef.current = false;
		let attempt = 0;

		const teardown = () => {
			if (reconnectRef.current) {
				clearTimeout(reconnectRef.current);
				reconnectRef.current = null;
			}
			unsubscribeRef.current?.();
			unsubscribeRef.current = null;
		};

		const connect = () => {
			if (cancelledRef.current) {
				return;
			}
			unsubscribeRef.current = subscribeGatewayTraffic(
				target,
				(ev) => {
					attempt = 0;
					setConnected(true);
					setError(null);
					setEvents((prev) => [ev, ...prev].slice(0, TRAFFIC_WINDOW));
				},
				(message, detail) => {
					setConnected(false);
					// A permission refusal is terminal: reconnecting cannot change
					// the caller's role, so stop instead of retrying forever.
					if (detail?.status === TRAFFIC_FORBIDDEN_STATUS) {
						setError(null);
						setEvents([]);
						setDenied(true);
						return;
					}
					setError(message);
					// Reconnect with backoff while the section is open.
					if (!cancelledRef.current) {
						attempt += 1;
						const delay = Math.min(1000 * 2 ** attempt, 15_000);
						reconnectRef.current = setTimeout(connect, delay);
					}
				}
			);
		};

		connect();
		return teardown;
	}, [canView, reachable, target]);

	if (!canView || denied) {
		return (
			<SettingsSection title="Live traffic">
				<p className="text-muted-foreground text-sm">
					Live traffic shows every member's requests, models, and cost. Ask an
					organization owner or admin for the audit.view permission to see it.
				</p>
			</SettingsSection>
		);
	}

	if (!reachable) {
		return (
			<SettingsSection title="Live traffic">
				<p className="text-muted-foreground text-sm">
					Live traffic shows once the gateway is reachable.
				</p>
			</SettingsSection>
		);
	}

	const total = events.length;
	const requests = events.filter((e) => e.event_type === "model_call").length;
	const tokens = events.reduce(
		(sum, e) => sum + (e.input_tokens ?? 0) + (e.output_tokens ?? 0),
		0
	);
	const errors = events.filter((e) => e.error).length;

	return (
		<SettingsSection
			caption="Every request this node completes, streamed live."
			headerAction={
				<StatusText tone={connected ? "success" : error ? "warning" : "muted"}>
					{connected ? "Live" : error ? "Reconnecting" : "Offline"}
				</StatusText>
			}
			title="Live traffic"
		>
			<StatGrid className="py-3">
				<StatTile label="Requests" value={formatNumber(total)} />
				<StatTile label="Tokens" value={formatTokens(tokens)} />
				<StatTile label="Errors" value={formatNumber(errors)} />
				<StatTile
					label="Error rate"
					value={requests === 0 ? "—" : formatPercent(errors / requests)}
				/>
			</StatGrid>

			{events.length === 0 ? (
				<p className="border-border border-t py-6 text-muted-foreground text-sm">
					{error
						? "Waiting for the feed to reconnect…"
						: "Send a request through this node and it appears here."}
				</p>
			) : (
				<Table className="min-w-[640px] text-sm">
					<TableHeader>
						<TableRow appearance="header">
							<TableHead className={HEAD}>Time</TableHead>
							<TableHead className={HEAD}>Model / service</TableHead>
							<TableHead className={HEAD}>Provider</TableHead>
							<TableHead className={HEAD}>Usage</TableHead>
							<TableHead className={HEAD}>Latency</TableHead>
							<TableHead className={HEAD}>Status</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{events.map((e) => (
							<TableRow className="border-border" key={e.request_id}>
								<TableCell
									className={cn(CELL, "text-muted-foreground tabular-nums")}
								>
									{formatTime(e.ts)}
								</TableCell>
								<TableCell
									className={cn(
										CELL,
										"max-w-[220px] truncate font-mono text-xs"
									)}
									title={trafficSubject(e)}
								>
									{trafficSubject(e)}
								</TableCell>
								<TableCell className={CELL}>{e.provider}</TableCell>
								<TableCell className={cn(CELL, "tabular-nums")}>
									{e.event_type === "service_call"
										? tl("{requests} requests / {documents} documents", {
												requests: formatNumber(e.service_usage?.requests ?? 0),
												documents: formatNumber(
													e.service_usage?.documents ?? 0
												),
											})
										: `${formatNumber(e.input_tokens ?? 0)} / ${formatNumber(e.output_tokens ?? 0)} tokens`}
								</TableCell>
								<TableCell className={cn(CELL, "tabular-nums")}>
									{e.latency_ms ?? 0}ms
								</TableCell>
								<TableCell className={CELL}>
									{e.error ? (
										<StatusText tone="destructive">Error</StatusText>
									) : e.cache_hit ? (
										<span className="text-muted-foreground">Cached</span>
									) : null}
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			)}
		</SettingsSection>
	);
}

const HEAD = "h-10 px-2 font-normal text-muted-foreground text-xs";
const CELL = "h-10 px-2 py-0";

function formatTokens(n: number): string {
	return formatNumber(n);
}

function formatPercent(ratio: number): string {
	return `${(ratio * 100).toFixed(0)}%`;
}

function formatTime(iso: string | undefined): string {
	if (!iso) {
		return "—";
	}
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) {
		return "—";
	}
	return formatDisplayTime(d, {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}
