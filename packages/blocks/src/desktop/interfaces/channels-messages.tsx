import { Button } from "@ryu/ui/components/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip";
import { cn } from "@ryu/ui/lib/utils";
import type {
	InterfaceAgent,
	InterfaceChannel,
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import {
	Check,
	ChevronRight,
	Copy,
	Hash,
	MessageSquareText,
	Pin,
} from "lucide-react";
import {
	type KeyboardEvent,
	type ReactNode,
	useEffect,
	useRef,
	useState,
} from "react";
import { ChannelsAvatar, PresenceDot } from "./channels-avatar.tsx";
import {
	clockTime,
	dayKey,
	dayLabel,
	lastReplyPhrase,
	withinWindow,
} from "./channels-time.ts";
import { agentById } from "./interface-renderer.ts";

/** How long the Copy action shows its confirmation. */
const COPIED_RESET_MS = 1600;

/** A sender's follow-ups fold into one block within this window. */
const COLLAPSE_WINDOW_MS = 5 * 60_000;
const MAX_THREAD_FACES = 3;

/**
 * Link ink: the theme's primary pulled toward the text color, so 12px links
 * clear AA contrast in light themes (a pale primary on white does not) while
 * still reading as the theme's link color.
 */
const LINK_INK =
	"text-[color-mix(in_oklab,var(--primary)_68%,var(--foreground))]";

interface MessageAuthor {
	agent?: InterfaceAgent;
	isAgent: boolean;
	key: string;
	name: string;
}

function authorOf(
	snapshot: InterfaceSnapshot,
	thread: InterfaceThread
): MessageAuthor {
	// A thread you just started has only your opening message so far.
	const startedByYou =
		thread.messageCount <= 1 && thread.lastMessageRole === "user";
	const agent = agentById(snapshot, thread.agentIds[0]);
	if (agent && !startedByYou) {
		return { agent, isAgent: true, key: agent.id, name: agent.name };
	}
	return { isAgent: false, key: "you", name: "You" };
}

type ListItem =
	| { key: string; kind: "day"; label: string }
	| {
			/** First message under a day divider: keep its toolbar off the rule. */
			afterDivider: boolean;
			author: MessageAuthor;
			compact: boolean;
			key: string;
			kind: "message";
			/** Tag the author as an app once per day, not on every message. */
			showAppTag: boolean;
			thread: InterfaceThread;
	  };

function buildItems(
	snapshot: InterfaceSnapshot,
	threads: InterfaceThread[],
	now: number
): ListItem[] {
	const items: ListItem[] = [];
	let previousDay: string | null = null;
	let previous: { author: string; at: string } | null = null;
	let taggedToday = new Set<string>();
	for (const thread of threads) {
		const day = dayKey(thread.updatedAt);
		if (day !== previousDay) {
			items.push({
				key: `day:${day}`,
				kind: "day",
				label: dayLabel(thread.updatedAt, now),
			});
			previousDay = day;
			previous = null;
			taggedToday = new Set<string>();
		}
		const afterDivider = previous === null;
		const author = authorOf(snapshot, thread);
		const compact =
			previous !== null &&
			!thread.pinned &&
			previous.author === author.key &&
			withinWindow(previous.at, thread.updatedAt, COLLAPSE_WINDOW_MS);
		const showAppTag =
			author.isAgent && !compact && !taggedToday.has(author.key);
		if (showAppTag) {
			taggedToday.add(author.key);
		}
		items.push({
			afterDivider,
			author,
			compact,
			key: thread.id,
			kind: "message",
			showAppTag,
			thread,
		});
		previous = { at: thread.updatedAt, author: author.key };
	}
	return items;
}

/** A run that ended without finishing: worth a word on the thread bar. */
type StoppedRun = "failed" | "interrupted" | null;

/** Another channel with search hits, offered when this one has none. */
export interface ChannelSearchHit {
	channel: InterfaceChannel;
	count: number;
	label: string;
}

/**
 * The channel's history: every thread is a parent message with
 * its thread bar, oldest first, anchored to the bottom (column-reverse keeps
 * the newest message in view without scroll effects).
 */
export function ChannelsMessageList({
	activeThreadId,
	channel,
	channelLabel,
	description,
	members,
	onClearSearch,
	onOpenThread,
	onSelectChannel,
	otherHits,
	pinnedOnly,
	searchQuery,
	snapshot,
	threads,
}: {
	activeThreadId: string | null;
	channel: InterfaceChannel;
	channelLabel: string;
	description: string;
	members: InterfaceAgent[];
	onClearSearch: () => void;
	onOpenThread: (threadId: string) => void;
	onSelectChannel: (channel: InterfaceChannel) => void;
	/** Other channels whose messages match the search. */
	otherHits: ChannelSearchHit[];
	/** The Pinned tab: only pinned threads, no channel intro. */
	pinnedOnly: boolean;
	/** Set when `threads` is narrowed by the title-bar search. */
	searchQuery: string | null;
	snapshot: InterfaceSnapshot;
	/** The channel's threads, oldest first. */
	threads: InterfaceThread[];
}) {
	const listRef = useRef<HTMLDivElement>(null);
	const now = Date.now();
	const items = buildItems(snapshot, threads, now);

	// Arrow keys walk between the message actions; Tab still reaches every
	// control in order.
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
			return;
		}
		const controls = [
			...(listRef.current?.querySelectorAll<HTMLButtonElement>(
				"[data-message-action]"
			) ?? []),
		];
		const index = controls.indexOf(document.activeElement as HTMLButtonElement);
		if (index === -1) {
			return;
		}
		event.preventDefault();
		const step = event.key === "ArrowDown" ? 1 : -1;
		controls[Math.min(controls.length - 1, Math.max(0, index + step))]?.focus();
	};

	const displayLabel =
		channel.kind === "agent" ? channelLabel : `#${channelLabel}`;
	if (searchQuery !== null && threads.length === 0) {
		return (
			<SearchEmpty
				channelLabel={displayLabel}
				hits={otherHits}
				onClear={onClearSearch}
				onSelectChannel={onSelectChannel}
				query={searchQuery}
				snapshot={snapshot}
			/>
		);
	}
	if (pinnedOnly && threads.length === 0) {
		return (
			<PaneNote
				description="Pinned threads stay at the top of this tab, so the ones you keep coming back to are one click away."
				title={<>Nothing pinned in {displayLabel}</>}
			/>
		);
	}

	// Search results and the pinned list read down from the top; history
	// reads up from the composer.
	const topAnchored = pinnedOnly || searchQuery !== null;
	const showIntro = !(pinnedOnly || searchQuery !== null);

	return (
		<>
			{searchQuery === null ? null : (
				<SearchBanner
					channelLabel={displayLabel}
					count={threads.length}
					onClear={onClearSearch}
					query={searchQuery}
				/>
			)}
			<div
				className={cn(
					// Day dividers stick to the top edge as the history scrolls.
					"flex min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-width:thin]",
					topAnchored ? "flex-col" : "flex-col-reverse"
				)}
			>
				<div className={cn("flex flex-col pb-4", topAnchored && "pt-2")}>
					{showIntro ? (
						<ChannelIntro
							channel={channel}
							channelLabel={channelLabel}
							description={description}
							members={members}
							snapshot={snapshot}
						/>
					) : null}
					<div
						aria-busy="false"
						aria-label={
							pinnedOnly ? "Pinned threads" : "Threads in this channel"
						}
						className="flex flex-col"
						onKeyDown={onKeyDown}
						ref={listRef}
						role="feed"
					>
						{items.map((item) =>
							item.kind === "day" ? (
								<DayDivider
									key={item.key}
									label={item.label}
									// Read from the top, the first day sits right under
									// the tab rule: a second hairline would stack on it.
									ruled={!(topAnchored && item === items[0])}
								/>
							) : (
								<MessageRow
									active={item.thread.id === activeThreadId}
									afterDivider={item.afterDivider}
									author={item.author}
									compact={item.compact}
									highlight={searchQuery}
									key={item.key}
									now={now}
									onOpenThread={onOpenThread}
									showAppTag={item.showAppTag}
									snapshot={snapshot}
									thread={item.thread}
								/>
							)
						)}
					</div>
				</div>
			</div>
		</>
	);
}

