import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type {
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import type { ReactNode } from "react";
import { agentById } from "./interface-renderer.ts";
import {
	type LiveCategoryEntry,
	type LiveChannel,
	liveCategoryOf,
} from "./live-model.ts";
import { LiveTag } from "./live-parts.tsx";
import { LiveBoxArt, LiveCategoryTile, LiveTile } from "./live-tile.tsx";

export type LiveBrowseTab = "categories" | "channels";

const STREAM_GRID =
	"grid grid-cols-[repeat(auto-fill,minmax(min(100%,17rem),1fr))] gap-x-4 gap-y-8";
/**
 * Live channels are the headline: `auto-fit` lets a few streams grow to fill
 * the row as large players instead of leaving it half empty, and many fall
 * back to the regular stream grid.
 */
const FEATURED_GRID =
	"grid grid-cols-[repeat(auto-fit,minmax(min(100%,24rem),1fr))] gap-x-5 gap-y-8";
/** Above this many live channels, they share the regular stream grid. */
const FEATURED_MAX = 3;
const DENSE_GRID =
	"grid grid-cols-[repeat(auto-fill,minmax(min(100%,15rem),1fr))] gap-x-4 gap-y-8";
const BOX_GRID =
	"grid grid-cols-[repeat(auto-fill,minmax(min(100%,9.5rem),1fr))] gap-x-4 gap-y-6";

/** Underlined text tabs, the reference's directory and channel tab style. */
export function LiveTabs<T extends string>({
	label,
	onChange,
	tabs,
	value,
}: {
	label: string;
	onChange: (value: T) => void;
	tabs: readonly { id: T; label: string }[];
	value: T;
}) {
	return (
		<div aria-label={label} className="flex gap-6" role="tablist">
			{tabs.map((tab) => {
				const selected = tab.id === value;
				return (
					<button
						aria-selected={selected}
						className={cn(
							"relative rounded-sm pb-2 font-semibold text-base leading-6 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
							selected ? "text-primary" : "text-foreground hover:text-primary"
						)}
						key={tab.id}
						onClick={() => onChange(tab.id)}
						onKeyDown={(event) => {
							if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") {
								return;
							}
							event.preventDefault();
							const index = tabs.findIndex((item) => item.id === tab.id);
							const step = event.key === "ArrowRight" ? 1 : -1;
							const next = tabs[(index + step + tabs.length) % tabs.length];
							if (next) {
								onChange(next.id);
								const list = event.currentTarget.parentElement;
								const buttons = list?.querySelectorAll("button");
								buttons?.[(index + step + tabs.length) % tabs.length]?.focus();
							}
						}}
						role="tab"
						tabIndex={selected ? 0 : -1}
						type="button"
					>
						{tab.label}
						{selected ? (
							<span
								aria-hidden="true"
								className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-primary"
							/>
						) : null}
					</button>
				);
			})}
		</div>
	);
}

function Section({
	children,
	count,
	title,
}: {
	children: ReactNode;
	count?: number;
	title: string;
}) {
	return (
		<section aria-label={title} className="flex flex-col gap-4">
			<h2 className="text-foreground text-lg leading-7">
				<span className="font-semibold">
					{title}
					{count === undefined ? null : (
						<span className="ml-2 font-normal text-muted-foreground tabular-nums">
							{count.toString()}
						</span>
					)}
				</span>
			</h2>
			{children}
		</section>
	);
}

export interface LiveTileActions {
	activeThreadId: string | null;
	now: number;
	onCategory: (categoryId: string) => void;
	onOpenThread: (threadId: string) => void;
	onWatch: (agentId: string) => void;
}

