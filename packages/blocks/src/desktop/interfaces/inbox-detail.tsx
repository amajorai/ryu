import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Separator } from "@ryu/ui/components/separator.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { ArrowLeft, ChevronDown, ChevronUp, Pin, X } from "lucide-react";
import type { KeyboardEvent, ReactNode, Ref } from "react";
import { InboxAgentAvatar } from "./inbox-avatar.tsx";
import {
	InboxButtonKbd,
	InboxHintKbd,
	InboxPrimaryKbd,
	InboxTooltipKbd,
} from "./inbox-kbd.tsx";
import type { InboxItem } from "./inbox-model.ts";
import { InboxItemAvatar } from "./inbox-row.tsx";
import { InboxStatusChip, inboxStatusLabel } from "./inbox-status.tsx";
import { compactAge } from "./interface-renderer.ts";

/** Icon button with a tooltip that names its shortcut. */
function HeaderAction({
	children,
	className,
	label,
	onClick,
	shortcut,
}: {
	children: ReactNode;
	className?: string;
	label: string;
	/** Undefined disables the action (e.g. no previous thread). */
	onClick: (() => void) | undefined;
	shortcut: string;
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button
						aria-label={label}
						className={className}
						disabled={!onClick}
						onClick={onClick}
						size="icon-sm"
						variant="ghost-muted"
					/>
				}
			>
				{children}
			</TooltipTrigger>
			<TooltipContent side="bottom">
				{label} <InboxTooltipKbd>{shortcut}</InboxTooltipKbd>
			</TooltipContent>
		</Tooltip>
	);
}

/** "Actor · Group" under a thread title, skipping a repeated name. */
function headerContext(item: InboxItem): string {
	const showGroup = item.groupName && item.groupName !== item.actorLabel;
	return showGroup ? `${item.actorLabel} · ${item.groupName}` : item.actorLabel;
}

/** Header above the host's conversation surface for the open thread. */
export function InboxDetailHeader({
	item,
	onClose,
	onNext,
	onPrevious,
}: {
	/** Null while the host shows a brand-new conversation. */
	item: InboxItem | null;
	onClose: () => void;
	onNext: (() => void) | undefined;
	onPrevious: (() => void) | undefined;
}) {
	const title = item
		? item.thread.title.trim() || "Untitled thread"
		: "New conversation";
	const context = item
		? headerContext(item)
		: "Pick an agent and write the first message below";
	return (
		<header className="flex h-14 shrink-0 items-center gap-3 border-border border-b bg-background px-4">
			<Button
				aria-label="Back to inbox"
				className="@min-[900px]:hidden"
				onClick={onClose}
				size="icon-sm"
				variant="ghost-muted"
			>
				<ArrowLeft aria-hidden="true" />
			</Button>
			{item ? <InboxItemAvatar item={item} size="sm" /> : null}
			<div className="flex min-w-0 flex-1 flex-col">
				<h3 className="truncate font-medium text-foreground text-sm">
					{title}
				</h3>
				<p className="truncate text-muted-foreground text-xs">{context}</p>
			</div>
			{item ? (
				<InboxStatusChip
					className="@max-[899px]:hidden"
					status={item.status}
					unassigned={item.unassigned}
				/>
			) : null}
			{/* One zero-gap action cluster: prev, next, a hairline, close. */}
			<div className="-mr-1 flex items-center">
				{item ? (
					<>
						<HeaderAction
							label="Previous thread"
							onClick={onPrevious}
							shortcut="K"
						>
							<ChevronUp aria-hidden="true" />
						</HeaderAction>
						<HeaderAction label="Next thread" onClick={onNext} shortcut="J">
							<ChevronDown aria-hidden="true" />
						</HeaderAction>
						<Separator
							className="mx-1 @max-[899px]:hidden data-vertical:h-4 data-vertical:self-center"
							orientation="vertical"
						/>
					</>
				) : null}
				<HeaderAction
					className="@max-[899px]:hidden"
					label="Close thread"
					onClick={onClose}
					shortcut="Esc"
				>
					<X aria-hidden="true" />
				</HeaderAction>
			</div>
		</header>
	);
}

/** True for targets where Escape belongs to the text the user is editing. */
export function isEditableTarget(target: EventTarget): boolean {
	if (!(target instanceof HTMLElement)) {
		return false;
	}
	return (
		target.isContentEditable ||
		target instanceof HTMLInputElement ||
		target instanceof HTMLTextAreaElement ||
		target instanceof HTMLSelectElement
	);
}