function ChannelIntro({
	channel,
	channelLabel,
	description,
	members,
	snapshot,
}: {
	channel: InterfaceChannel;
	channelLabel: string;
	description: string;
	members: InterfaceAgent[];
	snapshot: InterfaceSnapshot;
}) {
	if (channel.kind === "agent") {
		const agent = agentById(snapshot, channel.agentIds[0]);
		const working = agent?.status === "working";
		return (
			<div className="flex flex-col items-start px-5 pt-8 pb-6">
				<ChannelsAvatar agent={agent} name={channel.name} size={72} />
				<h3 className="mt-4 font-bold! @max-[480px]/channel:text-xl text-2xl text-foreground tracking-tight">
					{channelLabel}
				</h3>
				<p className="mt-1 flex min-w-0 max-w-full items-center gap-1.5 text-foreground/70 text-sm leading-5">
					<span className="relative inline-flex size-3 shrink-0">
						<PresenceDot active={working} className="inset-0 size-3" />
					</span>
					{working ? "Working" : "Away"}
					{agent?.description ? (
						<>
							<span aria-hidden="true">·</span>
							<span className="min-w-0 truncate">{agent.description}</span>
						</>
					) : null}
				</p>
				<p className="mt-4 max-w-[640px] text-foreground text-sm leading-6">
					This conversation is just between you and{" "}
					<span
						className={cn(
							"rounded-sm bg-primary/10 px-0.5 font-medium",
							LINK_INK
						)}
					>
						@{channelLabel}
					</span>
					. Every message you send here starts a new thread.
				</p>
			</div>
		);
	}
	return (
		<div className="flex flex-col items-start px-5 pt-8 pb-6">
			{/* The channel name never breaks at its hyphens. */}
			<h3 className="font-bold! @max-[480px]/channel:text-xl text-2xl text-foreground tracking-tight">
				Welcome to <span className="whitespace-nowrap">#{channelLabel}</span>
			</h3>
			{description ? (
				<p className="mt-2 max-w-[640px] text-foreground text-sm leading-6">
					{description}
				</p>
			) : null}
			{members.length > 0 ? (
				<p className="mt-1 max-w-[640px] text-foreground/70 text-sm leading-6">
					{memberSentence(members)}
				</p>
			) : null}
		</div>
	);
}

