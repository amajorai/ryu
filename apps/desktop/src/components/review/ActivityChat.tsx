// apps/desktop/src/components/review/ActivityChat.tsx
//
// Chat-over-your-activity: a thin conversational surface onto Shadow's local
// agent (POST /agent). The agent's tools search the on-device timeline, OCR, and
// transcripts, so answers are grounded in what the user actually did — nothing
// leaves the machine. Streaming is handled by `streamActivityChat`.

import { Button } from "@ryu/ui/components/button";
import { Spinner } from "@ryu/ui/components/spinner";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	type ActivityChatMessage,
	streamActivityChat,
} from "@/src/lib/api/shadow.ts";

const SUGGESTIONS = [
	"What did I spend the most time on today?",
	"When was I most distracted?",
	"Summarize what I worked on this morning.",
];

export function ActivityChat(props: { className?: string }) {
	const { className } = props;
	const [messages, setMessages] = useState<ActivityChatMessage[]>([]);
	const [input, setInput] = useState("");
	const [draft, setDraft] = useState("");
	const [busy, setBusy] = useState(false);
	const [toolHint, setToolHint] = useState<string | null>(null);
	const abortRef = useRef<AbortController | null>(null);
	const scrollRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
	}, []);

	// Abort any in-flight stream when the pane unmounts.
	useEffect(() => () => abortRef.current?.abort(), []);

	const send = useCallback(
		async (text: string) => {
			const trimmed = text.trim();
			if (!trimmed || busy) {
				return;
			}
			const history = [...messages];
			const nextMessages: ActivityChatMessage[] = [
				...history,
				{ role: "user", content: trimmed },
			];
			setMessages(nextMessages);
			setInput("");
			setDraft("");
			setToolHint(null);
			setBusy(true);

			const controller = new AbortController();
			abortRef.current = controller;
			let accumulated = "";
			let final: string | null = null;
			let errored: string | null = null;

			await streamActivityChat(
				trimmed,
				history,
				(event) => {
					const type = event.type as string | undefined;
					if (type === "text_delta" && typeof event.text === "string") {
						accumulated += event.text;
						setDraft(accumulated);
					} else if (
						type === "final_answer" &&
						typeof event.text === "string"
					) {
						final = event.text;
						setDraft(event.text);
					} else if (type === "tool_call" && typeof event.name === "string") {
						setToolHint(`Searching your activity (${event.name})…`);
					} else if (type === "error" && typeof event.message === "string") {
						errored = event.message;
					}
				},
				controller.signal
			);

			const answer = final ?? accumulated;
			setBusy(false);
			setToolHint(null);
			setDraft("");
			if (errored) {
				setMessages([
					...nextMessages,
					{ role: "assistant", content: `⚠️ ${errored}` },
				]);
				return;
			}
			if (answer.trim()) {
				setMessages([...nextMessages, { role: "assistant", content: answer }]);
			}
		},
		[busy, messages]
	);

	return (
		<div className={`flex min-h-0 flex-col ${className ?? ""}`}>
			<div className="border-b px-4 py-2 font-semibold text-sm">
				Ask about your activity
			</div>
			<div
				className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4"
				ref={scrollRef}
			>
				{messages.length === 0 && !busy && (
					<div className="space-y-2">
						<p className="text-muted-foreground text-sm">
							Ask anything about what you worked on. Answers come from your
							on-device timeline — nothing leaves this machine.
						</p>
						<div className="flex flex-col gap-1.5">
							{SUGGESTIONS.map((s) => (
								<button
									className="rounded-md border bg-muted/30 px-3 py-2 text-left text-xs transition-colors hover:bg-muted"
									key={s}
									onClick={() => send(s)}
									type="button"
								>
									{s}
								</button>
							))}
						</div>
					</div>
				)}
				{messages.map((m, i) => (
					<div
						className={
							m.role === "user" ? "flex justify-end" : "flex justify-start"
						}
						key={`${m.role}-${i}-${m.content.slice(0, 16)}`}
					>
						<div
							className={`max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
								m.role === "user"
									? "bg-primary text-primary-foreground"
									: "bg-muted"
							}`}
						>
							{m.content}
						</div>
					</div>
				))}
				{busy && (
					<div className="flex justify-start">
						<div className="max-w-[85%] rounded-lg bg-muted px-3 py-2 text-sm">
							{draft ? (
								<span className="whitespace-pre-wrap">{draft}</span>
							) : (
								<span className="flex items-center gap-2 text-muted-foreground">
									<Spinner className="size-3" />
									{toolHint ?? "Thinking…"}
								</span>
							)}
						</div>
					</div>
				)}
			</div>
			<form
				className="flex items-center gap-2 border-t p-3"
				onSubmit={(e) => {
					e.preventDefault();
					send(input);
				}}
			>
				<input
					className="min-w-0 flex-1 rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
					disabled={busy}
					onChange={(e) => setInput(e.target.value)}
					placeholder="Ask about your day…"
					value={input}
				/>
				<Button disabled={busy || !input.trim()} size="sm" type="submit">
					Ask
				</Button>
			</form>
		</div>
	);
}
