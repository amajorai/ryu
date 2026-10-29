import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { MessageSquarePlus } from "lucide-react";
import { BoardAvatar } from "./board-avatar.tsx";
import { compactAge } from "./interface-renderer.ts";
import {
	type MissionStation,
	missionThreadTitle,
	STATION_STATE_LABELS,
} from "./mission-control-model.ts";
import {
	Lamp,
	MissionPanel,
	STATE_TONE,
	TONE_TEXT,
} from "./mission-control-parts.tsx";

function ageLabel(iso: string | null, now: number, tl: LiteralMessage): string {
	if (!iso) {
		return "Never active";
	}
	const age = compactAge(iso, now);
	return age === "now" ? "Active now" : tl("Active {age} ago", { age });
}

/**
 * The latest line of the station's thread, attributed when it was yours. A
 * closing period is dropped so a clamp never ends on ".…".
 */
function previewLine(station: MissionStation): string | null {
	const message = station.focusThread?.lastMessage?.trim().replace(/\.$/, "");
	if (!message) {
		return null;
	}
	return station.focusThread?.lastMessageRole === "user"
		? `You: ${message}`
		: message;
}

function stationSummary(station: MissionStation): string {
	const { counts, threadCount } = station;
	if (threadCount === 0) {
		return "No threads";
	}
	const parts = [`${threadCount} ${threadCount === 1 ? "thread" : "threads"}`];
	if (counts.attention > 0) {
		parts.push(`${counts.attention} failed`);
	}
	if (counts["your-turn"] > 0) {
		parts.push(`${counts["your-turn"]} your turn`);
	}
	return parts.join(" · ");
}

function Station({
	activeThreadId,
	now,
	onMessage,
	onOpen,
	station,
}: {
	activeThreadId: string | null;
	now: number;
	onMessage: (agentId: string) => void;
	onOpen: (threadId: string) => void;
	station: MissionStation;
}) {
	const tl = useLiteralMessages();
	const { agent, focusThread, state } = station;
	const tone = STATE_TONE[state];
	const current = Boolean(
		focusThread && activeThreadId && focusThread.id === activeThreadId
	);
	const title = focusThread ? missionThreadTitle(focusThread) : null;
	const preview = previewLine(station);
	return (
		<li className="min-w-0 border-border border-r border-b">
			<article
				aria-current={current ? "true" : undefined}
				aria-label={`${agent.name}, ${STATION_STATE_LABELS[state]}`}
				className={cn(
					"group/station relative flex h-full min-w-0 flex-col gap-2 p-3",
					current &&
						"bg-muted/60 before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-primary"
				)}
				data-agent-id={agent.id}
				data-state={state}
			>
				<div className="flex min-w-0 items-center gap-2">
					<BoardAvatar agent={agent} name={agent.name} size={20} />
					<span className="min-w-0 flex-1 truncate font-medium text-[13px] text-foreground leading-5">
						{agent.name}
					</span>
					<span className="flex shrink-0 items-center gap-1.5">
						<Lamp state={state} />
						<span
							className={cn("font-medium text-xs leading-5", TONE_TEXT[tone])}
						>
							{STATION_STATE_LABELS[state]}
						</span>
					</span>
				</div>
				{focusThread && title ? (
					<button
						aria-label={tl("Open {name}'s current thread: {title}", {
							name: agent.name,
							title,
						})}
						className="group/current -mx-1.5 flex min-w-0 flex-col gap-0.5 rounded-md px-1.5 py-1 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
						onClick={() => onOpen(focusThread.id)}
						type="button"
					>
						<span className="truncate text-[13px] text-foreground leading-5">
							{title}
						</span>
						<span className="@min-[1100px]/wall:line-clamp-2 line-clamp-1 text-muted-foreground text-xs leading-4">
							{preview ?? "No messages yet"}
						</span>
					</button>
				) : (
					<p className="py-1 text-muted-foreground text-xs leading-5">
						No threads yet
					</p>
				)}
				<div className="mt-auto flex min-w-0 flex-col gap-2">
					<div className="flex h-5 min-w-0 items-center justify-between gap-2 text-muted-foreground text-xs tabular-nums">
						<span className="truncate">{stationSummary(station)}</span>
						<span className="relative flex shrink-0 items-center justify-end">
							{/* The age gives way to the action at once, never mid-fade under
							    a focus ring. */}
							<span className="group-focus-within/station:opacity-0 group-hover/station:opacity-0">
								{ageLabel(station.lastActive, now, tl)}
							</span>
							<Button
								aria-label={tl("Message {name}", { name: agent.name })}
								className="absolute right-0 text-muted-foreground opacity-0 focus-visible:opacity-100 group-focus-within/station:opacity-100 group-hover/station:opacity-100"
								onClick={() => onMessage(agent.id)}
								size="icon-xs"
								title={tl("New thread with {name}", { name: agent.name })}
								type="button"
								variant="ghost"
							>
								<MessageSquarePlus aria-hidden="true" />
							</Button>
						</span>
					</div>
				</div>
			</article>
		</li>
	);
}

/**
 * The agent status board: one console station per agent, in a fixed order,
 * as flush cells of one surface split by hairlines.
 */
export function StationBoard({
	activeThreadId,
	now,
	onMessage,
	onOpen,
	stations,
}: {
	activeThreadId: string | null;
	now: number;
	onMessage: (agentId: string) => void;
	onOpen: (threadId: string) => void;
	stations: MissionStation[];
}) {
	return (
		<MissionPanel title="Agent status" titleId="mission-stations-title">
			{stations.length === 0 ? (
				<div className="m-auto flex flex-col items-center gap-1 px-6 py-8 text-center">
					<p className="font-medium text-[13px] text-foreground">
						No agents yet
					</p>
					<p className="text-muted-foreground text-xs">
						Each agent gets a station here with its current thread.
					</p>
				</div>
			) : (
				<div className="@container flex min-h-0 flex-1 flex-col overflow-hidden">
					{/* Each cell draws its right and bottom hairline; the extra pixel
					    hides the outer ones under the panel's own border. */}
					<ul className="-mb-px grid w-[calc(100%+1px)] flex-1 auto-rows-fr @min-[400px]:grid-cols-2 @min-[640px]:grid-cols-3 grid-cols-1">
						{stations.map((station) => (
							<Station
								activeThreadId={activeThreadId}
								key={station.agent.id}
								now={now}
								onMessage={onMessage}
								onOpen={onOpen}
								station={station}
							/>
						))}
					</ul>
				</div>
			)}
		</MissionPanel>
	);
}
