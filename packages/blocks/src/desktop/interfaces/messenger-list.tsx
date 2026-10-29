import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from "@ryu/ui/components/input-group.tsx";
import { ScrollArea } from "@ryu/ui/components/scroll-area.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	CircleAlert,
	MessagesSquare,
	Search,
	SquarePen,
	X,
} from "lucide-react";
import { motion } from "motion/react";
import {
	type KeyboardEvent,
	type ReactNode,
	type RefObject,
	useId,
	useRef,
} from "react";
import { compactAge } from "./interface-renderer.ts";
import { MessengerAvatar, TypingDots } from "./messenger-avatar.tsx";
import {
	fullTimestamp,
	type MessengerEntry,
	searchHit,
} from "./messenger-model.ts";
import { useReducedMotion } from "./reduced-motion.ts";

const ROW_SELECTOR = "[data-messenger-contact]";

/**
 * Arrow keys, Home and End walk the contact rows like a native list. Bound
 * on the scroll area so the arrows also work from its focusable viewport,
 * which then hands focus to the list's tab stop.
 */
function moveFocus(event: KeyboardEvent<HTMLElement>) {
	const rows = Array.from(
		event.currentTarget.querySelectorAll<HTMLButtonElement>(ROW_SELECTOR)
	);
	if (rows.length === 0) {
		return;
	}
	const current = rows.indexOf(
		document.activeElement as HTMLButtonElement // focus is inside this list
	);
	const entry = Math.max(
		0,
		rows.findIndex((row) => row.tabIndex === 0)
	);
	let next: number | null = null;
	if (event.key === "ArrowDown") {
		next = current < 0 ? entry : Math.min(rows.length - 1, current + 1);
	} else if (event.key === "ArrowUp") {
		next = current < 0 ? entry : Math.max(0, current - 1);
	} else if (event.key === "Home") {
		next = 0;
	} else if (event.key === "End") {
		next = rows.length - 1;
	}
	if (next === null) {
		return;
	}
	event.preventDefault();
	rows[next]?.focus();
}

function previewText(entry: MessengerEntry): string {
	if (!entry.lastMessage) {
		return entry.threadIds.length > 0
			? "No messages yet"
			: entry.description || "Start a conversation";
	}
	return entry.lastMessageRole === "user"
		? `You: ${entry.lastMessage}`
		: entry.lastMessage;
}

/**
 * The row's accessible name: who, plus state. The preview is long, so it is
 * the row's description instead (`aria-describedby`).
 */
function rowLabel(entry: MessengerEntry, hitTitle: string | null): string {
	let name = entry.name;
	if (entry.kind === "team") {
		name = `${entry.name} (team)`;
	} else if (entry.kind === "other") {
		name = `${entry.name} (conversations without an agent)`;
	}
	const parts = [name];
	if (entry.pinned) {
		parts.push("pinned");
	}
	if (entry.running) {
		parts.push("typing");
	}
	if (entry.unread > 0) {
		parts.push(
			`${entry.unread} ${entry.unread === 1 ? "reply" : "replies"} waiting on you`
		);
	}
	if (entry.attention > 0) {
		parts.push("needs attention");
	}
	if (hitTitle !== null) {
		parts.push(`matching conversation: ${hitTitle || "Untitled"}`);
	}
	return parts.join(", ");
}

