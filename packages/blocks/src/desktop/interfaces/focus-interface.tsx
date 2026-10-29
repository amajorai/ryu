import { useLiteralMessages } from "@ryu/i18n/react";
import { Kbd } from "@ryu/ui/components/kbd.tsx";
import { useEffect, useMemo, useRef, useState } from "react";
import { FocusCard, FocusCardSkeleton } from "./focus-card.tsx";
import { FocusDone } from "./focus-done.tsx";
import { FocusFrame } from "./focus-frame.tsx";
import {
	buildFocusQueue,
	type FocusCursor,
	type FocusKeyAction,
	focusCursorAt,
	focusKeyAction,
	focusPosition,
	focusStatusCounts,
	initialFocusCursor,
	isFocusTypingTarget,
	resolveFocusIndex,
} from "./focus-model.ts";
import { FOCUS_STRIP_SELECTOR, FocusStrip } from "./focus-strip.tsx";
import { isInterfaceCovered } from "./interface-keys.ts";
import type { InterfaceRendererProps } from "./interface-renderer.ts";

const MINUTE_MS = 60_000;

/** The page footer's key legend. */
const FOCUS_KEY_HINTS = [
	{ keys: ["J", "K"], label: "Next / previous" },
	{ keys: ["↵"], label: "Open" },
	{ keys: ["Home", "End"], label: "First / last" },
] as const;

/** The current time, refreshed every minute so a card left open ages honestly. */
function useMinuteClock(): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), MINUTE_MS);
		return () => clearInterval(timer);
	}, []);
	return now;
}

/**
 * Focus: one thread at a time, most urgent first. A single reading column
 * (status, title, who, and the latest message) steps through the
 * queue with J/K or the arrow keys (Home and End jump to either end); Open hands the focus frame to the host's
 * own conversation surface; the end of the queue is a calm "caught up" card
 * with a composer for whatever comes next.
 */
