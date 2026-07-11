// The Checklist widget component (spec §6.1, the flagship first vertical).
//
// Reads the tool result via `useRyuGlobal("toolOutput")` (the `checklist__render`
// structuredContent `{ list_id, title, items:[{id,text,done,order}] }`), renders an
// interactive checklist, and drives every mutation through the governed bridge:
//   - toggle / add / edit / remove  -> window.ryu.callTool("checklist__update", ...)
//   - "Approve selected"            -> window.ryu.sendFollowUpMessage({ prompt })
//   - UI state persisted            -> window.ryu.setWidgetState({ items })
// Theme + intrinsic-height are handled for free by `WidgetRoot` (host.tsx), which
// reads `useRyuGlobal("theme")` and calls `notifyIntrinsicHeight` on resize.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRyuGlobal } from "../../shared/useRyuGlobal";

/** One checklist row as it lives in tool output + widget state. */
interface ChecklistItem {
	id: string;
	text: string;
	done: boolean;
	order: number;
}

/** The `checklist__render` structuredContent shape. */
interface ChecklistOutput {
	list_id: string;
	title: string;
	items: ChecklistItem[];
}

/** The persisted `widgetState` overlay (D4): the last-known item list, so a reload
 *  paints the user's edits before the re-emitted tool output arrives. */
interface ChecklistWidgetState {
	items: ChecklistItem[];
}

const UPDATE_TOOL = "checklist__update";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Coerce one unknown row into a `ChecklistItem`, tolerating missing fields. */
function toItem(value: unknown, index: number): ChecklistItem | null {
	if (!isRecord(value)) {
		return null;
	}
	const text = typeof value.text === "string" ? value.text : "";
	const id =
		typeof value.id === "string" && value.id.length > 0
			? value.id
			: `item-${index}`;
	const order = typeof value.order === "number" ? value.order : index;
	return { id, text, done: value.done === true, order };
}

/** Pull a normalized `ChecklistItem[]` out of any object that carries an `items`
 *  array (tolerant of `{items}`, `{output:{items}}`, `{structuredContent:{items}}`
 *  wrappers a governed round-trip may add). */
function extractItems(source: unknown): ChecklistItem[] | null {
	if (!isRecord(source)) {
		return null;
	}
	const candidates = [
		source.items,
		isRecord(source.output) ? source.output.items : undefined,
		isRecord(source.structuredContent)
			? source.structuredContent.items
			: undefined,
	];
	for (const candidate of candidates) {
		if (Array.isArray(candidate)) {
			return candidate
				.map((row, index) => toItem(row, index))
				.filter((item): item is ChecklistItem => item !== null)
				.sort((a, b) => a.order - b.order);
		}
	}
	return null;
}

/** Parse the `toolOutput` global into a typed output, or `null` while it is still
 *  loading / malformed. */
function parseOutput(toolOutput: unknown): ChecklistOutput | null {
	if (!isRecord(toolOutput)) {
		return null;
	}
	const items = extractItems(toolOutput);
	if (items === null) {
		return null;
	}
	const listId =
		typeof toolOutput.list_id === "string" ? toolOutput.list_id : "";
	const title =
		typeof toolOutput.title === "string" ? toolOutput.title : "Checklist";
	return { list_id: listId, title, items };
}

/** Inline check-mark icon. */
function CheckIcon() {
	return (
		<svg
			aria-hidden="true"
			fill="none"
			focusable="false"
			height="14"
			viewBox="0 0 24 24"
			width="14"
		>
			<title>done</title>
			<path
				d="M5 12.5l4.2 4.2L19 7"
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="2.6"
			/>
		</svg>
	);
}

/** Inline trash icon. */
function TrashIcon() {
	return (
		<svg
			aria-hidden="true"
			fill="none"
			focusable="false"
			height="15"
			viewBox="0 0 24 24"
			width="15"
		>
			<title>remove</title>
			<path
				d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m2 0v12a1 1 0 01-1 1H7a1 1 0 01-1-1V7"
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.8"
			/>
		</svg>
	);
}

/** Inline plus icon. */
function PlusIcon() {
	return (
		<svg
			aria-hidden="true"
			fill="none"
			focusable="false"
			height="16"
			viewBox="0 0 24 24"
			width="16"
		>
			<title>add</title>
			<path
				d="M12 5v14M5 12h14"
				stroke="currentColor"
				strokeLinecap="round"
				strokeWidth="2"
			/>
		</svg>
	);
}

/** Small close/x icon for the error banner. */
function CloseIcon() {
	return (
		<svg
			aria-hidden="true"
			fill="none"
			focusable="false"
			height="14"
			viewBox="0 0 24 24"
			width="14"
		>
			<title>dismiss</title>
			<path
				d="M6 6l12 12M18 6L6 18"
				stroke="currentColor"
				strokeLinecap="round"
				strokeWidth="2"
			/>
		</svg>
	);
}

