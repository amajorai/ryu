import { cn } from "@ryu/ui/lib/utils";
import type {
	InterfaceAgent,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { Users } from "lucide-react";
import { memo, type ReactNode } from "react";
import {
	type LiveCategory,
	type LiveCategoryEntry,
	liveAgo,
	liveArt,
	liveHash,
	liveMessages,
	liveParticipants,
	liveStatusTag,
} from "./live-model.ts";
import { liveCategoryStage } from "./live-palette.ts";
import {
	LiveAvatar,
	LiveBadge,
	LiveChip,
	LiveScreen,
	LiveTag,
	LiveUptime,
} from "./live-parts.tsx";

/** Attribute that marks a tile's main button, so focus can return to it. */
export const LIVE_TILE_ATTRIBUTE = "data-live-tile";

/**
 * The reference's thumbnail hover: the frame lifts up and to the right and
 * the accent shows beneath it as an extruded edge. Keyboard focus does the
 * same; reduced motion keeps the frame still and only shows the edge.
 */
function Extrude({ children }: { children: ReactNode }) {
	return (
		<div className="group/thumb relative">
			<span
				aria-hidden="true"
				className="absolute inset-0 bg-primary opacity-0 group-hover/thumb:opacity-100 group-has-focus-visible/thumb:opacity-100"
			/>
			<span
				aria-hidden="true"
				className="absolute -top-1.5 left-0 size-1.5 origin-bottom-left scale-0 bg-primary transition-transform duration-100 ease-out [clip-path:polygon(0_100%,100%_0,100%_100%)] group-hover/thumb:scale-100 group-has-focus-visible/thumb:scale-100 motion-reduce:hidden"
			/>
			<span
				aria-hidden="true"
				className="absolute -right-1.5 bottom-0 size-1.5 origin-top-left scale-0 bg-primary transition-transform duration-100 ease-out [clip-path:polygon(0_0,100%_0,0_100%)] group-hover/thumb:scale-100 group-has-focus-visible/thumb:scale-100 motion-reduce:hidden"
			/>
			<div className="motion-reduce:group-hover/thumb:translate-0 motion-reduce:group-has-focus-visible/thumb:translate-0 relative transition-transform duration-100 ease-out group-hover/thumb:translate-x-1.5 group-hover/thumb:-translate-y-1.5 group-has-focus-visible/thumb:translate-x-1.5 group-has-focus-visible/thumb:-translate-y-1.5 motion-reduce:transition-none">
				{children}
			</div>
		</div>
	);
}

export interface LiveTileProps {
	agent: InterfaceAgent | null;
	category: LiveCategory | null;
	/** True when this tile is the one shown in the player. */
	current?: boolean;
	/** Accessible name of the tile's main button. */
	label: string;
	live: boolean;
	now: number;
	onActivate: () => void;
	onCategory?: (categoryId: string) => void;
	/** Show the channel's avatar and name (off inside a channel's own videos). */
	showChannel?: boolean;
	thread: InterfaceThread | null;
	/** What the tile stands for: a channel (agent id) or a video (thread id). */
	tileId: string;
}

/**
 * A stream or video card: the 16:9 frame with its corner chips, then the
 * avatar, title, channel and category, and one tag for where the thread
 * stands. Only the frame is a tab stop; the title and channel repeat the same
 * action for the pointer, and the category is its own link.
 */
export const LiveTile = memo(function LiveTileImpl({
	agent,
	category,
	current = false,
	label,
	live,
	now,
	onActivate,
	onCategory,
	showChannel = true,
	thread,
	tileId,
}: LiveTileProps) {
	const spec = liveArt(thread, agent);
	const tag = thread ? liveStatusTag(thread) : null;
	const title = thread?.title ?? "No streams yet";
	return (
		<article className="flex min-w-0 flex-col gap-3">
			<Extrude>
				<button
					aria-current={current ? "true" : undefined}
					aria-label={label}
					className="block w-full outline-none"
					onClick={onActivate}
					type="button"
					{...{ [LIVE_TILE_ATTRIBUTE]: tileId }}
				>
					<LiveScreen agent={agent} dim={!thread} spec={spec}>
						<span className="absolute top-2 left-2 flex gap-1">
							{live ? <LiveBadge /> : null}
							{thread ? null : <LiveChip>Offline</LiveChip>}
							{current && !live ? <LiveChip>Now playing</LiveChip> : null}
						</span>
						{thread && live ? (
							<>
								<LiveChip className="absolute bottom-2 left-2">
									<LiveUptime since={thread.updatedAt} />
								</LiveChip>
								<LiveChip className="absolute right-2 bottom-2 gap-1">
									<Users aria-hidden="true" className="size-3.5" />
									{liveParticipants(thread)}
								</LiveChip>
							</>
						) : null}
						{thread && !live ? (
							<>
								<LiveChip className="absolute bottom-2 left-2">
									{liveMessages(thread.messageCount)}
								</LiveChip>
								<LiveChip className="absolute right-2 bottom-2">
									{liveAgo(thread.updatedAt, now)}
								</LiveChip>
							</>
						) : null}
					</LiveScreen>
				</button>
			</Extrude>
			<div className="flex min-w-0 gap-3">
				{showChannel && agent ? <LiveAvatar agent={agent} size={40} /> : null}
				<div className="flex min-w-0 flex-1 flex-col">
					<button
						className="truncate text-left font-semibold text-foreground text-sm leading-5 hover:text-primary"
						onClick={onActivate}
						tabIndex={-1}
						title={title}
						type="button"
					>
						{title}
					</button>
					{showChannel ? (
						<p className="truncate text-muted-foreground text-sm leading-5">
							{agent?.name ?? "No channel"}
						</p>
					) : null}
					{category && onCategory ? (
						<button
							className="w-fit max-w-full truncate rounded-sm text-left text-muted-foreground text-sm leading-5 outline-none hover:text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring"
							onClick={() => onCategory(category.id)}
							type="button"
						>
							{category.name}
						</button>
					) : null}
					{category && !onCategory ? (
						<p className="truncate text-muted-foreground text-sm leading-5">
							{category.name}
						</p>
					) : null}
					{tag ? (
						<div className="mt-1 flex">
							<LiveTag>{tag}</LiveTag>
						</div>
					) : null}
				</div>
			</div>
		</article>
	);
});

/**
 * Category box art (3:4): the category's name set as a cover in a colour of
 * its own, under a Team or Project label, on the same stage as the streams.
 */
export const LiveBoxArt = memo(function LiveBoxArtImpl({
	category,
}: {
	category: LiveCategory;
}) {
	const colors = liveCategoryStage(liveHash(category.id) % 360);
	return (
		<span
			aria-hidden="true"
			className="@container relative block aspect-[3/4] w-full overflow-hidden"
			style={{ background: colors.ground, color: colors.text }}
		>
			<span className="absolute inset-0 flex flex-col p-[9cqw] text-left">
				<span
					className="font-semibold text-[clamp(10px,6cqw,14px)] uppercase tracking-[0.16em]"
					style={{ color: colors.accent }}
				>
					{category.kind === "team" ? "Team" : "Project"}
				</span>
				<span className="mt-auto line-clamp-4 text-balance font-bold text-[16cqw] leading-[0.98] tracking-tight">
					{category.name}
				</span>
				<span
					className="mt-[6cqw] h-[1.6cqw] w-[24cqw] shrink-0 rounded-full"
					style={{ background: colors.frame }}
				/>
			</span>
		</span>
	);
});

/** A category in the Categories directory: box art, name, live count, kind. */
export function LiveCategoryTile({
	entry,
	onSelect,
}: {
	entry: LiveCategoryEntry;
	onSelect: (categoryId: string) => void;
}) {
	const { category } = entry;
	const meta =
		entry.liveCount > 0
			? `${entry.liveCount.toString()} live`
			: `${entry.threads.length.toString()} ${entry.threads.length === 1 ? "video" : "videos"}`;
	return (
		<article className="flex min-w-0 flex-col gap-2">
			<Extrude>
				<button
					aria-label={`${category.name}, ${meta}`}
					className="block w-full outline-none"
					onClick={() => onSelect(category.id)}
					type="button"
					{...{ [LIVE_TILE_ATTRIBUTE]: category.id }}
				>
					<LiveBoxArt category={category} />
				</button>
			</Extrude>
			<div className="flex min-w-0 flex-col">
				<button
					className="truncate text-left font-semibold text-foreground text-sm leading-5 hover:text-primary"
					onClick={() => onSelect(category.id)}
					tabIndex={-1}
					type="button"
				>
					{category.name}
				</button>
				<p
					className={cn(
						"text-sm leading-5",
						entry.liveCount > 0 ? "text-foreground" : "text-muted-foreground"
					)}
				>
					{meta}
				</p>
				<div className="mt-1 flex">
					<LiveTag>{category.kind === "team" ? "Team" : "Project"}</LiveTag>
				</div>
			</div>
		</article>
	);
}