/** "Brook and Forge are in this channel." with a tail for long lists. */
function memberSentence(members: InterfaceAgent[]): string {
	const names = members.map((member) => member.name);
	if (names.length === 1) {
		return `${names[0]} is in this channel.`;
	}
	if (names.length <= MAX_THREAD_FACES) {
		return `${names.slice(0, -1).join(", ")} and ${names.at(-1)} are in this channel.`;
	}
	const rest = names.length - (MAX_THREAD_FACES - 1);
	return `${names.slice(0, MAX_THREAD_FACES - 1).join(", ")} and ${rest} others are in this channel.`;
}

const MARK_CLASS = "rounded-sm bg-warning/30 text-inherit";

/** Wraps every case-insensitive occurrence of `needle` in a <mark>. */
function Highlighted({
	needle,
	text,
}: {
	needle: string | null;
	text: string;
}) {
	const query = needle?.toLowerCase();
	if (!query) {
		return text;
	}
	const lower = text.toLowerCase();
	const parts: Array<{ marked: boolean; start: number; value: string }> = [];
	let cursor = 0;
	let found = lower.indexOf(query, cursor);
	while (found !== -1) {
		if (found > cursor) {
			parts.push({
				marked: false,
				start: cursor,
				value: text.slice(cursor, found),
			});
		}
		parts.push({
			marked: true,
			start: found,
			value: text.slice(found, found + query.length),
		});
		cursor = found + query.length;
		found = lower.indexOf(query, cursor);
	}
	if (cursor < text.length) {
		parts.push({ marked: false, start: cursor, value: text.slice(cursor) });
	}
	return parts.map((part) =>
		part.marked ? (
			<mark className={MARK_CLASS} key={part.start}>
				{part.value}
			</mark>
		) : (
			<span key={part.start}>{part.value}</span>
		)
	);
}

function SearchBanner({
	channelLabel,
	count,
	onClear,
	query,
}: {
	channelLabel: string;
	count: number;
	onClear: () => void;
	query: string;
}) {
	const summary =
		count === 1
			? `1 message in ${channelLabel} matches`
			: `${count} messages in ${channelLabel} match`;
	return (
		<div className="flex shrink-0 items-center gap-3 border-border border-b px-5 py-2">
			<p
				aria-live="polite"
				className="min-w-0 flex-1 truncate text-foreground text-sm leading-6"
				role="status"
			>
				{summary}{" "}
				<mark className={`${MARK_CLASS} px-0.5 font-medium`}>{query}</mark>
			</p>
			<Button
				className={cn("shrink-0 px-0 text-sm", LINK_INK)}
				onClick={onClear}
				size="xs"
				variant="link"
			>
				Clear search
			</Button>
		</div>
	);
}