/** The open thread: our header plus the host's real chat screen. */
export function InboxDetail({
	item,
	onClose,
	onNext,
	onPrevious,
	ref,
	threadView,
}: {
	item: InboxItem | null;
	onClose: () => void;
	onNext: (() => void) | undefined;
	onPrevious: (() => void) | undefined;
	ref?: Ref<HTMLElement>;
	threadView: ReactNode;
}) {
	const label = item
		? `Thread: ${item.thread.title.trim() || "Untitled thread"}`
		: "New conversation";
	// Esc closes the thread from anywhere in the pane, unless the host's chat
	// already used it (a menu, a popover) or the user is typing a reply.
	const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
		if (
			event.key !== "Escape" ||
			event.defaultPrevented ||
			isEditableTarget(event.target)
		) {
			return;
		}
		event.preventDefault();
		onClose();
	};
	return (
		<section
			aria-label={label}
			className="flex min-h-0 min-w-0 flex-1 flex-col bg-background outline-none"
			data-testid="inbox-detail"
			onKeyDown={onKeyDown}
			ref={ref}
			tabIndex={-1}
		>
			<InboxDetailHeader
				item={item}
				onClose={onClose}
				onNext={onNext}
				onPrevious={onPrevious}
			/>
			{/* The host's chat owns its own keys; inbox-wide letter shortcuts skip it. */}
			<div className="min-h-0 flex-1" data-inbox-host="">
				{threadView}
			</div>
		</section>
	);
}

/** Who wrote the thread's last message, for the reading-pane preview. */
function lastAuthor(item: InboxItem): string {
	if (item.thread.lastMessageRole === "user") {
		return "You";
	}
	return item.leadAgent?.name ?? item.actorLabel;
}

/** "Updated Tue, Oct 13, 4:05 PM" — the absolute time the list abbreviates. */
function fullDate(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) {
		return "";
	}
	return date.toLocaleString(undefined, {
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		month: "short",
		weekday: "short",
	});
}

/** One label/value row in the preview's details list. */
function DetailRow({
	children,
	label,
}: {
	children: ReactNode;
	label: string;
}) {
	return (
		<div className="contents">
			<dt className="py-2 text-muted-foreground text-sm">{label}</dt>
			<dd className="flex min-w-0 items-center gap-2 py-2 text-foreground text-sm">
				{children}
			</dd>
		</div>
	);
}

/** The thread's agents as face + name chips, or a quiet "None yet". */
function AgentChips({ item }: { item: InboxItem }) {
	if (item.agents.length === 0) {
		return <span className="text-muted-foreground">None yet</span>;
	}
	return (
		<span className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
			{item.agents.map((agent) => (
				<span className="flex min-w-0 items-center gap-2" key={agent.id}>
					<InboxAgentAvatar agent={agent} size="sm" />
					<span className="truncate">{agent.name}</span>
				</span>
			))}
		</span>
	);
}

/**
 * Reading pane while nothing is open: the keyboard cursor's thread, previewed
 * the way a mail client's reading pane shows a message — subject, who and
 * when, the latest message in full, one way in, and the thread's details.
 * It follows J/K, so triage reads like flipping through mail.
 */
