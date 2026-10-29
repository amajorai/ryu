import { useLiteralMessages } from "@ryu/i18n/react";
import { AvatarGroup } from "@ryu/ui/components/avatar.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { Marker, MarkerContent, MarkerIcon } from "@ryu/ui/components/marker";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover";
import { formatTime, startOfTodayMs } from "@ryu/ui/lib/timezone.ts";
import { cn } from "@ryu/ui/lib/utils";
import { IconArrowsExchange, IconMessages } from "@tabler/icons-react";
import { memo, useMemo, useState } from "react";
import { dayLabel } from "../date-groups.ts";
import type { AgentMessageContext, AgentMessageIdentity } from "../types.ts";
import {
	AgentMessageExchange,
	IdentityAvatar,
	identityFor,
} from "./agent-message-tool.tsx";
import {
	type AgentMessageDelivery,
	type AgentMessageToolPart,
	type AgentPeerConversation,
	summarizeAgentMessageRun,
} from "./agent-message-tool-logic.ts";

/** The marker's stacked avatars, first recipient on top, before the rest
 * collapse into the count label. */
const STACKED_AVATAR_LAYERS = ["z-30", "z-20", "z-10"] as const;

/** "Today 2:35 PM" for the conversation's opening line; null when undated. */
function sentAtLabel(sentAt: Date | undefined): string | null {
	const ms = sentAt?.getTime();
	if (ms === undefined || !Number.isFinite(ms)) {
		return null;
	}
	const day = dayLabel(String(startOfTodayMs(ms)), startOfTodayMs());
	return `${day} ${formatTime(ms, { timeStyle: "short" })}`;
}

function deliveryNote(delivery: AgentMessageDelivery): string | null {
	if (delivery === "failed") {
		return "Not delivered";
	}
	return delivery === "sending" ? "Sending…" : null;
}

function DeliveryNote({ delivery }: { delivery: AgentMessageDelivery }) {
	const note = deliveryNote(delivery);
	if (!note) {
		return null;
	}
	return (
		<p
			className={cn(
				"ps-10 text-xs",
				delivery === "failed"
					? "text-status-destructive"
					: "text-muted-foreground"
			)}
		>
			{note}
		</p>
	);
}

function RecipientRow({
	conversation,
	identity,
	onOpen,
}: {
	conversation: AgentPeerConversation;
	identity: AgentMessageIdentity;
	onOpen: () => void;
}) {
	const note = deliveryNote(conversation.delivery);
	const latest = conversation.entries.at(-1)?.payload.text ?? "";
	const count = conversation.entries.length;
	return (
		<li>
			<button
				className="flex w-full min-w-0 items-center gap-2.5 rounded-2xl px-2 py-1.5 text-start outline-none transition-colors hover:bg-muted focus-visible:bg-muted"
				data-agent-id={identity.id}
				data-delivery={conversation.delivery}
				onClick={onOpen}
				type="button"
			>
				<IdentityAvatar className="size-7" identity={identity} />
				<span className="flex min-w-0 flex-1 flex-col">
					<span className="truncate font-medium text-sm">{identity.name}</span>
					<span
						className={cn(
							"truncate text-xs",
							conversation.delivery === "failed"
								? "text-status-destructive"
								: "text-muted-foreground"
						)}
						title={note ?? latest}
					>
						{note ?? latest}
					</span>
				</span>
				{count > 1 ? (
					<span className="shrink-0 text-muted-foreground text-xs tabular-nums">
						{count}
					</span>
				) : null}
			</button>
		</li>
	);
}

function AgentConversationView({
	conversation,
	recipient,
	sender,
	sentAt,
}: {
	conversation: AgentPeerConversation;
	recipient: AgentMessageIdentity;
	sender: AgentMessageIdentity;
	sentAt?: Date;
}) {
	const tl = useLiteralMessages();
	const opening = sentAtLabel(sentAt);
	return (
		<>
			<DialogHeader purpose="agent-conversation">
				<DialogTitle className="inline-flex max-w-full items-center gap-2 rounded-full bg-muted py-1 ps-1 pe-3 font-sans text-sm leading-normal">
					<IdentityAvatar className="size-6" identity={sender} />
					<span className="truncate">{sender.name}</span>
					<IconArrowsExchange
						aria-hidden="true"
						className="size-4 shrink-0 text-muted-foreground"
					/>
					<span className="sr-only">and</span>
					<IdentityAvatar className="size-6" identity={recipient} />
					<span className="truncate">{recipient.name}</span>
				</DialogTitle>
				<DialogDescription className="sr-only">
					{tl("Messages {senderName} sent to {recipientName} in this turn.", {
						senderName: sender.name,
						recipientName: recipient.name,
					})}
				</DialogDescription>
			</DialogHeader>
			<div
				className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4"
				data-testid="agent-conversation-transcript"
			>
				{opening ? (
					<p className="text-center text-muted-foreground text-xs">{opening}</p>
				) : null}
				{conversation.entries.map((entry) => (
					<div className="flex flex-col gap-1" key={entry.key}>
						<AgentMessageExchange
							payload={entry.payload}
							recipient={recipient}
							sender={sender}
							showRoute={false}
						/>
						<DeliveryNote delivery={entry.delivery} />
					</div>
				))}
			</div>
			<DialogFooter purpose="agent-conversation">
				<DialogClose render={<Button radius="pill" variant="secondary" />}>
					Close chat
				</DialogClose>
			</DialogFooter>
		</>
	);
}

