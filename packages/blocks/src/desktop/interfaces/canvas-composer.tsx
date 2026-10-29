import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Kbd } from "@ryu/ui/components/kbd.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import { ArrowUp, ChevronDown, X } from "lucide-react";
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
import { CARD_HEIGHT, CARD_WIDTH, type CanvasPoint } from "./canvas-model.ts";
import { useReducedMotion } from "./reduced-motion.ts";

const MAX_PROMPT_LENGTH = 8000;
/** The select's value for "let the host choose". */
const ANY_AGENT = "";

/**
 * Who the thread is for: one compact control on the footer row reading "Any
 * agent" or the agent's name, instead of a row of chips. A native select, so
 * the list, typing to jump and the keyboard all behave as the platform does.
 */
function AgentPicker({
	agents,
	onPick,
	picked,
}: {
	agents: InterfaceAgent[];
	onPick: (id: string | undefined) => void;
	picked: InterfaceAgent | undefined;
}) {
	return (
		<span className="relative -ms-1.5 flex h-6 min-w-0 max-w-32 items-center rounded-md text-foreground/80 transition-colors duration-150 focus-within:ring-2 focus-within:ring-ring/40 hover:bg-muted hover:text-foreground">
			{picked ? (
				<BoardAvatar
					agent={picked}
					className="pointer-events-none absolute start-1.5"
					name={picked.name}
					size={20}
				/>
			) : null}
			<select
				aria-label="Agent"
				className={cn(
					"h-full min-w-0 cursor-default appearance-none truncate bg-transparent pe-5 font-medium text-xs outline-none",
					picked ? "ps-7" : "ps-1.5"
				)}
				data-testid="canvas-composer-agents"
				onChange={(event) =>
					onPick(
						event.target.value === ANY_AGENT ? undefined : event.target.value
					)
				}
				value={picked?.id ?? ANY_AGENT}
			>
				<option value={ANY_AGENT}>Any agent</option>
				{agents.map((agent) => (
					<option key={agent.id} value={agent.id}>
						{agent.name}
					</option>
				))}
			</select>
			<ChevronDown
				aria-hidden="true"
				className="pointer-events-none absolute end-1 size-3 opacity-70"
			/>
		</span>
	);
}

/**
 * The new sticky itself, as tldraw makes one: a sticky-sized note where you
 * double-clicked, already selected and in edit mode. Pick who it is for (or
 * let the host choose), type, press Enter. Submitting is the explicit action
 * that lets the host send immediately; closing never sends anything.
 *
 * It floats above the board in screen space at the sticky's footprint
 * (`left`/`top`, scaled by `zoom`); zoomed out below 100% it stays at 100%,
 * growing from the footprint's centre, so the note stays readable.
 */
