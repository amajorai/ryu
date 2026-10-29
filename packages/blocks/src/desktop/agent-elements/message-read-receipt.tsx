import { Tick02Icon, TickDouble02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import {
	Avatar,
	AvatarFallback,
	AvatarGroup,
	AvatarGroupCount,
	AvatarImage,
} from "@ryu/ui/components/avatar.tsx";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover";
import { cn } from "@ryu/ui/lib/utils";
import type { ReactNode } from "react";

/** Display data for one person who has read a message. */
export interface MessageReader {
	avatar?: string;
	id: string;
	name: string;
}

/** Read state passed from the host's durable conversation receipt store. */
export interface MessageReadReceiptState {
	delivered?: boolean;
	readers: readonly MessageReader[];
}

function safeAvatarUrl(value: string | undefined): string | null {
	if (!value) {
		return null;
	}
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:"
			? url.href
			: null;
	} catch {
		return null;
	}
}

function initials(name: string): string {
	return (
		name
			.trim()
			.split(/\s+/)
			.slice(0, 2)
			.map((part) => part[0]?.toUpperCase() ?? "")
			.join("") || "?"
	);
}

function uniqueReaders(
	readers: readonly MessageReader[],
	messageAuthorId?: string
): MessageReader[] {
	const seen = new Set<string>();
	return readers.filter((reader) => {
		const id = reader.id.trim();
		if (!id || id === messageAuthorId || seen.has(id)) {
			return false;
		}
		seen.add(id);
		return true;
	});
}

function readerName(reader: MessageReader): string {
	return reader.name.trim() || "Someone";
}

function namesLabel(
	readers: readonly MessageReader[],
	tl: LiteralMessage
): string {
	const names = readers.map(readerName);
	if (names.length <= 3) {
		return names.join(", ");
	}
	return tl("{names} and {otherCount} others", {
		names: names.slice(0, 2).join(", "),
		otherCount: names.length - 2,
	});
}

function ReaderAvatar({ reader }: { reader: MessageReader }) {
	const tl = useLiteralMessages();
	const name = readerName(reader);
	const avatar = safeAvatarUrl(reader.avatar);
	return (
		<Avatar
			appearance="message-reader"
			aria-label={tl("{name} avatar", { name })}
			size="sm"
			title={name}
		>
			{avatar ? <AvatarImage alt="" src={avatar} /> : null}
			<AvatarFallback typography="tiny">{initials(name)}</AvatarFallback>
		</Avatar>
	);
}

function SeenByList({ readers }: { readers: readonly MessageReader[] }) {
	const tl = useLiteralMessages();
	return (
		<div className="flex flex-col gap-2">
			<div>
				<p className="font-medium text-sm">Seen by</p>
				<p className="text-muted-foreground text-xs">
					{tl(
						"{count, plural, one {# person has} other {# people have}} read this message.",
						{ count: readers.length }
					)}
				</p>
			</div>
			<ul className="m-0 flex max-h-48 list-none flex-col gap-1 overflow-y-auto p-0">
				{readers.map((reader) => (
					<li className="flex items-center gap-2" key={reader.id}>
						<ReaderAvatar reader={reader} />
						<span className="truncate text-xs" title={readerName(reader)}>
							{readerName(reader)}
						</span>
					</li>
				))}
			</ul>
		</div>
	);
}

/**
 * Compact WhatsApp-style delivery state with Instagram-style reader avatars.
 * The sender always sees a single tick once Core has persisted the message;
 * the tick becomes double and the overlapping people avatars appear after one
 * or more other humans acknowledge the message.
 */
export function MessageReadReceipt({
	delivered = false,
	messageAuthorId,
	readers,
	showSent = false,
}: MessageReadReceiptState & {
	delivered?: boolean;
	messageAuthorId?: string;
	showSent?: boolean;
}): ReactNode {
	const tl = useLiteralMessages();
	const seenBy = uniqueReaders(readers, messageAuthorId);
	if (!((showSent && delivered) || seenBy.length > 0)) {
		return null;
	}
	const isRead = seenBy.length > 0;
	const label = isRead
		? tl("Seen by {names}", { names: namesLabel(seenBy, tl) })
		: "Sent";
	const tick = (
		<HugeiconsIcon
			aria-hidden="true"
			className={cn(
				"size-3.5",
				isRead ? "text-status-info" : "text-muted-foreground/70"
			)}
			icon={isRead ? TickDouble02Icon : Tick02Icon}
			strokeWidth={2}
		/>
	);

	if (!isRead) {
		return (
			<span
				aria-label={label}
				className="inline-flex items-center"
				data-read-state="sent"
				data-slot="message-read-receipt"
				title={label}
			>
				{tick}
				<span className="sr-only">{label}</span>
			</span>
		);
	}

	const visibleAvatars = seenBy.slice(0, 3);
	const hiddenCount = seenBy.length - visibleAvatars.length;
	return (
		<Popover>
			<PopoverTrigger
				aria-label={label}
				data-read-state="read"
				data-slot="message-read-receipt"
				title={label}
				variant="message-read-receipt"
			>
				{tick}
				<AvatarGroup spacing="message-readers">
					{visibleAvatars.map((reader) => (
						<ReaderAvatar key={reader.id} reader={reader} />
					))}
					{hiddenCount > 0 ? (
						<AvatarGroupCount aria-hidden="true" purpose="message-readers">
							+{hiddenCount}
						</AvatarGroupCount>
					) : null}
				</AvatarGroup>
				<span className="sr-only">{label}</span>
			</PopoverTrigger>
			<PopoverContent
				align="end"
				appearance="message-read-list"
				className="w-56"
				side="top"
				sideOffset={8}
			>
				<SeenByList readers={seenBy} />
			</PopoverContent>
		</Popover>
	);
}