/**
 * A quiet note in the message area (an empty tab): a semibold line and one
 * sentence, left-aligned in a readable column, with no icon tile or card.
 */
function PaneNote({
	children,
	description,
	live = false,
	title,
}: {
	children?: ReactNode;
	description: string;
	/** Announce the title when it changes (search results). */
	live?: boolean;
	title: ReactNode;
}) {
	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 pt-8 pb-12">
			<div className="flex w-full max-w-md flex-col">
				<h3
					aria-live={live ? "polite" : undefined}
					className="font-semibold! text-base text-foreground leading-6"
					role={live ? "status" : undefined}
				>
					{title}
				</h3>
				<p className="mt-1 text-foreground/70 text-sm leading-5">
					{description}
				</p>
				{children}
			</div>
		</div>
	);
}

/**
 * No hits in this channel: say so in the middle of the pane, and point at
 * the channels that do have hits instead of leaving you to hunt for them.
 */
function SearchEmpty({
	channelLabel,
	hits,
	onClear,
	onSelectChannel,
	query,
	snapshot,
}: {
	channelLabel: string;
	hits: ChannelSearchHit[];
	onClear: () => void;
	onSelectChannel: (channel: InterfaceChannel) => void;
	query: string;
	snapshot: InterfaceSnapshot;
}) {
	return (
		<PaneNote
			description={
				hits.length > 0
					? "These channels have matching messages:"
					: "Nothing in any channel matches. Try a name or a shorter word."
			}
			live
			title={
				<>
					No messages in{" "}
					<span className="whitespace-nowrap">{channelLabel}</span> match{" "}
					<mark className={`${MARK_CLASS} whitespace-nowrap px-0.5`}>
						{query}
					</mark>
				</>
			}
		>
			{hits.length > 0 ? (
				<ul
					aria-label="Channels with matches"
					className="-mx-2 mt-3 flex max-w-[360px] flex-col"
				>
					{hits.map((hit) => (
						<li key={hit.channel.id}>
							<button
								className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-foreground text-sm outline-hidden transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
								onClick={() => onSelectChannel(hit.channel)}
								type="button"
							>
								{hit.channel.kind === "agent" ? (
									<ChannelsAvatar
										agent={agentById(snapshot, hit.channel.agentIds[0])}
										name={hit.label}
										size={20}
									/>
								) : (
									<Hash
										aria-hidden="true"
										className="size-4 shrink-0 text-foreground/70"
									/>
								)}
								<span className="min-w-0 flex-1 truncate">{hit.label}</span>
								<span className="shrink-0 text-foreground/70 text-xs tabular-nums">
									{hit.count === 1 ? "1 match" : `${hit.count} matches`}
								</span>
							</button>
						</li>
					))}
				</ul>
			) : null}
			<Button
				className={cn("mt-3 self-start px-0 text-sm", LINK_INK)}
				onClick={onClear}
				size="xs"
				variant="link"
			>
				Clear search
			</Button>
		</PaneNote>
	);
}

function DayDivider({ label, ruled }: { label: string; ruled: boolean }) {
	return (
		<div className="sticky top-0 z-10 flex h-10 items-center justify-center">
			{ruled ? (
				<span
					aria-hidden="true"
					className="absolute inset-x-0 top-1/2 h-px bg-border"
				/>
			) : null}
			{/* A label, not a control: it names the day the messages below share. */}
			<h3 className="relative cursor-default select-none rounded-full border border-border bg-background px-3 font-semibold! text-foreground text-xs leading-6">
				{label}
			</h3>
		</div>
	);
}

