import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Kbd, KbdGroup } from "@ryu/ui/components/kbd.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { Separator } from "@ryu/ui/components/separator.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import {
	type FormEvent,
	type KeyboardEvent,
	type Ref,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { FEED_META, FeedAvatar, YOU } from "./feed-parts.tsx";

/**
 * Longest prompt the composer accepts (the same cap every interface composer
 * uses); the ring fills toward it.
 */
export const FEED_PROMPT_LIMIT = 8000;
const WARN_REMAINING = 20;
/** Share of the limit at which the ring appears. */
const RING_THRESHOLD = 0.8;
/** The modifier the platform uses for "send": Command on Apple, Control elsewhere. */
const SUBMIT_MODIFIER =
	typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
		? "⌘"
		: "Ctrl";
/**
 * The tooltip here is a muted surface, not the inverted one Kbd assumes, so
 * its keys sit on the page background with full-strength text to stay legible
 * in low-contrast dark themes. (The typeface stays the app's code font, which
 * the desktop applies to every kbd.)
 */
const TOOLTIP_KBD =
	"border border-border bg-background text-foreground in-data-[slot=tooltip-content]:bg-background in-data-[slot=tooltip-content]:text-foreground dark:in-data-[slot=tooltip-content]:bg-background";
/** Smallest visible arc, so the first characters still register on the ring. */
const MIN_PROGRESS = 0.04;
const RING_RADIUS = 9;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** Circular character counter: fills as you type, counts down near the limit. */
function CharacterRing({ length }: { length: number }) {
	const tl = useLiteralMessages();
	// Agent prompts run long, so the ring only appears once the limit is near;
	// an almost-empty ring next to Post reads as a stalled spinner.
	if (length < FEED_PROMPT_LIMIT * RING_THRESHOLD) {
		return null;
	}
	const remaining = FEED_PROMPT_LIMIT - length;
	const warn = remaining <= WARN_REMAINING;
	const full = remaining <= 0;
	let stroke = "stroke-primary";
	if (full) {
		stroke = "stroke-destructive";
	} else if (warn) {
		stroke = "stroke-warning";
	}
	const progress = Math.min(
		1,
		Math.max(MIN_PROGRESS, length / FEED_PROMPT_LIMIT)
	);
	const size = warn ? 30 : 20;
	return (
		<span className="relative flex size-[30px] items-center justify-center">
			<svg
				aria-hidden="true"
				className="-rotate-90 transition-[width,height]"
				height={size}
				viewBox="0 0 22 22"
				width={size}
			>
				<circle
					className="stroke-border"
					cx="11"
					cy="11"
					fill="none"
					r={RING_RADIUS}
					strokeWidth="2"
				/>
				<circle
					className={stroke}
					cx="11"
					cy="11"
					fill="none"
					r={RING_RADIUS}
					strokeDasharray={RING_CIRCUMFERENCE}
					strokeDashoffset={RING_CIRCUMFERENCE * (1 - progress)}
					strokeLinecap="round"
					strokeWidth="2"
				/>
			</svg>
			{warn ? (
				<span
					aria-hidden="true"
					className={cn(
						"absolute text-[11px] tabular-nums",
						full ? "text-status-destructive" : FEED_META
					)}
				>
					{remaining}
				</span>
			) : null}
			<span className="sr-only" role="status">
				{warn ? tl("{remaining} characters remaining", { remaining }) : ""}
			</span>
		</span>
	);
}

/**
 * The timeline composer. Posting is the explicit user action that lets the
 * host start (and immediately send) a new thread with the typed prompt.
 */
export function FeedComposer({
	agents,
	onPost,
	textareaRef,
}: {
	agents: InterfaceAgent[];
	onPost: (input: { agentId?: string; prompt: string }) => void;
	textareaRef: Ref<HTMLTextAreaElement>;
}) {
	const fieldId = useId();
	const hintId = useId();
	const [prompt, setPrompt] = useState("");
	const [pickedAgentId, setPickedAgentId] = useState<string>();
	const growRef = useRef<HTMLTextAreaElement | null>(null);
	// Resolve the recipient every render so a pick the snapshot no longer
	// offers can never send to a hidden agent: what the chip shows is sent.
	const agentId =
		pickedAgentId && agents.some((agent) => agent.id === pickedAgentId)
			? pickedAgentId
			: agents[0]?.id;
	const trimmed = prompt.trim();

	// Grow with the text, like the timeline composer it mirrors.
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-measure whenever the text changes.
	useLayoutEffect(() => {
		const field = growRef.current;
		if (!field) {
			return;
		}
		field.style.height = "auto";
		field.style.height = `${Math.min(field.scrollHeight, 360)}px`;
	}, [prompt]);

	const submit = () => {
		if (!trimmed) {
			return;
		}
		onPost({ agentId, prompt: trimmed });
		setPrompt("");
	};
	const onSubmit = (event: FormEvent) => {
		event.preventDefault();
		submit();
	};
	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (
			event.key === "Enter" &&
			(event.metaKey || event.ctrlKey) &&
			!event.nativeEvent.isComposing
		) {
			event.preventDefault();
			submit();
		}
	};
	const setRefs = (node: HTMLTextAreaElement | null) => {
		growRef.current = node;
		if (typeof textareaRef === "function") {
			textareaRef(node);
		} else if (textareaRef) {
			textareaRef.current = node;
		}
	};

	return (
		<form
			className="flex gap-3 border-border border-b px-4 pt-1 pb-2"
			onSubmit={onSubmit}
		>
			<span className="pt-3">
				<FeedAvatar author={YOU} />
			</span>
			<div className="flex min-w-0 flex-1 flex-col">
				<label className="sr-only" htmlFor={fieldId}>
					New post
				</label>
				<textarea
					aria-describedby={hintId}
					aria-keyshortcuts="Control+Enter Meta+Enter"
					className="block min-h-[52px] w-full resize-none overflow-y-auto bg-transparent py-3 text-foreground text-xl leading-7 outline-none placeholder:text-muted-foreground"
					id={fieldId}
					maxLength={FEED_PROMPT_LIMIT}
					onChange={(event) => setPrompt(event.target.value)}
					onKeyDown={onKeyDown}
					placeholder="What should your agents do?"
					ref={setRefs}
					rows={1}
					value={prompt}
				/>
				<span className="sr-only" id={hintId}>
					Press Control or Command and Enter to post.
				</span>
				<Separator className="mt-1 bg-border/60" />
				<div className="flex items-center justify-between gap-3 pt-3">
					{agents.length > 0 ? (
						<Select
							items={agents.map((agent) => ({
								label: agent.name,
								value: agent.id,
							}))}
							onValueChange={(value) => setPickedAgentId(value)}
							value={agentId ?? null}
						>
							<SelectTrigger
								aria-label="Send to agent"
								className="-ml-3 h-8 min-w-0 max-w-[60%] gap-1 rounded-full border-transparent bg-transparent px-3 py-0 font-semibold text-[14px] text-primary shadow-none hover:bg-primary/10 aria-expanded:bg-primary/10 dark:bg-transparent dark:hover:bg-primary/10 [&_svg]:text-primary"
							>
								<span className="shrink-0">To</span>
								<SelectValue />
							</SelectTrigger>
							<SelectContent align="start" alignItemWithTrigger={false}>
								{agents.map((agent) => (
									<SelectItem key={agent.id} value={agent.id}>
										{agent.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					) : (
						<span />
					)}
					<div className="flex items-center">
						{prompt.length >= FEED_PROMPT_LIMIT * RING_THRESHOLD ? (
							<>
								<CharacterRing length={prompt.length} />
								<Separator className="mx-3 h-[31px]" orientation="vertical" />
							</>
						) : null}
						{/* The send shortcut lives in the Post button's tooltip. */}
						<Tooltip>
							<TooltipTrigger
								render={
									<Button
										className="h-9 rounded-full px-4 font-semibold disabled:opacity-50"
										disabled={!trimmed}
										type="submit"
									/>
								}
							>
								{/*
								 * An element, not bare text: Button wraps bare text in its
								 * own overflow tooltip, which would swallow this one.
								 */}
								<span>Post</span>
							</TooltipTrigger>
							<TooltipContent className="flex items-center gap-2">
								Post
								<KbdGroup>
									<Kbd className={TOOLTIP_KBD}>{SUBMIT_MODIFIER}</Kbd>
									<Kbd className={TOOLTIP_KBD}>Enter</Kbd>
								</KbdGroup>
							</TooltipContent>
						</Tooltip>
					</div>
				</div>
			</div>
		</form>
	);
}
