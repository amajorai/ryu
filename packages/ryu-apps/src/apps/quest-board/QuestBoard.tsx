// Quest Board — a hand-rolled HTML5 drag-drop kanban over the `ryu.quests` app
// tools (spec §5.3, app rank 6). The read tool `board` streams the grouped
// columns as `toolOutput`; the widget lets the user drag cards between columns,
// complete them inline, add new ones, and hand a quest back to the model.
//
// State model (D4): all UI mutations are OPTIMISTIC. We reflect the change into
// `window.ryu.widgetState` first (so the board re-renders instantly and survives
// reload), then fire the matching write tool over the governed `callTool` RPC. If
// the call fails we revert the optimistic slice and surface a dismissible error.
//
// The B1 Rust provider returns a stub/sample board, so this component renders and
// is fully driveable before the B2 quests-store wiring lands.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRyuGlobal } from "../../shared/useRyuGlobal";

// ---- tool wire names (spec §5.3) --------------------------------------------
// The host pins the widget's origin server (`ryu.quests`); we pass the tool's
// fully-qualified name as documented in the spec's `callTool('ryu.quests.update')`.
const TOOL_UPDATE = "ryu.quests.update";
const TOOL_COMPLETE = "ryu.quests.complete";
const TOOL_CREATE = "ryu.quests.create";

const FALLBACK_STATUS = "todo";
const FALLBACK_CWD = ".";

// ---- data shapes (mirror the `board` structuredContent) ---------------------
interface Quest {
	id: string;
	title: string;
	priority?: string;
	source?: string;
	detected_at?: string;
	project_cwd?: string;
}

interface BoardColumn {
	status: string;
	count?: number;
	quests?: Quest[];
}

interface BoardOutput {
	columns?: BoardColumn[];
}

interface BoardFilter {
	status?: string;
	project_cwd?: string;
}

interface BoardInput {
	filter?: BoardFilter;
	group_by?: "status" | "priority";
}

// ---- persisted widget state -------------------------------------------------
interface Placement {
	status: string;
	order: number;
}

interface QuestBoardState {
	/** Per-quest optimistic column + order override, merged onto `toolOutput`. */
	placements: Record<string, Placement>;
	/** Ids the user completed optimistically (hidden until the model refetches). */
	completed: string[];
	/** Locally-created quests not yet reflected in a fresh `board` output. */
	pending: Quest[];
}

const EMPTY_STATE: QuestBoardState = {
	placements: {},
	completed: [],
	pending: [],
};

interface DerivedQuest extends Quest {
	status: string;
	order: number;
}

interface DerivedColumn {
	status: string;
	quests: DerivedQuest[];
}

interface HoverTarget {
	status: string;
	index: number;
}

// ---- helpers ----------------------------------------------------------------
function readState(raw: unknown): QuestBoardState {
	if (!raw || typeof raw !== "object") {
		return EMPTY_STATE;
	}
	const value = raw as Partial<QuestBoardState>;
	return {
		placements:
			value.placements && typeof value.placements === "object"
				? value.placements
				: {},
		completed: Array.isArray(value.completed) ? value.completed : [],
		pending: Array.isArray(value.pending) ? value.pending : [],
	};
}

function readBoard(raw: unknown): BoardColumn[] | null {
	if (!raw || typeof raw !== "object") {
		return null;
	}
	const columns = (raw as BoardOutput).columns;
	return Array.isArray(columns) ? columns : null;
}

function titleCase(status: string): string {
	return status
		.replace(/[_-]+/g, " ")
		.replace(/\b\w/g, (char) => char.toUpperCase());
}

const PRIORITY_ORDER: Record<string, number> = {
	urgent: 0,
	high: 1,
	medium: 2,
	normal: 2,
	low: 3,
};

function priorityRank(priority?: string): number {
	if (!priority) {
		return 2;
	}
	return PRIORITY_ORDER[priority.toLowerCase()] ?? 2;
}

/** Merge raw columns + pending quests + placement/completed overrides into the
 *  columns actually rendered. Column identity/order comes from `toolOutput`. */
