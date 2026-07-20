// Embedded mini-chat shared by the command bar (and available to any embedder).
//
// Transport-agnostic: it owns message state and the streaming reducer (generalized
// from apps/island's use-island-chat) but delegates the actual network to an
// injected `ChatStreamFn`. The desktop wires AI SDK; the command bar wires its
// `window.command.core.chatStream` IPC; raycast wires its own fetch.

import { ArrowUp01Icon, StopIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@ryu/ui/lib/utils";
import {
	type KeyboardEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import type { ChatMessage, ChatStreamFn, ChatStreamHandle } from "./types.ts";

export interface ChatViewProps {
	/** Focus the composer on mount. */
	autoFocus?: boolean;
	className?: string;
	/** Shown above the (empty) message list before the first turn. */
	greeting?: React.ReactNode;
	/**
	 * Optional pre-populated history rendered on mount (e.g. resuming an existing
	 * conversation). The view stays append-only from there. Defaults to empty.
	 */
	initialMessages?: ChatMessage[];
	/** Optional seed prompt sent once on mount (e.g. typed into the palette). */
	initialPrompt?: string;
	/** Called when the user backs out (Escape on an empty composer). */
	onExit?: () => void;
	/** Placeholder for the composer. */
	placeholder?: string;
	/** Injected streaming transport. Required — the view owns no network. */
	stream: ChatStreamFn;
}

let idCounter = 0;
/** Monotonic id (no Date.now/Math.random — keeps the package SSR/seed-safe). */
function nextId(prefix: string): string {
	idCounter += 1;
	return `${prefix}-${idCounter}`;
}

/**
 * The shared mini-chat surface. Append-only message list + a composer; assistant
 * turns stream in via the injected transport with abort support.
 */
export function ChatView({
	stream,
	initialMessages,
	initialPrompt,
	placeholder,
	greeting,
	onExit,
	autoFocus = true,
	className,
}: ChatViewProps) {
	const [messages, setMessages] = useState<ChatMessage[]>(
		initialMessages ?? []
	);
	const [input, setInput] = useState("");
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const handleRef = useRef<ChatStreamHandle | null>(null);
	const listRef = useRef<HTMLDivElement | null>(null);
	const seededRef = useRef(false);

	const send = useCallback(
		(text: string) => {
			const trimmed = text.trim();
			if (trimmed.length === 0 || handleRef.current) {
				return;
			}
			setError(null);
			setInput("");
			const userMessage: ChatMessage = {
				id: nextId("user"),
				role: "user",
				content: trimmed,
			};
			const assistantId = nextId("assistant");
			const assistantMessage: ChatMessage = {
				id: assistantId,
				role: "assistant",
				content: "",
				streaming: true,
			};
			const history = [...messages, userMessage];
			setMessages([...history, assistantMessage]);
			setSending(true);

			const finish = (): void => {
				handleRef.current = null;
				setSending(false);
				setMessages((prev) =>
					prev.map((msg) =>
						msg.id === assistantId ? { ...msg, streaming: false } : msg
					)
				);
			};

			handleRef.current = stream(history, {
				onDelta: (delta) =>
					setMessages((prev) =>
						prev.map((msg) =>
							msg.id === assistantId
								? { ...msg, content: msg.content + delta }
								: msg
						)
					),
				onDone: finish,
				onError: (message) => {
					setError(message);
					finish();
				},
			});
		},
		[messages, stream]
	);

	const stop = useCallback(() => {
		handleRef.current?.abort();
	}, []);

	// Seed a one-shot prompt (the text the user typed into the palette) once.
	useEffect(() => {
		if (initialPrompt && !seededRef.current) {
			seededRef.current = true;
			send(initialPrompt);
		}
	}, [initialPrompt, send]);

	// Abort any in-flight stream if the view unmounts mid-turn.
	useEffect(() => () => handleRef.current?.abort(), []);

	// Keep the latest turn in view as it streams.
	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll on message growth
	useEffect(() => {
		const el = listRef.current;
		if (el) {
			el.scrollTop = el.scrollHeight;
		}
	}, [messages]);

	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			send(input);
			return;
		}
		if (event.key === "Escape" && input.length === 0) {
			onExit?.();
		}
	};

	return (
		<div className={cn("flex min-h-0 flex-col", className)}>
			<div
				className="no-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto p-3"
				ref={listRef}
			>
				{messages.length === 0 && greeting ? (
					<div className="px-1 py-6 text-center text-muted-foreground text-sm">
						{greeting}
					</div>
				) : null}
				{messages.map((msg) => (
					<div
						className={cn(
							"flex",
							msg.role === "user" ? "justify-end" : "justify-start"
						)}
						key={msg.id}
					>
						<div
							className={cn(
								"max-w-[85%] whitespace-pre-wrap rounded-3xl px-4 py-2 text-sm",
								msg.role === "user"
									? "bg-primary text-primary-foreground"
									: "bg-muted text-foreground"
							)}
						>
							{msg.content}
							{msg.streaming && msg.content.length === 0 ? (
								<span className="opacity-50">…</span>
							) : null}
						</div>
					</div>
				))}
				{error ? (
					<div className="rounded-2xl bg-destructive/10 px-4 py-2 text-destructive text-sm">
						{error}
					</div>
				) : null}
			</div>

			<div className="flex items-end gap-2 border-border/50 border-t p-2">
				<textarea
					autoFocus={autoFocus}
					className="max-h-32 min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground"
					onChange={(event) => setInput(event.target.value)}
					onKeyDown={onKeyDown}
					placeholder={placeholder ?? "Ask Ryu anything..."}
					rows={1}
					value={input}
				/>
				<button
					aria-label={sending ? "Stop" : "Send"}
					className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:opacity-40"
					disabled={!sending && input.trim().length === 0}
					onClick={() => (sending ? stop() : send(input))}
					type="button"
				>
					<HugeiconsIcon
						className="size-4"
						icon={sending ? StopIcon : ArrowUp01Icon}
					/>
				</button>
			</div>
		</div>
	);
}
