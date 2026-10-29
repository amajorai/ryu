import { Button } from "@ryu/ui/components/button";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import {
	Tabs,
	TabsContent,
	TabsIndicator,
	TabsList,
	TabsTrigger,
} from "@ryu/ui/components/tabs.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	type ChannelsParams,
	channelHandle,
	type InterfaceAgent,
	type InterfaceChannel,
	type InterfaceSnapshot,
	type InterfaceThread,
	projectChannels,
} from "@ryuhq/protocol/interfaces";
import {
	ChevronLeft,
	Hash,
	MessageCircle,
	MessagesSquare,
	Pin,
	SquarePen,
	Users,
	X,
} from "lucide-react";
import { motion } from "motion/react";
import { type ReactNode, useMemo, useState } from "react";
import { ChannelsAvatar, PresenceDot } from "./channels-avatar.tsx";
import { ChannelsComposer } from "./channels-composer.tsx";
import { ChannelsMembers } from "./channels-members.tsx";
import {
	type ChannelSearchHit,
	ChannelsMessageList,
} from "./channels-messages.tsx";
import {
	ChannelsSidebar,
	useChannelsSidebarState,
	WorkspaceRail,
} from "./channels-sidebar.tsx";
import { ChannelsTitleBar } from "./channels-titlebar.tsx";
import {
	agentById,
	type InterfaceRendererProps,
} from "./interface-renderer.ts";
import { useReducedMotion } from "./reduced-motion.ts";

type ChannelView = "messages" | "pinned";
/** Below 640px one column shows at a time: the channel list or a channel. */
type PhoneColumn = "list" | "channel";

/** Message skeleton text widths: one or two lines, never a uniform grid. */
const MESSAGE_SKELETON_LINES = [
	["w-3/4"],
	["w-full max-w-[560px]", "w-2/5"],
	["w-1/2"],
] as const;

/** A plain underlined tab: no pill, the indicator draws the rule. */
const TAB_CLASS =
	"flex-none rounded-md px-0.5 text-foreground/70 after:hidden hover:text-foreground data-active:text-foreground dark:text-foreground/70 dark:hover:text-foreground data-active:bg-transparent! dark:data-active:bg-transparent!";

function channelLabelFor(
	channel: InterfaceChannel,
	groupNames: ReadonlyMap<string, string>
): string {
	return channel.kind === "agent"
		? channel.name
		: channelHandle(groupNames.get(channel.id) ?? channel.name);
}

function channelDescription(
	channel: InterfaceChannel,
	groupNames: ReadonlyMap<string, string>
): string {
	const groupName = groupNames.get(channel.id) ?? channel.name;
	switch (channel.kind) {
		case "team":
			return `Every message here starts a thread with the ${groupName} team.`;
		case "project":
			return `Threads for the ${groupName} project live here; every message starts a new one.`;
		case "general":
			return "Threads without a team, project or agent land here.";
		default:
			return "";
	}
}

function channelMembers(
	channel: InterfaceChannel,
	snapshot: InterfaceSnapshot
): InterfaceAgent[] {
	if (channel.kind === "general" && channel.agentIds.length === 0) {
		return snapshot.agents;
	}
	return channel.agentIds
		.map((agentId) => agentById(snapshot, agentId))
		.filter((agent): agent is InterfaceAgent => agent !== undefined);
}

/** Lowercased, trimmed search text; empty means "not searching". */
function normalizeQuery(query: string): string {
	return query.trim().toLowerCase();
}

function threadMatches(
	thread: InterfaceThread,
	needle: string,
	snapshot: InterfaceSnapshot
): boolean {
	if (thread.title.toLowerCase().includes(needle)) {
		return true;
	}
	if (thread.lastMessage?.toLowerCase().includes(needle)) {
		return true;
	}
	return thread.agentIds.some((agentId) =>
		agentById(snapshot, agentId)?.name.toLowerCase().includes(needle)
	);
}

/** Members first, then everyone else: the picker's order. */
function recipientsFor(
	members: InterfaceAgent[],
	agents: InterfaceAgent[]
): InterfaceAgent[] {
	const memberIds = new Set(members.map((member) => member.id));
	return [...members, ...agents.filter((agent) => !memberIds.has(agent.id))];
}

