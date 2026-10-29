import {
	Avatar,
	AvatarFallback,
	AvatarImage,
} from "@ryu/ui/components/avatar.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceAgent,
	type InterfaceSnapshot,
	type InterfaceThread,
	THREAD_STATUS_LABELS,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { ArrowLeft, Workflow } from "lucide-react";
import { motion } from "motion/react";
import {
	type KeyboardEvent,
	type ReactNode,
	type RefObject,
	useEffect,
	useId,
	useState,
} from "react";
import { BoardStatusDot } from "./board-status.tsx";
import { hubAgentNames, hubThreadAgents, hubThreadTitle } from "./hub-model.ts";
import { useReducedMotion } from "./reduced-motion.ts";

/** Material's emphasized-decelerate curve, for cards, sheets, and the scrim. */
export const HUB_EASE = [0.05, 0.7, 0.1, 1] as const;

const MINUTE_MS = 60_000;

/**
 * The status facts as one line that wraps between facts, never inside one;
 * the separator stays with the fact before it.
 */
export function HubStatusLine({
	className,
	id,
	parts,
}: {
	className?: string;
	id?: string;
	parts: string[];
}) {
	return (
		<p className={cn("flex flex-wrap gap-x-2", className)} id={id}>
			<span className="sr-only">{parts.join(", ")}</span>
			{parts.map((part, index) => (
				<span aria-hidden="true" className="whitespace-nowrap" key={part}>
					{index < parts.length - 1 ? `${part} ·` : part}
				</span>
			))}
		</p>
	);
}

/** The current time, ticking on the minute boundary so the clock never lags. */
export function useHubClock(): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		let interval: ReturnType<typeof setInterval> | undefined;
		const align = setTimeout(
			() => {
				setNow(Date.now());
				interval = setInterval(() => setNow(Date.now()), MINUTE_MS);
			},
			MINUTE_MS - (Date.now() % MINUTE_MS) + 50
		);
		return () => {
			clearTimeout(align);
			if (interval) {
				clearInterval(interval);
			}
		};
	}, []);
	return now;
}

/**
 * An agent's picture, or a flat tonal disc with its initial: calm and legible
 * from across a room. Decorative: the row or tile around it names the agent.
 */
export function HubAvatar({
	agent,
	className,
}: {
	agent: InterfaceAgent;
	className?: string;
}) {
	const initial = agent.name.trim().charAt(0).toUpperCase() || "?";
	return (
		<Avatar aria-hidden="true" className={cn("size-11 text-[17px]", className)}>
			{agent.avatarUrl ? <AvatarImage alt="" src={agent.avatarUrl} /> : null}
			<AvatarFallback className="bg-muted font-medium text-[length:inherit] text-foreground">
				{initial}
			</AvatarFallback>
		</Avatar>
	);
}

/** A row's lead disc when no agent owns it: a workflow, not a face. */
export function HubWorkflowDisc({ className }: { className?: string }) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"flex size-11 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground",
				className
			)}
		>
			<Workflow className="size-5" />
		</span>
	);
}

/** A thread's lead agent, or the workflow disc for agentless threads. */
export function HubThreadAvatar({
	agents,
	className,
}: {
	agents: InterfaceAgent[];
	className?: string;
}) {
	const lead = agents[0];
	if (lead) {
		return <HubAvatar agent={lead} className={className} />;
	}
	return <HubWorkflowDisc className={className} />;
}

const FOCUSABLE =
	"a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

/** Keep Tab inside the sheet: it is modal over the cards. */
function trapTab(event: KeyboardEvent<HTMLElement>) {
	if (event.key !== "Tab") {
		return;
	}
	const focusable = [
		...event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE),
	].filter((element) => !element.closest("[inert]"));
	const first = focusable[0];
	const last = focusable.at(-1);
	if (!(first && last)) {
		event.preventDefault();
		return;
	}
	const active = document.activeElement;
	if (event.shiftKey && (active === first || active === event.currentTarget)) {
		event.preventDefault();
		last.focus();
	} else if (!event.shiftKey && active === last) {
		event.preventDefault();
		first.focus();
	}
}

/**
 * The open thread as a full-height modal sheet over the cards. The host's own
 * conversation surface fills it; the Hub adds a back control and a title.
 * The caller moves focus into it on open and restores it on close.
 */
export function HubThreadSheet({
	onClose,
	sheetRef,
	snapshot,
	thread,
	threadView,
}: {
	onClose: () => void;
	sheetRef: RefObject<HTMLElement | null>;
	snapshot: InterfaceSnapshot;
	thread: InterfaceThread | undefined;
	threadView: ReactNode;
}) {
	const reduceMotion = useReducedMotion();
	const titleId = useId();
	const title = thread ? hubThreadTitle(thread) : "New conversation";
	const agents = thread ? hubThreadAgents(snapshot, thread) : [];
	const status = thread ? threadStatus(thread) : null;
	return (
		<>
			<motion.div
				animate={{ opacity: 1 }}
				aria-hidden="true"
				className="absolute inset-0 z-20 bg-foreground/20 dark:bg-background/60"
				data-testid="hub-scrim"
				exit={{ opacity: 0 }}
				initial={{ opacity: 0 }}
				onClick={onClose}
				transition={{ duration: reduceMotion ? 0 : 0.24 }}
			/>
			<motion.section
				animate={{ x: 0 }}
				aria-labelledby={titleId}
				aria-modal="true"
				className="corner-squircle absolute inset-y-0 right-0 z-30 flex w-full min-w-0 flex-col overflow-hidden bg-background outline-none md:w-[min(48rem,62%)] md:rounded-l-[28px] md:border-border/60 md:border-l"
				data-testid="hub-thread-sheet"
				exit={reduceMotion ? { opacity: 0 } : { x: "100%" }}
				initial={reduceMotion ? false : { x: "100%" }}
				onKeyDown={trapTab}
				ref={sheetRef}
				role="dialog"
				tabIndex={-1}
				transition={{ duration: reduceMotion ? 0 : 0.4, ease: HUB_EASE }}
			>
				<header className="flex h-18 shrink-0 items-center gap-3 border-border border-b px-3">
					<Button
						aria-keyshortcuts="Escape"
						aria-label="Back to cards"
						className="size-11"
						onClick={onClose}
						size="icon-lg"
						title="Back (Esc)"
						type="button"
						variant="ghost"
					>
						<ArrowLeft aria-hidden="true" className="size-5" />
					</Button>
					<div className="flex min-w-0 flex-1 flex-col">
						<h2
							className="truncate font-medium text-[17px] text-foreground leading-6"
							id={titleId}
						>
							{title}
						</h2>
						{status ? (
							<p className="flex min-w-0 items-center gap-2 text-muted-foreground text-sm leading-5">
								<BoardStatusDot status={status} />
								<span className="truncate">
									{`${THREAD_STATUS_LABELS[status]} · ${hubAgentNames(agents)}`}
								</span>
							</p>
						) : null}
					</div>
				</header>
				<div className="min-h-0 flex-1">{threadView}</div>
			</motion.section>
		</>
	);
}
