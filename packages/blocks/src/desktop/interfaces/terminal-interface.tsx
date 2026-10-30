import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceParamsByRenderer,
	parseTerminalCommand,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
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
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import {
	explainUnknown,
	startThread as startThreadCommand,
} from "./terminal-interface-commands.ts";
import {
	error,
	line,
	MAX_ENTRIES,
	MAX_HISTORY,
	MAX_NOTICES,
	muted,
	type NewEntry,
	notice,
} from "./terminal-interface-entries.ts";
import { TerminalFooter } from "./terminal-interface-footer.tsx";
import { TerminalPrompt } from "./terminal-interface-prompt.tsx";
import { TerminalScrollback } from "./terminal-interface-scrollback.tsx";
import { TerminalThreadPane } from "./terminal-interface-thread-pane.tsx";
import { TerminalTitleBar } from "./terminal-interface-title-bar.tsx";
import {
	completeInput,
	listAgents,
	listThreads,
	promptPath,
	resolveOpenTarget,
	statusChanges,
	statusMap,
	TERMINAL_STATUS_GLYPHS,
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
	type TerminalEntry,
} from "./terminal-output.tsx";

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

	const tl = useLiteralMessages();
	/** Read inside the live-notice effect without re-running it per render. */
	const tlRef = useRef(tl);
	tlRef.current = tl;
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
						label: tlRef.current("Open thread: {title}", {
							title: threadTitle(thread),
						}),
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

	const startThread = (handle: string | null, prompt: string) =>
		startThreadCommand({ port, push, snapshot, tl }, handle, prompt);

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
				explainUnknown(push, command.input);
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
			className="@container/terminal flex size-full min-h-0 flex-col overflow-hidden bg-background font-mono @3xl/terminal:text-sm text-detail text-foreground @3xl/terminal:leading-6 leading-5"
			data-testid="interface-terminal"
		>
			<TerminalTitleBar
				activeThread={activeThread}
				loading={loading}
				threadOpen={threadOpen}
			/>
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
					<TerminalScrollback
						agentRows={agentRows}
						blocks={blocks}
						counts={counts}
						gutter={gutter}
						loading={loading}
						needsYou={needsYou}
						now={now}
						runAction={runAction}
						scrollRef={scrollRef}
					/>
					<TerminalPrompt
						cwd={cwd}
						gutter={gutter}
						historyIndex={historyIndex}
						input={input}
						inputId={inputId}
						inputRef={inputRef}
						onKeyDown={onKeyDown}
						onSubmit={onSubmit}
						setInput={setInput}
					/>
				</section>
				{threadOpen ? (
					<TerminalThreadPane
						activeStatus={activeStatus}
						activeThread={activeThread}
						closeThread={closeThread}
						focusInput={focusInput}
						snapshot={snapshot}
						threadView={threadView}
					/>
				) : null}
			</div>
			<TerminalFooter
				counts={counts}
				cwd={cwd}
				loading={loading}
				threadOpen={threadOpen}
			/>
		</div>
	);
}
