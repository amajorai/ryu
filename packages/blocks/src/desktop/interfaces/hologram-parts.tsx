import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceEvent, ThreadStatus } from "@ryuhq/protocol/interfaces";
import { ChevronDown } from "lucide-react";
import { type ReactNode, useRef } from "react";
import { useHiddenBelow, useHoloNow } from "./hologram-hooks.ts";
import {
	clock,
	countdown,
	dayTag,
	elapsedClock,
	type HoloThread,
	polar,
	shortCadence,
	statusPhrase,
} from "./hologram-model.ts";
import { PANEL_TEXTURE } from "./hologram-palette.ts";
import { compactAge } from "./interface-renderer.ts";

/** Tiny uppercase HUD label. */
export const HUD_LABEL =
	"font-mono text-[12px] uppercase leading-4 tracking-[0.12em]";

/** Hover, press and keyboard focus for every row and control on the deck. */
export const HUD_INTERACTIVE =
	"outline-none transition-colors duration-150 hover:bg-(--holo-ink)/8 active:bg-(--holo-ink)/14 focus-visible:ring-1 focus-visible:ring-(--holo-ink) focus-visible:ring-inset";

/**
 * Keyframes for the deck's looping motion. They run as CSS animations (and
 * only behind `motion-safe:`), so the spoke flow and the core's pulse stay
 * on the compositor instead of competing with the ring for the main thread.
 */
const KEYFRAMES = [
	"@keyframes holo-dash{to{stroke-dashoffset:-16}}",
	"@keyframes holo-pulse{0%,100%{opacity:var(--holo-pulse-lo);transform:scale(0.96)}50%{opacity:var(--holo-pulse-hi);transform:scale(1)}}",
	"@keyframes holo-pop{from{scale:0.92}}",
].join("");

export function HoloKeyframes() {
	return <style>{KEYFRAMES}</style>;
}

/** The four corner brackets that frame a holographic panel. */
export function CornerBrackets({ className }: { className?: string }) {
	const corner = "pointer-events-none absolute size-2.5 border-(--holo-ink)";
	return (
		<span aria-hidden="true" className={className}>
			<span className={cn(corner, "-top-px -left-px border-t border-l")} />
			<span className={cn(corner, "-top-px -right-px border-t border-r")} />
			<span className={cn(corner, "-bottom-px -left-px border-b border-l")} />
			<span className={cn(corner, "-right-px -bottom-px border-r border-b")} />
		</span>
	);
}

/**
 * A floating holographic panel: hairline edge, corner brackets, scanline
 * fill, a tiny label and a count readout. The body scrolls in place; when
 * rows sit below the fold, a footer says how many and pages down to them.
 */
export function HoloPanel({
	action,
	children,
	className,
	count,
	id,
	label,
}: {
	action?: ReactNode;
	children: ReactNode;
	className?: string;
	count?: number;
	id: string;
	label: string;
}) {
	const tl = useLiteralMessages();
	const headingId = `holo-panel-${id}`;
	const bodyRef = useRef<HTMLDivElement>(null);
	const hidden = useHiddenBelow(bodyRef, children);
	const pageDown = () => {
		const body = bodyRef.current;
		if (!body) {
			return;
		}
		const still = window.matchMedia?.(
			"(prefers-reduced-motion: reduce)"
		).matches;
		body.scrollBy({
			behavior: still ? "auto" : "smooth",
			top: Math.max(48, body.clientHeight - 52),
		});
	};
	return (
		<section
			aria-labelledby={headingId}
			className={cn(
				"relative flex min-h-0 flex-col border border-(--holo-line)",
				className
			)}
			data-holo-panel={id}
			style={PANEL_TEXTURE}
		>
			<CornerBrackets />
			<header className="flex h-9 shrink-0 items-center gap-2 border-(--holo-line) border-b px-4">
				<h2
					className={cn(HUD_LABEL, "flex-1 truncate text-(--holo-ink)")}
					id={headingId}
				>
					{label}
				</h2>
				{count === undefined ? null : (
					<span className="font-mono text-(--holo-dim) text-[12px] tabular-nums">
						{String(count).padStart(2, "0")}
					</span>
				)}
				{action}
			</header>
			<div
				className={cn(
					"min-h-0 flex-1 overflow-y-auto overscroll-contain py-1",
					// Rows cut by the fold fade out above the "n more" footer.
					hidden > 0 &&
						"[mask-image:linear-gradient(to_bottom,black_calc(100%-40px),transparent)]"
				)}
				data-hidden-below={hidden > 0 ? hidden : undefined}
				ref={bodyRef}
			>
				{children}
			</div>
			{hidden > 0 ? (
				<button
					className={cn(
						HUD_LABEL,
						HUD_INTERACTIVE,
						"flex h-8 shrink-0 items-center justify-between border-(--holo-line) border-t px-4 text-(--holo-dim) hover:text-(--holo-text)"
					)}
					onClick={pageDown}
					tabIndex={-1}
					type="button"
				>
					<span className="tabular-nums">
						{tl("{hidden} more", { hidden })}
					</span>
					<ChevronDown aria-hidden="true" className="size-3.5" />
				</button>
			) : null}
		</section>
	);
}

