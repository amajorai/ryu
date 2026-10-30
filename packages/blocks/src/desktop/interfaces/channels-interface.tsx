import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import {
	type ChannelsParams,
	channelHandle,
	type InterfaceChannel,
	type InterfaceSnapshot,
	type InterfaceThread,
	projectChannels,
} from "@ryuhq/protocol/interfaces";
import { type ReactNode, useMemo, useState } from "react";
import { ChannelPane } from "./channels-interface-pane.tsx";
import { NoAgents, PaneSkeleton } from "./channels-interface-placeholders.tsx";
import type { ChannelSearchHit } from "./channels-messages.tsx";
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

/** Below 640px one column shows at a time: the channel list or a channel. */
type PhoneColumn = "list" | "channel";

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
	groupNames: ReadonlyMap<string, string>,
	tl: LiteralMessage
): string {
	const groupName = groupNames.get(channel.id) ?? channel.name;
	switch (channel.kind) {
		case "team":
			return tl(
				"Every message here starts a thread with the {groupName} team.",
				{
					groupName,
				}
			);
		case "project":
			return tl(
				"Threads for the {groupName} project live here; every message starts a new one.",
				{ groupName }
			);
		case "general":
			return tl("Threads without a team, project or agent land here.");
		default:
			return "";
	}
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
	const tl = useLiteralMessages();
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
				description={channelDescription(selected, groupNames, tl)}
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
