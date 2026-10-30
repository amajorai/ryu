import type { CSSProperties } from "react";
import crmStyles from "./crm-values.module.css";

interface CrmDataStyle extends CSSProperties {
	"--crm-color"?: string;
	"--crm-share"?: string;
}

import { isNativeNumber } from "@ryu/ui/lib/native-primitive-observation.ts";
// The kanban board: records grouped into columns by a select/status field.
//
// The column set comes from the FIELD's declared options, not from the values that
// happen to be present — an empty stage is a real and important thing to see, and a
// board built from `DISTINCT(value)` silently hides the stage nobody has reached.
// Records with no value land in a leading "Unassigned" column rather than being
// dropped, for the same reason.
//
// Dragging a card writes the group-by field back optimistically and rolls back on
// failure. That write is the same `updateRecord` merge a grid cell edit uses, so it
// raises the same `deal.stage_changed` hook event — a board drag and a PATCH are
// indistinguishable to an automation, which is what makes automations trustworthy.

import { Alert01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	formatCents,
	formatValue,
	recordTitle,
} from "@/src/components/panels/crm/fields.tsx";
import type {
	CrmClient,
	CrmRecord,
	Field,
	ObjectWithFields,
	SelectOption,
	View,
} from "@/src/lib/api/crm.ts";

/** A board loads more rows than a grid page because every column is on screen at
 *  once; the server still clamps it. */
const BOARD_LIMIT = 300;

/** The synthetic column for records whose group-by field is empty. Not a real
 *  option id, and never written back — dropping a card here CLEARS the field. */
const UNASSIGNED = "__unassigned__";

