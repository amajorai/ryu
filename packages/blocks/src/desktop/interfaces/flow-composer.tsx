import { cn } from "@ryu/ui/lib/utils";
import { ArrowUp, MessageSquarePlus } from "lucide-react";
import {
	type FormEvent,
	type KeyboardEvent,
	useEffect,
	useRef,
	useState,
} from "react";
import type { FlowTarget } from "./flow-model.ts";

/**
 * The pending node a new conversation starts from: a dashed node with one line
 * of input. Enter sends (the prompt goes out immediately through the port),
 * Escape drops the node.
 */
export function FlowComposerNode({
	id,
	onCancel,
	onFocusNode,
	onSubmit,
	target,
}: {
	id: string;
	onCancel: () => void;
	onFocusNode: (id: string) => void;
	onSubmit: (prompt: string) => void;
	target: FlowTarget;
}) {
	const [draft, setDraft] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);
	useEffect(() => {
		inputRef.current?.focus({ preventScroll: true });
	}, []);
	const prompt = draft.trim();
	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (prompt) {
			onSubmit(prompt);
		}
	};
	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			onCancel();
		}
	};
	return (
		<form
			aria-label={target.label}
			className="flex size-full items-center gap-2 rounded-lg border border-primary/60 border-dashed bg-card ps-3 pe-1.5 shadow-xs ring-[3px] ring-primary/10 focus-within:border-primary focus-within:border-solid"
			data-flow-node={id}
			onSubmit={submit}
		>
			<MessageSquarePlus
				aria-hidden="true"
				className="size-3.5 shrink-0 stroke-[1.75] text-primary"
			/>
			<input
				aria-label={target.label}
				className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
				onChange={(event) => setDraft(event.target.value)}
				onFocus={() => onFocusNode(id)}
				onKeyDown={onKeyDown}
				placeholder={`${target.label}…`}
				ref={inputRef}
				value={draft}
			/>
			<button
				aria-label="Send"
				className={cn(
					"flex size-7 shrink-0 items-center justify-center rounded-md outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/40",
					prompt
						? "bg-primary text-primary-foreground hover:bg-primary/85"
						: "bg-muted text-muted-foreground"
				)}
				disabled={!prompt}
				type="submit"
			>
				<ArrowUp aria-hidden="true" className="size-3.5 stroke-[2.25]" />
			</button>
		</form>
	);
}
