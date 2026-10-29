import { useLiteralMessages } from "@ryu/i18n/react";
import { Kbd } from "@ryu/ui/components/kbd.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type {
	InterfaceAgent,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import { CornerDownLeft } from "lucide-react";
import {
	type ChangeEvent,
	type KeyboardEvent,
	type RefObject,
	type SyntheticEvent,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { MOMENTS_KBD, MomentsGlyph } from "./moments-glyph.tsx";
import {
	momentsMentionHandle,
	momentsMentionMatches,
	momentsMentionQuery,
	parseMomentsIntent,
} from "./moments-model.ts";

const CLOCK_TICK_MS = 15_000;

/** The small wall clock in the top-right corner, as on MercuryOS. */
export function MomentsClock() {
	const [now, setNow] = useState(() => new Date());
	useEffect(() => {
		const timer = window.setInterval(() => setNow(new Date()), CLOCK_TICK_MS);
		return () => window.clearInterval(timer);
	}, []);
	return (
		<time
			className="shrink-0 text-muted-foreground text-sm tabular-nums"
			dateTime={now.toISOString()}
		>
			{now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
		</time>
	);
}

/**
 * "What would you like to do?" Typing and pressing Enter starts a thread with
 * the typed prompt. `@name` picks the agent inline (with suggestions);
 * otherwise the thread goes to `fallback`, the agent of the place you are in.
 */
export function MomentsIntentBar({
	fallback,
	inputRef,
	onLeave,
	onStart,
	snapshot,
}: {
	/** Who an un-addressed prompt goes to, named in the Enter hint. */
	fallback: InterfaceAgent | undefined;
	inputRef: RefObject<HTMLInputElement | null>;
	/** ArrowDown in an empty bar hands focus back to the page. */
	onLeave: () => void;
	onStart: (prompt: string, agent: InterfaceAgent | undefined) => void;
	snapshot: InterfaceSnapshot;
}) {
	const tl = useLiteralMessages();
	const listId = useId();
	const [text, setText] = useState("");
	const [caret, setCaret] = useState(0);
	const [highlight, setHighlight] = useState(0);
	const [dismissed, setDismissed] = useState(false);
	/** Where the caret goes after a picked mention, set before the next key. */
	const pendingCaret = useRef<number | null>(null);

	useLayoutEffect(() => {
		const position = pendingCaret.current;
		if (position === null) {
			return;
		}
		pendingCaret.current = null;
		inputRef.current?.setSelectionRange(position, position);
	});

	const mention = momentsMentionQuery(text, caret);
	const matches = mention
		? momentsMentionMatches(snapshot.agents, mention.query)
		: [];
	const open = matches.length > 0 && !dismissed;
	const active = matches[Math.min(highlight, matches.length - 1)];
	const intent = parseMomentsIntent(snapshot, text);
	const target = intent.agent ?? fallback;

	function syncCaret(event: SyntheticEvent<HTMLInputElement>) {
		setCaret(
			event.currentTarget.selectionStart ?? event.currentTarget.value.length
		);
	}

	function handleChange(event: ChangeEvent<HTMLInputElement>) {
		setText(event.target.value);
		syncCaret(event);
		setHighlight(0);
		setDismissed(false);
	}

	function choose(agent: InterfaceAgent) {
		if (!mention) {
			return;
		}
		const handle = momentsMentionHandle(agent);
		const tail = text.slice(caret);
		const next = `${text.slice(0, mention.start)}@${handle} ${tail}`;
		const nextCaret = mention.start + handle.length + 2;
		setText(next);
		setCaret(nextCaret);
		setHighlight(0);
		// React leaves the caret at the end; only a mid-line mention needs it
		// moved, and that happens synchronously after commit, before the next
		// key can land.
		if (tail) {
			pendingCaret.current = nextCaret;
		}
	}

	function submit() {
		if (!intent.prompt) {
			return;
		}
		onStart(intent.prompt, intent.agent);
		setText("");
		setCaret(0);
	}

	function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
		if (open && active) {
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				const delta = event.key === "ArrowDown" ? 1 : -1;
				setHighlight(
					(index) => (index + delta + matches.length) % matches.length
				);
				return;
			}
			if (event.key === "Enter" || event.key === "Tab") {
				event.preventDefault();
				choose(active);
				return;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				setDismissed(true);
				return;
			}
		}
		if (event.key === "ArrowDown" && !text) {
			event.preventDefault();
			onLeave();
			return;
		}
		if (event.key === "Enter" && !event.nativeEvent.isComposing) {
			event.preventDefault();
			submit();
			return;
		}
		if (event.key === "Escape") {
			event.stopPropagation();
			if (text) {
				setText("");
				setCaret(0);
			} else {
				event.currentTarget.blur();
			}
		}
	}

	const startHint = target
		? tl("Start with {name}", { name: target.name })
		: "Start a thread";

	return (
		<div className="relative min-w-0 flex-1">
			<div className="flex h-12 items-center gap-3 rounded-full border border-foreground/5 bg-card/60 px-5 shadow-foreground/5 shadow-sm transition-colors focus-within:border-border focus-within:bg-card/90">
				<input
					aria-activedescendant={
						open && active ? `${listId}-${active.id}` : undefined
					}
					aria-autocomplete="list"
					aria-controls={open ? listId : undefined}
					aria-expanded={open}
					aria-label="What would you like to do?"
					autoComplete="off"
					className="h-full min-w-0 flex-1 bg-transparent text-base text-foreground outline-none placeholder:text-foreground/55"
					onChange={handleChange}
					onClick={syncCaret}
					onKeyDown={handleKeyDown}
					onKeyUp={syncCaret}
					placeholder="What would you like to do?"
					ref={inputRef}
					role="combobox"
					spellCheck={false}
					type="text"
					value={text}
				/>
				{open || intent.prompt ? (
					<span className="flex shrink-0 items-center gap-2 text-muted-foreground text-xs">
						<span className="hidden sm:inline">
							{open ? "Choose" : startHint}
						</span>
						<Kbd aria-hidden="true" className={MOMENTS_KBD}>
							<CornerDownLeft />
						</Kbd>
					</span>
				) : (
					<Kbd
						aria-hidden="true"
						className={cn(MOMENTS_KBD, "hidden sm:inline-flex")}
					>
						/
					</Kbd>
				)}
			</div>
			{open ? (
				<div
					aria-label="Agents"
					className="absolute top-full left-0 z-30 mt-1 w-72 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-foreground/5 shadow-lg"
					id={listId}
					role="listbox"
				>
					{matches.map((agent) => (
						<div
							aria-selected={agent === active}
							className={cn(
								"flex h-10 cursor-default items-center gap-2.5 rounded-md px-2",
								agent === active && "bg-accent text-accent-foreground"
							)}
							id={`${listId}-${agent.id}`}
							key={agent.id}
							onMouseDown={(event) => {
								event.preventDefault();
								choose(agent);
							}}
							onMouseEnter={() => setHighlight(matches.indexOf(agent))}
							role="option"
							tabIndex={-1}
						>
							<MomentsGlyph agent={agent} size="md" />
							<span className="min-w-0 flex-1 truncate">
								<span className="text-sm">{agent.name}</span>
								{agent.description ? (
									<span className="ml-2 text-muted-foreground text-xs">
										{agent.description}
									</span>
								) : null}
							</span>
						</div>
					))}
				</div>
			) : null}
		</div>
	);
}