function ChannelGrid({
	actions,
	channels,
	featured = false,
}: {
	actions: LiveTileActions;
	channels: readonly LiveChannel[];
	featured?: boolean;
}) {
	const tl = useLiteralMessages();
	return (
		<div className={featured ? FEATURED_GRID : STREAM_GRID}>
			{channels.map((channel) => (
				<LiveTile
					agent={channel.agent}
					category={channel.category}
					key={channel.agent.id}
					label={
						channel.current
							? tl("Watch {name}: {title}", {
									name: channel.agent.name,
									title: channel.current.title,
								})
							: tl("Watch {name}, offline", { name: channel.agent.name })
					}
					live={channel.live && channel.current?.running === true}
					now={actions.now}
					onActivate={() => actions.onWatch(channel.agent.id)}
					onCategory={actions.onCategory}
					thread={channel.current}
					tileId={channel.agent.id}
				/>
			))}
		</div>
	);
}

/** A grid of threads (category pages and unassigned threads). */
export function LiveThreadGrid({
	actions,
	dense = false,
	showChannel = true,
	snapshot,
	threads,
	withCategory = true,
}: {
	actions: LiveTileActions;
	/** Narrower tiles, for a channel's own videos under the player. */
	dense?: boolean;
	showChannel?: boolean;
	snapshot: InterfaceSnapshot;
	threads: readonly InterfaceThread[];
	withCategory?: boolean;
}) {
	return (
		<div className={dense ? DENSE_GRID : STREAM_GRID}>
			{threads.map((thread) => {
				const agent = agentById(snapshot, thread.agentIds[0]) ?? null;
				return (
					<LiveTile
						agent={agent}
						category={withCategory ? liveCategoryOf(snapshot, thread) : null}
						current={thread.id === actions.activeThreadId}
						key={thread.id}
						label={`${thread.running ? "Watch" : "Open"} ${thread.title}${agent ? `, ${agent.name}` : ""}`}
						live={thread.running}
						now={actions.now}
						onActivate={() => actions.onOpenThread(thread.id)}
						onCategory={withCategory ? actions.onCategory : undefined}
						showChannel={showChannel}
						thread={thread}
						tileId={thread.id}
					/>
				);
			})}
		</div>
	);
}

function NoResults({ onClear, query }: { onClear: () => void; query: string }) {
	const tl = useLiteralMessages();
	return (
		<div className="flex flex-col items-start gap-3 py-8">
			<p className="font-semibold text-foreground text-sm leading-5">
				{tl("No results for “{query}”", { query: query.trim() })}
			</p>
			<p className="text-muted-foreground text-sm leading-5">
				Search by channel, stream title, or category.
			</p>
			<Button onClick={onClear} size="sm" type="button" variant="outline">
				Clear search
			</Button>
		</div>
	);
}

/**
 * Browse: the reference's directory. Channels lists live streams first, then
 * offline channels and threads no channel owns; Categories shows teams and
 * projects as box art.
 */
