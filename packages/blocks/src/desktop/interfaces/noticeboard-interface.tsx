import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceParamsByRenderer } from "@ryuhq/protocol/interfaces";
import { Plus } from "lucide-react";
import {
	type KeyboardEvent as ReactKeyboardEvent,
	type ReactNode,
	type PointerEvent as ReactPointerEvent,
	type RefObject,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { isInterfaceCovered } from "./interface-keys.ts";
import {
	compactAge,
	type InterfaceRendererProps,
} from "./interface-renderer.ts";
import { NoticeboardComposer } from "./noticeboard-composer.tsx";
import {
	moveNote,
	type NotePoint,
	type NotePositions,
	noticeboardAreas,
	noticeboardLayout,
	noticeboardNote,
	noticeboardSummary,
	nudgedPoint,
	type PlacedNote,
	prunePositions,
	readNotePositions,
	summaryText,
	writeNotePositions,
} from "./noticeboard-model.ts";
import { NOTE_ATTRIBUTE, NoticeboardNoteButton } from "./noticeboard-note.tsx";
import { NoticeboardPanel } from "./noticeboard-panel.tsx";
import { PinDot } from "./noticeboard-paper.tsx";
import {
	BOARD_SURFACE,
	BOARD_SURFACE_CLASS,
	NoticeboardEmpty,
	NoticeboardSkeleton,
} from "./noticeboard-states.tsx";
import { useReducedMotion } from "./reduced-motion.ts";

const MINUTE = 60_000;
/** Width assumed before the first measurement (server render, tests). */
const UNMEASURED_WIDTH = 1200;
/** Below this the panel covers the board instead of sitting beside it. */
const SPLIT_MIN_WIDTH = 900;
/** The panel widens a little on large frames. */
const WIDE_MIN_WIDTH = 1280;
const PANEL_WIDTH = 400;
const PANEL_WIDTH_WIDE = 460;
/** Below this the header drops its summary line. */
const COMPACT_MAX_WIDTH = 640;
/** How far a press must travel before it becomes a drag rather than a click. */
const DRAG_THRESHOLD = 4;

/** Wall clock that ticks once a minute so ages stay honest. */
function useMinuteClock(): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), MINUTE);
		return () => window.clearInterval(timer);
	}, []);
	return now;
}

/** The element's content width, kept current with a ResizeObserver. */
function useElementWidth(ref: RefObject<HTMLElement | null>): number {
	const [width, setWidth] = useState(0);
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) {
			return;
		}
		setWidth(element.clientWidth);
		if (typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver((entries) => {
			const next = entries[0]?.contentRect.width;
			if (next !== undefined) {
				setWidth(next);
			}
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref]);
	return width || UNMEASURED_WIDTH;
}

/** True for targets whose keys belong to typing or to the host's chat. */
function ownsKeys(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) {
		return false;
	}
	return (
		target.isContentEditable ||
		target instanceof HTMLInputElement ||
		target instanceof HTMLTextAreaElement ||
		target instanceof HTMLSelectElement ||
		target.closest("[data-testid='noticeboard-thread-view']") !== null
	);
}

interface DragState {
	moved: boolean;
	origin: NotePoint;
	pointerId: number;
	startX: number;
	startY: number;
	threadId: string;
}

/**
 * Noticeboard: every conversation pinned to a felt board as a paper note, an
 * index card, or a typed memo, grouped into areas by what it needs
 * from you. Notes can be dragged anywhere (the arrangement is remembered per
 * viewer); clicking one lifts it and opens the host's conversation beside the
 * board. "Pin a note" starts a new thread from what the user writes.
 */
