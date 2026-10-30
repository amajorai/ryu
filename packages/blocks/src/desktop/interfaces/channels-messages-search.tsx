import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button";
import { cn } from "@ryu/ui/lib/utils";
import type {
	InterfaceChannel,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import { Hash } from "lucide-react";
import type { ReactNode } from "react";
import { ChannelsAvatar } from "./channels-avatar.tsx";
import { LINK_INK, MARK_CLASS } from "./channels-messages-constants.ts";
import { agentById } from "./interface-renderer.ts";

/** Another channel with search hits, offered when this one has none. */
export interface ChannelSearchHit {
	channel: InterfaceChannel;
	count: number;
	label: string;
}

/** Wraps every case-insensitive occurrence of `needle` in a <mark>. */
export function Highlighted({
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

export function SearchBanner({
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
	const tl = useLiteralMessages();
	const summary = tl(
		"{count, plural, one {{countLabel} message in {channelLabel} matches} other {{countLabel} messages in {channelLabel} match}}",
		{ channelLabel, count, countLabel: String(count) }
	);
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
export function PaneNote({
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
export function SearchEmpty({
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
	const tl = useLiteralMessages();
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
									{tl(
										"{count, plural, one {{countLabel} match} other {{countLabel} matches}}",
										{ count: hit.count, countLabel: String(hit.count) }
									)}
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