function ContactRow({
	entry,
	highlightId,
	onSelect,
	query,
	reduceMotion,
	selected,
	tabbable,
}: {
	entry: MessengerEntry;
	/** Shared layout id so the selection slides between rows. */
	highlightId: string;
	onSelect: (entry: MessengerEntry, threadId?: string) => void;
	query: string;
	reduceMotion: boolean;
	selected: boolean;
	/** Roving tabindex: one row is the list's single Tab stop. */
	tabbable: boolean;
}) {
	const previewId = useId();
	const hit = searchHit(entry, query);
	const unread = entry.unread > 0;
	const meta = selected
		? "text-sidebar-primary-foreground/80"
		: "text-muted-foreground";
	const stamp = entry.lastActivityAt ? (
		<time
			className={cn("shrink-0 text-xs tabular-nums", meta)}
			dateTime={entry.lastActivityAt}
			title={fullTimestamp(entry.lastActivityAt)}
		>
			{compactAge(entry.lastActivityAt)}
		</time>
	) : null;
	let previewTone = "text-muted-foreground";
	if (selected) {
		previewTone = "text-sidebar-primary-foreground/90";
	} else if (unread || hit) {
		previewTone = "text-sidebar-foreground";
	}
	let preview: ReactNode = previewText(entry);
	let clamp = "line-clamp-2";
	if (hit) {
		preview = (
			<span className="inline-flex max-w-full items-center gap-1">
				<MessagesSquare aria-hidden="true" className="size-3.5 shrink-0" />
				<span className="truncate">{hit.title || "Untitled"}</span>
			</span>
		);
	} else if (entry.running) {
		// Typing takes the first preview line, as in Messages; the last
		// message stays under it so the row keeps its two-line rhythm.
		clamp = "flex flex-col";
		preview = (
			<>
				<span className="flex h-[18px] items-center gap-1.5">
					typing
					<TypingDots />
				</span>
				<span className="truncate">{previewText(entry)}</span>
			</>
		);
	}
	return (
		<li>
			<button
				aria-current={selected ? "true" : undefined}
				aria-describedby={previewId}
				aria-label={rowLabel(entry, hit?.title ?? null)}
				className={cn(
					"relative flex w-full items-center gap-2 rounded-lg py-2 pr-3 pl-1 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
					selected
						? "text-sidebar-primary-foreground"
						: "text-sidebar-foreground hover:bg-sidebar-accent"
				)}
				data-messenger-contact={entry.key}
				onClick={() => onSelect(entry, hit?.threadId)}
				tabIndex={tabbable ? 0 : -1}
				type="button"
			>
				{selected ? (
					<motion.span
						aria-hidden="true"
						className="absolute inset-0 rounded-lg bg-sidebar-primary"
						layoutId={reduceMotion ? undefined : highlightId}
						transition={{ duration: 0.16, ease: "easeOut" }}
					/>
				) : null}
				<span
					aria-hidden="true"
					className="relative flex w-2.5 shrink-0 justify-center"
				>
					{unread && !selected ? (
						<span
							className="size-2.5 rounded-full bg-primary"
							data-testid="messenger-unread"
						/>
					) : null}
				</span>
				<MessengerAvatar
					entry={entry}
					ringClassName={selected ? "ring-sidebar-primary" : "ring-sidebar"}
					size="list"
				/>
				<span className="relative ml-1 flex min-w-0 flex-1 flex-col gap-0.5">
					<span className="flex items-baseline gap-2">
						<span
							className={cn(
								"min-w-0 flex-1 truncate text-sm",
								unread ? "font-semibold" : "font-medium"
							)}
						>
							{entry.name}
						</span>
						{stamp}
					</span>
					<span className="flex items-start gap-2">
						<span
							className={cn(
								// Two lines tall even when shorter, so every row matches.
								"min-h-9 min-w-0 flex-1 text-[13px] leading-[18px]",
								clamp,
								previewTone
							)}
							id={previewId}
						>
							{preview}
						</span>
						{entry.attention > 0 ? (
							<CircleAlert
								aria-hidden="true"
								className={cn(
									"mt-px size-4 shrink-0",
									selected
										? "text-sidebar-primary-foreground"
										: "text-destructive"
								)}
							/>
						) : null}
					</span>
				</span>
			</button>
		</li>
	);
}

function ListSkeleton() {
	return (
		<ul aria-hidden="true" className="flex flex-col gap-0.5 px-3">
			{["a", "b", "c", "d", "e"].map((key) => (
				<li className="flex items-center gap-2 py-2 pr-3 pl-1" key={key}>
					<span className="w-2.5 shrink-0" />
					<Skeleton className="size-11 shrink-0" radius="pill" />
					<span className="ml-1 flex flex-1 flex-col gap-2">
						<Skeleton className="h-3.5 w-1/2" radius="dense" />
						<Skeleton className="h-3 w-5/6" radius="dense" />
					</span>
				</li>
			))}
		</ul>
	);
}

/**
 * The contact column: title with compose, search, and the contact rows.
 * Uses the sidebar tokens so it reads as the app's own side rail.
 */
