import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Kbd } from "@ryu/ui/components/kbd.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
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

const MAX_PROMPT_LENGTH = 8000;

/**
 * The play slip that opens when a lever is pulled (or Spin, or New game):
 * a slip fed out over the floor in the user's theme, its tab naming the
 * machine. It sends only what the user typed and submitted (Enter or
 * Spin); the machine's reels spin as the conversation starts. The same
 * contract as the shared composer, with the slip's own submit row.
 */
export function ArcadeComposer({
	agents,
	machineName,
	onClose,
	onSubmit,
	reduced,
}: {
	/** Offered as a picker for a new game; a pulled lever already names its agent. */
	agents?: InterfaceAgent[];
	/** The machine whose lever was pulled, or undefined for a new game. */
	machineName: string | undefined;
	onClose: () => void;
	onSubmit: (input: { agentId?: string; prompt: string }) => void;
	reduced: boolean;
}) {
	const fieldId = useId();
	const tl = useLiteralMessages();
	const fieldRef = useRef<HTMLTextAreaElement>(null);
	const [prompt, setPrompt] = useState("");
	const [pickedAgentId, setPickedAgentId] = useState<string>();
	useEffect(() => {
		fieldRef.current?.focus();
	}, []);
	// Resolve the recipient every render, so the picker always shows who
	// the slip goes to, even when the offered agents change.
	const agentId =
		pickedAgentId && agents?.some((agent) => agent.id === pickedAgentId)
			? pickedAgentId
			: agents?.[0]?.id;
	const trimmed = prompt.trim();
	const heading = machineName
		? tl("Play {machineName}", { machineName })
		: "New game";

	const submit = () => {
		if (!trimmed) {
			return;
		}
		onSubmit({ agentId, prompt: trimmed });
		setPrompt("");
	};
	const onFormSubmit = (event: FormEvent) => {
		event.preventDefault();
		submit();
	};
	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (
			event.key === "Enter" &&
			!event.shiftKey &&
			!event.nativeEvent.isComposing
		) {
			event.preventDefault();
			submit();
		}
	};

	return (
		<motion.div
			animate={{ opacity: 1, y: 0 }}
			aria-label={heading}
			className="absolute inset-x-4 bottom-4 z-20 mx-auto flex max-w-[560px] flex-col drop-shadow-md"
			data-arcade-composer=""
			initial={reduced ? false : { opacity: 0, y: 16 }}
			role="dialog"
			transition={{ duration: reduced ? 0 : 0.18, ease: [0.22, 1, 0.36, 1] }}
		>
			<div className="relative z-10 -mb-px flex h-9 max-w-[calc(100%-48px)] items-center gap-1 self-start rounded-t-lg border border-border border-b-0 bg-card pr-1.5 pl-4">
				<h2 className="truncate font-heading font-medium text-foreground text-sm">
					{heading}
				</h2>
				<Button
					aria-label="Close"
					onClick={onClose}
					size="icon-xs"
					title="Close (Esc)"
					type="button"
					variant="ghost"
				>
					<X aria-hidden="true" />
				</Button>
			</div>
			<form
				className="flex flex-col gap-2 rounded-lg rounded-tl-none border border-border bg-card p-3"
				onSubmit={onFormSubmit}
			>
				<label className="sr-only" htmlFor={fieldId}>
					{machineName
						? tl("Message for {machineName}", { machineName })
						: "Message for a new conversation"}
				</label>
				<Textarea
					className="min-h-16 resize-none border-0 bg-transparent p-1 shadow-none focus-visible:ring-0"
					id={fieldId}
					maxLength={MAX_PROMPT_LENGTH}
					onChange={(event) => setPrompt(event.target.value)}
					onKeyDown={onKeyDown}
					placeholder={
						machineName
							? tl("Ask {machineName} to…", { machineName })
							: "Start a conversation…"
					}
					ref={fieldRef}
					value={prompt}
				/>
				<div className="flex items-center justify-end gap-2">
					{agents && agents.length > 1 ? (
						<NativeSelect
							aria-label="Agent"
							className="mr-auto w-44"
							onChange={(event) => setPickedAgentId(event.target.value)}
							size="sm"
							value={agentId}
						>
							{agents.map((agent) => (
								<NativeSelectOption key={agent.id} value={agent.id}>
									{agent.name}
								</NativeSelectOption>
							))}
						</NativeSelect>
					) : null}
					<Button
						className="disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100"
						disabled={!trimmed}
						size="sm"
						type="submit"
					>
						Spin
						<Kbd
							aria-hidden="true"
							className="h-5 min-w-5 bg-primary-foreground/15 in-disabled:bg-background/60 text-current"
						>
							⏎
						</Kbd>
					</Button>
				</div>
			</form>
		</motion.div>
	);
}
