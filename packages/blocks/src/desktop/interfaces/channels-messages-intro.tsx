import { cn } from "@ryu/ui/lib/utils";
import type {
	InterfaceAgent,
	InterfaceChannel,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import { ChannelsAvatar, PresenceDot } from "./channels-avatar.tsx";
import { LINK_INK, MAX_THREAD_FACES } from "./channels-messages-constants.ts";
import { agentById } from "./interface-renderer.ts";

export function ChannelIntro({
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

export function DayDivider({
	label,
	ruled,
}: {
	label: string;
	ruled: boolean;
}) {
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