export function CanvasComposer({
	agents,
	defaultAgentId,
	left,
	onClose,
	onSubmit,
	top,
	world,
	zoom,
}: {
	agents: InterfaceAgent[];
	defaultAgentId: string | undefined;
	left: number;
	onClose: () => void;
	onSubmit: (input: { agentId?: string; prompt: string }) => void;
	top: number;
	/** Where the sticky lands, in world units. */
	world: CanvasPoint;
	zoom: number;
}) {
	const tl = useLiteralMessages();
	const fieldId = useId();
	const titleId = useId();
	const reduceMotion = useReducedMotion();
	const fieldRef = useRef<HTMLTextAreaElement>(null);
	const [prompt, setPrompt] = useState("");
	const [pickedAgentId, setPickedAgentId] = useState(defaultAgentId);
	// Never send to an agent the snapshot no longer has.
	const agentId = agents.some((agent) => agent.id === pickedAgentId)
		? pickedAgentId
		: undefined;
	const picked = agents.find((agent) => agent.id === agentId);
	const trimmed = prompt.trim();
	const scale = Math.max(1, zoom);
	// Below 100% the note keeps its 100% size, centred on the footprint.
	const grow = (scale - zoom) / 2;

	useEffect(() => {
		fieldRef.current?.focus({ preventScroll: true });
	}, []);

	// Picking a recipient hands the cursor straight back to the note.
	const pick = (id: string | undefined) => {
		setPickedAgentId(id);
		fieldRef.current?.focus({ preventScroll: true });
	};

	const submit = () => {
		if (!trimmed) {
			return;
		}
		onSubmit({ agentId, prompt: trimmed });
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

	return (
		<div
			className="pointer-events-none absolute top-0 left-0 z-30 origin-top-left"
			style={{
				height: CARD_HEIGHT,
				transform: `translate3d(${left - grow * CARD_WIDTH}px, ${top - grow * CARD_HEIGHT}px, 0) scale(${scale})`,
				width: CARD_WIDTH,
			}}
		>
			<motion.div
				animate={{ opacity: 1, scale: 1 }}
				aria-labelledby={titleId}
				className="pointer-events-auto relative size-full rounded-md bg-card text-card-foreground shadow-foreground/10 shadow-md ring-1 ring-foreground/[0.07] dark:ring-foreground/10"
				data-testid="canvas-composer"
				data-world={`${world.x},${world.y}`}
				initial={reduceMotion ? false : { opacity: 0, scale: 0.96 }}
				onDoubleClick={(event) => event.stopPropagation()}
				onKeyDown={(event) => {
					// The agent menu is portalled: its own Escape only closes the menu.
					if (
						event.key === "Escape" &&
						event.currentTarget.contains(event.target as Node)
					) {
						event.preventDefault();
						event.stopPropagation();
						onClose();
					}
				}}
				onPointerDown={(event) => event.stopPropagation()}
				role="dialog"
				transition={{ duration: 0.14, ease: [0.2, 0, 0, 1] }}
			>
				{/* Selected and editing: the same 2px outline a selected sticky has. */}
				<span
					aria-hidden="true"
					className="pointer-events-none absolute -inset-1 rounded-[calc(var(--radius-md)+4px)] border-2 border-primary"
				/>
				<form className="flex size-full flex-col p-3" onSubmit={onFormSubmit}>
					<header className="flex h-4 items-center">
						<h2
							className="truncate text-foreground/65 text-xs leading-none"
							id={titleId}
						>
							<span className="font-medium">New thread</span>
						</h2>
						<Button
							aria-label="Close"
							className="absolute top-2 right-2 text-foreground/65 hover:text-foreground"
							onClick={onClose}
							size="icon-xs"
							type="button"
							variant="ghost"
						>
							<X aria-hidden="true" />
						</Button>
					</header>
					<label className="sr-only" htmlFor={fieldId}>
						Message for the new thread
					</label>
					<Textarea
						className="mt-2 min-h-0 flex-1 resize-none rounded-none border-0 bg-transparent p-0 font-medium text-[13px] text-foreground leading-[18px] shadow-none placeholder:font-normal placeholder:text-foreground/50 focus-visible:ring-0 md:text-[13px] dark:bg-transparent"
						id={fieldId}
						maxLength={MAX_PROMPT_LENGTH}
						onChange={(event) => setPrompt(event.target.value)}
						onKeyDown={onFieldKeyDown}
						placeholder={
							picked
								? tl("Ask {name} something…", { name: picked.name })
								: "What should happen next?"
						}
						ref={fieldRef}
						rows={4}
						value={prompt}
					/>
					<footer className="mt-2 flex h-6 items-center gap-2">
						{agents.length > 0 ? (
							<AgentPicker agents={agents} onPick={pick} picked={picked} />
						) : (
							<span className="text-foreground/65 text-xs">
								Ryu picks who answers
							</span>
						)}
						<Tooltip>
							<TooltipTrigger
								render={
									<Button
										className="ms-auto -me-1"
										disabled={!trimmed}
										size="xs"
										type="submit"
										variant={trimmed ? "default" : "ghost"}
									/>
								}
							>
								<ArrowUp aria-hidden="true" data-icon="inline-start" />
								Start thread
							</TooltipTrigger>
							<TooltipContent side="bottom">
								Start thread
								<Kbd>Enter</Kbd>
							</TooltipContent>
						</Tooltip>
					</footer>
				</form>
			</motion.div>
		</div>
	);
}