function MessageRow({
	active,
	afterDivider,
	author,
	compact,
	highlight,
	now,
	onOpenThread,
	showAppTag,
	snapshot,
	thread,
}: {
	active: boolean;
	afterDivider: boolean;
	author: MessageAuthor;
	compact: boolean;
	/** The search text to mark in the message. */
	highlight: string | null;
	now: number;
	onOpenThread: (threadId: string) => void;
	showAppTag: boolean;
	snapshot: InterfaceSnapshot;
	thread: InterfaceThread;
}) {
	const time = clockTime(thread.updatedAt);
	const replies = Math.max(0, thread.messageCount - 1);
	const faces = thread.agentIds
		.map((agentId) => agentById(snapshot, agentId))
		.filter((agent): agent is InterfaceAgent => agent !== undefined)
		.slice(0, MAX_THREAD_FACES);
	const title = thread.title || "Untitled";
	const body =
		thread.lastMessage && thread.lastMessage.trim() !== title.trim()
			? thread.lastMessage
			: null;
	// Copy what the message shows: its title, then its latest text.
	const copyText = body ? `${title}\n${body}` : title;
	let stopped: StoppedRun = null;
	if (!thread.running && thread.runState === "failed") {
		stopped = "failed";
	} else if (!thread.running && thread.runState === "interrupted") {
		stopped = "interrupted";
	}
	return (
		<article
			aria-label={`${author.name}, ${time}: ${title}`}
			className={cn(
				"group relative flex flex-col px-5 transition-colors",
				compact ? "py-0.5" : "py-2",
				thread.pinned &&
					!active &&
					"bg-warning/5 hover:bg-warning/10 has-[:focus-visible]:bg-warning/10",
				active && "bg-primary/10",
				!(thread.pinned || active) &&
					"hover:bg-muted/60 has-[:focus-visible]:bg-muted/60"
			)}
		>
			{thread.pinned ? (
				// Its own row above the message, so the avatar still lines up
				// with the author line below it.
				<p className="flex gap-3 text-foreground/80 text-xs leading-5">
					<span className="flex w-9 shrink-0 items-center justify-end">
						<Pin aria-hidden="true" className="size-3 text-warning" />
					</span>
					Pinned by you
				</p>
			) : null}
			<div className="flex gap-3">
				<div className="flex w-9 shrink-0 justify-center">
					{compact ? (
						<span className="invisible whitespace-nowrap text-foreground/70 text-xs tabular-nums leading-6 group-hover:visible group-has-[:focus-visible]:visible">
							{time.replace(/\s?[AP]M$/, "")}
						</span>
					) : (
						<ChannelsAvatar
							agent={author.agent}
							className="mt-0.5"
							name={author.name}
							size={36}
						/>
					)}
				</div>
				<div className="min-w-0 flex-1">
					{compact ? null : (
						<p className="flex min-w-0 items-baseline gap-1.5">
							<span className="truncate font-bold text-foreground text-sm leading-6">
								{author.name}
							</span>
							{showAppTag ? (
								<span className="shrink-0 rounded-sm bg-muted px-1 font-semibold text-foreground/90 text-xs leading-4">
									App
								</span>
							) : null}
							<time
								className="shrink-0 whitespace-nowrap text-foreground/70 text-xs tabular-nums leading-6"
								dateTime={thread.updatedAt}
							>
								{time}
							</time>
						</p>
					)}
					<p className="max-w-[720px] whitespace-pre-wrap break-words font-semibold text-foreground text-sm leading-6">
						<Highlighted needle={highlight} text={title} />
					</p>
					{body ? (
						<p className="line-clamp-2 max-w-[720px] whitespace-pre-wrap break-words text-foreground text-sm leading-6">
							<Highlighted needle={highlight} text={body} />
						</p>
					) : null}
					{replies > 0 || thread.running || stopped ? (
						<ThreadBar
							faces={faces}
							now={now}
							onOpen={() => onOpenThread(thread.id)}
							replies={replies}
							running={thread.running}
							stopped={stopped}
							title={title}
							updatedAt={thread.updatedAt}
							workerName={faces[0]?.name}
						/>
					) : null}
				</div>
			</div>
			<div
				className={cn(
					"absolute right-5 z-20 flex rounded-lg border border-border bg-popover p-0.5 text-popover-foreground opacity-0 shadow-sm transition-opacity duration-100 motion-reduce:transition-none",
					"group-hover:opacity-100 group-has-[:focus-visible]:opacity-100",
					// Under a day divider the toolbar would sit on the rule.
					afterDivider ? "top-1" : "-top-4"
				)}
			>
				<Tooltip>
					<TooltipTrigger
						render={
							<Button
								aria-label="Reply in thread"
								className="text-foreground/70"
								data-message-action=""
								onClick={() => onOpenThread(thread.id)}
								size="icon-sm"
								variant="ghost-muted"
							/>
						}
					>
						<MessageSquareText aria-hidden="true" />
					</TooltipTrigger>
					<TooltipContent side="top">Reply in thread</TooltipContent>
				</Tooltip>
				<CopyMessageButton text={copyText} />
			</div>
		</article>
	);
}

