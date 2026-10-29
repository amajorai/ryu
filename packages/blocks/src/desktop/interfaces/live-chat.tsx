import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import { ArrowRightToLine, X } from "lucide-react";
import { motion } from "motion/react";
import {
	type FormEvent,
	type ReactNode,
	type RefObject,
	useId,
	useState,
} from "react";

const MAX_PROMPT_LENGTH = 8000;

/**
 * The chat box under an empty chat room. Sending is the explicit user action
 * that lets the host start a thread with this prompt (`startThread`).
 */
function LiveChatInput({
	agent,
	onSend,
}: {
	agent: InterfaceAgent;
	onSend: (prompt: string) => void;
}) {
	const tl = useLiteralMessages();
	const fieldId = useId();
	const [prompt, setPrompt] = useState("");
	const trimmed = prompt.trim();
	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (!trimmed) {
			return;
		}
		onSend(trimmed);
		setPrompt("");
	};
	return (
		<form className="flex flex-col gap-2 p-3" onSubmit={submit}>
			<label className="sr-only" htmlFor={fieldId}>
				{tl("Message {name}", { name: agent.name })}
			</label>
			<Input
				autoComplete="off"
				className="h-10"
				id={fieldId}
				maxLength={MAX_PROMPT_LENGTH}
				onChange={(event) => setPrompt(event.target.value)}
				placeholder="Send a message"
				value={prompt}
			/>
			<div className="flex justify-end">
				<Button disabled={!trimmed} size="sm" type="submit">
					Chat
				</Button>
			</div>
		</form>
	);
}

/**
 * The right column, styled as the reference's chat: a STREAM CHAT header with
 * a collapse arrow, then the host's real conversation for the open thread.
 * With no thread open on a channel, it shows the empty chat room and a chat
 * box that starts the agent's first thread.
 */
export function LiveChat({
	agent,
	headingRef,
	onCollapse,
	onSend,
	overlay,
	reduceMotion,
	threadView,
	width,
}: {
	agent: InterfaceAgent | null;
	headingRef: RefObject<HTMLHeadingElement | null>;
	onCollapse: () => void;
	onSend: (prompt: string) => void;
	overlay: boolean;
	reduceMotion: boolean;
	threadView: ReactNode | null;
	width: number;
}) {
	const tl = useLiteralMessages();
	return (
		<motion.aside
			animate={{ opacity: 1, x: 0 }}
			aria-label="Stream chat"
			className={cn(
				"flex h-full min-h-0 flex-col border-border bg-background",
				overlay ? "absolute inset-0 z-30" : "relative shrink-0 border-l"
			)}
			data-testid="live-chat"
			initial={reduceMotion ? false : { opacity: 0, x: 16 }}
			style={overlay ? undefined : { width }}
			transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
		>
			<header className="relative flex h-12 shrink-0 items-center justify-center border-border border-b px-12">
				<Button
					aria-label={overlay ? "Close chat" : "Collapse chat"}
					className="absolute left-2 text-muted-foreground hover:text-foreground"
					onClick={onCollapse}
					size="icon-sm"
					type="button"
					variant="ghost"
				>
					{overlay ? (
						<X aria-hidden="true" className="size-4" />
					) : (
						<ArrowRightToLine aria-hidden="true" className="size-4" />
					)}
				</Button>
				<h2
					className="text-foreground text-xs uppercase tracking-wide outline-none"
					ref={headingRef}
					tabIndex={-1}
				>
					<span className="font-semibold">Stream chat</span>
				</h2>
			</header>
			{threadView ? (
				<div className="min-h-0 flex-1" data-live-chat-view="">
					{threadView}
				</div>
			) : (
				<>
					<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
						<p className="font-semibold text-foreground text-sm leading-5">
							Welcome to the chat room
						</p>
						<p className="text-muted-foreground text-sm leading-5">
							{agent
								? tl("Send {name} a message to start a stream.", {
										name: agent.name,
									})
								: "Open a stream to see its conversation."}
						</p>
					</div>
					{agent ? <LiveChatInput agent={agent} onSend={onSend} /> : null}
				</>
			)}
		</motion.aside>
	);
}
