import { Button } from "@ryu/ui/components/button.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip";
import { cn } from "@ryu/ui/lib/utils";
import { ArrowLeftToLine, ArrowRightToLine } from "lucide-react";
import type { LiveChannel } from "./live-model.ts";
import { LiveAvatar, LiveDot } from "./live-parts.tsx";

/** The rail's two groups, live channels first. */
const RAIL_GROUPS = [
	{ label: "Live now", live: true },
	{ label: "Offline", live: false },
] as const;

/** What a rail row says to a screen reader. */
export function liveRailLabel(channel: LiveChannel): string {
	if (!channel.live) {
		return `${channel.agent.name}, offline`;
	}
	const on = channel.current ? `: ${channel.current.title}` : "";
	return `${channel.agent.name}, live${on}`;
}

function RailRow({
	channel,
	onSelect,
	selected,
}: {
	channel: LiveChannel;
	onSelect: (agentId: string) => void;
	selected: boolean;
}) {
	const { agent } = channel;
	return (
		<li>
			<button
				aria-current={selected ? "page" : undefined}
				aria-label={liveRailLabel(channel)}
				className={cn(
					"flex w-full items-center gap-3 px-3 py-1.5 text-left outline-none transition-colors hover:bg-sidebar-accent focus-visible:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-inset",
					selected && "bg-sidebar-accent"
				)}
				onClick={() => onSelect(agent.id)}
				type="button"
			>
				<LiveAvatar agent={agent} offline={!channel.live} size={32} />
				<span className="flex min-w-0 flex-1 flex-col">
					<span
						className={cn(
							"truncate font-semibold text-sm leading-5",
							channel.live ? "text-sidebar-foreground" : "text-muted-foreground"
						)}
					>
						{agent.name}
					</span>
					{channel.live && channel.current ? (
						<span className="truncate text-[13px] text-muted-foreground leading-4">
							{channel.current.title}
						</span>
					) : null}
				</span>
				{channel.live ? (
					<span className="flex shrink-0 items-center gap-1.5 text-sidebar-foreground text-xs tabular-nums leading-4">
						<LiveDot />
						{channel.liveCount > 1 ? channel.liveCount.toString() : null}
					</span>
				) : null}
			</button>
		</li>
	);
}

function CollapsedRow({
	channel,
	onSelect,
	selected,
}: {
	channel: LiveChannel;
	onSelect: (agentId: string) => void;
	selected: boolean;
}) {
	const { agent } = channel;
	return (
		<li>
			<Tooltip>
				<TooltipTrigger
					render={
						<button
							aria-current={selected ? "page" : undefined}
							aria-label={liveRailLabel(channel)}
							className={cn(
								"flex h-11 w-full items-center justify-center outline-none transition-colors hover:bg-sidebar-accent focus-visible:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-inset",
								selected && "bg-sidebar-accent"
							)}
							onClick={() => onSelect(agent.id)}
							type="button"
						/>
					}
				>
					<span className="relative">
						<LiveAvatar agent={agent} offline={!channel.live} size={32} />
						{channel.live ? (
							<span className="absolute -right-0.5 -bottom-0.5 flex rounded-full ring-2 ring-sidebar">
								<LiveDot />
							</span>
						) : null}
					</span>
				</TooltipTrigger>
				<TooltipContent side="right">
					<span className="flex flex-col">
						<span className="font-semibold">{agent.name}</span>
						<span className="text-muted-foreground">
							{channel.live && channel.current
								? channel.current.title
								: "Offline"}
						</span>
					</span>
				</TooltipContent>
			</Tooltip>
		</li>
	);
}

/**
 * The reference's left nav: followed channels, live ones first with what they
 * are streaming and a live count, offline ones greyed. Collapses to a column of
 * faces, the way the reference folds it on narrow windows.
 */
export function LiveRail({
	channels,
	collapsed,
	onSelect,
	onToggle,
	selectedId,
}: {
	channels: readonly LiveChannel[];
	collapsed: boolean;
	onSelect: (agentId: string) => void;
	onToggle: () => void;
	selectedId: string | null;
}) {
	const Row = collapsed ? CollapsedRow : RailRow;
	return (
		<nav
			aria-label="Followed channels"
			className={cn(
				"flex h-full shrink-0 flex-col border-sidebar-border border-r bg-sidebar text-sidebar-foreground",
				collapsed ? "w-14" : "w-60"
			)}
			data-collapsed={collapsed ? "true" : undefined}
		>
			<div
				className={cn(
					"flex h-12 shrink-0 items-center",
					collapsed ? "justify-center" : "justify-between pr-2 pl-3"
				)}
			>
				{collapsed ? null : (
					<h2 className="text-sm leading-5">
						<span className="font-semibold">Followed channels</span>
					</h2>
				)}
				<Button
					aria-label={
						collapsed
							? "Expand followed channels"
							: "Collapse followed channels"
					}
					className="text-muted-foreground hover:text-sidebar-foreground"
					onClick={onToggle}
					size="icon-sm"
					type="button"
					variant="ghost"
				>
					{collapsed ? (
						<ArrowRightToLine aria-hidden="true" className="size-4" />
					) : (
						<ArrowLeftToLine aria-hidden="true" className="size-4" />
					)}
				</Button>
			</div>
			{channels.length === 0 ? (
				collapsed ? null : (
					<p className="px-3 text-[13px] text-muted-foreground leading-5">
						Channels appear here when you add agents.
					</p>
				)
			) : (
				<div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-2">
					{RAIL_GROUPS.map((group) => {
						const members = channels.filter(
							(channel) => channel.live === group.live
						);
						if (members.length === 0) {
							return null;
						}
						return (
							<section
								aria-label={group.label}
								className="pb-2"
								key={group.label}
							>
								{collapsed ? null : (
									<h3 className="flex items-baseline gap-1.5 px-3 pt-2 pb-1 font-semibold text-muted-foreground text-xs uppercase leading-4 tracking-wider">
										{group.label}
										<span className="font-normal tabular-nums">
											{members.length.toString()}
										</span>
									</h3>
								)}
								<ul>
									{members.map((channel) => (
										<Row
											channel={channel}
											key={channel.agent.id}
											onSelect={onSelect}
											selected={channel.agent.id === selectedId}
										/>
									))}
								</ul>
							</section>
						);
					})}
				</div>
			)}
		</nav>
	);
}
