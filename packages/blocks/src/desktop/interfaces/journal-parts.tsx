import { Button } from "@ryu/ui/components/button.tsx";
import { Kbd, KbdGroup } from "@ryu/ui/components/kbd.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceAgent,
	THREAD_STATUS_LABELS,
	type ThreadStatus,
} from "@ryuhq/protocol/interfaces";
import { X } from "lucide-react";
import {
	type FormEvent,
	type KeyboardEvent,
	type ReactNode,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { BoardAvatar } from "./board-avatar.tsx";
import { agentNames } from "./journal-model.ts";

/** Title face: Day One's serif option, or the app's heading face. */
export function titleFace(serif: boolean): string {
	return serif ? "font-serif tracking-normal" : "font-heading tracking-tight";
}

const STATUS_DOT: Record<ThreadStatus, string> = {
	attention: "bg-destructive",
	quiet: "border border-muted-foreground/70 border-dashed",
	waiting: "border-[1.5px] border-muted-foreground/70",
	working: "border-2 border-success",
	// Foreground, never primary: in green themes primary sits next to success.
	"your-turn": "bg-foreground",
};

/**
 * Status by shape first, color second: a solid dot asks for something (red
 * when a run failed, ink when it is your turn), a success ring is a live run
 * (pulsing inside its own box only where `live` is set), and muted outlines
 * are waiting or not started.
 */
export function JournalStatusDot({
	className,
	live = false,
	status,
}: {
	className?: string;
	/** Pulse a working dot; reserved for the open entry's header. */
	live?: boolean;
	status: ThreadStatus;
}) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"relative inline-block size-2 shrink-0 rounded-full",
				STATUS_DOT[status],
				className
			)}
		>
			{live && status === "working" ? (
				<span className="absolute inset-px rounded-full bg-success/70 motion-safe:animate-pulse" />
			) : null}
		</span>
	);
}

/** The thread's status as a dot, named for screen readers. */
export function JournalStatusMark({
	className,
	status,
}: {
	className?: string;
	status: ThreadStatus;
}) {
	return (
		<span
			className={cn("inline-flex items-center", className)}
			title={THREAD_STATUS_LABELS[status]}
		>
			<JournalStatusDot status={status} />
			<span className="sr-only">{THREAD_STATUS_LABELS[status]}</span>
		</span>
	);
}

/** Dot plus words, for the places where there is room to say it. */
export function JournalStatusText({
	live = false,
	status,
}: {
	live?: boolean;
	status: ThreadStatus;
}) {
	return (
		<span
			className={cn(
				"inline-flex items-center gap-1.5",
				status === "attention" && "text-destructive",
				status === "your-turn" && "text-foreground"
			)}
		>
			<JournalStatusDot live={live} status={status} />
			{THREAD_STATUS_LABELS[status]}
		</span>
	);
}

/** Kbd chips readable on the tooltip's muted surface in both themes. */
const TOOLTIP_KBD =
	"in-data-[slot=tooltip-content]:bg-background in-data-[slot=tooltip-content]:text-foreground dark:in-data-[slot=tooltip-content]:bg-background";

/** An icon button whose name, and shortcut if any, show in a tooltip. */
export function JournalIconButton({
	children,
	disabled,
	hint,
	keys,
	label,
	onClick,
	shortcut,
}: {
	children: ReactNode;
	disabled?: boolean;
	/** Tooltip text when it should say more than the accessible name. */
	hint?: ReactNode;
	/** Shortcut chips shown in the tooltip. */
	keys?: string[];
	label: string;
	onClick: () => void;
	/** aria-keyshortcuts value. */
	shortcut?: string;
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button
						aria-keyshortcuts={shortcut}
						aria-label={label}
						disabled={disabled}
						onClick={onClick}
						size="icon-sm"
						type="button"
						variant="ghost"
					/>
				}
			>
				{children}
			</TooltipTrigger>
			<TooltipContent side="bottom">
				<span className="max-w-60 truncate">{hint ?? label}</span>
				{keys && keys.length > 0 ? (
					<KbdGroup>
						{keys.map((key) => (
							<Kbd className={TOOLTIP_KBD} key={key}>
								{key}
							</Kbd>
						))}
					</KbdGroup>
				) : null}
			</TooltipContent>
		</Tooltip>
	);
}

const STACK_LIMIT = 3;

/** Overlapping faces for an entry's agents, cut out of the page color. */
export function JournalFaces({
	agents,
	ring = "ring-background",
}: {
	agents: InterfaceAgent[];
	ring?: string;
}) {
	if (agents.length === 0) {
		return null;
	}
	return (
		<span aria-hidden="true" className="flex shrink-0 -space-x-1.5">
			{agents.slice(0, STACK_LIMIT).map((agent) => (
				<BoardAvatar
					agent={agent}
					className={cn("ring-2", ring)}
					key={agent.id}
					name={agent.name}
					size={20}
				/>
			))}
		</span>
	);
}

export interface JournalMetaItem {
	key: string;
	node: ReactNode;
	/** The one segment allowed to shrink and truncate; the rest keep their width. */
	shrink?: boolean;
}

/**
 * The line Day One gives to place and weather: faces, then equal-weight
 * segments split by the same separator. It never wraps, so a separator can
 * never start a line; the shrinking segment truncates instead.
 */