export function NoticeboardInterface({
	activeThreadId,
	loading,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<InterfaceParamsByRenderer["noticeboard"]>) {
	const rootRef = useRef<HTMLDivElement>(null);
	const boardRef = useRef<HTMLDivElement>(null);
	const headingRef = useRef<HTMLHeadingElement>(null);
	const composerTriggerRef = useRef<HTMLButtonElement>(null);
	const dragRef = useRef<DragState | null>(null);
	const suppressClickRef = useRef<string | null>(null);
	const lastOpenedRef = useRef<string | null>(null);
	const idBase = useId();
	const descriptionId = `${idBase}-note-help`;

	const rootWidth = useElementWidth(rootRef);
	const boardWidth = useElementWidth(boardRef);
	const now = useMinuteClock();
	const reduceMotion = useReducedMotion();
	const [positions, setPositions] = useState<NotePositions>(readNotePositions);
	const [drag, setDrag] = useState<{
		point: NotePoint;
		threadId: string;
	} | null>(null);
	const [composerOpen, setComposerOpen] = useState(false);

	const areas = useMemo(() => noticeboardAreas(snapshot), [snapshot]);
	const layout = useMemo(
		() => noticeboardLayout(areas, positions, boardWidth),
		[areas, positions, boardWidth]
	);
	const placements = useMemo(() => {
		const map = new Map<string, PlacedNote>();
		for (const item of layout.notes) {
			map.set(item.note.thread.id, item);
		}
		return map;
	}, [layout]);
	const summary = useMemo(() => noticeboardSummary(snapshot), [snapshot]);

	const open = threadView !== null && threadView !== undefined;
	const overlay = rootWidth < SPLIT_MIN_WIDTH;
	const panelWidth =
		rootWidth >= WIDE_MIN_WIDTH ? PANEL_WIDTH_WIDE : PANEL_WIDTH;
	const compact = rootWidth < COMPACT_MAX_WIDTH;
	const activeThread = activeThreadId
		? snapshot.threads.find((thread) => thread.id === activeThreadId)
		: undefined;
	const activeNote = activeThread
		? noticeboardNote(snapshot, activeThread)
		: null;
	const moved = Object.keys(positions).length > 0;

	const commitPositions = useCallback((next: NotePositions) => {
		setPositions(next);
		writeNotePositions(next);
	}, []);

	// Forget positions for threads that are gone, once real data has loaded.
	useEffect(() => {
		if (loading || snapshot.threads.length === 0) {
			return;
		}
		const ids = new Set(snapshot.threads.map((thread) => thread.id));
		setPositions((previous) => {
			const pruned = prunePositions(previous, ids);
			if (pruned !== previous) {
				writeNotePositions(pruned);
			}
			return pruned;
		});
	}, [loading, snapshot.threads]);

	const openThread = useCallback(
		(threadId: string) => {
			if (suppressClickRef.current === threadId) {
				suppressClickRef.current = null;
				return;
			}
			lastOpenedRef.current = threadId;
			port.openThread(threadId);
		},
		[port]
	);
	const closeThread = useCallback(() => port.closeThread(), [port]);

	const onNotePointerDown = useCallback(
		(
			event: ReactPointerEvent<HTMLButtonElement>,
			threadId: string,
			point: NotePoint
		) => {
			if (event.button !== 0 || event.pointerType === "touch") {
				return;
			}
			dragRef.current = {
				moved: false,
				origin: point,
				pointerId: event.pointerId,
				startX: event.clientX,
				startY: event.clientY,
				threadId,
			};
		},
		[]
	);
	const onNotePointerMove = useCallback(
		(event: ReactPointerEvent<HTMLButtonElement>) => {
			const state = dragRef.current;
			if (!state || state.pointerId !== event.pointerId) {
				return;
			}
			const dx = event.clientX - state.startX;
			const dy = event.clientY - state.startY;
			if (!state.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) {
				return;
			}
			if (!state.moved) {
				state.moved = true;
				event.currentTarget.setPointerCapture?.(event.pointerId);
			}
			setDrag({
				point: {
					x: Math.max(0, Math.round(state.origin.x + dx)),
					y: Math.max(0, Math.round(state.origin.y + dy)),
				},
				threadId: state.threadId,
			});
		},
		[]
	);
	const onNotePointerUp = useCallback(
		(event: ReactPointerEvent<HTMLButtonElement>) => {
			const state = dragRef.current;
			if (!state || state.pointerId !== event.pointerId) {
				return;
			}
			dragRef.current = null;
			if (!state.moved) {
				return;
			}
			suppressClickRef.current = state.threadId;
			const point = {
				x: Math.max(
					0,
					Math.round(state.origin.x + event.clientX - state.startX)
				),
				y: Math.max(
					0,
					Math.round(state.origin.y + event.clientY - state.startY)
				),
			};
			commitPositions(moveNote(positions, state.threadId, point));
			setDrag(null);
		},
		[commitPositions, positions]
	);
	const onNotePointerCancel = useCallback(() => {
		dragRef.current = null;
		setDrag(null);
	}, []);
	const onNoteKeyDown = useCallback(
		(
			event: ReactKeyboardEvent<HTMLButtonElement>,
			threadId: string,
			point: NotePoint
		) => {
			if (event.altKey || event.metaKey || event.ctrlKey) {
				return;
			}
			const next = nudgedPoint(point, event.key, event.shiftKey);
			if (!next) {
				return;
			}
			event.preventDefault();
			commitPositions(moveNote(positions, threadId, next));
		},
		[commitPositions, positions]
	);

	const tidyUp = useCallback(() => commitPositions({}), [commitPositions]);
	const openComposer = useCallback(() => setComposerOpen(true), []);
	const toggleComposer = useCallback(
		() => setComposerOpen((previous) => !previous),
		[]
	);
	const closeComposer = useCallback((restoreFocus: boolean) => {
		setComposerOpen(false);
		if (restoreFocus) {
			composerTriggerRef.current?.focus();
		}
	}, []);
	const pinNote = useCallback(
		(input: { agentId?: string; prompt: string }) => {
			setComposerOpen(false);
			port.startThread(input);
		},
		[port]
	);

	// The covering panel hides the board: move focus into it. Closing returns
	// focus to the note it came from when focus would otherwise be lost.
	const wasOpen = useRef(open);
	useEffect(() => {
		if (open && !wasOpen.current && overlay) {
			headingRef.current?.focus({ preventScroll: true });
		}
		if (!open && wasOpen.current && lastOpenedRef.current) {
			const focused = document.activeElement;
			if (!focused || focused === document.body) {
				boardRef.current
					?.querySelector<HTMLElement>(
						`[${NOTE_ATTRIBUTE}="${CSS.escape(lastOpenedRef.current)}"]`
					)
					?.focus({ preventScroll: false });
			}
		}
		wasOpen.current = open;
	}, [open, overlay]);

	useEffect(() => {
		if (activeThreadId) {
			lastOpenedRef.current = activeThreadId;
		}
	}, [activeThreadId]);

	// Escape puts the lifted note back (unless a field or the chat owns it).
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (isInterfaceCovered(rootRef.current)) {
				return;
			}
			if (event.defaultPrevented || event.key !== "Escape") {
				return;
			}
			if (dragRef.current?.moved) {
				event.preventDefault();
				dragRef.current = null;
				setDrag(null);
				return;
			}
			if (open && !ownsKeys(event.target)) {
				event.preventDefault();
				port.closeThread();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [open, port]);

	let board: ReactNode;
	if (loading) {
		board = <NoticeboardSkeleton width={boardWidth} />;
	} else if (snapshot.threads.length === 0) {
		board = (
			<NoticeboardEmpty
				hasAgents={snapshot.agents.length > 0}
				onPin={openComposer}
			/>
		);
	} else {
		board = (
			<div
				className="relative"
				style={{ height: layout.height, width: layout.width }}
			>
				<p className="sr-only" id={descriptionId}>
					Press Enter to open. Drag, or use the arrow keys, to move the note.
				</p>
				{areas.map((area) => {
					const placed = layout.areas.find(
						(item) => item.status === area.status
					);
					const headingId = `${idBase}-${area.status}`;
					return (
						<section aria-labelledby={headingId} key={area.status}>
							<h2
								className={cn(
									placed ? "absolute flex h-7 items-center gap-2" : "sr-only"
								)}
								id={headingId}
								style={
									placed
										? { left: placed.x, top: placed.y, width: placed.width }
										: undefined
								}
							>
								<PinDot status={area.status} />
								<span className="font-semibold text-foreground text-sm">
									{area.label}
								</span>
								<span className="text-foreground/60 text-sm tabular-nums">
									{area.notes.length}
								</span>
								<span
									aria-hidden="true"
									className="ms-2 h-px flex-1 bg-foreground/12"
								/>
							</h2>
							<ul aria-labelledby={headingId}>
								{area.notes.map((note) => {
									const threadId = note.thread.id;
									const placement = placements.get(threadId);
									const point =
										drag?.threadId === threadId
											? drag.point
											: { x: placement?.x ?? 0, y: placement?.y ?? 0 };
									return (
										<li key={threadId}>
											<NoticeboardNoteButton
												active={open && activeThreadId === threadId}
												age={compactAge(note.thread.updatedAt, now)}
												descriptionId={descriptionId}
												dragging={drag?.threadId === threadId}
												moved={placement?.placed ?? false}
												note={note}
												onClick={openThread}
												onKeyDown={onNoteKeyDown}
												onPointerCancel={onNotePointerCancel}
												onPointerDown={onNotePointerDown}
												onPointerMove={onNotePointerMove}
												onPointerUp={onNotePointerUp}
												point={point}
												reduceMotion={reduceMotion}
											/>
										</li>
									);
								})}
							</ul>
						</section>
					);
				})}
			</div>
		);
	}

	const boardHidden = open && overlay;
	return (
		<div
			className="relative flex size-full min-h-0 overflow-hidden bg-background text-foreground"
			data-testid="interface-noticeboard"
			ref={rootRef}
		>
			<div
				aria-hidden={boardHidden || undefined}
				className="relative flex min-h-0 min-w-0 flex-1 flex-col"
				inert={boardHidden}
			>
				<header className="flex h-14 shrink-0 items-center gap-3 border-border border-b bg-background px-4 sm:px-6">
					<div className="flex min-w-0 flex-1 items-baseline gap-3">
						<h1 className="shrink-0 font-semibold text-base text-foreground">
							Noticeboard
						</h1>
						{compact || loading ? null : (
							<p className="truncate text-muted-foreground text-sm">
								{summaryText(summary)}
							</p>
						)}
					</div>
					{moved && !loading ? (
						<Button onClick={tidyUp} size="sm" variant="ghost-muted">
							Tidy up
						</Button>
					) : null}
					<Button
						aria-expanded={composerOpen}
						aria-haspopup="dialog"
						data-noticeboard-composer-trigger=""
						onClick={toggleComposer}
						ref={composerTriggerRef}
						size="sm"
					>
						<Plus aria-hidden="true" data-icon="inline-start" />
						Pin a note
					</Button>
				</header>
				<div
					className={cn(
						"relative min-h-0 flex-1 overflow-auto",
						BOARD_SURFACE_CLASS
					)}
					data-testid="noticeboard-board"
					ref={boardRef}
					style={BOARD_SURFACE}
				>
					{board}
				</div>
				{composerOpen ? (
					<div className="absolute top-16 right-4 z-40 sm:right-6">
						<NoticeboardComposer
							agents={snapshot.agents}
							onClose={closeComposer}
							onSubmit={pinNote}
						/>
					</div>
				) : null}
			</div>
			{open ? (
				<NoticeboardPanel
					headingRef={headingRef}
					note={activeNote}
					now={now}
					onClose={closeThread}
					overlay={overlay}
					reduceMotion={reduceMotion}
					threadView={threadView}
					width={panelWidth}
				/>
			) : null}
		</div>
	);
}