export function MessengerContactList({
	composing,
	entries,
	loading,
	onCompose,
	onQueryChange,
	onSelect,
	query,
	searchRef,
	selectedKey,
	totalCount,
}: {
	composing: boolean;
	entries: MessengerEntry[];
	loading: boolean;
	onCompose: () => void;
	onQueryChange: (query: string) => void;
	onSelect: (entry: MessengerEntry, threadId?: string) => void;
	query: string;
	searchRef: RefObject<HTMLInputElement | null>;
	selectedKey: string | null;
	totalCount: number;
}) {
	const tl = useLiteralMessages();
	const searchId = useId();
	const listRef = useRef<HTMLUListElement>(null);
	const highlightId = useId();
	const reduceMotion = useReducedMotion();
	let body: ReactNode;
	if (loading) {
		body = <ListSkeleton />;
	} else if (totalCount === 0) {
		body = (
			<p className="px-5 py-8 text-center text-muted-foreground text-sm">
				No contacts yet. Create an agent to start messaging.
			</p>
		);
	} else if (entries.length === 0) {
		body = (
			<p
				className="px-5 py-8 text-center text-muted-foreground text-sm"
				role="status"
			>
				{tl("No contacts match “{query}”.", { query: query.trim() })}
			</p>
		);
	} else {
		const activeKey = composing ? null : selectedKey;
		const tabKey = entries.some((entry) => entry.key === activeKey)
			? activeKey
			: entries[0]?.key;
		body = (
			<ul
				aria-label="Contacts"
				className="flex flex-col gap-0.5 px-3 pb-3"
				ref={listRef}
			>
				{entries.map((entry) => (
					<ContactRow
						entry={entry}
						highlightId={highlightId}
						key={entry.key}
						onSelect={onSelect}
						query={query}
						reduceMotion={reduceMotion}
						selected={entry.key === activeKey}
						tabbable={entry.key === tabKey}
					/>
				))}
			</ul>
		);
	}

	return (
		<nav
			aria-busy={loading}
			aria-label="Messages"
			className="flex size-full min-h-0 flex-col bg-sidebar text-sidebar-foreground"
		>
			<header className="flex h-16 shrink-0 items-center justify-between gap-2 px-4">
				<h2>
					<span className="font-sans font-semibold text-xl tracking-tight">
						Messages
					</span>
				</h2>
				<Tooltip>
					<TooltipTrigger
						render={
							<Button
								aria-label="New message"
								aria-pressed={composing}
								className={cn(
									"text-sidebar-foreground hover:bg-sidebar-accent",
									composing &&
										"bg-sidebar-accent text-primary hover:text-primary"
								)}
								onClick={onCompose}
								size="icon-sm"
								variant="ghost"
							/>
						}
					>
						<SquarePen aria-hidden="true" />
					</TooltipTrigger>
					<TooltipContent side="bottom">New message</TooltipContent>
				</Tooltip>
			</header>
			<div className="px-3 pb-3">
				<label className="sr-only" htmlFor={searchId}>
					Search contacts and conversations
				</label>
				<InputGroup className="h-8 bg-sidebar-accent">
					<InputGroupAddon>
						<Search aria-hidden="true" />
					</InputGroupAddon>
					<InputGroupInput
						autoComplete="off"
						className="h-8 text-sm [&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none"
						id={searchId}
						onChange={(event) => onQueryChange(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Escape" && query) {
								event.preventDefault();
								onQueryChange("");
							} else if (event.key === "ArrowDown") {
								event.preventDefault();
								listRef.current
									?.querySelector<HTMLButtonElement>(ROW_SELECTOR)
									?.focus();
							}
						}}
						placeholder="Search"
						ref={searchRef}
						type="search"
						value={query}
					/>
					{query ? (
						<InputGroupAddon align="inline-end">
							<InputGroupButton
								aria-label="Clear search"
								onClick={() => {
									onQueryChange("");
									searchRef.current?.focus();
								}}
								size="icon-xs"
							>
								<X aria-hidden="true" />
							</InputGroupButton>
						</InputGroupAddon>
					) : null}
				</InputGroup>
			</div>
			<ScrollArea className="min-h-0 flex-1" onKeyDown={moveFocus}>
				{body}
			</ScrollArea>
		</nav>
	);
}
