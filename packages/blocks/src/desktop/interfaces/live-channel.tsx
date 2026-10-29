import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type {
	InterfaceEvent,
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { MessageSquare } from "lucide-react";
import { type ReactNode, useState } from "react";
import {
	LiveTabs,
	LiveThreadGrid,
	type LiveTileActions,
} from "./live-browse.tsx";
import {
	type LiveChannel,
	liveAgo,
	liveCategoryOf,
	liveMessages,
	liveSchedule,
	liveStatusTag,
} from "./live-model.ts";
import { LiveAvatar, LiveBadge, LiveTag, LiveUptime } from "./live-parts.tsx";
import { LivePlayer } from "./live-player.tsx";

export type LiveChannelTab = "about" | "schedule" | "videos";

const DATE = new Intl.DateTimeFormat(undefined, {
	day: "numeric",
	month: "short",
});
const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const TIME = new Intl.DateTimeFormat(undefined, {
	hour: "numeric",
	minute: "2-digit",
});

function ScheduleRow({ event }: { event: InterfaceEvent }) {
	const tl = useLiteralMessages();
	const start = new Date(event.start);
	const failed = event.outcome === "failure";
	let outcome: string | null = null;
	if (event.kind === "past") {
		outcome = failed ? "Failed" : "Succeeded";
	}
	return (
		<li className="grid grid-cols-[4rem_1fr_auto] items-center gap-4 border-border border-b py-3 last:border-b-0">
			<span className="flex flex-col">
				<span className="text-muted-foreground text-xs uppercase leading-4 tracking-wide">
					{WEEKDAY.format(start)}
				</span>
				<span className="font-semibold text-foreground text-sm leading-5">
					{DATE.format(start)}
				</span>
			</span>
			<span className="flex min-w-0 flex-col">
				<span className="truncate font-semibold text-foreground text-sm leading-5">
					{event.title}
					{event.count && event.count > 1 ? (
						<span className="font-normal text-muted-foreground">
							{` ${tl("· {runCount} runs", { runCount: event.count.toString() })}`}
						</span>
					) : null}
				</span>
				<span className="truncate text-muted-foreground text-sm leading-5">
					<time dateTime={event.start}>{TIME.format(start)}</time>
					{event.label ? ` · ${event.label}` : ""}
				</span>
			</span>
			{outcome ? (
				<span
					className={cn(
						"text-sm leading-5",
						failed ? "text-status-destructive" : "text-muted-foreground"
					)}
				>
					{outcome}
				</span>
			) : (
				<span />
			)}
		</li>
	);
}

function Schedule({
	channel,
	snapshot,
}: {
	channel: LiveChannel;
	snapshot: InterfaceSnapshot;
}) {
	const tl = useLiteralMessages();
	const { past, upcoming } = liveSchedule(snapshot, channel.agent.id);
	if (past.length === 0 && upcoming.length === 0) {
		return (
			<p className="text-muted-foreground text-sm leading-5">
				{tl("{name} has no scheduled streams.", { name: channel.agent.name })}
			</p>
		);
	}
	return (
		<div className="flex max-w-3xl flex-col gap-8">
			{upcoming.length > 0 ? (
				<section aria-label="Upcoming" className="flex flex-col gap-2">
					<h3 className="text-foreground text-sm leading-5">
						<span className="font-semibold">Upcoming</span>
					</h3>
					<ul>
						{upcoming.map((event) => (
							<ScheduleRow event={event} key={event.id} />
						))}
					</ul>
				</section>
			) : null}
			{past.length > 0 ? (
				<section aria-label="Recent runs" className="flex flex-col gap-2">
					<h3 className="text-foreground text-sm leading-5">
						<span className="font-semibold">Recent runs</span>
					</h3>
					<ul>
						{past.map((event) => (
							<ScheduleRow event={event} key={event.id} />
						))}
					</ul>
				</section>
			) : null}
		</div>
	);
}

function About({
	channel,
	snapshot,
}: {
	channel: LiveChannel;
	snapshot: InterfaceSnapshot;
}) {
	const tl = useLiteralMessages();
	const messages = channel.threads.reduce(
		(total, thread) => total + thread.messageCount,
		0
	);
	const categories = [
		...new Set(
			channel.threads
				.map((thread) => liveCategoryOf(snapshot, thread)?.name)
				.filter((name): name is string => Boolean(name))
		),
	];
	const stats: [string, string][] = [
		["Streams", channel.threads.length.toString()],
		["Messages", messages.toString()],
		["Live now", channel.liveCount.toString()],
	];
	return (
		<div className="flex max-w-3xl flex-col gap-6">
			<div className="flex flex-col gap-2">
				<h3 className="text-foreground text-lg leading-7">
					<span className="font-semibold">
						{tl("About {name}", { name: channel.agent.name })}
					</span>
				</h3>
				<p className="text-foreground text-sm leading-6">
					{channel.agent.description || "No description yet."}
				</p>
			</div>
			<dl className="flex gap-10">
				{stats.map(([label, value]) => (
					<div className="flex flex-col" key={label}>
						<dt className="text-muted-foreground text-sm leading-5">{label}</dt>
						<dd className="font-semibold text-foreground text-lg tabular-nums leading-7">
							{value}
						</dd>
					</div>
				))}
			</dl>
			{categories.length > 0 ? (
				<div className="flex flex-col gap-2">
					<h4 className="text-muted-foreground text-sm leading-5">
						Streams in
					</h4>
					<div className="flex flex-wrap gap-2">
						{categories.map((name) => (
							<LiveTag key={name}>{name}</LiveTag>
						))}
					</div>
				</div>
			) : null}
		</div>
	);
}

/**
 * The info bar under the player: the channel's avatar (ringed while live),
 * name, stream title, category and state, Message, and uptime.
 */
function ChannelInfo({
	channel,
	chatHidden,
	compact,
	featured,
	gutter,
	now,
	onCategory,
	onMessage,
	onShowChat,
	snapshot,
	streaming,
}: {
	channel: LiveChannel;
	chatHidden: boolean;
	compact: boolean;
	featured: InterfaceThread | null;
	gutter: number;
	now: number;
	onCategory: (categoryId: string) => void;
	onMessage: () => void;
	onShowChat: () => void;
	snapshot: InterfaceSnapshot;
	streaming: boolean;
}) {
	const tl = useLiteralMessages();
	const { agent } = channel;
	const category = liveCategoryOf(snapshot, featured);
	const tag = featured ? liveStatusTag(featured) : null;
	let status: ReactNode = null;
	if (featured && streaming) {
		status = (
			<LiveUptime className="text-foreground" since={featured.updatedAt} />
		);
	} else if (featured) {
		status = (
			<span>
				{liveMessages(featured.messageCount)} ·{" "}
				{liveAgo(featured.updatedAt, now)}
			</span>
		);
	}
	return (
		<div
			className={cn("flex gap-4 py-5", compact ? "flex-col" : "items-start")}
			style={{ paddingInline: gutter }}
		>
			<div className="flex min-w-0 flex-1 gap-4">
				<div className="relative shrink-0">
					<LiveAvatar
						agent={agent}
						className={cn(
							streaming &&
								"ring-2 ring-destructive ring-offset-2 ring-offset-background"
						)}
						size={64}
					/>
					{streaming ? (
						<LiveBadge className="absolute -bottom-2 left-1/2 -translate-x-1/2 ring-2 ring-background" />
					) : null}
				</div>
				<div className="flex min-w-0 flex-col gap-1">
					<h1 className="truncate text-foreground text-lg leading-7">
						<span className="font-semibold">{agent.name}</span>
					</h1>
					<p className="line-clamp-2 font-semibold text-foreground text-sm leading-5">
						{featured?.title ?? agent.description ?? "Offline"}
					</p>
					<div className="flex flex-wrap items-center gap-2">
						{category ? (
							<button
								className="rounded-sm text-primary text-sm leading-5 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
								onClick={() => onCategory(category.id)}
								type="button"
							>
								{category.name}
							</button>
						) : null}
						{tag ? <LiveTag>{tag}</LiveTag> : null}
					</div>
				</div>
			</div>
			<div
				className={cn(
					"flex shrink-0 gap-2",
					compact
						? "flex-row-reverse items-center justify-between"
						: "flex-col items-end"
				)}
			>
				<div className="flex items-center gap-2">
					{chatHidden ? (
						<Button
							onClick={onShowChat}
							size="sm"
							type="button"
							variant="outline"
						>
							<MessageSquare
								aria-hidden="true"
								className="size-4"
								data-icon="inline-start"
							/>
							Chat
						</Button>
					) : null}
					<Button
						aria-label={tl("Message {name}", { name: agent.name })}
						onClick={onMessage}
						size="sm"
						type="button"
						variant={streaming ? "outline" : "default"}
					>
						Message
					</Button>
				</div>
				{status ? (
					<p className="text-muted-foreground text-sm tabular-nums leading-5">
						{status}
					</p>
				) : null}
			</div>
		</div>
	);
}

/**
 * A channel: the player with the featured thread, the info bar, and the
 * reference's channel tabs: Videos (its other threads), Schedule (its
 * routines) and About.
 */
export function LiveChannelPage({
	actions,
	channel,
	chatHidden,
	compact,
	featured,
	gutter,
	onMessage,
	onShowChat,
	playerMaxWidth,
	reduceMotion,
	snapshot,
}: {
	actions: LiveTileActions;
	channel: LiveChannel;
	chatHidden: boolean;
	/** Stack the info bar's actions under the title on narrow pages. */
	compact: boolean;
	featured: InterfaceThread | null;
	gutter: number;
	onMessage: () => void;
	onShowChat: () => void;
	playerMaxWidth: number;
	reduceMotion: boolean;
	snapshot: InterfaceSnapshot;
}) {
	const tl = useLiteralMessages();
	const [tab, setTab] = useState<LiveChannelTab>("videos");
	const streaming = featured?.running === true;
	const videos = channel.threads.filter((thread) => thread.id !== featured?.id);
	let panel: ReactNode;
	if (tab === "schedule") {
		panel = <Schedule channel={channel} snapshot={snapshot} />;
	} else if (tab === "about") {
		panel = <About channel={channel} snapshot={snapshot} />;
	} else if (videos.length > 0) {
		panel = (
			<LiveThreadGrid
				actions={actions}
				dense
				showChannel={false}
				snapshot={snapshot}
				threads={videos}
			/>
		);
	} else {
		panel = (
			<p className="text-muted-foreground text-sm leading-5">
				{channel.threads.length > 0
					? tl("{name} has no other videos.", { name: channel.agent.name })
					: tl("{name} has not streamed yet.", { name: channel.agent.name })}
			</p>
		);
	}
	return (
		<div className="flex flex-col pb-16" data-live-channel={channel.agent.id}>
			<LivePlayer
				agent={channel.agent}
				live={channel.live}
				maxWidth={playerMaxWidth}
				reduceMotion={reduceMotion}
				thread={featured}
			/>
			<ChannelInfo
				channel={channel}
				chatHidden={chatHidden}
				compact={compact}
				featured={featured}
				gutter={gutter}
				now={actions.now}
				onCategory={actions.onCategory}
				onMessage={onMessage}
				onShowChat={onShowChat}
				snapshot={snapshot}
				streaming={streaming}
			/>
			<div className="border-border border-b" style={{ marginInline: gutter }}>
				<LiveTabs
					label={tl("{name} channel", { name: channel.agent.name })}
					onChange={setTab}
					tabs={[
						{ id: "videos", label: "Videos" },
						{ id: "schedule", label: "Schedule" },
						{ id: "about", label: "About" },
					]}
					value={tab}
				/>
			</div>
			<div className="pt-6" role="tabpanel" style={{ paddingInline: gutter }}>
				{panel}
			</div>
		</div>
	);
}
