import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { MessengerAvatar } from "./messenger-avatar.tsx";
import { canStartWith, type MessengerEntry } from "./messenger-model.ts";

function startText(
	entry: MessengerEntry,
	hasHistory: boolean,
	tl: LiteralMessage
): string {
	if (!canStartWith(entry)) {
		return "Pick a conversation above to read it and reply.";
	}
	return hasHistory
		? "Pick an earlier conversation above, or send a message to start a new one."
		: tl("This is the start of your conversation with {name}.", {
				name: entry.name,
			});
}

/** Opening state for a contact with no conversation open. */
export function ConversationStart({ entry }: { entry: MessengerEntry }) {
	const tl = useLiteralMessages();
	const hasHistory = entry.threadIds.length > 0;
	return (
		<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-y-auto px-6 py-10 text-center">
			<MessengerAvatar
				entry={entry}
				ringClassName="ring-background"
				size="header"
			/>
			<div className="flex flex-col gap-1">
				<p className="font-medium text-sm">{entry.name}</p>
				{entry.description ? (
					<p className="max-w-sm text-muted-foreground text-sm">
						{entry.description}
					</p>
				) : null}
			</div>
			<p className="max-w-sm text-muted-foreground text-xs">
				{startText(entry, hasHistory, tl)}
			</p>
		</div>
	);
}