/**
 * Copies the message text to the clipboard and confirms in place (icon,
 * tooltip and a polite live announcement), or says so when the clipboard
 * is unavailable.
 */
function CopyMessageButton({ text }: { text: string }) {
	const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
	useEffect(() => {
		if (state === "idle") {
			return;
		}
		const timer = window.setTimeout(() => setState("idle"), COPIED_RESET_MS);
		return () => window.clearTimeout(timer);
	}, [state]);
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(text);
			setState("copied");
		} catch {
			setState("failed");
		}
	};
	let label = "Copy message";
	if (state === "copied") {
		label = "Copied";
	} else if (state === "failed") {
		label = "Couldn't copy";
	}
	return (
		<>
			<Tooltip>
				<TooltipTrigger
					render={
						<Button
							aria-label="Copy message"
							className={cn(
								"text-foreground/70",
								state === "copied" && "text-success hover:text-success"
							)}
							data-message-action=""
							onClick={copy}
							size="icon-sm"
							variant="ghost-muted"
						/>
					}
				>
					{state === "copied" ? (
						<Check aria-hidden="true" />
					) : (
						<Copy aria-hidden="true" />
					)}
				</TooltipTrigger>
				<TooltipContent side="top">{label}</TooltipContent>
			</Tooltip>
			<span aria-live="polite" className="sr-only">
				{state === "idle" ? "" : label}
			</span>
		</>
	);
}

function ThreadBar({
	faces,
	now,
	onOpen,
	replies,
	running,
	stopped,
	title,
	updatedAt,
	workerName,
}: {
	faces: InterfaceAgent[];
	now: number;
	onOpen: () => void;
	replies: number;
	running: boolean;
	stopped: StoppedRun;
	title: string;
	updatedAt: string;
	workerName?: string;
}) {
	const stoppedLabel = stopped === "failed" ? "Run failed" : "Run interrupted";
	const repliesLabel = replies === 1 ? "1 reply" : `${replies} replies`;
	const last = lastReplyPhrase(updatedAt, now);
	const workingLabel = workerName ? `${workerName} is working…` : "Working…";
	let summary =
		replies > 0 ? `${repliesLabel}, last reply ${last}` : workingLabel;
	if (stopped) {
		summary =
			replies > 0
				? `${repliesLabel}, ${stoppedLabel.toLowerCase()}`
				: stoppedLabel;
	}
	return (
		<button
			aria-label={`${summary}: ${title}`}
			className="group/bar mt-1 -ml-1 flex w-full max-w-[728px] items-center gap-2 rounded-md p-1 text-left outline-hidden transition-colors hover:bg-background hover:ring-1 hover:ring-border focus-visible:bg-background focus-visible:ring-2 focus-visible:ring-ring"
			data-message-action=""
			onClick={onOpen}
			type="button"
		>
			{faces.length > 0 ? (
				// Separate tiles with a hairline gap, as a team chat lays out
				// the faces of a thread's participants.
				<span className="flex gap-1">
					{faces.map((face) => (
						<ChannelsAvatar
							agent={face}
							key={face.id}
							name={face.name}
							size={20}
						/>
					))}
				</span>
			) : null}
			{replies > 0 ? (
				<span
					className={cn(
						"shrink-0 whitespace-nowrap font-semibold text-xs underline-offset-2 group-hover/bar:underline",
						LINK_INK
					)}
				>
					{repliesLabel}
				</span>
			) : null}
			{running ? (
				<span className="flex min-w-0 shrink-0 items-center gap-1.5 whitespace-nowrap text-foreground text-xs">
					<span
						aria-hidden="true"
						className="size-2 shrink-0 rounded-full bg-success"
					/>
					{workingLabel}
				</span>
			) : null}
			{stopped ? (
				<span className="shrink-0 whitespace-nowrap font-semibold text-destructive text-xs">
					{stoppedLabel}
				</span>
			) : null}
			{replies > 0 ? (
				<span className="@max-[420px]/channel:hidden min-w-0 truncate text-foreground/70 text-xs group-hover/bar:hidden group-focus-visible/bar:hidden">
					Last reply {last}
				</span>
			) : null}
			<span className="ml-auto hidden shrink-0 items-center gap-0.5 whitespace-nowrap pr-1 text-foreground/70 text-xs group-hover/bar:flex group-focus-visible/bar:flex">
				View thread
				<ChevronRight aria-hidden="true" className="size-4" />
			</span>
		</button>
	);
}
