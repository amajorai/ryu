import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils.ts";
import { X } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { MessengerAvatar } from "./messenger-avatar.tsx";
import {
	BackButton,
	HeaderBar,
	HeaderTitle,
} from "./messenger-conversation-chrome.tsx";
import { MessengerComposer } from "./messenger-conversation-composer.tsx";
import { ConversationStart } from "./messenger-conversation-start.tsx";
import { type MessengerEntry, matchRecipients } from "./messenger-model.ts";

const LIST_STEP: Record<string, number> = {
	ArrowDown: 1,
	ArrowUp: -1,
};

function RecipientOption({
	active,
	entry,
	id,
	onPick,
}: {
	active: boolean;
	entry: MessengerEntry;
	id: string;
	onPick: (entry: MessengerEntry) => void;
}) {
	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: the combobox input owns the keys (aria-activedescendant)
		<div
			aria-selected={active}
			className={cn(
				"flex h-9 cursor-default items-center gap-2.5 rounded-md px-2",
				active ? "bg-muted" : "hover:bg-muted/60"
			)}
			data-recipient={entry.key}
			id={id}
			onClick={() => onPick(entry)}
			// Keep focus in the To: field while the pointer picks.
			onMouseDown={(event) => event.preventDefault()}
			role="option"
		>
			<MessengerAvatar entry={entry} ringClassName="ring-muted" size="chip" />
			<span className="shrink-0 font-medium text-sm">{entry.name}</span>
			{entry.description ? (
				<span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
					{entry.description}
				</span>
			) : null}
		</div>
	);
}

/**
 * "New message": a To: field with a typeahead list under it, as in
 * Messages. Picking a recipient turns it into a single chip; Backspace in
 * the empty field takes it back out.
 */
export function MessengerCompose({
	entries,
	initialKey,
	onBack,
	onSend,
}: {
	entries: MessengerEntry[];
	initialKey: string | null;
	onBack: () => void;
	onSend: (entry: MessengerEntry, text: string) => void;
}) {
	const tl = useLiteralMessages();
	const [recipientKey, setRecipientKey] = useState<string | null>(initialKey);
	const [query, setQuery] = useState("");
	const [activeIndex, setActiveIndex] = useState(0);
	const recipient = entries.find((entry) => entry.key === recipientKey);
	const matches = matchRecipients(entries, query);
	const toId = useId();
	const listId = useId();
	const inputRef = useRef<HTMLInputElement>(null);
	const messageRef = useRef<HTMLTextAreaElement>(null);
	const listOpen = recipient === undefined;
	const active = matches[Math.min(activeIndex, matches.length - 1)];
	const optionId = (entry: MessengerEntry) =>
		`${listId}-${entry.key.replace(/[^\w-]/g, "_")}`;

	useEffect(() => {
		(recipientKey ? messageRef : inputRef).current?.focus();
	}, [recipientKey]);

	const pick = (entry: MessengerEntry) => {
		setRecipientKey(entry.key);
		setQuery("");
		setActiveIndex(0);
	};

	const onFieldKey = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Backspace" && recipient && !query) {
			event.preventDefault();
			setRecipientKey(null);
			return;
		}
		if (!listOpen || matches.length === 0) {
			return;
		}
		const step = LIST_STEP[event.key];
		if (step !== undefined) {
			event.preventDefault();
			setActiveIndex(
				(index) =>
					(Math.min(index, matches.length - 1) + step + matches.length) %
					matches.length
			);
		} else if (event.key === "Enter" && active) {
			event.preventDefault();
			pick(active);
		}
	};

	return (
		<section
			aria-label="New message"
			className="flex size-full min-h-0 flex-col"
		>
			<HeaderBar>
				<BackButton onBack={onBack} />
				<HeaderTitle className="flex-1">New message</HeaderTitle>
			</HeaderBar>
			<div className="flex h-11 shrink-0 items-center gap-2 border-border border-b px-4">
				<label className="text-muted-foreground text-sm" htmlFor={toId}>
					To:
				</label>
				{recipient ? (
					<span
						className="flex h-6 shrink-0 items-center gap-1 rounded-full bg-primary/10 pr-1 pl-2.5 font-medium text-primary text-sm"
						data-testid="messenger-recipient"
					>
						{recipient.name}
						<button
							aria-label={tl("Remove {name}", { name: recipient.name })}
							className="flex size-4 items-center justify-center rounded-full outline-none hover:bg-primary/15 focus-visible:ring-2 focus-visible:ring-ring"
							onClick={() => setRecipientKey(null)}
							type="button"
						>
							<X aria-hidden="true" className="size-3" />
						</button>
					</span>
				) : null}
				<input
					aria-activedescendant={
						listOpen && active ? optionId(active) : undefined
					}
					aria-autocomplete="list"
					aria-controls={listOpen ? listId : undefined}
					aria-expanded={listOpen}
					autoComplete="off"
					className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
					id={toId}
					onChange={(event) => {
						setQuery(event.target.value);
						setActiveIndex(0);
					}}
					onKeyDown={onFieldKey}
					placeholder={recipient ? "" : "Agent or team"}
					ref={inputRef}
					role="combobox"
					type="text"
					value={query}
				/>
			</div>
			{listOpen ? (
				<div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
					{matches.length > 0 ? (
						<div
							aria-label="Recipients"
							className="flex max-w-md flex-col gap-0.5"
							id={listId}
							role="listbox"
						>
							{matches.map((entry) => (
								<RecipientOption
									active={entry === active}
									entry={entry}
									id={optionId(entry)}
									key={entry.key}
									onPick={pick}
								/>
							))}
						</div>
					) : (
						<p
							className="px-2 py-1.5 text-muted-foreground text-sm"
							role="status"
						>
							{tl("No agents or teams match “{query}”.", {
								query: query.trim(),
							})}
						</p>
					)}
				</div>
			) : (
				<ConversationStart entry={{ ...recipient, threadIds: [] }} />
			)}
			<MessengerComposer
				disabledReason={recipient ? undefined : "Pick a recipient first."}
				inputRef={messageRef}
				label="New message"
				onSend={(text) => {
					if (recipient) {
						onSend(recipient, text);
					}
				}}
				placeholder={
					recipient ? tl("Message {name}", { name: recipient.name }) : "Message"
				}
			/>
		</section>
	);
}