function deriveColumns(
	columns: BoardColumn[],
	state: QuestBoardState,
): DerivedColumn[] {
	const completed = new Set(state.completed);
	const natural = new Map<string, DerivedQuest>();
	const statusOrder: string[] = [];

	for (const column of columns) {
		if (!statusOrder.includes(column.status)) {
			statusOrder.push(column.status);
		}
		const quests = column.quests ?? [];
		for (const [index, quest] of quests.entries()) {
			natural.set(quest.id, {
				...quest,
				status: column.status,
				order: index,
			});
		}
	}

	for (const quest of state.pending) {
		const pendingStatus = (quest as DerivedQuest).status || FALLBACK_STATUS;
		natural.set(quest.id, {
			...quest,
			status: pendingStatus,
			// Sort locally-created quests to the end of their column.
			order: 1000 + natural.size,
		});
	}

	const buckets = new Map<string, DerivedQuest[]>();
	for (const status of statusOrder) {
		buckets.set(status, []);
	}

	for (const quest of natural.values()) {
		if (completed.has(quest.id)) {
			continue;
		}
		const override = state.placements[quest.id];
		const effective: DerivedQuest = override
			? { ...quest, status: override.status, order: override.order }
			: quest;
		if (!buckets.has(effective.status)) {
			buckets.set(effective.status, []);
			if (!statusOrder.includes(effective.status)) {
				statusOrder.push(effective.status);
			}
		}
		buckets.get(effective.status)?.push(effective);
	}

	for (const list of buckets.values()) {
		list.sort((a, b) => {
			if (a.order !== b.order) {
				return a.order - b.order;
			}
			const rank = priorityRank(a.priority) - priorityRank(b.priority);
			return rank !== 0 ? rank : a.title.localeCompare(b.title);
		});
	}

	return statusOrder.map((status) => ({
		status,
		quests: buckets.get(status) ?? [],
	}));
}

function resolveErrorMessage(error: unknown): string {
	if (error && typeof error === "object" && "message" in error) {
		return String((error as { message?: unknown }).message ?? "Request failed");
	}
	if (typeof error === "string") {
		return error;
	}
	return "Request failed";
}

// ---- icons (inline SVG; no external assets under the widget CSP) -------------
function CheckIcon() {
	return (
		<svg aria-hidden="true" height="14" viewBox="0 0 16 16" width="14">
			<path
				d="M13.5 4.5 6.5 11.5 2.5 7.5"
				fill="none"
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.8"
			/>
		</svg>
	);
}

function ChatIcon() {
	return (
		<svg aria-hidden="true" height="14" viewBox="0 0 16 16" width="14">
			<path
				d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"
				fill="none"
				stroke="currentColor"
				strokeLinejoin="round"
				strokeWidth="1.4"
			/>
		</svg>
	);
}

function PlusIcon() {
	return (
		<svg aria-hidden="true" height="14" viewBox="0 0 16 16" width="14">
			<path
				d="M8 3v10M3 8h10"
				fill="none"
				stroke="currentColor"
				strokeLinecap="round"
				strokeWidth="1.6"
			/>
		</svg>
	);
}

function GripIcon() {
	return (
		<svg aria-hidden="true" height="14" viewBox="0 0 16 16" width="14">
			<g fill="currentColor">
				<circle cx="6" cy="4" r="1" />
				<circle cx="6" cy="8" r="1" />
				<circle cx="6" cy="12" r="1" />
				<circle cx="10" cy="4" r="1" />
				<circle cx="10" cy="8" r="1" />
				<circle cx="10" cy="12" r="1" />
			</g>
		</svg>
	);
}

// ---- card -------------------------------------------------------------------
interface CardProps {
	quest: DerivedQuest;
	dragging: boolean;
	busy: boolean;
	onDragStart: (id: string) => void;
	onDragEnd: () => void;
	onComplete: (id: string) => void;
	onDiscuss: (quest: DerivedQuest) => void;
}

