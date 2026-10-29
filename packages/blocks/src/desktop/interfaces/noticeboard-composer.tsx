import { Button } from "@ryu/ui/components/button.tsx";
import { Kbd } from "@ryu/ui/components/kbd.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import { X } from "lucide-react";
import { motion } from "motion/react";
import {
	type FormEvent,
	type KeyboardEvent,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { BoardAvatar } from "./board-avatar.tsx";
import { useReducedMotion } from "./reduced-motion.ts";

const MAX_PROMPT_LENGTH = 8000;

/** One recipient: avatar and name. */
function Recipient({
	agent,
	onPick,
	picked,
}: {
	agent: InterfaceAgent;
	onPick: () => void;
	picked: boolean;
}) {
	return (
		<button
			aria-pressed={picked}
			className={cn(
				"flex h-7 max-w-36 items-center gap-1.5 rounded-full border ps-1 pe-2.5 font-medium text-xs outline-none transition-colors duration-150",
				"focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card",
				picked
					? "border-primary bg-primary/10 text-foreground"
					: "border-border text-foreground/80 hover:bg-muted hover:text-foreground"
			)}
			onClick={onPick}
			title={agent.description || undefined}
			type="button"
		>
			<BoardAvatar agent={agent} name={agent.name} size={20} />
			<span className="truncate">{agent.name}</span>
		</button>
	);
}

/**
 * "Pin a note": a blank card that drops under the header button. What the
 * user writes here is the prompt; pinning it is the explicit action that
 * lets the host start the thread and send it right away.
 */
export function NoticeboardComposer({
	agents,
	onClose,
	onSubmit,
}: {
	agents: InterfaceAgent[];
	onClose: (restoreFocus: boolean) => void;
	onSubmit: (input: { agentId?: string; prompt: string }) => void;
}) {
	const fieldId = useId();
	const headingId = useId();
	const reduceMotion = useReducedMotion();
	const rootRef = useRef<HTMLFormElement>(null);
	const fieldRef = useRef<HTMLTextAreaElement>(null);
	const [prompt, setPrompt] = useState("");
	const [pickedId, setPickedId] = useState<string>();
	// A pick the snapshot no longer offers falls back to the first agent, so
	// the highlighted recipient is always the one that receives the note.
	const agentId =
		pickedId && agents.some((agent) => agent.id === pickedId)
			? pickedId
			: agents[0]?.id;
	const trimmed = prompt.trim();

	useEffect(() => {
		fieldRef.current?.focus();
	}, []);

	// Clicking anywhere else on the board puts the blank card away.
	useEffect(() => {
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target;
			if (
				target instanceof Node &&
				!rootRef.current?.contains(target) &&
				!(
					target instanceof Element &&
					target.closest("[data-noticeboard-composer-trigger]")
				)
			) {
				onClose(false);
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		return () => document.removeEventListener("pointerdown", onPointerDown);
	}, [onClose]);

	const submit = () => {
		if (!trimmed) {
			return;
		}
		onSubmit(agentId ? { agentId, prompt: trimmed } : { prompt: trimmed });
		setPrompt("");
	};
	const onFormSubmit = (event: FormEvent) => {
		event.preventDefault();
		submit();
	};
	const onFieldKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (
			event.key === "Enter" &&
			!event.shiftKey &&
			!event.nativeEvent.isComposing
		) {
			event.preventDefault();
			submit();
		}
	};
	const onFormKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			onClose(true);
		}
	};

	return (
		<motion.form
			animate={{ opacity: 1, y: 0 }}
			aria-labelledby={headingId}
			className="flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col rounded-lg border border-border bg-card text-card-foreground shadow-foreground/10 shadow-lg"
			data-testid="noticeboard-composer"
			initial={reduceMotion ? false : { opacity: 0, y: -4 }}
			onKeyDown={onFormKeyDown}
			onSubmit={onFormSubmit}
			ref={rootRef}
			transition={{ duration: 0.14, ease: [0.2, 0, 0, 1] }}
		>
			<div className="flex items-center justify-between gap-2 ps-4 pe-2 pt-2">
				<h2 className="font-semibold text-sm" id={headingId}>
					Pin a note
				</h2>
				<Button
					aria-label="Close"
					onClick={() => onClose(true)}
					size="icon-sm"
					type="button"
					variant="ghost-muted"
				>
					<X aria-hidden="true" />
				</Button>
			</div>
			<label className="sr-only" htmlFor={fieldId}>
				Note
			</label>
			<textarea
				className="min-h-24 resize-none bg-transparent px-4 pt-1 pb-3 text-sm leading-5 outline-none placeholder:text-muted-foreground"
				id={fieldId}
				maxLength={MAX_PROMPT_LENGTH}
				onChange={(event) => setPrompt(event.target.value)}
				onKeyDown={onFieldKeyDown}
				placeholder="What should an agent pick up?"
				ref={fieldRef}
				value={prompt}
			/>
			{agents.length > 1 ? (
				<fieldset className="flex flex-col gap-2 border-border border-t px-4 py-3">
					<legend className="float-left mb-2 text-muted-foreground text-xs">
						For
					</legend>
					<div className="clear-both flex flex-wrap gap-1.5">
						{agents.map((agent) => (
							<Recipient
								agent={agent}
								key={agent.id}
								onPick={() => setPickedId(agent.id)}
								picked={agent.id === agentId}
							/>
						))}
					</div>
				</fieldset>
			) : null}
			<div className="flex items-center justify-between gap-3 border-border border-t px-4 py-3">
				<span className="flex items-center gap-1.5 text-muted-foreground text-xs">
					<Kbd>Enter</Kbd>
					to pin
				</span>
				<Button disabled={!trimmed} size="sm" type="submit">
					Pin note
				</Button>
			</div>
		</motion.form>
	);
}
