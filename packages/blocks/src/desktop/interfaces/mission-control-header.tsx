import { Button } from "@ryu/ui/components/button.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { Plus } from "lucide-react";
import { compactAge } from "./interface-renderer.ts";
import { useNow } from "./mission-control-hooks.ts";
import {
	clockDate,
	clockTime,
	type MissionBanner,
	utcOffsetLabel,
} from "./mission-control-model.ts";
import { Lamp } from "./mission-control-parts.tsx";

/** The big wall clock. It ticks on its own so the rest of the wall does not. */
function MissionClock() {
	const now = useNow(1000);
	const { hours, seconds } = clockTime(now);
	return (
		<div className="flex flex-col items-end @min-[1200px]:items-center leading-none">
			<time
				className="font-mono font-normal @min-[1200px]:text-[28px] text-[22px] text-foreground tabular-nums tracking-tight"
				dateTime={new Date(now).toISOString()}
				suppressHydrationWarning
			>
				{hours}
				<span className="text-muted-foreground">:{seconds}</span>
			</time>
			<span className="mt-1 text-muted-foreground text-xs tabular-nums">
				{clockDate(now)} · {utcOffsetLabel(now)}
			</span>
		</div>
	);
}

function plural(count: number, one: string): string {
	return `${count} ${one}${count === 1 ? "" : "s"}`;
}

/**
 * The top strip: what the wall is, the live clock, and a one-line status
 * readout (lamp, headline, detail) with a jump to the alerts when anything
 * failed.
 */
export function MissionHeader({
	agentCount,
	banner,
	lastUpdate,
	loading,
	now,
	onNewThread,
	onReview,
	threadCount,
}: {
	agentCount: number;
	banner: MissionBanner;
	lastUpdate: string | null;
	loading: boolean;
	now: number;
	onNewThread: () => void;
	onReview: () => void;
	threadCount: number;
}) {
	const attention = banner.tone === "attention";
	const age = lastUpdate ? compactAge(lastUpdate, now) : "";
	let freshness = "No activity yet";
	if (age) {
		freshness = age === "now" ? "Updated just now" : `Updated ${age} ago`;
	}
	return (
		<header className="grid shrink-0 @min-[1200px]:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-3 border-border border-b @min-[1000px]:px-4 px-3 py-3">
			<div className="flex min-w-0 flex-col gap-0.5">
				<h1 className="truncate font-medium text-base text-foreground leading-6 tracking-tight">
					Mission Control
				</h1>
				<p className="truncate text-muted-foreground text-xs tabular-nums leading-4">
					{loading
						? "Connecting…"
						: `${plural(agentCount, "agent")} · ${plural(threadCount, "thread")} · ${freshness}`}
				</p>
			</div>
			<MissionClock />
			<div className="@container/banner @min-[1200px]:col-span-1 col-span-2 flex min-w-0 items-center @min-[1200px]:justify-end gap-4">
				<div
					className="flex h-8 min-w-0 @max-[1199px]/wall:flex-1 items-center gap-2"
					data-banner={loading ? "loading" : banner.tone}
				>
					{loading ? (
						<Skeleton className="h-4 w-48" radius="block" />
					) : (
						<>
							<Lamp
								pulse={!attention}
								state={attention ? "alert" : "success"}
							/>
							<p
								aria-live="polite"
								className="flex min-w-0 items-baseline gap-2"
								role="status"
							>
								<span className="shrink-0 whitespace-nowrap font-medium text-[13px] text-foreground">
									{banner.headline}
								</span>
								<span className="@max-[34rem]/banner:hidden min-w-0 truncate text-muted-foreground text-xs">
									{banner.detail}
								</span>
							</p>
						</>
					)}
					{attention && !loading ? (
						<button
							className="shrink-0 rounded-sm font-medium text-[13px] text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
							onClick={onReview}
							type="button"
						>
							Review alerts
						</button>
					) : null}
				</div>
				<Button
					aria-label="New thread"
					className="ml-auto shrink-0"
					onClick={onNewThread}
					size="sm"
					title="Start a new thread"
					type="button"
					variant="outline"
				>
					<Plus aria-hidden="true" />
					<span className="max-sm:hidden">New thread</span>
				</Button>
			</div>
		</header>
	);
}
