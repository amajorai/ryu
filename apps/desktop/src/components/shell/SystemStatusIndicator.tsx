import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover";
import { useState } from "react";
import { cn } from "@/lib/utils.ts";
import { useSystemStatusContext } from "@/src/contexts/SystemStatusContext.tsx";
import { startSidecar } from "@/src/lib/api/plugins.ts";
import { triggerGlobalRefresh } from "@/src/lib/core-refresh.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";

type Tone = "green" | "amber" | "red" | "pending";

function resolveTone(
	loading: boolean,
	coreReachable: boolean,
	gatewayReachable: boolean,
	shadowReachable: boolean | null
): Tone {
	if (loading) {
		return "pending";
	}
	if (!coreReachable) {
		return "red";
	}
	if (!gatewayReachable || shadowReachable === false) {
		return "amber";
	}
	return "green";
}

interface StatusRowProps {
	description: string;
	label: string;
	onStart: () => Promise<void>;
	running: boolean;
}

function StatusRow({ label, description, running, onStart }: StatusRowProps) {
	const [starting, setStarting] = useState(false);

	const handleStart = async () => {
		setStarting(true);
		try {
			await onStart();
		} finally {
			setStarting(false);
		}
	};

	return (
		<div className="flex items-center gap-3 py-1.5">
			<span
				aria-hidden
				className={cn("size-2 shrink-0 rounded-full", {
					"bg-success": running,
					"bg-destructive": !running,
				})}
			/>
			<div className="min-w-0 flex-1">
				<p className="truncate font-medium text-xs leading-tight">{label}</p>
				<p className="truncate text-muted-foreground text-xs leading-tight">
					{description}
				</p>
			</div>
			{running ? null : (
				<button
					className="shrink-0 rounded px-2 py-0.5 text-xs hover:bg-accent disabled:opacity-50"
					disabled={starting}
					onClick={handleStart}
					type="button"
				>
					{starting ? "Starting…" : "Start"}
				</button>
			)}
		</div>
	);
}

export function SystemStatusIndicator() {
	const { coreReachable, gatewayReachable, shadowReachable, loading, refresh } =
		useSystemStatusContext();
	const [refreshing, setRefreshing] = useState(false);

	const activeNode = useNodeStore((s) => s.getActiveNode());

	// One button to re-check Core and refetch every data source in the app, so a
	// user never has to press "Try again" section by section after Core recovers.
	const handleRefreshAll = async () => {
		setRefreshing(true);
		try {
			await refresh();
			triggerGlobalRefresh();
		} finally {
			setRefreshing(false);
		}
	};

	const tone = resolveTone(
		loading,
		coreReachable,
		gatewayReachable,
		shadowReachable
	);

	const dotColor = {
		green: "bg-success",
		amber: "bg-warning",
		red: "bg-destructive",
		pending: "bg-muted-foreground/40",
	}[tone];

	const label = loading
		? "Connecting…"
		: tone === "green"
			? "All systems running"
			: tone === "amber"
				? "Degraded"
				: "Core offline";

	const target = { url: activeNode.url, token: activeNode.token };

	return (
		<Popover>
			<PopoverTrigger
				aria-label={`System status: ${label}`}
				className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-muted-foreground text-xs outline-none hover:bg-accent"
			>
				<span
					aria-hidden
					className={cn("size-2 shrink-0 rounded-full", dotColor)}
				/>
				<span className="truncate">{label}</span>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-72" side="top">
				<p className="mb-1 font-medium text-muted-foreground text-xs">
					System status
				</p>
				<div className="divide-y divide-border/50">
					<StatusRow
						description={coreReachable ? "Running" : "Not running"}
						label="Local AI (Core)"
						onStart={async () => {
							await startSidecar(target, "core");
						}}
						running={coreReachable}
					/>
					<StatusRow
						description={gatewayReachable ? "Running" : "Not running"}
						label="AI Gateway"
						onStart={async () => {
							await startSidecar(target, "gateway");
						}}
						running={gatewayReachable}
					/>
					<StatusRow
						description={
							shadowReachable === null
								? "Status unknown"
								: shadowReachable
									? "Running"
									: "Not running"
						}
						label="Screen capture (Shadow)"
						onStart={async () => {
							await startSidecar(target, "shadow");
						}}
						running={shadowReachable === true}
					/>
				</div>
				<button
					className="mt-2 w-full rounded border border-border/60 px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
					disabled={refreshing}
					onClick={handleRefreshAll}
					type="button"
				>
					{refreshing ? "Refreshing…" : "Refresh all data"}
				</button>
			</PopoverContent>
		</Popover>
	);
}
