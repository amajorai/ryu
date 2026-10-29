import { useLocalizedText } from "@ryu/i18n/react";
import { badgeVariants } from "@ryu/ui/components/badge";
import { Bubble, BubbleContent } from "@ryu/ui/components/bubble";
import { DitherAvatar } from "@ryu/ui/components/dither-kit/avatar";
import { Marker, MarkerContent, MarkerIcon } from "@ryu/ui/components/marker";
import {
	Message,
	MessageAvatar,
	MessageContent,
	MessageHeader,
} from "@ryu/ui/components/message";
import { cn } from "@ryu/ui/lib/utils";
import { IconMessages } from "@tabler/icons-react";
import { memo } from "react";
import type { AgentMessageContext, AgentMessageIdentity } from "../types.ts";
import { getToolStatus } from "../utils/format-tool.ts";
import {
	type AgentMessagePayload,
	type AgentMessageToolPart,
	isAgentMessageRefused,
	readAgentMessagePayload,
} from "./agent-message-tool-logic.ts";
import { GenericTool } from "./generic-tool.tsx";

function prettyAgentId(id: string): string {
	const label = id
		.replace(/^acp:/, "")
		.replace(/[._-]+/g, " ")
		.trim();
	if (!label) {
		return "Agent";
	}
	return label.replace(/\b\w/g, (character) => character.toUpperCase());
}

/** The display identity for an agent id: the chat's own agent, the host's
 * roster, else a title-cased id. */
export function identityFor(
	id: string,
	context: AgentMessageContext | undefined
): AgentMessageIdentity {
	if (context?.current?.id === id) {
		return context.current;
	}
	return (
		context?.resolve?.(id) ?? {
			id,
			name: prettyAgentId(id),
		}
	);
}

export function IdentityAvatar({
	className,
	identity,
}: {
	className?: string;
	identity: AgentMessageIdentity;
}) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted",
				className
			)}
		>
			{identity.avatar ?? (
				<DitherAvatar
					animate={false}
					className="size-full"
					name={identity.id}
				/>
			)}
		</span>
	);
}

function AgentChip({ identity }: { identity: AgentMessageIdentity }) {
	const children = useLocalizedText(
		<>
			<IdentityAvatar className="size-4" identity={identity} />
			<span className="truncate">{identity.name}</span>
		</>
	);
	return (
		<span
			className={cn(
				badgeVariants({ variant: "ghost", typography: "normal" }),
				"max-w-52 px-1.5"
			)}
			data-agent-id={identity.id}
			data-slot="badge"
			data-variant="ghost"
			title={identity.name}
		>
			{children}
		</span>
	);
}

/** One send (sender's bubble) and, for an ask, the peer's reply under it.
 * `showRoute` adds "to <peer>" beside each name; a view that already names
 * both agents (the conversation dialog's header) leaves it off. */
export function AgentMessageExchange({
	payload,
	recipient,
	sender,
	showRoute = true,
}: {
	payload: AgentMessagePayload;
	recipient: AgentMessageIdentity;
	sender: AgentMessageIdentity;
	showRoute?: boolean;
}) {
	return (
		<>
			<Message
				align="start"
				className="items-start"
				data-testid="agent-message-bubble"
			>
				<MessageAvatar className="size-8 self-start" variant="transparent">
					<IdentityAvatar className="size-8" identity={sender} />
				</MessageAvatar>
				<MessageContent spacing="compact">
					<MessageHeader inset="none" spacing="relaxed">
						<span>{sender.name}</span>
						{showRoute ? (
							<span className="font-normal text-muted-foreground/70">
								to {recipient.name}
							</span>
						) : null}
					</MessageHeader>
					<Bubble
						align="start"
						className="max-w-[min(80%,42rem)]"
						variant="muted"
					>
						<BubbleContent className="whitespace-pre-wrap">
							{payload.text}
						</BubbleContent>
					</Bubble>
				</MessageContent>
			</Message>
			{payload.reply ? (
				<Message
					align="start"
					className="items-start"
					data-testid="agent-message-reply"
				>
					<MessageAvatar className="size-8 self-start" variant="transparent">
						<IdentityAvatar className="size-8" identity={recipient} />
					</MessageAvatar>
					<MessageContent spacing="compact">
						<MessageHeader inset="none" spacing="relaxed">
							<span>{recipient.name}</span>
							{showRoute ? (
								<span className="font-normal text-muted-foreground/70">
									to {sender.name}
								</span>
							) : null}
						</MessageHeader>
						<Bubble
							align="start"
							className="max-w-[min(80%,42rem)]"
							variant="outline"
						>
							<BubbleContent className="whitespace-pre-wrap">
								{payload.reply}
							</BubbleContent>
						</Bubble>
					</MessageContent>
				</Message>
			) : null}
		</>
	);
}

export const AgentMessageTool = memo(function AgentMessageTool({
	chatStatus,
	context,
	part,
}: {
	chatStatus?: string;
	context?: AgentMessageContext;
	part: AgentMessageToolPart;
}) {
	const payload = readAgentMessagePayload(part);
	const { isError, isInterrupted, isPending } = getToolStatus(part, chatStatus);
	if (!payload) {
		return (
			<GenericTool
				isError={isError || isInterrupted}
				isPending={isPending}
				title={
					isPending
						? "Sending message"
						: part.toolName === "agents.ask"
							? "Ask an Agent"
							: "Message an Agent"
				}
			/>
		);
	}

	const sender = identityFor(
		payload.from ?? context?.current?.id ?? "agent",
		context
	);
	const recipient = identityFor(payload.to, context);
	const failed = isError || isInterrupted || isAgentMessageRefused(part);
	const activityVerb = failed
		? payload.kind === "ask"
			? "couldn't ask"
			: "couldn't send a message to"
		: isPending
			? payload.kind === "ask"
				? "is asking"
				: "is sending a message to"
			: payload.kind === "ask"
				? "asked"
				: "sent a message to";

	return (
		<div
			aria-label={`${sender.name} ${activityVerb} ${recipient.name}`}
			className="flex min-w-0 flex-col gap-1.5"
			data-testid="agent-message-activity"
		>
			<Marker size="compact" spacing="activity">
				<MarkerIcon>
					<IconMessages className="size-3.5" />
				</MarkerIcon>
				<MarkerContent
					className="flex min-w-0 flex-wrap items-center"
					spacing="compact"
				>
					<AgentChip identity={sender} />
					<span>{activityVerb}</span>
					<AgentChip identity={recipient} />
				</MarkerContent>
			</Marker>

			<AgentMessageExchange
				payload={payload}
				recipient={recipient}
				sender={sender}
			/>
		</div>
	);
});