function InboxPreview({
	item,
	now,
	onOpen,
}: {
	item: InboxItem;
	now: number;
	onOpen: (threadId: string) => void;
}) {
	const tl = useLiteralMessages();
	const { thread } = item;
	const title = thread.title.trim() || "Untitled thread";
	const status = inboxStatusLabel(item.status, item.unassigned);
	const message = thread.lastMessage?.trim();
	const age = compactAge(thread.updatedAt, now);
	const updated = fullDate(thread.updatedAt);
	const author = lastAuthor(item);
	const messages = `${thread.messageCount} ${thread.messageCount === 1 ? "message" : "messages"}`;
	return (
		<section
			aria-label={tl("Preview: {title}", { title })}
			className="flex h-full min-h-0 flex-col"
			data-testid="inbox-idle"
		>
			<header className="flex h-14 shrink-0 items-center gap-3 border-border border-b bg-background px-4">
				<InboxItemAvatar item={item} size="sm" />
				<div className="flex min-w-0 flex-1 flex-col">
					<p className="truncate font-medium text-foreground text-sm">
						{headerContext(item)}
					</p>
					<p className="truncate text-muted-foreground text-xs">
						{messages}
						{age ? ` ${tl("· updated {age} ago", { age })}` : ""}
					</p>
				</div>
				<InboxStatusChip
					className="@max-[899px]:hidden"
					status={item.status}
					unassigned={item.unassigned}
				/>
			</header>
			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto flex w-full max-w-3xl flex-col gap-8 @min-[1100px]:px-10 px-6 py-8">
					<div className="flex flex-col gap-3">
						<h3 className="text-balance font-semibold text-2xl text-foreground leading-8 tracking-tight">
							{title}
						</h3>
						{item.groupName || thread.pinned ? (
							<p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-sm">
								{item.groupName ? <span>{item.groupName}</span> : null}
								{item.groupName && thread.pinned ? (
									<span aria-hidden="true">·</span>
								) : null}
								{thread.pinned ? (
									<span className="inline-flex items-center gap-1">
										<Pin aria-hidden="true" className="size-3.5 rotate-45" />
										Pinned
									</span>
								) : null}
							</p>
						) : null}
					</div>

					{message ? (
						<article className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5 text-card-foreground">
							<header className="flex items-center gap-3">
								{thread.lastMessageRole === "user" || !item.leadAgent ? (
									<span
										aria-hidden="true"
										className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary font-medium text-primary-foreground text-xs"
									>
										{thread.lastMessageRole === "user" ? "You" : "?"}
									</span>
								) : (
									<InboxAgentAvatar agent={item.leadAgent} />
								)}
								<div className="flex min-w-0 flex-1 flex-col">
									<span className="truncate font-medium text-foreground text-sm">
										{author}
									</span>
									<time
										className="text-muted-foreground text-xs tabular-nums"
										dateTime={thread.updatedAt}
									>
										{updated || age}
									</time>
								</div>
							</header>
							<p className="line-clamp-[12] whitespace-pre-line text-[15px] text-foreground leading-7">
								{message}
							</p>
						</article>
					) : (
						<p className="rounded-xl border border-border border-dashed p-5 text-muted-foreground text-sm">
							No messages yet
						</p>
					)}

					<div className="flex flex-wrap items-center gap-x-4 gap-y-2">
						<Button
							aria-label={tl("Open {title}, {status}, {actorLabel}", {
								actorLabel: item.actorLabel,
								status,
								title,
							})}
							onClick={() => onOpen(thread.id)}
						>
							Open thread
							<InboxPrimaryKbd>Enter</InboxPrimaryKbd>
						</Button>
						<p className="flex items-center gap-1.5 text-muted-foreground text-sm">
							<InboxHintKbd>J</InboxHintKbd>
							<InboxHintKbd>K</InboxHintKbd>
							<span>to move between threads</span>
						</p>
					</div>

					<section aria-label="Details" className="flex flex-col gap-1">
						<h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
							Details
						</h4>
						<dl className="grid grid-cols-[minmax(7rem,9rem)_1fr] border-border border-t">
							<DetailRow label="Status">
								<InboxStatusChip
									className="text-foreground text-sm"
									status={item.status}
									unassigned={item.unassigned}
								/>
							</DetailRow>
							<DetailRow label="Agents">
								<AgentChips item={item} />
							</DetailRow>
							{item.groupName ? (
								<DetailRow
									label={item.groupKind === "team" ? "Team" : "Project"}
								>
									{item.groupName}
								</DetailRow>
							) : null}
							<DetailRow label="Messages">
								<span className="tabular-nums">{thread.messageCount}</span>
							</DetailRow>
							{updated ? (
								<DetailRow label="Last activity">
									<time dateTime={thread.updatedAt}>{updated}</time>
								</DetailRow>
							) : null}
						</dl>
					</section>
				</div>
			</div>
		</section>
	);
}

/** Calm right pane while nothing is open: a preview, or the empty state. */
export function InboxIdle({
	cursorItem,
	empty,
	now,
	onOpen,
	onStart,
}: {
	/** The list's keyboard cursor; the pane previews it. */
	cursorItem: InboxItem | null;
	/** True when the inbox has no threads at all. */
	empty: boolean;
	now: number;
	onOpen: (threadId: string) => void;
	onStart: () => void;
}) {
	if (cursorItem && !empty) {
		return <InboxPreview item={cursorItem} now={now} onOpen={onOpen} />;
	}
	return (
		<div
			className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center"
			data-testid="inbox-idle"
		>
			<p className="max-w-sm text-muted-foreground text-sm">
				Threads with your agents land here, sorted by what needs you.
			</p>
			{empty ? (
				<Button onClick={onStart} size="sm" variant="outline">
					New thread
					<InboxButtonKbd>C</InboxButtonKbd>
				</Button>
			) : null}
		</div>
	);
}
