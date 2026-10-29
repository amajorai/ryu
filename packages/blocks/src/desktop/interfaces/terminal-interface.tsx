import { Button } from "@ryu/ui/components/button.tsx";
import { Kbd } from "@ryu/ui/components/kbd.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceParamsByRenderer,
	parseTerminalCommand,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { Check, Copy, SquareTerminal, X } from "lucide-react";
import {
	type FormEvent,
	type KeyboardEvent,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	agentHandle,
	type InterfaceRendererProps,
} from "./interface-renderer.ts";
import {
	completeInput,
	listAgents,
	listThreads,
	promptPath,
	resolveOpenTarget,
	resolveStartTarget,
	statusChanges,
	statusMap,
	TERMINAL_STATUS_GLYPHS,
	type TerminalThreadRow,
	terminalCounts,
	threadOwnerLabel,
	threadsNeedingYou,
	threadTitle,
} from "./terminal-model.ts";
import {
	BANNER_ROWS,
	groupTerminalBlocks,
	STATUS_GLYPH_TONE,
	STATUS_TONE,
	type TerminalAction,
	type TerminalBlock,
	type TerminalEntry,
	TerminalEntryView,
	type TerminalSegment,
	TerminalStatus,
	terminalBlockText,
} from "./terminal-output.tsx";

/** Scrollback kept in memory; older blocks scroll away like a real terminal. */
const MAX_ENTRIES = 400;
const MAX_HISTORY = 100;
/** At most this many live status notices are printed per snapshot update. */
const MAX_NOTICES = 3;

/** Footer key hints; esc is shown only while a thread is open. */
const KEY_HINTS = [
	{ keys: "↑↓", label: "history" },
	{ keys: "tab", label: "complete" },
	{ keys: "ctrl-l", label: "clear" },
	{ keys: "esc", label: "close" },
] as const;

type WithoutId<Entry> = Entry extends unknown ? Omit<Entry, "id"> : never;
/** A scrollback block before it is given an id. */
type NewEntry = WithoutId<TerminalEntry>;

function line(...segments: TerminalSegment[]): NewEntry {
	return { kind: "line", segments };
}

/** A line printed without a command, so it gets its own block. */
function notice(...segments: TerminalSegment[]): NewEntry {
	return { kind: "line", segments, standalone: true };
}

function error(text: string): NewEntry {
	return line({ text, tone: "error" });
}

function muted(text: string): NewEntry {
	return line({ text, tone: "muted" });
}

/** How long the copy action shows its confirmation. */
const COPIED_MS = 1200;

/** Copy a block's output; revealed on block hover or keyboard focus. */
function BlockCopyButton({
	block,
	needsYou,
	now,
}: {
	block: TerminalBlock;
	needsYou: readonly TerminalThreadRow[];
	now: number;
}) {
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) {
			return;
		}
		const timer = window.setTimeout(() => setCopied(false), COPIED_MS);
		return () => window.clearTimeout(timer);
	}, [copied]);
	const copy = async () => {
		const text = terminalBlockText(block, { needsYou, now });
		try {
			await navigator.clipboard.writeText(text);
			setCopied(true);
		} catch {
			// Clipboard access can be denied; the output stays selectable.
		}
	};
	const Icon = copied ? Check : Copy;
	return (
		<Button
			aria-label={copied ? "Copied" : "Copy output"}
			className="absolute top-2.5 @3xl/terminal:right-5 right-3 text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover/block:opacity-100 motion-safe:transition-opacity"
			onClick={copy}
			size="icon-xs"
			variant="ghost"
		>
			<Icon aria-hidden="true" className="size-4" />
		</Button>
	);
}

/** Elements that handle their own pointer input inside the terminal pane. */
const INTERACTIVE = "a, button, input, select, textarea, [role='button']";

/**
 * Terminal interface: a keyboard-first command line over agents and threads.
 * Commands are parsed by the shared Terminal language, every action goes
 * through the port, and the open thread is shown beside the scrollback in the
 * host's own conversation surface. Uses only the user's theme tokens.
 */