/** One quiet line for a panel with nothing in it. */
export function PanelEmpty({ children }: { children: ReactNode }) {
	return (
		<p className="px-4 py-2 font-mono text-(--holo-dim) text-[12px] leading-5">
			{children}
		</p>
	);
}

const MARK_TONE: Record<ThreadStatus, string> = {
	attention: "bg-(--holo-alert)",
	quiet: "border border-(--holo-faint)",
	waiting: "border border-(--holo-dim)",
	working: "bg-(--holo-ink)",
	"your-turn": "bg-(--holo-turn)",
};

/** A small diamond in the status tone. */
export function StatusMark({ status }: { status: ThreadStatus }) {
	return (
		<span
			aria-hidden="true"
			className={cn("block size-1.5 rotate-45", MARK_TONE[status])}
		/>
	);
}

const SPINNER = 14;
const SPINNER_RADIUS = SPINNER / 2 - 1;

/**
 * A live run's mark: the same lit sweep that turns on a working agent's
 * node, on a hairline track. Runs report no progress, so it claims none; it
 * holds still when motion is reduced.
 */
export function LiveSpinner() {
	const end = polar(96, SPINNER_RADIUS);
	return (
		<svg
			aria-hidden="true"
			className="block shrink-0 overflow-visible motion-safe:animate-[spin_1.8s_linear_infinite]"
			height={SPINNER}
			viewBox={`${-SPINNER / 2} ${-SPINNER / 2} ${SPINNER} ${SPINNER}`}
			width={SPINNER}
		>
			<circle
				className="stroke-(--holo-line)"
				fill="none"
				r={SPINNER_RADIUS}
				strokeWidth={1}
			/>
			<path
				className="stroke-(--holo-ink)"
				d={`M 0 ${-SPINNER_RADIUS} A ${SPINNER_RADIUS} ${SPINNER_RADIUS} 0 0 1 ${end.x} ${end.y}`}
				fill="none"
				strokeLinecap="round"
				strokeWidth={2}
			/>
		</svg>
	);
}

const ROW = "grid w-full items-start gap-x-2 rounded-sm px-3 py-2 text-left";

/**
 * A thread on the deck: status mark, title, who and where it stands, age.
 * The `live` variant is for running threads: a turning mark, an elapsed
 * clock, and the agent's newest line under the title, up to two lines.
 */
export function ThreadRow({
	active,
	item,
	now,
	onOpen,
	variant = "status",
}: {
	active: boolean;
	item: HoloThread;
	now: number;
	onOpen: (threadId: string) => void;
	variant?: "live" | "status";
}) {
	const who =
		item.agentNames.length > 0 ? item.agentNames.join(", ") : "No agent";
	const live = variant === "live";
	// Live rows count up by the second; the rest only need the deck's beat.
	const tick = useHoloNow(live ? 1000 : 60_000);
	const age = live
		? elapsedClock(item.thread.updatedAt, Math.max(now, tick))
		: compactAge(item.thread.updatedAt, now);
	return (
		<li className="px-1">
			<button
				aria-current={active ? "true" : undefined}
				className={cn(
					ROW,
					"grid-cols-[12px_minmax(0,1fr)_auto]",
					HUD_INTERACTIVE,
					active && "bg-(--holo-ink)/12"
				)}
				data-thread-id={item.id}
				onClick={() => onOpen(item.id)}
				type="button"
			>
				<span className="flex h-5 items-center justify-center">
					{live ? <LiveSpinner /> : <StatusMark status={item.status} />}
				</span>
				<span className="truncate text-(--holo-text) text-[14px] leading-5">
					{item.title}
				</span>
				<span
					className={cn(
						"font-mono text-[12px] tabular-nums leading-5",
						live ? "text-(--holo-ink)" : "text-(--holo-dim)"
					)}
				>
					{age}
				</span>
				{live ? (
					<span className="col-span-2 col-start-2 line-clamp-2 text-(--holo-dim) text-[13px] leading-4">
						<span className="font-mono text-(--holo-text) text-[12px]">
							{who}
						</span>
						<span className="font-mono text-[12px]">{" · "}</span>
						{item.thread.lastMessage ?? statusPhrase(item.thread)}
					</span>
				) : (
					<span className="col-span-2 col-start-2 truncate font-mono text-(--holo-dim) text-[12px] leading-4">
						<span
							className={cn(
								item.status === "attention" && "text-(--holo-alert)",
								item.status === "your-turn" && "text-(--holo-turn)"
							)}
						>
							{statusPhrase(item.thread)}
						</span>
						{" · "}
						{who}
					</span>
				)}
			</button>
		</li>
	);
}