/**
 * A run of agent-to-agent sends, drawn as ONE activity marker:
 * "Messaged ◐◑◒ 7 agents". With several recipients the avatar stack opens a
 * roster; choosing a recipient (or the only one) opens that pair's exchange
 * as a read-only "Sender ⇄ Recipient" conversation. The transcript stays one
 * line per fan-out however many agents were messaged.
 */
export const AgentMessagesMarker = memo(function AgentMessagesMarker({
	chatStatus,
	context,
	parts,
	sentAt,
}: {
	chatStatus?: string;
	context?: AgentMessageContext;
	parts: readonly AgentMessageToolPart[];
	/** When the turn was sent, for the conversation's opening line. */
	sentAt?: Date;
}) {
	const tl = useLiteralMessages();
	const { peers, unreadable } = useMemo(
		() => summarizeAgentMessageRun(parts, chatStatus),
		[parts, chatStatus]
	);
	const [rosterOpen, setRosterOpen] = useState(false);
	const [dialogOpen, setDialogOpen] = useState(false);
	// Kept after close so the dialog's exit animation still has content.
	const [activePeer, setActivePeer] = useState<string | null>(null);

	const sending =
		peers.some((peer) => peer.delivery === "sending") ||
		unreadable.some((call) => call.delivery === "sending");
	const failedCount = peers.filter((peer) => peer.delivery === "failed").length;
	const sender = identityFor(
		peers.find((peer) => peer.from)?.from ?? context?.current?.id ?? "agent",
		context
	);
	const recipients = peers.map((peer) => identityFor(peer.peer, context));

	if (peers.length === 0) {
		const failed = unreadable.every((call) => call.delivery === "failed");
		return (
			<Marker
				data-testid="agent-messages-marker"
				size="compact"
				spacing="activity"
				tone={failed && !sending ? "destructive" : "default"}
			>
				<MarkerIcon>
					<IconMessages className="size-3.5" />
				</MarkerIcon>
				<MarkerContent>
					{sending
						? "Messaging an agent…"
						: failed
							? "Couldn't message an agent"
							: "Messaged an agent"}
				</MarkerContent>
			</Marker>
		);
	}

	const verb = sending ? "Messaging" : "Messaged";
	const onlyPeer = peers.length === 1 ? peers[0] : undefined;
	const countLabel =
		onlyPeer && recipients[0] ? recipients[0].name : `${peers.length} agents`;
	const summaryLabel = `${verb} ${recipients
		.map((recipient) => recipient.name)
		.join(", ")}${failedCount > 0 ? `, ${failedCount} not delivered` : ""}`;

	const openConversation = (peer: string) => {
		setRosterOpen(false);
		setActivePeer(peer);
		setDialogOpen(true);
	};
	const activeConversation = peers.find((peer) => peer.peer === activePeer);

	const stack = (
		<>
			<AvatarGroup spacing="agent-recipients">
				{STACKED_AVATAR_LAYERS.slice(0, recipients.length).map(
					(layer, index) => {
						const recipient = recipients[index];
						return recipient ? (
							<IdentityAvatar
								className={cn("relative size-5 ring-2 ring-background", layer)}
								identity={recipient}
								key={recipient.id}
							/>
						) : null;
					}
				)}
			</AvatarGroup>
			<span className="max-w-48 truncate">{countLabel}</span>
		</>
	);
	const triggerButton = (
		<Button
			aria-label={summaryLabel}
			radius="pill"
			size="micro"
			title={summaryLabel}
			variant="ghost-muted"
		/>
	);

	return (
		<>
			<Marker
				data-testid="agent-messages-marker"
				size="compact"
				spacing="activity"
			>
				<MarkerIcon>
					<IconMessages className="size-3.5" />
				</MarkerIcon>
				<MarkerContent
					className="flex min-w-0 flex-wrap items-center"
					spacing="compact"
				>
					<span>{verb}</span>
					{onlyPeer ? (
						<Button
							aria-haspopup="dialog"
							aria-label={summaryLabel}
							onClick={() => openConversation(onlyPeer.peer)}
							radius="pill"
							size="micro"
							title={summaryLabel}
							variant="ghost-muted"
						>
							{stack}
						</Button>
					) : (
						<Popover onOpenChange={setRosterOpen} open={rosterOpen}>
							<PopoverTrigger render={triggerButton}>{stack}</PopoverTrigger>
							<PopoverContent
								align="start"
								appearance="agent-recipient-list"
								side="bottom"
								sideOffset={6}
							>
								<ul
									aria-label={
										sending
											? tl("Messaging {count} agents", { count: peers.length })
											: tl("Messaged {count} agents", { count: peers.length })
									}
									className="m-0 flex max-h-96 list-none flex-col gap-0.5 overflow-y-auto p-0"
									data-testid="agent-messages-roster"
								>
									{peers.map((conversation, index) => (
										<RecipientRow
											conversation={conversation}
											identity={
												recipients[index] ??
												identityFor(conversation.peer, context)
											}
											key={conversation.peer}
											onOpen={() => openConversation(conversation.peer)}
										/>
									))}
								</ul>
							</PopoverContent>
						</Popover>
					)}
					{failedCount > 0 ? (
						<span className="text-status-destructive">
							{tl("· {failedCount} not delivered", { failedCount })}
						</span>
					) : null}
				</MarkerContent>
			</Marker>
			<Dialog onOpenChange={setDialogOpen} open={dialogOpen}>
				{activeConversation ? (
					<DialogContent
						appearance="agent-conversation"
						data-testid="agent-conversation-dialog"
						showCloseButton={false}
					>
						<AgentConversationView
							conversation={activeConversation}
							recipient={identityFor(activeConversation.peer, context)}
							sender={sender}
							sentAt={sentAt}
						/>
					</DialogContent>
				) : null}
			</Dialog>
		</>
	);
});