function QuestCard({
	quest,
	dragging,
	busy,
	onDragStart,
	onDragEnd,
	onComplete,
	onDiscuss,
}: CardProps) {
	const priority = quest.priority?.toLowerCase() ?? "medium";
	return (
		<article
			aria-label={quest.title}
			className={`qb-card${dragging ? " qb-card--dragging" : ""}`}
			draggable={!busy}
			onDragEnd={onDragEnd}
			onDragStart={(event) => {
				event.dataTransfer.effectAllowed = "move";
				event.dataTransfer.setData("text/plain", quest.id);
				onDragStart(quest.id);
			}}
		>
			<span className="qb-card__grip" aria-hidden="true">
				<GripIcon />
			</span>
			<div className="qb-card__body">
				<p className="qb-card__title">{quest.title}</p>
				<div className="qb-card__meta">
					<span className={`qb-badge qb-badge--${priority}`}>{priority}</span>
					{quest.source ? (
						<span className="qb-card__source">{quest.source}</span>
					) : null}
				</div>
			</div>
			<div className="qb-card__actions">
				<button
					aria-label={`Discuss "${quest.title}" with the agent`}
					className="qb-icon-btn"
					disabled={busy}
					onClick={() => onDiscuss(quest)}
					type="button"
				>
					<ChatIcon />
				</button>
				<button
					aria-label={`Complete "${quest.title}"`}
					className="qb-icon-btn qb-icon-btn--done"
					disabled={busy}
					onClick={() => onComplete(quest.id)}
					type="button"
				>
					<CheckIcon />
				</button>
			</div>
		</article>
	);
}

// ---- add form ---------------------------------------------------------------
interface AddFormProps {
	status: string;
	onCreate: (status: string, title: string) => void;
}

function AddQuest({ status, onCreate }: AddFormProps) {
	const [open, setOpen] = useState(false);
	const [title, setTitle] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (open) {
			inputRef.current?.focus();
		}
	}, [open]);

	const submit = () => {
		const trimmed = title.trim();
		if (!trimmed) {
			return;
		}
		onCreate(status, trimmed);
		setTitle("");
		setOpen(false);
	};

	if (!open) {
		return (
			<button
				className="qb-add-btn"
				onClick={() => setOpen(true)}
				type="button"
			>
				<PlusIcon />
				<span>Add quest</span>
			</button>
		);
	}

	return (
		<div className="qb-add-form">
			<input
				aria-label="New quest title"
				className="qb-add-input"
				onChange={(event) => setTitle(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter") {
						submit();
					} else if (event.key === "Escape") {
						setOpen(false);
						setTitle("");
					}
				}}
				placeholder="Quest title…"
				ref={inputRef}
				value={title}
			/>
			<div className="qb-add-form__row">
				<button
					className="qb-btn qb-btn--primary"
					onClick={submit}
					type="button"
				>
					Add
				</button>
				<button
					className="qb-btn"
					onClick={() => {
						setOpen(false);
						setTitle("");
					}}
					type="button"
				>
					Cancel
				</button>
			</div>
		</div>
	);
}

// ---- board ------------------------------------------------------------------
let pendingSeq = 0;

