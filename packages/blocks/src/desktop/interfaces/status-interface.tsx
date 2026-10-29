import { Button } from "@ryu/ui/components/button.tsx";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { CircleAlert, CircleCheck, Plus, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import {
	agentById,
	type InterfaceRendererProps,
} from "./interface-renderer.ts";
import { useNow, useThreadPanelFocus } from "./interface-thread-panel.ts";
import { StatusComponents } from "./status-components.tsx";
import {
	StatusHistory,
	StatusMaintenanceList,
	StatusOpenIncidents,
} from "./status-incidents.tsx";
import {
	buildStatusPage,
	OVERALL_LABELS,
	type OverallState,
	type StatusIncident,
} from "./status-model.ts";
import { StatusThreadPanel } from "./status-panel.tsx";

/** How often "now" (ages, today's bar, the banner time) refreshes. */
const CLOCK_TICK_MS = 60_000;

const BANNER: Record<OverallState, string> = {
	degraded: "bg-warning text-warning-foreground",
	operational: "bg-success text-success-foreground",
	partial: "bg-destructive text-background",
};

const BANNER_ICON = {
	degraded: TriangleAlert,
	operational: CircleCheck,
	partial: CircleAlert,
} as const;

const clockFormat = new Intl.DateTimeFormat("en-US", {
	hour: "numeric",
	minute: "2-digit",
});

function StatusBanner({ now, state }: { now: number; state: OverallState }) {
	const Icon = BANNER_ICON[state];
	return (
		<div
			className={cn(
				"flex items-center gap-3 rounded-md px-5 py-4 max-sm:px-4",
				BANNER[state]
			)}
			data-state={state}
			data-testid="status-banner"
			role="status"
		>
			<Icon aria-hidden="true" className="size-5 shrink-0" />
			<p className="min-w-0 flex-1 font-semibold text-lg leading-7">
				{OVERALL_LABELS[state]}
			</p>
			<p className="shrink-0 text-sm opacity-80 max-sm:hidden">
				Updated{" "}
				<time dateTime={new Date(now).toISOString()}>
					{clockFormat.format(now)}
				</time>
			</p>
		</div>
	);
}

function PageSkeleton() {
	return (
		<div aria-hidden="true" className="flex flex-col gap-10">
			<Skeleton className="h-15" radius="dense" />
			<div className="flex flex-col gap-3">
				<Skeleton className="h-4 w-20" radius="dense" />
				<div className="flex flex-col divide-y divide-border rounded-md border border-border">
					{["one", "two", "three", "four"].map((key) => (
						<div className="flex flex-col gap-3 px-5 py-4" key={key}>
							<div className="flex justify-between">
								<Skeleton className="h-4 w-24" radius="dense" />
								<Skeleton className="h-4 w-20" radius="dense" />
							</div>
							<Skeleton className="h-8" radius="block" />
							<Skeleton className="h-3" radius="block" />
						</div>
					))}
				</div>
			</div>
		</div>
	);
}

/**
 * Status: the workspace as a public status page (Statuspage, Better Stack).
 * A banner gives the overall state; open incidents (failed or interrupted
 * threads, failed scheduled runs) follow; every agent is a component, grouped
 * by team, with a 30-day uptime strip; upcoming runs are scheduled
 * maintenance; and a week of history closes the page. An incident opens the
 * host's real conversation in a side panel.
 */
export function StatusInterface({
	activeThreadId,
	loading,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<Record<string, never>>) {
	const now = useNow(CLOCK_TICK_MS);
	const page = useMemo(() => buildStatusPage(snapshot, now), [snapshot, now]);
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
		() => new Set()
	);
	const toggleGroup = (groupId: string) => {
		setCollapsed((current) => {
			const next = new Set(current);
			if (next.has(groupId)) {
				next.delete(groupId);
			} else {
				next.add(groupId);
			}
			return next;
		});
	};

	const panelOpen = threadView !== null;
	const activeThread = activeThreadId
		? snapshot.threads.find((thread) => thread.id === activeThreadId)
		: undefined;
	const activeIncident: StatusIncident | undefined = activeThreadId
		? page.incidents.find((incident) => incident.threadId === activeThreadId)
		: undefined;
	const panelAgents = (activeThread?.agentIds ?? [])
		.map((agentId) => agentById(snapshot, agentId)?.name)
		.filter((name): name is string => Boolean(name));

	const {
		closePanel,
		fallbackRef: newThreadRef,
		headingRef,
		onRootKeyDown,
		openThread,
		rootRef,
		startThread,
	} = useThreadPanelFocus(port, panelOpen);
	const newThread = () => startThread({});

	const isEmpty =
		!loading &&
		snapshot.agents.length === 0 &&
		snapshot.threads.length === 0 &&
		(snapshot.events ?? []).length === 0;

	let body = <PageSkeleton />;
	if (isEmpty) {
		body = (
			<Empty
				appearance="bordered"
				className="rounded-md"
				data-testid="status-empty"
				inset="compact"
			>
				<EmptyHeader>
					<EmptyTitle>No agents to report on</EmptyTitle>
					<EmptyDescription>
						Each agent appears here with its status and a 30-day uptime history.
						Failed runs show up as incidents.
					</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button onClick={newThread} size="sm" type="button" variant="outline">
						<Plus aria-hidden="true" data-icon="inline-start" />
						New thread
					</Button>
				</EmptyContent>
			</Empty>
		);
	} else if (!loading) {
		body = (
			<div className="flex flex-col gap-10">
				<StatusBanner now={now} state={page.overall} />
				{page.incidents.length > 0 ? (
					<StatusOpenIncidents
						activeThreadId={activeThreadId}
						incidents={page.incidents}
						now={now}
						onOpen={openThread}
					/>
				) : null}
				{page.sections.length > 0 ? (
					<StatusComponents
						collapsed={collapsed}
						onToggle={toggleGroup}
						sections={page.sections}
					/>
				) : null}
				<StatusMaintenanceList items={page.maintenance} now={now} />
				<StatusHistory
					activeThreadId={activeThreadId}
					days={page.history}
					now={now}
					onOpen={openThread}
				/>
			</div>
		);
	}

	return (
		<div
			aria-busy={loading ? "true" : undefined}
			className="relative flex size-full min-h-0 bg-background text-foreground"
			data-testid="interface-status"
			onKeyDown={onRootKeyDown}
			ref={rootRef}
		>
			<main className="min-w-0 flex-1 overflow-y-auto">
				<div className="mx-auto flex w-full max-w-[52rem] flex-col gap-8 px-8 pt-8 pb-16 max-sm:px-4 max-sm:pt-6">
					<header className="flex items-center justify-between gap-4">
						<h1 className="min-w-0 truncate text-xl leading-7">
							<span className="font-semibold text-foreground">Workspace</span>{" "}
							<span className="text-muted-foreground">Status</span>
						</h1>
						<Button
							onClick={newThread}
							ref={newThreadRef}
							size="sm"
							type="button"
							variant="outline"
						>
							<Plus aria-hidden="true" data-icon="inline-start" />
							New thread
						</Button>
					</header>
					{body}
				</div>
			</main>
			{panelOpen ? (
				<StatusThreadPanel
					agentNames={panelAgents}
					headingRef={headingRef}
					incident={activeIncident}
					onClose={closePanel}
					thread={activeThread}
					threadView={threadView}
				/>
			) : null}
		</div>
	);
}