export function JournalMetaLine({
	agents,
	className,
	items,
}: {
	agents: InterfaceAgent[];
	className?: string;
	items: JournalMetaItem[];
}) {
	return (
		<div
			className={cn(
				"flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap text-muted-foreground",
				className
			)}
		>
			<JournalFaces agents={agents} />
			{items.map((item, index) => (
				<span
					className={cn(
						"flex items-center gap-2",
						item.shrink ? "min-w-0 shrink" : "shrink-0"
					)}
					key={item.key}
				>
					{index > 0 ? (
						<span aria-hidden="true" className="shrink-0">
							·
						</span>
					) : null}
					<span className={cn(item.shrink && "truncate")}>{item.node}</span>
				</span>
			))}
		</div>
	);
}

/** Agent names and project as separate meta segments. */
export function entryPlaceItems(
	agents: InterfaceAgent[],
	place: string | null
): JournalMetaItem[] {
	const items: JournalMetaItem[] = [];
	if (agents.length > 0) {
		items.push({ key: "agents", node: agentNames(agents), shrink: true });
	}
	if (place) {
		items.push({ key: "place", node: place, shrink: true });
	}
	return items;
}

/** Quiet, centered empty state with one optional action. */
export function JournalEmpty({
	action,
	className,
	description,
	title,
}: {
	action?: ReactNode;
	className?: string;
	description: string;
	title: string;
}) {
	return (
		<div
			className={cn(
				"flex flex-col items-center gap-1 px-6 py-12 text-center",
				className
			)}
		>
			<p className="font-medium text-foreground text-sm">{title}</p>
			<p className="max-w-xs text-balance text-muted-foreground text-sm">
				{description}
			</p>
			{action ? <div className="mt-4">{action}</div> : null}
		</div>
	);
}

const MAX_PROMPT_LENGTH = 8000;

/**
 * A blank entry: pick the agent, write, start. Submitting is the explicit
 * user action that lets the host send the text right away.
 */
export function JournalComposer({
	agents,
	dateLine,
	defaultAgentId,
	onCancel,
	onSubmit,
	titleClass,
}: {
	agents: InterfaceAgent[];
	dateLine: string;
	defaultAgentId?: string;
	onCancel: () => void;
	onSubmit: (input: { agentId?: string; prompt: string }) => void;
	titleClass: string;
}) {
	const fieldId = useId();
	const fieldRef = useRef<HTMLTextAreaElement>(null);
	const [prompt, setPrompt] = useState("");
	const [pickedAgentId, setPickedAgentId] = useState<string>();
	const agentId =
		pickedAgentId && agents.some((agent) => agent.id === pickedAgentId)
			? pickedAgentId
			: (defaultAgentId ?? agents[0]?.id);
	const pickedAgent = agents.find((agent) => agent.id === agentId);
	const trimmed = prompt.trim();

	useEffect(() => {
		fieldRef.current?.focus();
	}, []);

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
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			onCancel();
			return;
		}
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
		<form
			aria-label="New entry"
			className="rounded-lg border border-border bg-card transition-colors focus-within:border-ring/60"
			onSubmit={onFormSubmit}
		>
			<div className="ps-5 pe-2 pt-2">
				<div className="flex h-8 items-center justify-between gap-2">
					<p className="text-muted-foreground text-xs">{dateLine}</p>
					<JournalIconButton
						keys={["Esc"]}
						label="Cancel new entry"
						onClick={onCancel}
					>
						<X aria-hidden="true" className="size-4" />
					</JournalIconButton>
				</div>
				<label className="sr-only" htmlFor={fieldId}>
					New entry
				</label>
				<textarea
					className={cn(
						"mt-1 block min-h-24 w-full resize-none bg-transparent pe-3 text-foreground text-lg leading-relaxed outline-none placeholder:text-muted-foreground/70",
						titleClass
					)}
					id={fieldId}
					maxLength={MAX_PROMPT_LENGTH}
					onChange={(event) => setPrompt(event.target.value)}
					onKeyDown={onKeyDown}
					placeholder="What should today's entry be about?"
					ref={fieldRef}
					value={prompt}
				/>
			</div>
			<div className="flex items-center gap-2 border-border border-t px-3 py-2">
				{agents.length > 0 ? (
					<div className="relative">
						<BoardAvatar
							agent={pickedAgent}
							className="pointer-events-none absolute start-2 top-1/2 z-10 -translate-y-1/2"
							name={pickedAgent?.name ?? "Agent"}
							size={20}
						/>
						<NativeSelect
							aria-label="Agent"
							className="[&>select]:bg-transparent [&>select]:ps-9 [&>select]:hover:bg-muted"
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
					</div>
				) : (
					<span className="px-2 text-muted-foreground text-xs">
						No agents yet. The entry starts without one.
					</span>
				)}
				<Button
					aria-keyshortcuts="Enter"
					aria-label="Start entry"
					className="ms-auto"
					disabled={!trimmed}
					size="sm"
					type="submit"
				>
					Start entry
					<Kbd
						aria-hidden="true"
						className="bg-primary-foreground/15 text-primary-foreground max-sm:hidden"
					>
						↵
					</Kbd>
				</Button>
			</div>
		</form>
	);
}