function outcomeLabel(outcome: InterfaceEvent["outcome"]): string {
	if (outcome === "failure") {
		return "Failed";
	}
	return outcome === "success" ? "Done" : "Ran";
}

/**
 * A scheduled run: when, the routine, its agent and cadence, and either how
 * many runs are queued (upcoming) or how it went (past). A recurring run
 * leads with its countdown (or, once past, its day), since its cadence
 * already says the time of day; a one-off leads with its local start time.
 * Hovering the readout shows the other form.
 */
export function EventRow({
	agentName,
	event,
	now,
}: {
	agentName: string | null;
	event: InterfaceEvent;
	now: number;
}) {
	const tl = useLiteralMessages();
	const start = Date.parse(event.start);
	const past = event.kind === "past";
	const runs = event.count && event.count > 1 ? `${event.count} runs` : null;
	const meta = [agentName, event.label ? shortCadence(event.label) : null]
		.filter(Boolean)
		.join(" · ");
	const age = past ? compactAge(event.end ?? event.start, now) : "";
	const day = dayTag(start, now);
	const recurring = Boolean(event.label);
	let primary = clock(start);
	if (recurring) {
		primary = past ? day : countdown(event.start, now);
	}
	const secondary = recurring && past ? null : day;
	const hint = recurring
		? `${day} ${clock(start)}`
		: countdown(event.start, now);
	return (
		<li className="grid grid-cols-[56px_minmax(0,1fr)_auto] items-start gap-x-2 px-4 py-2">
			<time
				className="flex flex-col"
				dateTime={event.start}
				title={past && !recurring ? undefined : hint}
			>
				<span className="whitespace-nowrap font-mono text-(--holo-text) text-[13px] tabular-nums leading-5">
					{primary}
				</span>
				{secondary ? (
					<span className={cn(HUD_LABEL, "text-(--holo-dim)")}>
						{secondary}
					</span>
				) : null}
			</time>
			<span className="flex min-w-0 flex-col">
				<span className="truncate text-(--holo-text) text-[14px] leading-5">
					{event.title}
				</span>
				{meta ? (
					<span className="truncate font-mono text-(--holo-dim) text-[12px] leading-4">
						{meta}
					</span>
				) : null}
			</span>
			{past ? (
				<span className="flex flex-col items-end">
					<span
						className={cn(
							"font-mono text-[12px] leading-5",
							event.outcome === "failure"
								? "text-(--holo-alert)"
								: "text-(--holo-dim)"
						)}
					>
						{outcomeLabel(event.outcome)}
					</span>
					<span className="font-mono text-(--holo-dim) text-[12px] tabular-nums leading-4">
						{age === "now" ? "now" : tl("{age} ago", { age })}
					</span>
				</span>
			) : (
				<span className="font-mono text-(--holo-dim) text-[12px] tabular-nums leading-5">
					{runs}
				</span>
			)}
		</li>
	);
}

/** A tiny label that opens a group of rows inside a panel. */
export function PanelSubhead({ children }: { children: ReactNode }) {
	return (
		<h3
			className={cn(
				HUD_LABEL,
				"px-4 pt-2 pb-1 text-(--holo-dim) [&:not(:first-child)]:mt-1 [&:not(:first-child)]:border-(--holo-line) [&:not(:first-child)]:border-t [&:not(:first-child)]:pt-3"
			)}
		>
			{children}
		</h3>
	);
}

/** One figure on the System panel. */
export function Readout({
	label,
	tone = "text",
	value,
}: {
	label: string;
	tone?: "alert" | "ink" | "text" | "turn";
	value: number;
}) {
	return (
		<div className="flex flex-col gap-1">
			<dt className={cn(HUD_LABEL, "text-(--holo-dim)")}>{label}</dt>
			<dd
				className={cn(
					"font-mono text-[22px] tabular-nums leading-7",
					tone === "text" && "text-(--holo-text)",
					tone === "ink" && "text-(--holo-ink)",
					tone === "alert" && "text-(--holo-alert)",
					tone === "turn" && "text-(--holo-turn)"
				)}
			>
				{String(value).padStart(2, "0")}
			</dd>
		</div>
	);
}
