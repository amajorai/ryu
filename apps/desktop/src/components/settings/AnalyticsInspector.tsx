// apps/desktop/src/components/settings/AnalyticsInspector.tsx
//
// The "what we send" inspector (P3 of
// docs/observability-analytics-support-access.md §4.2 — the Next.js
// `_TELEMETRY_DEBUG` idea surfaced in-app, plus Zed's "open telemetry log").
//
// Two views, both content-free:
//   1. Catalog: the static universe of every event the desktop CAN send (from the
//      typed AnalyticsEvent enum), with its scalar props — so the user can audit
//      exactly what is collectible, by name, before anything is sent.
//   2. Egress log: the running record of what WAS sent (the localStorage ring
//      buffer), newest first, with timestamps. Holds typed props only.
//
// It shows the random, account-unlinked install id and whether a project is
// configured, and offers a one-click clear of the egress log.

import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@ryu/ui/components/dialog";
import { ScrollArea } from "@ryu/ui/components/scroll-area";
import { useCallback, useEffect, useState } from "react";
import {
	ANALYTICS_EVENT_CATALOG,
	ANALYTICS_EVENT_NAMES,
	clearEgressLog,
	type EgressLogEntry,
	getEgressLog,
	getInstallId,
	isAnalyticsConfigured,
} from "@/src/lib/analytics.ts";

function formatProps(props: Record<string, string | number | boolean>): string {
	const entries = Object.entries(props);
	if (entries.length === 0) {
		return "(no props)";
	}
	return entries.map(([k, v]) => `${k}=${String(v)}`).join(", ");
}

function EgressRow({ entry }: { entry: EgressLogEntry }) {
	return (
		<div className="flex flex-col gap-0.5 border-border/50 border-b py-1.5 last:border-b-0">
			<div className="flex items-center justify-between gap-2">
				<code className="font-medium text-xs">{entry.event}</code>
				<span className="text-[10px] text-muted-foreground">
					{new Date(entry.at).toLocaleString()}
				</span>
			</div>
			<span className="text-[11px] text-muted-foreground">
				{formatProps(entry.props)}
			</span>
		</div>
	);
}

export function AnalyticsInspector() {
	const [open, setOpen] = useState(false);
	const [log, setLog] = useState<EgressLogEntry[]>([]);

	const refresh = useCallback(() => {
		setLog([...getEgressLog()].reverse());
	}, []);

	const handleOpenChange = useCallback(
		(next: boolean) => {
			setOpen(next);
			if (next) {
				refresh();
			}
		},
		[refresh]
	);

	const handleClear = useCallback(() => {
		clearEgressLog();
		refresh();
	}, [refresh]);

	// Keep the log live while the dialog is open so events sent by background
	// work (e.g. a model install completing) show up without reopening.
	useEffect(() => {
		if (!open) {
			return;
		}
		const interval = setInterval(refresh, 2000);
		return () => clearInterval(interval);
	}, [open, refresh]);

	const configured = isAnalyticsConfigured();

	return (
		<Dialog onOpenChange={handleOpenChange} open={open}>
			<DialogTrigger
				render={
					<Button size="sm" variant="outline">
						See what we send
					</Button>
				}
			/>
			<DialogContent className="max-w-2xl">
				<DialogHeader>
					<DialogTitle>What product analytics sends</DialogTitle>
					<DialogDescription>
						Anonymous, content-free events only. Install id (random, not linked
						to your account):{" "}
						<code className="text-[11px]">{getInstallId()}</code>.{" "}
						{configured
							? "A project is configured."
							: "No analytics project is configured, so nothing is sent."}
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-4">
					<section className="space-y-2">
						<h3 className="font-medium text-sm">
							Event catalog ({ANALYTICS_EVENT_NAMES.length})
						</h3>
						<p className="text-muted-foreground text-xs">
							Every event type the app can ever send. There is no free-text or
							content field in any of them.
						</p>
						<ScrollArea className="h-48 rounded-md border p-2">
							<div className="space-y-2">
								{ANALYTICS_EVENT_NAMES.map((name) => {
									const meta = ANALYTICS_EVENT_CATALOG[name];
									return (
										<div className="flex flex-col gap-1" key={name}>
											<div className="flex flex-wrap items-center gap-1.5">
												<code className="font-medium text-xs">{name}</code>
												{meta.props.map((prop) => (
													<Badge
														className="text-[10px]"
														key={prop}
														variant="secondary"
													>
														{prop}
													</Badge>
												))}
											</div>
											<span className="text-[11px] text-muted-foreground">
												{meta.description}
											</span>
										</div>
									);
								})}
							</div>
						</ScrollArea>
					</section>

					<section className="space-y-2">
						<div className="flex items-center justify-between">
							<h3 className="font-medium text-sm">Egress log ({log.length})</h3>
							<div className="flex items-center gap-1">
								<Button
									onClick={refresh}
									size="sm"
									title="Refresh the log"
									variant="ghost"
								>
									Refresh
								</Button>
								<Button
									disabled={log.length === 0}
									onClick={handleClear}
									size="sm"
									variant="ghost"
								>
									Clear log
								</Button>
							</div>
						</div>
						<p className="text-muted-foreground text-xs">
							A local record of events actually sent from this install, newest
							first.
						</p>
						<ScrollArea className="h-40 rounded-md border p-2">
							{log.length === 0 ? (
								<p className="py-4 text-center text-muted-foreground text-xs">
									Nothing sent yet.
								</p>
							) : (
								<div>
									{log.map((entry) => (
										<EgressRow
											entry={entry}
											key={`${entry.event}-${entry.at}`}
										/>
									))}
								</div>
							)}
						</ScrollArea>
					</section>
				</div>
			</DialogContent>
		</Dialog>
	);
}