export function QuestBoard() {
	const toolOutput = useRyuGlobal("toolOutput");
	const toolInput = useRyuGlobal("toolInput");
	const rawWidgetState = useRyuGlobal("widgetState");
	// Read theme so a host theme change re-renders the tree; `tokens.css` +
	// `WidgetRoot` stamp `data-theme`, so colors resolve without extra work.
	const theme = useRyuGlobal("theme");

	const [error, setError] = useState<string | null>(null);
	const [draggingId, setDraggingId] = useState<string | null>(null);
	const [hover, setHover] = useState<HoverTarget | null>(null);
	const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());

	const state = useMemo(() => readState(rawWidgetState), [rawWidgetState]);
	const columns = readBoard(toolOutput);

	const derived = useMemo(
		() => (columns ? deriveColumns(columns, state) : []),
		[columns, state],
	);

	const totalQuests = derived.reduce((sum, col) => sum + col.quests.length, 0);

	const defaultCwd = useMemo(() => {
		const input = (toolInput ?? null) as BoardInput | null;
		if (input?.filter?.project_cwd) {
			return input.filter.project_cwd;
		}
		if (columns) {
			for (const column of columns) {
				const withCwd = (column.quests ?? []).find((q) => q.project_cwd);
				if (withCwd?.project_cwd) {
					return withCwd.project_cwd;
				}
			}
		}
		return FALLBACK_CWD;
	}, [toolInput, columns]);

	const persist = useCallback((next: QuestBoardState) => {
		// Optimistic local write + best-effort server persistence (D4).
		void window.ryu?.setWidgetState(next);
	}, []);

	const setBusy = useCallback((id: string, on: boolean) => {
		setBusyIds((prev) => {
			const next = new Set(prev);
			if (on) {
				next.add(id);
			} else {
				next.delete(id);
			}
			return next;
		});
	}, []);

	// Report intrinsic height whenever the rendered board changes. `WidgetRoot`
	// also observes resize; this is the explicit belt-and-suspenders call.
	useEffect(() => {
		// `derived` + `error` change the rendered height; re-report on either so
		// the host can size the iframe to fit the current board.
		const boardIsRenderable = derived.length >= 0;
		const errorText = error ?? "";
		if (boardIsRenderable || errorText.length > 0) {
			window.ryu?.notifyIntrinsicHeight(
				Math.ceil(document.documentElement.scrollHeight),
			);
		}
	}, [derived, error]);

	const moveQuest = useCallback(
		(id: string, targetStatus: string, targetIndex: number) => {
			if (!columns) {
				return;
			}
			const before = state;
			const targetList = derived.find((col) => col.status === targetStatus);
			const remaining = (targetList?.quests ?? []).filter((q) => q.id !== id);
			const clamped = Math.max(0, Math.min(targetIndex, remaining.length));
			const ordered = [
				...remaining.slice(0, clamped).map((q) => q.id),
				id,
				...remaining.slice(clamped).map((q) => q.id),
			];

			const placements = { ...state.placements };
			for (const [index, questId] of ordered.entries()) {
				placements[questId] = { status: targetStatus, order: index };
			}
			const next: QuestBoardState = { ...state, placements };
			persist(next);
			setError(null);

			setBusy(id, true);
			void window.ryu
				?.callTool(TOOL_UPDATE, {
					id,
					status: targetStatus,
					order: clamped,
				})
				.catch((err: unknown) => {
					persist(before);
					setError(resolveErrorMessage(err));
				})
				.finally(() => setBusy(id, false));
		},
		[columns, derived, state, persist, setBusy],
	);

	const completeQuest = useCallback(
		(id: string) => {
			const before = state;
			const next: QuestBoardState = {
				...state,
				completed: state.completed.includes(id)
					? state.completed
					: [...state.completed, id],
			};
			persist(next);
			setError(null);

			setBusy(id, true);
			void window.ryu
				?.callTool(TOOL_COMPLETE, { id })
				.catch((err: unknown) => {
					persist(before);
					setError(resolveErrorMessage(err));
				})
				.finally(() => setBusy(id, false));
		},
		[state, persist, setBusy],
	);

	const createQuest = useCallback(
		(status: string, title: string) => {
			pendingSeq += 1;
			const tempId = `pending-${Date.now()}-${pendingSeq}`;
			const optimistic: Quest = {
				id: tempId,
				title,
				priority: "medium",
				source: "widget",
				project_cwd: defaultCwd,
			};
			const before = state;
			const withStatus = { ...optimistic, status } as DerivedQuest;
			const next: QuestBoardState = {
				...state,
				pending: [...state.pending, withStatus],
			};
			persist(next);
			setError(null);

			setBusy(tempId, true);
			void window.ryu
				?.callTool(TOOL_CREATE, { title, project_cwd: defaultCwd })
				.catch((err: unknown) => {
					persist(before);
					setError(resolveErrorMessage(err));
				})
				.finally(() => setBusy(tempId, false));
		},
		[state, persist, setBusy, defaultCwd],
	);

	const discussQuest = useCallback((quest: DerivedQuest) => {
		setError(null);
		void window.ryu
			?.sendFollowUpMessage({
				prompt: `Let's work on the quest "${quest.title}". Break it into concrete next steps.`,
			})
			.catch((err: unknown) => setError(resolveErrorMessage(err)));
	}, []);

	// ---- drag plumbing ----
	const onColumnDragOver = (
		event: React.DragEvent,
		status: string,
		questIds: string[],
	) => {
		if (!draggingId) {
			return;
		}
		event.preventDefault();
		event.dataTransfer.dropEffect = "move";
		const cards =
			event.currentTarget.querySelectorAll<HTMLElement>("[data-card-id]");
		let index = questIds.length;
		for (const [i, card] of Array.from(cards).entries()) {
			const rect = card.getBoundingClientRect();
			if (event.clientY < rect.top + rect.height / 2) {
				index = i;
				break;
			}
		}
		setHover((prev) =>
			prev?.status === status && prev.index === index
				? prev
				: { status, index },
		);
	};

	const onColumnDrop = (event: React.DragEvent, status: string) => {
		event.preventDefault();
		const id = draggingId ?? event.dataTransfer.getData("text/plain");
		const index =
			hover?.status === status ? hover.index : Number.MAX_SAFE_INTEGER;
		if (id) {
			moveQuest(id, status, index);
		}
		setDraggingId(null);
		setHover(null);
	};

	// ---- render states ----
	if (columns === null) {
		return (
			<div className="qb" data-theme={theme}>
				<div
					aria-busy="true"
					aria-label="Loading quests"
					className="qb-skeleton"
					role="status"
				>
					{[0, 1, 2].map((col) => (
						<div className="qb-skeleton__col" key={col}>
							<div className="qb-skeleton__head" />
							<div className="qb-skeleton__card" />
							<div className="qb-skeleton__card" />
						</div>
					))}
				</div>
			</div>
		);
	}

	return (
		<div className="qb" data-theme={theme}>
			<header className="qb-header">
				<h1 className="qb-title">Quest Board</h1>
				<span className="qb-count">{totalQuests} open</span>
			</header>

			{error ? (
				<div className="qb-error" role="alert">
					<span>{error}</span>
					<button
						aria-label="Dismiss error"
						className="qb-error__close"
						onClick={() => setError(null)}
						type="button"
					>
						×
					</button>
				</div>
			) : null}

			{derived.length === 0 ? (
				<div className="qb-empty">
					<p className="qb-empty__title">No quests yet</p>
					<p className="qb-empty__hint">
						Quests appear as Ryu detects work. The board updates live.
					</p>
				</div>
			) : (
				<div className="qb-columns">
					{derived.map((column) => {
						const questIds = column.quests.map((q) => q.id);
						const isHoverCol = hover?.status === column.status;
						return (
							<section
								aria-label={`${titleCase(column.status)} column`}
								className={`qb-column${
									isHoverCol && draggingId ? " qb-column--over" : ""
								}`}
								key={column.status}
								onDragLeave={(event) => {
									if (event.currentTarget === event.target) {
										setHover((prev) =>
											prev?.status === column.status ? null : prev,
										);
									}
								}}
								onDragOver={(event) =>
									onColumnDragOver(event, column.status, questIds)
								}
								onDrop={(event) => onColumnDrop(event, column.status)}
							>
								<header className="qb-column__head">
									<span className="qb-column__name">
										{titleCase(column.status)}
									</span>
									<span className="qb-column__count">
										{column.quests.length}
									</span>
								</header>
								<div className="qb-column__body">
									{column.quests.map((quest, index) => (
										<div data-card-id={quest.id} key={quest.id}>
											{isHoverCol && draggingId && hover?.index === index ? (
												<div className="qb-drop-line" aria-hidden="true" />
											) : null}
											<QuestCard
												busy={busyIds.has(quest.id)}
												dragging={draggingId === quest.id}
												onComplete={completeQuest}
												onDiscuss={discussQuest}
												onDragEnd={() => {
													setDraggingId(null);
													setHover(null);
												}}
												onDragStart={setDraggingId}
												quest={quest}
											/>
										</div>
									))}
									{isHoverCol &&
									draggingId &&
									hover !== null &&
									hover.index >= column.quests.length ? (
										<div className="qb-drop-line" aria-hidden="true" />
									) : null}
									{column.quests.length === 0 && !draggingId ? (
										<p className="qb-column__empty">Drop quests here</p>
									) : null}
								</div>
								<AddQuest onCreate={createQuest} status={column.status} />
							</section>
						);
					})}
				</div>
			)}
		</div>
	);
}