export function BoardView({
	client,
	onOpenRecord,
	search,
	subject,
	view,
}: {
	client: CrmClient;
	onOpenRecord: (recordId: string) => void;
	search: string;
	subject: ObjectWithFields;
	view: View;
}) {
	const tl = useLiteralMessages();
	const [records, setRecords] = useState<CrmRecord[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [dragging, setDragging] = useState<string | null>(null);
	const [dropTarget, setDropTarget] = useState<string | null>(null);

	const groupField = useMemo<Field | undefined>(
		() =>
			subject.fields.find((f) => f.id === view.group_by_field_id) ??
			subject.fields.find(
				(f) => f.field_type === "status" || f.field_type === "select"
			),
		[subject.fields, view.group_by_field_id]
	);

	/** The currency field a column header totals, if the object has one. */
	const valueField = useMemo(
		() => subject.fields.find((f) => f.field_type === "currency"),
		[subject.fields]
	);

	const titleField = useMemo(
		() => subject.fields.find((f) => f.id === subject.object.title_field_id),
		[subject.fields, subject.object.title_field_id]
	);

	/** Two fields worth showing under a card's title, chosen once so every card in
	 *  a board shows the same two rather than whatever each record happens to have. */
	const cardFields = useMemo(
		() =>
			subject.fields
				.filter(
					(f) =>
						!f.is_system && f.id !== groupField?.id && f.id !== titleField?.id
				)
				.slice(0, 2),
		[groupField?.id, subject.fields, titleField?.id]
	);

	const slug = subject.object.slug;
	const filter = view.filter ?? null;

	const load = useCallback(
		(signal?: AbortSignal) => {
			setLoading(true);
			setError(null);
			return client
				.queryRecords(
					slug,
					{
						filter,
						limit: BOARD_LIMIT,
						search: search.trim() === "" ? null : search.trim(),
						sorts: view.sorts ?? [],
					},
					signal
				)
				.then((page) => setRecords(page.items))
				.catch((cause) => {
					if (signal?.aborted) {
						return;
					}
					setError(cause instanceof Error ? cause.message : String(cause));
				})
				.finally(() => {
					if (!signal?.aborted) {
						setLoading(false);
					}
				});
		},
		[client, filter, search, slug, view.sorts]
	);

	useEffect(() => {
		const controller = new AbortController();
		void load(controller.signal);
		return () => controller.abort();
	}, [load]);

	const columns = useMemo(() => {
		const options: (SelectOption | { id: string; label: string })[] = [
			{ id: UNASSIGNED, label: "Unassigned" },
			...(groupField?.config?.options ?? []),
		];
		return options.map((option) => {
			const items = records.filter((record) => {
				const raw = groupField ? record.values?.[groupField.slug] : undefined;
				return option.id === UNASSIGNED
					? raw === null || raw === undefined || raw === ""
					: raw === option.id;
			});
			const total = valueField
				? items.reduce((sum, record) => {
						const cents = record.values?.[valueField.slug];
						return sum + (isNativeNumber(cents) ? cents : 0);
					}, 0)
				: 0;
			return { items, option, total };
		});
	}, [groupField, records, valueField]);

	const moveCard = async (recordId: string, optionId: string) => {
		setDragging(null);
		setDropTarget(null);
		if (!groupField) {
			return;
		}
		const record = records.find((r) => r.id === recordId);
		if (!record) {
			return;
		}
		const previous = record.values?.[groupField.slug];
		const next = optionId === UNASSIGNED ? null : optionId;
		if (previous === next) {
			return;
		}
		setRecords((current) =>
			current.map((row) =>
				row.id === recordId
					? { ...row, values: { ...row.values, [groupField.slug]: next } }
					: row
			)
		);
		try {
			const updated = await client.updateRecord(recordId, {
				[groupField.slug]: next,
			});
			setRecords((current) =>
				current.map((row) => (row.id === recordId ? updated : row))
			);
		} catch (cause) {
			setRecords((current) =>
				current.map((row) =>
					row.id === recordId
						? {
								...row,
								values: { ...row.values, [groupField.slug]: previous },
							}
						: row
				)
			);
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	};

	if (!groupField) {
		return (
			<div className="flex h-full items-center justify-center p-6 text-center text-muted-foreground text-sm">
				{tl(
					"A board needs a select or status field to group by, and {objectPlural} has none yet. Add one in the schema editor.",
					{ objectPlural: subject.object.plural }
				)}
			</div>
		);
	}

	return (
		<div className="flex h-full min-h-0 flex-col">
			{error && (
				<div className="flex items-start gap-2 border-b bg-destructive/10 px-3 py-2 text-status-destructive text-xs">
					<HugeiconsIcon icon={Alert01Icon} size={14} />
					<span>{error}</span>
				</div>
			)}
			{/* The board scrolls horizontally inside its own container; the panel
			    body never does. */}
			<div className="scroll-fade-x flex min-h-0 flex-1 gap-3 overflow-x-auto p-3">
				{columns.map(({ items, option, total }) => {
					const colour = "color" in option ? option.color : undefined;
					const colorStyle: CrmDataStyle = {
						"--crm-color": colour ?? undefined,
					};
					return (
						// a drop zone is a region, and every card it holds is independently reachable by keyboard
						<section
							aria-label={`${option.label} — ${items.length} ${
								items.length === 1
									? subject.object.singular
									: subject.object.plural
							}`}
							className={cn(
								"flex w-64 shrink-0 flex-col rounded-lg border bg-muted/30",
								dropTarget === option.id && "ring-2 ring-primary"
							)}
							key={option.id}
							onDragLeave={() =>
								setDropTarget((t) => (t === option.id ? null : t))
							}
							onDragOver={(event) => {
								event.preventDefault();
								setDropTarget(option.id);
							}}
							onDrop={(event) => {
								event.preventDefault();
								if (dragging) {
									void moveCard(dragging, option.id);
								}
							}}
						>
							<header className="flex items-center justify-between gap-2 border-b px-3 py-2">
								<div className="flex min-w-0 items-center gap-2">
									{colour && (
										<span
											aria-hidden="true"
											className={cn(
												crmStyles.color,
												"size-2 shrink-0 rounded-full"
											)}
											style={colorStyle}
										/>
									)}
									<span
										className="truncate font-medium text-sm"
										title={option.label}
									>
										{option.label}
									</span>
								</div>
								<div className="flex shrink-0 items-center gap-1.5">
									{valueField && total > 0 && (
										<span className="font-mono text-muted-foreground text-xs tabular-nums">
											{formatCents(
												total,
												valueField.config?.currency_code ?? "USD"
											)}
										</span>
									)}
									<Badge typography="normal" variant="secondary">
										{items.length}
									</Badge>
								</div>
							</header>

							<div className="scroll-fade flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
								{loading && records.length === 0 ? (
									<Skeleton className="h-16 w-full" />
								) : (
									items.map((record) => (
										// the draggable wrapper carries the drag handlers; the button inside is the keyboard-reachable control
										<div
											className={cn(
												"rounded-lg border border-border bg-card p-2",
												dragging === record.id && "opacity-50"
											)}
											draggable
											key={record.id}
											onDragEnd={() => {
												setDragging(null);
												setDropTarget(null);
											}}
											onDragStart={() => setDragging(record.id)}
										>
											<button
												className="w-full text-left"
												onClick={() => onOpenRecord(record.id)}
												type="button"
											>
												<div
													className="truncate font-medium text-sm hover:underline"
													title={recordTitle(
														record.title,
														record.values,
														titleField
													)}
												>
													{recordTitle(record.title, record.values, titleField)}
												</div>
											</button>
											{cardFields.map((field) => (
												<div
													className="mt-1 truncate text-muted-foreground text-xs"
													key={field.id}
												>
													<span className="opacity-70">{field.name}: </span>
													{formatValue(field, record.values?.[field.slug])}
												</div>
											))}
										</div>
									))
								)}
								{!loading && items.length === 0 && (
									<p className="px-1 py-3 text-center text-muted-foreground text-xs">
										Nothing here
									</p>
								)}
							</div>
						</section>
					);
				})}
			</div>
		</div>
	);
}