export function TerminalInterface({
	activeThreadId,
	loading,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<InterfaceParamsByRenderer["terminal"]>) {
	const inputId = useId();
	const inputRef = useRef<HTMLInputElement>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const nextId = useRef(1);
	const [entries, setEntries] = useState<TerminalEntry[]>(() => [
		{ id: 0, kind: "banner" },
	]);
	const [input, setInput] = useState("");
	const [history, setHistory] = useState<string[]>([]);
	/** Position while browsing history; null means editing the draft. */
	const historyIndex = useRef<number | null>(null);
	const draft = useRef("");
	/** Thread ids of the last `ls`, so `open <n>` matches what was printed. */
	const lastListing = useRef<string[] | null>(null);

	const counts = useMemo(() => terminalCounts(snapshot), [snapshot]);
	const agentRows = useMemo(() => listAgents(snapshot), [snapshot]);
	const needsYou = useMemo(
		() => threadsNeedingYou(snapshot, BANNER_ROWS),
		[snapshot]
	);
	/** Clock for the banner's ages, refreshed with each snapshot. */
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-read the clock when the snapshot changes.
	const now = useMemo(() => Date.now(), [snapshot]);
	const blocks = useMemo(() => groupTerminalBlocks(entries), [entries]);
	const activeThread = useMemo(
		() => snapshot.threads.find((thread) => thread.id === activeThreadId),
		[activeThreadId, snapshot.threads]
	);
	const threadOpen = threadView !== null && threadView !== undefined;
	const cwd = threadOpen ? promptPath(activeThread) : "~";

	const push = useCallback((...blocks: NewEntry[]) => {
		const stamped = blocks.map((block) => {
			const id = nextId.current;
			nextId.current += 1;
			return { ...block, id } as TerminalEntry;
		});
		setEntries((previous) => [...previous, ...stamped].slice(-MAX_ENTRIES));
	}, []);

	const focusInput = useCallback(() => {
		inputRef.current?.focus({ preventScroll: true });
	}, []);

	// The prompt owns focus when the interface mounts.
	useEffect(() => {
		focusInput();
	}, [focusInput]);

	// Keep the newest output and the prompt in view.
	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll whenever scrollback grows or the split resizes the pane.
	useLayoutEffect(() => {
		const node = scrollRef.current;
		if (node) {
			node.scrollTop = node.scrollHeight;
		}
	}, [entries, threadOpen]);

	// Clicking empty space in the terminal returns focus to the prompt, unless
	// the user is selecting output to copy.
	useEffect(() => {
		const node = scrollRef.current;
		if (!node) {
			return;
		}
		const onPointerUp = (event: PointerEvent) => {
			const target = event.target;
			if (target instanceof Element && target.closest(INTERACTIVE)) {
				return;
			}
			if (window.getSelection()?.isCollapsed ?? true) {
				focusInput();
			}
		};
		node.addEventListener("pointerup", onPointerUp);
		return () => node.removeEventListener("pointerup", onPointerUp);
	}, [focusInput]);

	// Live notices: print a line when a thread changes status after load.
	const previousStatuses = useRef<Map<
		string,
		ReturnType<typeof threadStatus>
	> | null>(null);
	useEffect(() => {
		if (loading) {
			return;
		}
		const previous = previousStatuses.current;
		previousStatuses.current = statusMap(snapshot);
		if (!previous) {
			return;
		}
		const notices = statusChanges(previous, snapshot)
			.slice(0, MAX_NOTICES)
			.map(({ status, thread }) =>
				notice(
					{
						text: `${TERMINAL_STATUS_GLYPHS[status]} `,
						tone: STATUS_GLYPH_TONE[status],
					},
					{ text: `${threadOwnerLabel(snapshot, thread)} `, tone: "muted" },
					{
						action: { kind: "open", threadId: thread.id },
						label: `Open thread: ${threadTitle(thread)}`,
						text: threadTitle(thread),
					},
					{ text: " is now ", tone: "muted" },
					{ text: status, tone: STATUS_TONE[status] }
				)
			);
		if (notices.length > 0) {
			push(...notices);
		}
	}, [loading, push, snapshot]);

	const closeThread = useCallback(
		(fromCommand: boolean) => {
			if (!threadOpen) {
				return false;
			}
			port.closeThread();
			const message = `closed ${threadTitle(activeThread)}`;
			push(
				fromCommand ? muted(message) : notice({ text: message, tone: "muted" })
			);
			return true;
		},
		[activeThread, port, push, threadOpen]
	);

	const openThread = useCallback(
		(threadId: string, number: number | null, fromCommand: boolean) => {
			const thread = snapshot.threads.find((item) => item.id === threadId);
			port.openThread(threadId);
			const print = fromCommand ? line : notice;
			push(
				print(
					{ text: "opened ", tone: "muted" },
					{ text: number === null ? "" : `#${number} `, tone: "muted" },
					{ text: threadTitle(thread) }
				)
			);
		},
		[port, push, snapshot.threads]
	);

	const runAction = useCallback(
		(action: TerminalAction) => {
			if (action.kind === "open") {
				openThread(action.threadId, null, false);
			} else {
				setInput(action.value);
				historyIndex.current = null;
			}
			focusInput();
		},
		[focusInput, openThread]
	);

	const startThread = (handle: string | null, prompt: string) => {
		const message = prompt.trim();
		if (!message) {
			push(
				error("new: missing message"),
				muted("usage: new [@agent] <message>")
			);
			return;
		}
		const target = resolveStartTarget(snapshot, handle);
		switch (target.kind) {
			case "unknown":
				push(
					line(
						{
							text: `new: no agent, team, or project @${handle}`,
							tone: "error",
						},
						{
							text: target.close ? " did you mean " : " try ",
							tone: "muted",
						},
						...target.suggestions.flatMap((suggestion, index) => [
							...(index > 0 ? [{ text: ", ", tone: "muted" as const }] : []),
							{
								action: {
									kind: "fill" as const,
									value: `${suggestion} ${message}`,
								},
								label: `Use ${suggestion}`,
								text: suggestion,
								tone: "primary" as const,
							},
						]),
						{
							text: target.close && target.suggestions.length > 0 ? "?" : "",
							tone: "muted",
						}
					)
				);
				return;
			case "agent":
				port.startThread({ agentId: target.agent.id, prompt: message });
				push(
					line(
						{ text: "→ ", tone: "success" },
						{ text: "started a thread with ", tone: "muted" },
						{ text: agentHandle(target.agent.name), tone: "primary" }
					)
				);
				return;
			case "group":
				port.startThread(
					target.group.kind === "team"
						? { prompt: message, teamId: target.group.id }
						: { projectId: target.group.id, prompt: message }
				);
				push(
					line(
						{ text: "→ ", tone: "success" },
						{
							text: `started a thread in ${target.group.kind} `,
							tone: "muted",
						},
						{ text: target.group.name, tone: "primary" }
					)
				);
				return;
			default:
				port.startThread({ prompt: message });
				push(
					line(
						{ text: "→ ", tone: "success" },
						{ text: "started a new thread", tone: "muted" }
					)
				);
		}
	};

	const explainUnknown = (raw: string) => {
		const [verb = ""] = raw.split(/\s+/);
		const lower = verb.toLowerCase();
		if (lower === "ls" || lower === "list") {
			push(
				error(`ls: unknown filter "${raw.slice(verb.length).trim()}"`),
				muted("filters: all, working, your-turn, waiting, attention, quiet")
			);
			return;
		}
		if (lower === "open" || lower === "cd") {
			push(
				error("open: which thread?"),
				muted("usage: open <n|id> · ls for numbers")
			);
			return;
		}
		push(error(`ryu: command not found: ${verb}`), muted("try help"));
	};

	const runCommand = (raw: string) => {
		push({ kind: "command", prompt: cwd, text: raw });
		const command = parseTerminalCommand(raw);
		const needsData =
			command.kind === "agents" ||
			command.kind === "list" ||
			command.kind === "new" ||
			command.kind === "open";
		if (loading && needsData) {
			push(muted("still loading agents and threads · try again shortly"));
			return;
		}
		switch (command.kind) {
			case "empty":
				return;
			case "help":
				push({ kind: "help" });
				return;
			case "clear":
				setEntries([]);
				return;
			case "list": {
				const rows = listThreads(snapshot, command.filter);
				lastListing.current = rows.map((row) => row.threadId);
				push({
					filter: command.filter,
					kind: "threads",
					now: Date.now(),
					rows,
				});
				return;
			}
			case "agents":
				push({ kind: "agents", rows: listAgents(snapshot) });
				return;
			case "open": {
				if (command.target === ".." || command.target === "~") {
					if (!closeThread(true)) {
						push(muted("already at ~"));
					}
					return;
				}
				const resolved = resolveOpenTarget(
					snapshot,
					command.target,
					lastListing.current
				);
				if (resolved.kind === "found") {
					openThread(resolved.threadId, resolved.number, true);
				} else {
					push(error(resolved.message), muted(resolved.hint));
				}
				return;
			}
			case "new":
				startThread(command.agentHandle, command.prompt);
				return;
			case "close":
				if (!closeThread(true)) {
					push(muted("close: no thread is open"));
				}
				return;
			default:
				explainUnknown(command.input);
		}
	};

	const onSubmit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const raw = input;
		setInput("");
		historyIndex.current = null;
		draft.current = "";
		if (raw.trim()) {
			setHistory((previous) =>
				previous.at(-1) === raw.trim()
					? previous
					: [...previous, raw.trim()].slice(-MAX_HISTORY)
			);
		}
		runCommand(raw);
	};

	const browseHistory = (direction: -1 | 1) => {
		if (history.length === 0) {
			return;
		}
		const current = historyIndex.current;
		if (current === null) {
			if (direction === 1) {
				return;
			}
			draft.current = input;
			historyIndex.current = history.length - 1;
		} else {
			const next = current + direction;
			if (next >= history.length) {
				historyIndex.current = null;
				setInput(draft.current);
				return;
			}
			historyIndex.current = Math.max(0, next);
		}
		setInput(history[historyIndex.current] ?? "");
	};

	const complete = () => {
		const result = completeInput(snapshot, input);
		if (result.value !== input) {
			setInput(result.value);
			return;
		}
		if (result.candidates.length > 0) {
			push(
				{ kind: "command", prompt: cwd, text: input },
				muted(result.candidates.join("   "))
			);
		}
	};

	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		const { ctrlKey, key, metaKey, shiftKey } = event;
		const target = event.currentTarget;
		if (key === "ArrowUp" || key === "ArrowDown") {
			event.preventDefault();
			browseHistory(key === "ArrowUp" ? -1 : 1);
			return;
		}
		// With an empty prompt Tab moves focus normally, so it never traps.
		if (key === "Tab" && !shiftKey && input.length > 0) {
			event.preventDefault();
			complete();
			return;
		}
		if (key === "Escape") {
			event.preventDefault();
			if (!closeThread(false)) {
				setInput("");
			}
			return;
		}
		if (!(ctrlKey || metaKey)) {
			return;
		}
		const lower = key.toLowerCase();
		if (lower === "l") {
			event.preventDefault();
			setEntries([]);
		} else if (lower === "u" && ctrlKey) {
			event.preventDefault();
			setInput("");
		} else if (
			lower === "c" &&
			ctrlKey &&
			!metaKey &&
			target.selectionStart === target.selectionEnd
		) {
			event.preventDefault();
			push({ kind: "command", prompt: cwd, text: `${input}^C` });
			setInput("");
			historyIndex.current = null;
		}
	};

	const activeStatus = activeThread ? threadStatus(activeThread) : null;
	const gutter = "px-4 @3xl/terminal:px-6";

	return (
		<div
			className="@container/terminal flex size-full min-h-0 flex-col overflow-hidden bg-background font-mono @3xl/terminal:text-sm text-[13px] text-foreground @3xl/terminal:leading-6 leading-5"
			data-testid="interface-terminal"
		>
			<div
				className="flex h-10 shrink-0 items-end gap-1 border-border border-b bg-muted/50 px-2 font-sans text-[13px]"
				role="presentation"
			>
				<p className="flex h-8 min-w-0 max-w-80 items-center gap-2 rounded-t-md border border-border border-b-0 bg-background px-3 text-foreground">
					<SquareTerminal
						aria-hidden="true"
						className="size-4 shrink-0 text-muted-foreground"
					/>
					<span className="truncate">
						you@ryu: {threadOpen ? threadTitle(activeThread) : "~"}
					</span>
				</p>
				<p className="mb-2 ml-auto @md/terminal:flex hidden shrink-0 items-center gap-1.5 pr-1 text-muted-foreground">
					<span
						aria-hidden="true"
						className={cn(
							"size-2 rounded-full",
							loading ? "bg-muted-foreground/40" : "bg-success"
						)}
					/>
					{loading ? "connecting" : "connected"}
				</p>
			</div>
			<div className="-mt-px flex min-h-0 flex-1 @3xl/terminal:flex-row flex-col">
				<section
					aria-label="Terminal"
					className="flex min-h-0 min-w-0 flex-1 basis-0 flex-col"
				>
					{threadOpen ? (
						// Side by side, both panes share one header rule.
						// The cwd stays muted so the thread title is the primary heading.
						<header
							className={cn(
								"@3xl/terminal:flex hidden h-10 shrink-0 items-center border-border border-b text-muted-foreground",
								gutter
							)}
						>
							<p className="min-w-0 truncate">{cwd}</p>
						</header>
					) : null}
					<div
						className="@container/terminal-log min-h-0 flex-1 overflow-y-auto overscroll-contain"
						ref={scrollRef}
					>
						<div
							aria-busy={loading}
							aria-label="Terminal output"
							aria-live="polite"
							className="flex flex-col"
							role="log"
						>
							{blocks.map((block) => {
								const [first, ...rest] = block.entries;
								const output = block.kind === "command" ? rest : block.entries;
								return (
									<div
										className={cn(
											"group/block relative border-border/60 border-b py-3 last:border-b-0 focus-within:bg-muted/40 hover:bg-muted/40 motion-safe:transition-colors motion-safe:duration-100",
											gutter
										)}
										data-block={block.kind}
										key={block.id}
									>
										{block.kind === "command" && first ? (
											<TerminalEntryView
												agents={agentRows}
												counts={counts}
												entry={first}
												loading={loading}
												needsYou={needsYou}
												now={now}
												onAction={runAction}
											/>
										) : null}
										{output.length > 0 ? (
											<div
												className={
													block.kind === "command" ? "pt-2" : undefined
												}
											>
												{output.map((entry) => (
													<TerminalEntryView
														agents={agentRows}
														counts={counts}
														entry={entry}
														key={entry.id}
														loading={loading}
														needsYou={needsYou}
														now={now}
														onAction={runAction}
													/>
												))}
											</div>
										) : null}
										<BlockCopyButton
											block={block}
											needsYou={needsYou}
											now={now}
										/>
									</div>
								);
							})}
						</div>
					</div>
					<form
						className={cn(
							"group/prompt flex shrink-0 items-center border-border border-t bg-muted/30 py-3",
							gutter
						)}
						onSubmit={onSubmit}
					>
						<label
							className="flex min-w-0 max-w-[50%] shrink-0 select-none"
							htmlFor={inputId}
						>
							<span className="sr-only">Terminal command</span>
							<span
								aria-hidden="true"
								className="shrink-0 text-muted-foreground group-focus-within/prompt:text-foreground"
							>
								you@ryu
							</span>
							<span
								aria-hidden="true"
								className="min-w-0 truncate whitespace-pre text-foreground"
							>
								{` ${cwd}`}
							</span>
							<span
								aria-hidden="true"
								className="shrink-0 whitespace-pre text-primary"
							>
								{" ❯ "}
							</span>
						</label>
						<input
							autoCapitalize="off"
							autoComplete="off"
							autoCorrect="off"
							className="block min-w-0 flex-1 bg-transparent p-0 text-foreground caret-primary outline-none placeholder:text-muted-foreground/70"
							enterKeyHint="send"
							id={inputId}
							onChange={(event) => {
								setInput(event.target.value);
								historyIndex.current = null;
							}}
							onKeyDown={onKeyDown}
							placeholder="help, ls, or @agent <message>"
							ref={inputRef}
							spellCheck={false}
							type="text"
							value={input}
						/>
					</form>
				</section>
				{threadOpen ? (
					<section
						aria-label={`Thread: ${threadTitle(activeThread)}`}
						className="flex @3xl/terminal:h-auto @md/terminal:h-1/2 h-2/3 min-h-0 @3xl/terminal:w-[min(58%,56rem)] shrink-0 flex-col border-border border-t @3xl/terminal:border-t-0 @3xl/terminal:border-l"
					>
						<header className="flex h-10 shrink-0 items-center gap-3 border-border border-b bg-background pr-2 pl-4">
							<h2 className="min-w-0 truncate font-medium">
								{threadTitle(activeThread)}
							</h2>
							{activeThread && activeStatus ? (
								<p className="shrink-0 whitespace-nowrap text-muted-foreground">
									<span className="@md/terminal:inline hidden">
										{threadOwnerLabel(snapshot, activeThread)} ·{" "}
									</span>
									<TerminalStatus status={activeStatus} />
								</p>
							) : null}
							<Tooltip>
								<TooltipTrigger
									render={
										<Button
											aria-label="Close thread"
											className="ml-auto shrink-0 text-muted-foreground hover:text-foreground"
											onClick={() => {
												closeThread(false);
												focusInput();
											}}
											size="icon-sm"
											variant="ghost"
										>
											<X aria-hidden="true" className="size-4" />
										</Button>
									}
								/>
								<TooltipContent side="bottom">
									Close thread{" "}
									<Kbd className="in-data-[slot=tooltip-content]:bg-background in-data-[slot=tooltip-content]:text-foreground dark:in-data-[slot=tooltip-content]:bg-background">
										Esc
									</Kbd>
								</TooltipContent>
							</Tooltip>
						</header>
						<div className="min-h-0 flex-1 overflow-hidden font-sans text-sm leading-normal">
							{threadView}
						</div>
					</section>
				) : null}
			</div>
			<footer
				aria-label="Terminal status"
				className={cn(
					"flex h-7 shrink-0 items-center gap-4 border-border border-t bg-muted/50 @3xl/terminal:pr-6 pr-4 text-muted-foreground text-xs"
				)}
			>
				<p className="flex h-full shrink-0 items-center gap-2 bg-primary px-3 font-medium text-primary-foreground">
					ryu
				</p>
				<p className="@md/terminal:flex hidden h-full shrink-0 items-center border-border border-r pr-4 text-foreground">
					{cwd}
				</p>
				{loading ? (
					<p>loading…</p>
				) : (
					<p className="flex min-w-0 items-center gap-2 whitespace-nowrap">
						<span
							aria-hidden="true"
							className={cn(
								"size-1.5 shrink-0 rounded-full",
								counts.working > 0
									? "bg-success motion-safe:animate-pulse"
									: "bg-muted-foreground/40"
							)}
						/>
						<span className="min-w-0 truncate">
							{counts.working} working · {counts.needsYou} need you
							{counts.attention > 0 ? (
								<>
									{" · "}
									<span className="text-destructive">
										{counts.attention} attention
									</span>
								</>
							) : null}
						</span>
					</p>
				)}
				<p className="ml-auto @3xl/terminal:flex hidden shrink-0 gap-4 whitespace-nowrap">
					{KEY_HINTS.filter((hint) => threadOpen || hint.keys !== "esc").map(
						(hint) => (
							<span key={hint.keys}>
								<span className="text-foreground">{hint.keys}</span>{" "}
								{hint.label}
							</span>
						)
					)}
				</p>
			</footer>
		</div>
	);
}
