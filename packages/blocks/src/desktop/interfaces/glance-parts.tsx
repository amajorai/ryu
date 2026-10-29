import { useLiteralMessages } from "@ryu/i18n/react";
import {
	Avatar,
	AvatarFallback,
	AvatarImage,
} from "@ryu/ui/components/avatar.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	DitherAvatar,
	ditherAvatarSeed,
} from "@ryu/ui/components/dither-kit/avatar.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceAgent,
	type InterfaceSnapshot,
	type InterfaceThread,
	THREAD_STATUS_LABELS,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { X } from "lucide-react";
import { motion } from "motion/react";
import { type ReactNode, type RefObject, useEffect, useState } from "react";
import type { GlanceAgentState } from "./glance-model.ts";
import { glanceThreadTitle } from "./glance-model.ts";
import { agentById } from "./interface-renderer.ts";
import { useReducedMotion } from "./reduced-motion.ts";

/**
 * Apple's system face first (SF Pro on macOS), then the app's own sans. The
 * clock and tiles lean on SF's display cuts at large sizes.
 */
export const GLANCE_FONT_STACK =
	'-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Inter Variable", system-ui, sans-serif';

/** Apple's spring-like ease for faces and sheets. */
export const GLANCE_EASE = [0.32, 0.72, 0, 1] as const;

const MINUTE_MS = 60_000;

/** The current time, ticking on the minute boundary so the clock never lags. */
export function useGlanceClock(): number {
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
 * An agent's picture, or Ryu's generative dither tile seeded by id.
 * Decorative: the tile or row around it names the agent.
 */
export function GlanceAvatar({
	agent,
	className,
}: {
	agent: InterfaceAgent;
	className?: string;
}) {
	const seed = ditherAvatarSeed({ id: agent.id, name: agent.name });
	return (
		<Avatar aria-hidden="true" className={cn("size-8", className)}>
			{agent.avatarUrl ? <AvatarImage alt="" src={agent.avatarUrl} /> : null}
			<AvatarFallback appearance="artwork" className="overflow-hidden bg-muted">
				<DitherAvatar animate={false} className="size-full" name={seed} />
			</AvatarFallback>
		</Avatar>
	);
}

/**
 * Secondary ink on the display and its tiles. A theme tunes muted-foreground
 * for its page background; on the raised surfaces of a dark display that
 * falls under 4.5:1, so dark mode reads the foreground at reduced strength.
 */
export const GLANCE_INK_SECONDARY =
	"text-muted-foreground dark:text-foreground/70";

/**
 * Status ink for each state's word. "Your turn" stays in full-strength
 * foreground so it never depends on the theme keeping primary and success
 * apart; the mark beside it carries the hue.
 */
export const GLANCE_STATE_TEXT: Record<GlanceAgentState, string> = {
	attention: "text-destructive",
	idle: GLANCE_INK_SECONDARY,
	waiting: GLANCE_INK_SECONDARY,
	working: "text-success",
	"your-turn": "text-foreground",
};

const MARK: Record<GlanceAgentState, string> = {
	attention: "bg-destructive",
	idle: "border-[1.5px] border-muted-foreground/50",
	waiting: "border-[1.5px] border-muted-foreground/70",
	working: "bg-success",
	"your-turn": "bg-primary",
};

/**
 * One small status mark shared by every face. Each state differs in form as
 * well as hue, so no theme can make two of them look alike: a solid dot when
 * it needs you, a dot inside a ring while it works (the ring breathes unless
 * motion is reduced), a hollow ring when quiet.
 */
export function GlanceMark({
	className,
	state,
}: {
	className?: string;
	state: GlanceAgentState;
}) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"relative inline-block size-2 shrink-0 rounded-full",
				MARK[state],
				className
			)}
		>
			{state === "working" ? (
				<span
					className="absolute -inset-[3px] rounded-full border-[1.5px] border-success motion-safe:animate-pulse"
					data-mark-ring
				/>
			) : null}
		</span>
	);
}

/** A thread's status as a Glance mark state ("quiet" reads as idle). */
export function glanceThreadState(thread: InterfaceThread): GlanceAgentState {
	const status = threadStatus(thread);
	return status === "quiet" ? "idle" : status;
}

/**
 * The open thread, as a sheet beside the display. The host's own
 * conversation surface fills it; Glance adds only who and where it stands.
 */
export function GlanceThreadSheet({
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
	const tl = useLiteralMessages();
	const reduceMotion = useReducedMotion();
	const title = thread ? glanceThreadTitle(thread) : "New thread";
	const agents = (thread?.agentIds ?? [])
		.map((id) => agentById(snapshot, id))
		.filter((agent): agent is InterfaceAgent => agent !== undefined);
	const lead = agents[0];
	const state = thread ? glanceThreadState(thread) : null;
	return (
		<motion.aside
			animate={{ opacity: 1, x: 0 }}
			aria-label={tl("Thread: {title}", { title })}
			className="relative flex min-h-0 w-[clamp(22rem,38%,40rem)] shrink-0 flex-col border-border border-l bg-background max-md:absolute max-md:inset-0 max-md:z-30 max-md:w-full max-md:border-l-0"
			data-testid="glance-thread-sheet"
			exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: 32 }}
			initial={reduceMotion ? false : { opacity: 0, x: 32 }}
			ref={sheetRef}
			transition={{ duration: 0.32, ease: GLANCE_EASE }}
		>
			<header className="flex h-16 shrink-0 items-center gap-3 border-border border-b pr-3 pl-5">
				{lead ? <GlanceAvatar agent={lead} className="size-8" /> : null}
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<h2 className="truncate font-semibold text-[15px] text-foreground leading-5">
						{title}
					</h2>
					{thread && state ? (
						<p className="flex min-w-0 items-center gap-1.5 text-[13px] text-muted-foreground leading-4">
							<GlanceMark className="size-1.5" state={state} />
							<span className={cn("shrink-0", GLANCE_STATE_TEXT[state])}>
								{THREAD_STATUS_LABELS[threadStatus(thread)]}
							</span>
							{agents.length > 0 ? (
								<span className="truncate">
									{" · "}
									{agents.map((agent) => agent.name).join(", ")}
								</span>
							) : null}
						</p>
					) : null}
				</div>
				<Button
					aria-keyshortcuts="Escape"
					aria-label="Close thread"
					onClick={onClose}
					size="icon-sm"
					title="Close (Esc)"
					type="button"
					variant="ghost"
				>
					<X aria-hidden="true" />
				</Button>
			</header>
			<div className="min-h-0 flex-1">{threadView}</div>
		</motion.aside>
	);
}