export function FocusInterface({
	activeThreadId,
	loading,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<Record<string, never>>) {
	const tl = useLiteralMessages();
	const queue = useMemo(() => buildFocusQueue(snapshot), [snapshot]);
	const [cursor, setCursor] = useState<FocusCursor>(() =>
		initialFocusCursor(queue, activeThreadId)
	);
	const [direction, setDirection] = useState(1);
	const [syncedThreadId, setSyncedThreadId] = useState(activeThreadId);
	const now = useMinuteClock();

	// Follow the host: when it opens a thread (from here or anywhere else), the
	// queue position moves to that thread so "back to queue" lands on it.
	if (activeThreadId !== syncedThreadId) {
		setSyncedThreadId(activeThreadId);
		const openIndex = queue.findIndex(
			(item) => item.thread.id === activeThreadId
		);
		if (activeThreadId && openIndex !== -1) {
			setCursor({ id: activeThreadId, index: openIndex, kind: "thread" });
		}
	}

	const total = queue.length;
	const index = resolveFocusIndex(queue, cursor);
	const current = queue[index];
	const isOpen = threadView !== null && threadView !== undefined;
	const openIndex = activeThreadId
		? queue.findIndex((item) => item.thread.id === activeThreadId)
		: -1;
	const frameIndex = openIndex === -1 ? index : openIndex;
	const frameItem = activeThreadId ? queue[openIndex] : undefined;
	const working = focusStatusCounts(queue).working ?? 0;
	const upNext = current ? queue[index + 1] : undefined;

	const goTo = (target: number, { open }: { open: boolean }) => {
		const next = focusCursorAt(queue, target);
		const nextIndex = resolveFocusIndex(queue, next);
		setDirection(nextIndex >= index ? 1 : -1);
		setCursor(next);
		if (!open) {
			return;
		}
		if (next.kind === "thread") {
			port.openThread(next.id);
		} else {
			port.closeThread();
		}
	};

	const step = (delta: number) => {
		const from = isOpen ? frameIndex : index;
		const target = Math.min(Math.max(from + delta, 0), total);
		if (target === from) {
			return;
		}
		goTo(target, { open: isOpen });
	};

	const openCurrent = () => {
		if (current) {
			port.openThread(current.thread.id);
		}
	};

	const runAction = (action: FocusKeyAction): boolean => {
		switch (action) {
			case "next":
				if (index >= total && !isOpen) {
					return false;
				}
				step(1);
				return true;
			case "previous":
				step(-1);
				return true;
			case "first":
				step(-(isOpen ? frameIndex : index));
				return true;
			case "last": {
				// Open, the last thread; in the queue, the caught-up page.
				const end = isOpen ? total - 1 : total;
				step(end - (isOpen ? frameIndex : index));
				return true;
			}
			case "open":
				if (isOpen || !current) {
					return false;
				}
				openCurrent();
				return true;
			default:
				if (!isOpen) {
					return false;
				}
				port.closeThread();
				return true;
		}
	};

	const runActionRef = useRef(runAction);
	runActionRef.current = runAction;
	const rootRef = useRef<HTMLDivElement>(null);
	const threadRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (isInterfaceCovered(rootRef.current)) {
				return;
			}
			if (event.defaultPrevented || event.isComposing) {
				return;
			}
			const action = focusKeyAction(event);
			if (!action) {
				return;
			}
			const target = event.target;
			if (isFocusTypingTarget(target)) {
				return;
			}
			// The queue strip runs its own roving arrow keys.
			if (target instanceof Element && target.closest(FOCUS_STRIP_SELECTOR)) {
				return;
			}
			// Enter on a focused control belongs to that control.
			if (
				action === "open" &&
				target instanceof Element &&
				target.closest("button, a, [role='button']")
			) {
				return;
			}
			const root = rootRef.current;
			const onPage =
				target === document.body ||
				target === document.documentElement ||
				(target instanceof Node && root?.contains(target) === true);
			// Inside the host's conversation, its own keys win.
			const inThread =
				target instanceof Node && threadRef.current?.contains(target) === true;
			if (!onPage || inThread) {
				return;
			}
			if (runActionRef.current(action)) {
				event.preventDefault();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, []);

	const start = ({ agentId, prompt }: { agentId?: string; prompt: string }) => {
		port.startThread({ agentId, prompt });
	};

	if (isOpen) {
		return (
			<div
				className="flex size-full min-h-0 flex-col bg-background text-foreground"
				data-state="open"
				data-testid="interface-focus"
				ref={rootRef}
			>
				<FocusFrame
					currentIndex={frameIndex}
					hasNext={frameIndex < total - 1}
					hasPrevious={frameIndex > 0}
					item={frameItem}
					onBack={() => port.closeThread()}
					onNext={() => step(1)}
					onPrevious={() => step(-1)}
					onSelect={(target) => goTo(target, { open: true })}
					position={frameItem ? focusPosition(frameIndex, total) : "New"}
					queue={queue}
					threadRef={threadRef}
					threadView={threadView}
				/>
			</div>
		);
	}

	let stage = (
		<FocusDone
			agents={snapshot.agents}
			onBackToTop={total > 0 ? () => goTo(0, { open: false }) : null}
			onStart={start}
			total={total}
			working={working}
		/>
	);
	if (loading) {
		stage = <FocusCardSkeleton />;
	} else if (current) {
		stage = (
			<FocusCard
				direction={direction}
				hasNext={index < total - 1}
				hasPrevious={index > 0}
				item={current}
				now={now}
				onNext={() => step(1)}
				onOpen={openCurrent}
				onPrevious={() => step(-1)}
				upNext={upNext}
			/>
		);
	}

	const remaining = Math.max(0, total - index - (current ? 1 : 0));
	return (
		<div
			aria-busy={loading || undefined}
			className="@container size-full overflow-y-auto bg-background text-foreground"
			data-state={current ? "card" : "done"}
			data-testid="interface-focus"
			ref={rootRef}
		>
			<div className="mx-auto flex min-h-full w-full max-w-[52rem] flex-col @min-[640px]:px-8 px-4 @min-[640px]:py-10 py-6">
				<header className="flex flex-col gap-3">
					<div className="flex items-baseline gap-3">
						<h1 className="font-semibold text-foreground text-lg tracking-tight">
							Focus
						</h1>
						<p
							aria-live="polite"
							className="text-muted-foreground text-sm tabular-nums"
						>
							{loading ? "Loading" : focusPosition(index, total)}
						</p>
						{loading || !current ? null : (
							<p className="ml-auto text-muted-foreground text-sm tabular-nums">
								{remaining === 0
									? "Last one"
									: working > 0
										? tl("{remaining} left · {working} working", {
												remaining,
												working,
											})
										: tl("{remaining} left", { remaining })}
							</p>
						)}
					</div>
					{loading ? null : (
						<FocusStrip
							currentIndex={index}
							onSelect={(target) => goTo(target, { open: false })}
							queue={queue}
						/>
					)}
				</header>
				{/* Centred in the window, with the card's top held at a fixed
				    offset so the title stays put while messages change length. */}
				<div className="flex flex-1 flex-col justify-center @min-[640px]:py-12 py-8">
					<div className="@min-[640px]:min-h-[30rem]">{stage}</div>
				</div>
				<footer
					aria-label="Keyboard shortcuts"
					className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-muted-foreground text-xs max-sm:hidden"
				>
					{FOCUS_KEY_HINTS.map((hint) => (
						<span className="flex items-center gap-1.5" key={hint.label}>
							{hint.keys.map((key) => (
								<Kbd key={key}>{key}</Kbd>
							))}
							{hint.label}
						</span>
					))}
				</footer>
			</div>
		</div>
	);
}
