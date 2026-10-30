import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button";
import {
	Tabs,
	TabsContent,
	TabsIndicator,
	TabsList,
	TabsTrigger,
} from "@ryu/ui/components/tabs.tsx";
import type {
	ChannelsParams,
	InterfaceAgent,
	InterfaceChannel,
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { ChevronLeft, Hash, MessageCircle, Pin, Users, X } from "lucide-react";
import { motion } from "motion/react";
import { type ReactNode, useState } from "react";
import { ChannelsAvatar, PresenceDot } from "./channels-avatar.tsx";
import { ChannelsComposer } from "./channels-composer.tsx";
import { ChannelsMembers } from "./channels-members.tsx";
import {
	type ChannelSearchHit,
	ChannelsMessageList,
} from "./channels-messages.tsx";
import {
	agentById,
	type InterfaceRendererProps,
} from "./interface-renderer.ts";
import { useReducedMotion } from "./reduced-motion.ts";

type ChannelView = "messages" | "pinned";

/** A plain underlined tab: no pill, the indicator draws the rule. */
const TAB_CLASS =
	"flex-none rounded-md px-0.5 text-foreground/70 after:hidden hover:text-foreground data-active:text-foreground dark:text-foreground/70 dark:hover:text-foreground data-active:bg-transparent! dark:data-active:bg-transparent!";

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

/** Members first, then everyone else: the picker's order. */
function recipientsFor(
	members: InterfaceAgent[],
	agents: InterfaceAgent[]
): InterfaceAgent[] {
	const memberIds = new Set(members.map((member) => member.id));
	return [...members, ...agents.filter((agent) => !memberIds.has(agent.id))];
}

export function ChannelPane({
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
	const tl = useLiteralMessages();
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
				aria-label={
					isDm ? tl("Conversation with {label}", { label }) : `#${label}`
				}
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
						label={tl("Message {label}", { label })}
						onSubmit={onSend}
						placeholder={
							isDm
								? tl("Message {label}", { label })
								: tl("Message #{label}", { label })
						}
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
