import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button";
import {
	Popover,
	PopoverContent,
	PopoverDescription,
	PopoverHeader,
	PopoverTitle,
	PopoverTrigger,
} from "@ryu/ui/components/popover.tsx";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import { MessageCircle } from "lucide-react";
import { ChannelsAvatar, PresenceDot } from "./channels-avatar.tsx";

const MAX_FACEPILE = 3;

/**
 * The channel header's member count: a facepile button that opens the
 * member list, with each agent's presence and a way to message them
 * directly.
 */
export function ChannelsMembers({
	channelLabel,
	members,
	onMessage,
}: {
	channelLabel: string;
	members: InterfaceAgent[];
	/** Open the direct conversation with this agent. */
	onMessage: (agentId: string) => void;
}) {
	const tl = useLiteralMessages();
	const countLabel =
		members.length === 1 ? "1 member" : `${members.length} members`;
	return (
		<Popover>
			<PopoverTrigger
				render={
					<Button
						aria-label={`${countLabel} of #${channelLabel}`}
						className="ml-auto h-7 gap-1 rounded-md border border-border pr-2 pl-1 hover:bg-muted aria-expanded:bg-muted"
						size="sm"
						variant="ghost"
					/>
				}
			>
				<span aria-hidden="true" className="flex -space-x-1.5">
					{members.slice(0, MAX_FACEPILE).map((member) => (
						<ChannelsAvatar
							agent={member}
							className="ring-2 ring-background"
							key={member.id}
							name={member.name}
							size={20}
						/>
					))}
				</span>
				<span
					aria-hidden="true"
					className="font-medium text-foreground text-xs tabular-nums"
				>
					{members.length}
				</span>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-72 gap-2" spacing="menu">
				<PopoverHeader className="gap-0 px-2 pt-1 pb-1">
					<PopoverTitle className="font-semibold! text-foreground text-sm leading-5">
						#{channelLabel}
					</PopoverTitle>
					<PopoverDescription className="text-foreground/70 text-xs leading-4">
						{countLabel}
					</PopoverDescription>
				</PopoverHeader>
				<ul aria-label="Members" className="flex flex-col">
					{members.map((member) => {
						const working = member.status === "working";
						return (
							<li
								className="flex items-center gap-2.5 rounded-md px-2 py-1.5"
								key={member.id}
							>
								<span className="relative flex shrink-0 text-muted-foreground">
									<ChannelsAvatar agent={member} name={member.name} size={24} />
									<PresenceDot active={working} ringClassName="bg-popover" />
								</span>
								<span className="flex min-w-0 flex-1 flex-col">
									<span className="truncate font-medium text-foreground text-sm">
										{member.name}
									</span>
									<span className="truncate text-foreground/70 text-xs">
										{working ? "Working" : "Away"}
									</span>
								</span>
								<Button
									aria-label={tl("Message {name}", { name: member.name })}
									onClick={() => onMessage(member.id)}
									size="icon-sm"
									title={tl("Message {name}", { name: member.name })}
									variant="ghost"
								>
									<MessageCircle aria-hidden="true" />
								</Button>
							</li>
						);
					})}
				</ul>
			</PopoverContent>
		</Popover>
	);
}