/**
 * Team-chat interface: teams and projects are #channels, agents are direct
 * messages, each thread is a parent message with a thread bar, and the open
 * thread shows the host's chat surface in a right-hand thread panel. Every
 * color comes from the user's theme: the frame, rail and channel list use
 * the sidebar tokens, the conversation uses the background tokens.
 */
export function ChannelsInterface({
	activeThreadId,
	loading,
	params,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<ChannelsParams>) {
	const sections = useMemo(
		() => projectChannels(snapshot, params),
		[snapshot, params]
	);
	const allChannels = useMemo(
		() => sections.flatMap((section) => section.channels),
		[sections]
	);
	const groupNames = useMemo(
		() =>
			new Map(
				snapshot.groups.map((group) => [
					`${group.kind}:${group.id}`,
					group.name,
				])
			),
		[snapshot.groups]
	);
	const threadsById = useMemo(
		() => new Map(snapshot.threads.map((thread) => [thread.id, thread])),
		[snapshot.threads]
	);
	const runningCounts = useMemo(() => {
		const counts = new Map<string, number>();
		for (const channel of allChannels) {
			const running = channel.threadIds.filter(
				(threadId) => threadsById.get(threadId)?.running
			).length;
			if (running > 0) {
				counts.set(channel.id, running);
			}
		}
		return counts;
	}, [allChannels, threadsById]);
	const sidebar = useChannelsSidebarState();
	const [query, setQuery] = useState("");
	const needle = normalizeQuery(query);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	// Follow the open thread to its channel; otherwise keep the user's pick.
	const channelOfActive = activeThreadId
		? allChannels.find((channel) => channel.threadIds.includes(activeThreadId))
		: undefined;
	const selected =
		channelOfActive ??
		allChannels.find((channel) => channel.id === selectedId) ??
		allChannels[0];
	const selectedAgentId =
		selected?.kind === "agent" ? selected.agentIds[0] : undefined;
	const selectedTeamId =
		selected?.kind === "team" ? selected.id.slice("team:".length) : undefined;
	const selectedProjectId =
		selected?.kind === "project"
			? selected.id.slice("project:".length)
			: undefined;
	const labelFor = (channel: InterfaceChannel) =>
		channelLabelFor(channel, groupNames);
	const threadsOf = (channel: InterfaceChannel) =>
		channel.threadIds
			.map((threadId) => threadsById.get(threadId))
			.filter((thread): thread is InterfaceThread => thread !== undefined);

	// Search narrows the sidebar to channels whose name or messages match,
	// and the open channel to its matching messages. A channel found by its
	// name alone shows all of its messages: the channel itself is the hit.
	const nameMatches = (channel: InterfaceChannel) =>
		labelFor(channel).toLowerCase().includes(needle);
	const visibleSections = needle
		? sections.map((section) => ({
				...section,
				channels: section.channels.filter(
					(channel) =>
						channel.id === selected?.id ||
						nameMatches(channel) ||
						threadsOf(channel).some((thread) =>
							threadMatches(thread, needle, snapshot)
						)
				),
			}))
		: sections;
	const selectedThreads = selected ? threadsOf(selected).reverse() : [];
	const matchingThreads = needle
		? selectedThreads.filter((thread) =>
				threadMatches(thread, needle, snapshot)
			)
		: selectedThreads;
	const searchApplies =
		needle !== "" &&
		!(selected && nameMatches(selected) && matchingThreads.length === 0);
	const otherHits: ChannelSearchHit[] = [];
	if (searchApplies) {
		for (const channel of allChannels) {
			if (channel.id === selected?.id) {
				continue;
			}
			const count = threadsOf(channel).filter((thread) =>
				threadMatches(thread, needle, snapshot)
			).length;
			if (count > 0) {
				otherHits.push({ channel, count, label: labelFor(channel) });
			}
		}
	}

	// Switching channels never opens a thread: it closes the
	// open one, which also lets the new pick win over the thread's channel.
	const [phoneColumn, setPhoneColumn] = useState<PhoneColumn>(
		activeThreadId ? "channel" : "list"
	);
	const selectChannel = (channel: InterfaceChannel) => {
		setSelectedId(channel.id);
		setPhoneColumn("channel");
		port.closeThread();
	};
	// A member's direct conversation; an agent without one (hidden by the
	// layout's params) gets a fresh thread instead.
	const messageAgent = (agentId: string) => {
		const dm = allChannels.find((channel) => channel.id === `agent:${agentId}`);
		if (dm) {
			selectChannel(dm);
		} else {
			port.startThread({ agentId });
		}
	};
	const threadOpen = Boolean(threadView);
	const onCompose = () => port.startThread({});
	// An open thread always needs the channel column on a phone.
	const showChannelColumn = threadOpen || phoneColumn === "channel";
	let pane: ReactNode;
	if (selected) {
		pane = (
			<ChannelPane
				activeThreadId={activeThreadId}
				channel={selected}
				description={channelDescription(selected, groupNames)}
				// Tabs and drafts belong to one channel.
				key={selected.id}
				label={labelFor(selected)}
				onBack={() => setPhoneColumn("list")}
				onClearSearch={() => setQuery("")}
				onClose={() => port.closeThread()}
				onMessageAgent={messageAgent}
				onOpenThread={(threadId) => port.openThread(threadId)}
				onSelectChannel={selectChannel}
				onSend={({ agentId, prompt }) =>
					port.startThread({
						agentId: selectedAgentId ?? agentId,
						projectId: selectedProjectId,
						prompt,
						teamId: selectedTeamId,
					})
				}
				otherHits={otherHits}
				searchQuery={searchApplies ? query.trim() : null}
				selectedAgentId={selectedAgentId}
				// A team receives the prompt as a team (Core's team id wins
				// over an agent), and a DM has exactly one recipient, so
				// only #general and project channels offer a picker.
				showPicker={!(selectedAgentId || selectedTeamId)}
				snapshot={snapshot}
				threads={searchApplies ? matchingThreads : selectedThreads}
				threadView={threadView}
			/>
		);
	} else if (loading) {
		pane = <PaneSkeleton />;
	} else {
		pane = <NoAgents onCompose={onCompose} />;
	}

	return (
		<div
			className="@container relative flex size-full min-h-0 flex-col overflow-hidden bg-sidebar text-foreground"
			data-testid="interface-channels"
		>
			<ChannelsTitleBar onQueryChange={setQuery} query={query} />
			<div className="flex min-h-0 flex-1">
				<WorkspaceRail onHome={sidebar.goHome} threadOpen={threadOpen} />
				<ChannelsSidebar
					className={cn(
						showChannelColumn && "@max-[640px]:hidden",
						// An open thread takes the list's place below 1100px, so the
						// channel keeps a readable column beside the thread panel.
						threadOpen && "@max-[1100px]:hidden"
					)}
					collapsed={sidebar.collapsed}
					filtering={needle !== ""}
					labelFor={labelFor}
					loading={loading}
					navRef={sidebar.navRef}
					onCompose={onCompose}
					onSelect={selectChannel}
					onToggle={sidebar.toggle}
					runningCounts={runningCounts}
					sections={visibleSections}
					selectedId={selected?.id}
					snapshot={snapshot}
				/>
				<div
					className={cn(
						"corner-squircle relative @max-[900px]:m-0 my-2 mr-2 flex min-w-0 flex-1 overflow-hidden @max-[900px]:rounded-none rounded-xl border border-border @max-[900px]:border-y-0 @max-[900px]:border-r-0 @max-[640px]:border-l-0 bg-background text-foreground",
						!showChannelColumn && "@max-[640px]:hidden",
						// With the rail and list hidden for a thread, keep the
						// frame's gap on the left edge too.
						threadOpen && "@min-[900px]:@max-[1100px]:ml-2"
					)}
				>
					{pane}
				</div>
			</div>
		</div>
	);
}

/** The pane while the first snapshot loads: the header and three messages. */
function PaneSkeleton() {
	return (
		<div
			aria-busy="true"
			aria-label="Loading channel"
			className="flex min-w-0 flex-1 flex-col"
			role="status"
		>
			<div className="flex h-12 shrink-0 items-center gap-2 border-border border-b px-5">
				<Skeleton className="size-4" radius="dense" />
				<Skeleton className="h-4 w-36" radius="dense" />
			</div>
			<div aria-hidden="true" className="mt-auto flex flex-col gap-4 px-5 py-4">
				{MESSAGE_SKELETON_LINES.map((lines) => (
					<div className="flex gap-3" key={lines.join()}>
						<Skeleton className="size-9 shrink-0" radius="dense" />
						<div className="flex min-w-0 flex-1 flex-col gap-2 pt-1">
							<Skeleton className="h-3 w-20" radius="dense" />
							{lines.map((width) => (
								<Skeleton
									className={cn("h-3", width)}
									key={width}
									radius="dense"
								/>
							))}
						</div>
					</div>
				))}
				<Skeleton className="mt-2 h-20 w-full" radius="panel" />
			</div>
		</div>
	);
}

/** No agents, so no channels: say what fills this space and offer the first step. */
function NoAgents({ onCompose }: { onCompose: () => void }) {
	return (
		<div className="flex min-w-0 flex-1 items-center justify-center p-6">
			<Empty>
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<MessagesSquare aria-hidden="true" />
					</EmptyMedia>
					<EmptyTitle>No agents yet</EmptyTitle>
					<EmptyDescription className="text-foreground/70">
						Agents and teams you create appear here as channels and direct
						messages.
					</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button onClick={onCompose} size="sm">
						<SquarePen aria-hidden="true" />
						New message
					</Button>
				</EmptyContent>
			</Empty>
		</div>
	);
}

function ChannelPane({
	activeThreadId,
	channel,
	description,
	label,
	onBack,
	onClearSearch,
	onClose,
	onMessageAgent,
	onOpenThread,
	onSelectChannel,
	onSend,
	otherHits,
	searchQuery,
	selectedAgentId,
	showPicker,
	snapshot,
	threads,
	threadView,
}: {
	activeThreadId: string | null;
	channel: InterfaceChannel;
	description: string;
	label: string;
	/** Phone layout: back to the channel list. */
	onBack: () => void;
	onClearSearch: () => void;
	onClose: () => void;
	onMessageAgent: (agentId: string) => void;
	onOpenThread: (threadId: string) => void;
	onSelectChannel: (channel: InterfaceChannel) => void;
	onSend: (input: { agentId?: string; prompt: string }) => void;
	otherHits: ChannelSearchHit[];
	searchQuery: string | null;
	selectedAgentId: string | undefined;
	showPicker: boolean;
	snapshot: InterfaceSnapshot;
	threads: InterfaceThread[];
	threadView: InterfaceRendererProps<ChannelsParams>["threadView"];
}) {
	const isDm = channel.kind === "agent";
	const dmAgent = isDm ? agentById(snapshot, selectedAgentId) : undefined;
	const members = channelMembers(channel, snapshot);
	// Members lead the picker and the default recipient is a member, so a
	// message in #website-redesign goes to someone who is in it.
	const composerAgents = showPicker
		? recipientsFor(members, snapshot.agents)
		: undefined;
	const defaultAgentId = selectedAgentId ?? members[0]?.id;
	const [view, setView] = useState<ChannelView>("messages");
	const reduceMotion = useReducedMotion();
	const pinned = threads.filter((thread) => thread.pinned);
	// Without a picker, the composer names who gets the message.
	let recipient: ReactNode = null;
	if (isDm) {
		recipient = (
			<>
				<ChannelsAvatar agent={dmAgent} name={label} size={16} />
				<span className="truncate">@{label}</span>
			</>
		);
	} else if (!showPicker) {
		recipient = (
			<>
				<Users aria-hidden="true" className="size-4 shrink-0" />
				<span className="truncate">@{label}</span>
			</>
		);
	}
	const listFor = (pinnedOnly: boolean) => (
		// No fade on a channel or tab switch: the history swaps in place, so
		// a slow frame never shows a washed-out pane.
		<div className="@container/channel flex min-h-0 flex-1 flex-col">
			<ChannelsMessageList
				activeThreadId={activeThreadId}
				channel={channel}
				channelLabel={label}
				description={description}
				members={members}
				onClearSearch={onClearSearch}
				onOpenThread={onOpenThread}
				onSelectChannel={onSelectChannel}
				otherHits={otherHits}
				pinnedOnly={pinnedOnly}
				searchQuery={searchQuery}
				snapshot={snapshot}
				threads={pinnedOnly ? pinned : threads}
			/>
		</div>
	);
	return (
		<>
			<Tabs
				aria-label={isDm ? `Conversation with ${label}` : `#${label}`}
				className="min-w-0 flex-1 gap-0"
				onValueChange={(next) =>
					setView(next === "pinned" ? "pinned" : "messages")
				}
				render={<section />}
				value={view}
			>
				<header className="shrink-0 border-border border-b">
					<div className="flex h-12 items-center gap-2 pr-3 @max-[640px]:pl-2 pl-5">
						<Button
							aria-label="All channels"
							className="@min-[640px]:hidden text-foreground/70"
							onClick={onBack}
							size="icon-sm"
							title="All channels"
							variant="ghost-muted"
						>
							<ChevronLeft aria-hidden="true" />
						</Button>
						{isDm ? (
							<span className="relative flex shrink-0 text-foreground/70">
								<ChannelsAvatar agent={dmAgent} name={label} size={24} />
								<PresenceDot active={dmAgent?.status === "working"} />
							</span>
						) : (
							<Hash
								aria-hidden="true"
								className="-mr-1 size-4 shrink-0 text-foreground/70"
							/>
						)}
						<h2 className="min-w-0 truncate font-bold! text-foreground text-lg">
							{label}
						</h2>
						{members.length > 0 && !isDm ? (
							<ChannelsMembers
								channelLabel={label}
								members={members}
								onMessage={onMessageAgent}
							/>
						) : null}
					</div>
					<TabsList
						aria-label="Channel views"
						className="h-9 gap-4 p-0 @max-[640px]:px-4 px-5"
						manageLayout={false}
						persistLayout={false}
						variant="line"
					>
						<TabsTrigger className={TAB_CLASS} value="messages">
							<MessageCircle aria-hidden="true" />
							Messages
						</TabsTrigger>
						<TabsTrigger className={TAB_CLASS} value="pinned">
							<Pin aria-hidden="true" />
							Pinned
							{pinned.length > 0 ? (
								<span className="text-foreground/70 text-xs tabular-nums">
									{pinned.length}
								</span>
							) : null}
						</TabsTrigger>
						<TabsIndicator className="border-0! bg-transparent! shadow-none! after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-full after:bg-primary dark:bg-transparent!" />
					</TabsList>
				</header>
				<TabsContent className="flex min-h-0 flex-col" value="messages">
					{listFor(false)}
				</TabsContent>
				<TabsContent className="flex min-h-0 flex-col" value="pinned">
					{listFor(true)}
				</TabsContent>
				<div className="shrink-0 @max-[640px]:px-3 px-5 @max-[640px]:pb-3 pb-5">
					<ChannelsComposer
						agents={composerAgents}
						defaultAgentId={defaultAgentId}
						// One composer per channel: the draft and the recipient
						// never carry over to the next channel.
						key={channel.id}
						label={`Message ${label}`}
						onSubmit={onSend}
						placeholder={isDm ? `Message ${label}` : `Message #${label}`}
						recipient={recipient}
					/>
				</div>
			</Tabs>
			{threadView ? (
				<motion.aside
					animate={{ opacity: 1, x: 0 }}
					aria-label="Thread"
					// Side by side down to 720px (the rail and sidebar give way
					// first), then the thread takes the whole pane.
					className="@max-[720px]:absolute @max-[720px]:inset-0 @max-[720px]:z-30 flex @max-[1100px]:w-[min(420px,50%)] @max-[720px]:w-full w-[420px] shrink-0 flex-col border-border border-l @max-[720px]:border-l-0 bg-background"
					initial={reduceMotion ? false : { opacity: 0, x: 12 }}
					transition={{ duration: 0.18, ease: "easeOut" }}
				>
					{/* Two rows, like the channel header beside it, so the rule
					    under both headers runs straight across the split. */}
					<header className="shrink-0 border-border border-b">
						<div className="flex h-12 items-center gap-2 pr-3 pl-5">
							<h2 className="min-w-0 flex-1 truncate font-bold! text-base text-foreground">
								Thread
							</h2>
							<Button
								aria-label="Close thread"
								className="text-foreground/70"
								onClick={onClose}
								size="icon-sm"
								title="Close"
								variant="ghost-muted"
							>
								<X aria-hidden="true" />
							</Button>
						</div>
						<p className="flex h-9 min-w-0 items-center gap-1 pr-3 pl-5 text-foreground/70 text-sm">
							{isDm ? null : (
								<Hash aria-hidden="true" className="size-4 shrink-0" />
							)}
							<span className="truncate">{label}</span>
						</p>
					</header>
					<div className="min-h-0 flex-1 overflow-hidden">{threadView}</div>
				</motion.aside>
			) : null}
		</>
	);
}