function LoadingSkeleton() {
	const rows = [0, 1, 2];
	return (
		<section
			aria-busy="true"
			className="checklist"
			aria-label="Loading checklist"
		>
			<div className="checklist__skeleton">
				{rows.map((row) => (
					<div
						className="checklist__skeleton-row"
						key={row}
						style={{ width: `${70 - row * 12}%` }}
					/>
				))}
			</div>
		</section>
	);
}

export function Checklist() {
	const toolOutput = useRyuGlobal("toolOutput");
	const widgetState = useRyuGlobal("widgetState");

	const output = useMemo(() => parseOutput(toolOutput), [toolOutput]);

	const [items, setItems] = useState<ChecklistItem[] | null>(null);
	const [listId, setListId] = useState("");
	const [title, setTitle] = useState("Checklist");
	const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());
	const [editingId, setEditingId] = useState<string | null>(null);
	const [draft, setDraft] = useState("");
	const [newText, setNewText] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [approving, setApproving] = useState(false);

	// The list_id we have already seeded from, so a host push of the SAME list does
	// not clobber the user's in-flight local edits, but a brand-new render does.
	const seededList = useRef<string | null>(null);

	// Seed from persisted widgetState once, before/alongside the first tool output.
	useEffect(() => {
		if (items !== null || !isRecord(widgetState)) {
			return;
		}
		const restored = extractItems(widgetState);
		if (restored && restored.length > 0) {
			setItems(restored);
		}
	}, [widgetState, items]);

	// Adopt the tool output as the source of truth on first load and whenever the
	// list identity changes (a new `checklist__render`).
	useEffect(() => {
		if (!output) {
			return;
		}
		setTitle(output.title);
		setListId(output.list_id);
		const isNewList = seededList.current !== output.list_id;
		if (isNewList || items === null) {
			seededList.current = output.list_id;
			setItems(output.items);
		}
	}, [output, items]);

	const persist = useCallback((next: ChecklistItem[]) => {
		// Best-effort local persistence (D4): survives a reload; the host mirrors it
		// server-side. Never throws into the UI.
		void window.ryu?.setWidgetState({
			items: next,
		} satisfies ChecklistWidgetState);
	}, []);

	const markPending = useCallback((id: string, on: boolean) => {
		setPendingIds((prev) => {
			const next = new Set(prev);
			if (on) {
				next.add(id);
			} else {
				next.delete(id);
			}
			return next;
		});
	}, []);

	/** Run a governed `checklist__update` and reconcile with the returned items.
	 *  `optimistic` is applied immediately; on failure we revert to `snapshot`. */
	const runUpdate = useCallback(
		async (
			args: Record<string, unknown>,
			optimistic: ChecklistItem[],
			snapshot: ChecklistItem[],
			pendingId?: string,
		) => {
			if (!window.ryu) {
				setError("Widget bridge is not ready yet.");
				return;
			}
			setError(null);
			setItems(optimistic);
			persist(optimistic);
			if (pendingId) {
				markPending(pendingId, true);
			}
			try {
				const result = await window.ryu.callTool(UPDATE_TOOL, {
					list_id: listId,
					...args,
				});
				const reconciled = extractItems(result);
				if (reconciled) {
					setItems(reconciled);
					persist(reconciled);
				}
			} catch (rpcError) {
				setItems(snapshot);
				persist(snapshot);
				const message =
					rpcError instanceof Error
						? rpcError.message
						: "Could not update the checklist.";
				setError(message);
			} finally {
				if (pendingId) {
					markPending(pendingId, false);
				}
			}
		},
		[listId, persist, markPending],
	);

	const handleToggle = useCallback(
		(item: ChecklistItem) => {
			if (!items) {
				return;
			}
			const snapshot = items;
			const optimistic = items.map((row) =>
				row.id === item.id ? { ...row, done: !row.done } : row,
			);
			void runUpdate(
				{ item_id: item.id, op: "toggle" },
				optimistic,
				snapshot,
				item.id,
			);
		},
		[items, runUpdate],
	);

	const handleRemove = useCallback(
		(item: ChecklistItem) => {
			if (!items) {
				return;
			}
			const snapshot = items;
			const optimistic = items.filter((row) => row.id !== item.id);
			void runUpdate(
				{ item_id: item.id, op: "remove" },
				optimistic,
				snapshot,
				item.id,
			);
		},
		[items, runUpdate],
	);

	const commitEdit = useCallback(
		(item: ChecklistItem) => {
			const trimmed = draft.trim();
			setEditingId(null);
			if (!(items && trimmed) || trimmed === item.text) {
				return;
			}
			const snapshot = items;
			const optimistic = items.map((row) =>
				row.id === item.id ? { ...row, text: trimmed } : row,
			);
			void runUpdate(
				{ item_id: item.id, op: "edit", text: trimmed },
				optimistic,
				snapshot,
				item.id,
			);
		},
		[draft, items, runUpdate],
	);

	const handleAdd = useCallback(() => {
		const trimmed = newText.trim();
		if (!trimmed) {
			return;
		}
		const current = items ?? [];
		const snapshot = current;
		const tempId = `temp-${Date.now()}`;
		const optimistic: ChecklistItem[] = [
			...current,
			{
				id: tempId,
				text: trimmed,
				done: false,
				order: current.length,
			},
		];
		setNewText("");
		void runUpdate({ op: "add", text: trimmed }, optimistic, snapshot, tempId);
	}, [newText, items, runUpdate]);

	const startEdit = useCallback((item: ChecklistItem) => {
		setEditingId(item.id);
		setDraft(item.text);
	}, []);

	const checkedItems = useMemo(
		() => (items ?? []).filter((item) => item.done),
		[items],
	);

	const handleApprove = useCallback(async () => {
		if (!(window.ryu && checkedItems.length > 0)) {
			return;
		}
		const lines = checkedItems.map((item) => `- ${item.text}`).join("\n");
		const heading = title.trim()
			? `${title.trim()}: approved items`
			: "Approved items";
		const prompt = `${heading}\n${lines}`;
		setError(null);
		setApproving(true);
		try {
			await window.ryu.sendFollowUpMessage({ prompt });
		} catch (followUpError) {
			const message =
				followUpError instanceof Error
					? followUpError.message
					: "Could not send the approval.";
			setError(message);
		} finally {
			setApproving(false);
		}
	}, [checkedItems, title]);

	// Loading: no output parsed yet and nothing restored from widgetState.
	if (items === null) {
		return <LoadingSkeleton />;
	}

	const total = items.length;
	const doneCount = checkedItems.length;

	return (
		<section aria-label={title} className="checklist">
			<header className="checklist__header">
				<h1 className="checklist__title">{title}</h1>
				{total > 0 ? (
					<span className="checklist__count">
						{doneCount}/{total} done
					</span>
				) : null}
			</header>

			{error ? (
				<div className="checklist__error" role="alert">
					<span>{error}</span>
					<button
						aria-label="Dismiss error"
						className="checklist__error-dismiss"
						onClick={() => setError(null)}
						type="button"
					>
						<CloseIcon />
					</button>
				</div>
			) : null}

			{total === 0 ? (
				<p className="checklist__empty">
					No items yet. Add one below to get started.
				</p>
			) : (
				<ul className="checklist__items">
					{items.map((item) => {
						const isEditing = editingId === item.id;
						const isPending = pendingIds.has(item.id);
						return (
							<li
								className="checklist__item"
								data-pending={isPending}
								key={item.id}
							>
								<label className="checklist__check">
									<input
										aria-label={
											item.done
												? `Mark "${item.text}" not done`
												: `Mark "${item.text}" done`
										}
										checked={item.done}
										className="checklist__check-input"
										disabled={isPending}
										onChange={() => handleToggle(item)}
										type="checkbox"
									/>
									<span aria-hidden="true" className="checklist__check-box">
										<CheckIcon />
									</span>
								</label>

								{isEditing ? (
									<input
										// biome-ignore lint/a11y/noAutofocus: focus the field the user just opened
										autoFocus
										className="checklist__edit-input"
										onBlur={() => commitEdit(item)}
										onChange={(event) => setDraft(event.target.value)}
										onKeyDown={(event) => {
											if (event.key === "Enter") {
												event.preventDefault();
												commitEdit(item);
											} else if (event.key === "Escape") {
												setEditingId(null);
											}
										}}
										value={draft}
									/>
								) : (
									<button
										className="checklist__text"
										data-done={item.done}
										onClick={() => startEdit(item)}
										title="Click to edit"
										type="button"
									>
										{item.text || "Untitled"}
									</button>
								)}

								<button
									aria-label={`Remove "${item.text}"`}
									className="checklist__remove"
									disabled={isPending}
									onClick={() => handleRemove(item)}
									type="button"
								>
									<TrashIcon />
								</button>
							</li>
						);
					})}
				</ul>
			)}

			<div className="checklist__add">
				<PlusIcon />
				<input
					aria-label="Add a checklist item"
					className="checklist__add-input"
					onChange={(event) => setNewText(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							event.preventDefault();
							handleAdd();
						}
					}}
					placeholder="Add an item and press Enter"
					value={newText}
				/>
			</div>

			<footer className="checklist__footer">
				<span className="checklist__hint">
					{doneCount > 0
						? `${doneCount} selected`
						: "Check items, then approve"}
				</span>
				<button
					className="checklist__approve"
					disabled={doneCount === 0 || approving}
					onClick={handleApprove}
					type="button"
				>
					{approving ? "Sending…" : "Approve selected"}
				</button>
			</footer>
		</section>
	);
}