export function LiveBrowse({
	actions,
	categories,
	channels,
	gutter,
	onClearQuery,
	onTab,
	query,
	snapshot,
	tab,
	unassigned,
}: {
	actions: LiveTileActions;
	categories: readonly LiveCategoryEntry[];
	channels: readonly LiveChannel[];
	gutter: number;
	onClearQuery: () => void;
	onTab: (tab: LiveBrowseTab) => void;
	query: string;
	snapshot: InterfaceSnapshot;
	tab: LiveBrowseTab;
	unassigned: readonly InterfaceThread[];
}) {
	const searching = query.trim().length > 0;
	const live = channels.filter((channel) => channel.current?.running);
	const offline = channels.filter((channel) => !channel.current?.running);
	const shownUnassigned = searching ? [] : unassigned;
	const nothing =
		tab === "channels"
			? channels.length === 0 && shownUnassigned.length === 0
			: categories.length === 0;

	let body: ReactNode;
	if (nothing && searching) {
		body = <NoResults onClear={onClearQuery} query={query} />;
	} else if (tab === "categories") {
		body =
			categories.length === 0 ? (
				<p className="text-muted-foreground text-sm leading-5">
					Teams and projects show up here as categories.
				</p>
			) : (
				<div className={BOX_GRID}>
					{categories.map((entry) => (
						<LiveCategoryTile
							entry={entry}
							key={entry.category.id}
							onSelect={actions.onCategory}
						/>
					))}
				</div>
			);
	} else {
		body = (
			<div className="flex flex-col gap-12">
				{live.length > 0 ? (
					<Section count={live.length} title="Live channels">
						<ChannelGrid
							actions={actions}
							channels={live}
							featured={live.length <= FEATURED_MAX}
						/>
					</Section>
				) : null}
				{offline.length > 0 ? (
					<Section count={offline.length} title="Offline channels">
						<ChannelGrid actions={actions} channels={offline} />
					</Section>
				) : null}
				{shownUnassigned.length > 0 ? (
					<Section count={shownUnassigned.length} title="Without a channel">
						<LiveThreadGrid
							actions={actions}
							snapshot={snapshot}
							threads={shownUnassigned}
						/>
					</Section>
				) : null}
			</div>
		);
	}

	return (
		<div className="flex flex-col pt-8 pb-16" style={{ paddingInline: gutter }}>
			<h1 className="text-4xl text-foreground leading-10 tracking-tight">
				<span className="font-bold">
					{searching ? "Search results" : "Browse"}
				</span>
			</h1>
			<div className="mt-6">
				<LiveTabs
					label="Browse"
					onChange={onTab}
					tabs={[
						{ id: "channels", label: "Channels" },
						{ id: "categories", label: "Categories" },
					]}
					value={tab}
				/>
			</div>
			<div className="mt-8" role="tabpanel">
				{body}
			</div>
		</div>
	);
}

/** A category's directory page: box art and counts, then its streams and videos. */
export function LiveCategoryPage({
	actions,
	entry,
	gutter,
	snapshot,
}: {
	actions: LiveTileActions;
	entry: LiveCategoryEntry;
	gutter: number;
	snapshot: InterfaceSnapshot;
}) {
	const tl = useLiteralMessages();
	const { category } = entry;
	const live = entry.threads.filter((thread) => thread.running);
	const videos = entry.threads.filter((thread) => !thread.running);
	const videoCount = `${entry.threads.length.toString()} ${entry.threads.length === 1 ? "video" : "videos"}`;
	const meta = [
		entry.liveCount > 0 ? `${entry.liveCount.toString()} live` : null,
		videoCount,
		`${entry.channelIds.length.toString()} ${entry.channelIds.length === 1 ? "channel" : "channels"}`,
	]
		.filter(Boolean)
		.join(" · ");
	return (
		<div className="flex flex-col pt-8 pb-16" style={{ paddingInline: gutter }}>
			<div className="flex items-end gap-6">
				<div className="w-24 shrink-0">
					<LiveBoxArt category={category} />
				</div>
				<div className="flex min-w-0 flex-col gap-2">
					<h1 className="truncate text-4xl text-foreground leading-10 tracking-tight">
						<span className="font-bold">{category.name}</span>
					</h1>
					<p className="text-muted-foreground text-sm leading-5">{meta}</p>
					<div className="flex">
						<LiveTag>{category.kind === "team" ? "Team" : "Project"}</LiveTag>
					</div>
				</div>
			</div>
			<div className="mt-10 flex flex-col gap-12">
				{live.length > 0 ? (
					<Section count={live.length} title="Live channels">
						<LiveThreadGrid
							actions={actions}
							snapshot={snapshot}
							threads={live}
							withCategory={false}
						/>
					</Section>
				) : null}
				<Section count={videos.length} title="Videos">
					{videos.length > 0 ? (
						<LiveThreadGrid
							actions={actions}
							snapshot={snapshot}
							threads={videos}
							withCategory={false}
						/>
					) : (
						<p className="text-muted-foreground text-sm leading-5">
							{tl("No past streams in {name} yet.", { name: category.name })}
						</p>
					)}
				</Section>
			</div>
		</div>
	);
}
