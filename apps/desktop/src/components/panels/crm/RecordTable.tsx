import type { ValueBag } from "@/src/lib/api/crm.ts";
// The record grid — the surface people judge a CRM by.
//
// Renders one saved view over one object: the view decides which fields are
// columns, in what order, filtered and sorted how. Sorting is done SERVER-side by
// re-running the query with a new `sorts` list rather than sorting the loaded page
// locally, because a local sort of page 1 silently lies about a 4,000-row object —
// it reorders the fifty rows you happen to have, not the object.
//
// Cell edits are optimistic with rollback, and commit through `updateRecord`, which
// merges: only the edited key is sent, so a cell edit can never clobber a column
// this view was not showing.

import { Alert01Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ryu/ui/components/table.tsx";
import { formatNumber } from "@ryu/ui/lib/number-format.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	FieldEditor,
	FieldValue,
	isNumericField,
	recordTitle,
} from "@/src/components/panels/crm/fields.tsx";
import type {
	CrmClient,
	CrmRecord,
	Field,
	ObjectWithFields,
	SortDirection,
	View,
	ViewSort,
} from "@/src/lib/api/crm.ts";

/** One page. The server clamps this too; asking for a sane page keeps first paint
 *  to one screen of rows rather than the whole object. */
const PAGE_SIZE = 50;

interface CellAddress {
	fieldSlug: string;
	recordId: string;
}

export function RecordTable({
	client,
	onOpenRecord,
	onRequestCreate,
	search,
	subject,
	view,
}: {
	client: CrmClient;
	onOpenRecord: (recordId: string) => void;
	onRequestCreate: () => void;
	/** Free-text narrowing applied on top of the view's own filter. */
	search: string;
	subject: ObjectWithFields;
	view: View | undefined;
}) {
	const tl = useLiteralMessages();
	const [records, setRecords] = useState<CrmRecord[]>([]);
	const [total, setTotal] = useState(0);
	const [hasMore, setHasMore] = useState(false);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [editing, setEditing] = useState<CellAddress | null>(null);
	const [sorts, setSorts] = useState<ViewSort[]>(view?.sorts ?? []);
	const [offset, setOffset] = useState(0);
	const slug = subject.object.slug;

	// A view switch is a different query, so both the sort override and the page
	// reset with it — carrying either across would show page 3 of a view the user
	// just opened, or sort by a field the new view does not display.
	useEffect(() => {
		setSorts(view?.sorts ?? []);
		setOffset(0);
		setSelected(new Set());
		setEditing(null);
	}, [slug, view?.id, view?.sorts]);

	useEffect(() => {
		setOffset(0);
	}, [search]);

	useEffect(() => {
		setSelected(new Set());
		setEditing(null);
	}, [offset, search, sorts]);

	const columns = useMemo(() => {
		const visible = view?.visible_field_ids ?? [];
		if (visible.length === 0) {
			return subject.fields.filter((f) => !f.is_system).slice(0, 8);
		}
		// Ordered by the VIEW, not by the field table: the whole point of column
		// order on a view is that it differs from the schema's own order.
		return visible
			.map((id) => subject.fields.find((f) => f.id === id))
			.filter((f): f is Field => Boolean(f));
	}, [subject.fields, view?.visible_field_ids]);

	const titleField = useMemo(
		() => subject.fields.find((f) => f.id === subject.object.title_field_id),
		[subject.fields, subject.object.title_field_id]
	);

	const load = useCallback(
		(signal?: AbortSignal) => {
			setLoading(true);
			setError(null);
			const query = {
				filter: view?.filter ?? null,
				limit: PAGE_SIZE,
				offset,
				search: search.trim() === "" ? null : search.trim(),
				sorts,
			};
			return client
				.queryRecords(slug, query, signal)
				.then((page) => {
					setRecords(page.items);
					setTotal(page.total);
					setHasMore(page.has_more);
				})
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
		[client, offset, search, slug, sorts, view?.filter]
	);

	useEffect(() => {
		const controller = new AbortController();
		void load(controller.signal);
		return () => controller.abort();
	}, [load]);

	const toggleSort = (field: Field) => {
		setOffset(0);
		setSorts((current) => {
			const existing = current.find((s) => s.field_id === field.id);
			const next: SortDirection =
				existing?.direction === "asc" ? "desc" : "asc";
			return [{ direction: next, field_id: field.id }];
		});
	};

	// Optimistic: paint the new value, send the merge, and put the old value back
	// if the store rejects it. The store validates per field type, so a rejection
	// here is a real answer ("that is not a valid email"), not a transport error.
	const commitCell = async (
		record: CrmRecord,
		field: Field,
		next: ValueBag[string]
	) => {
		setEditing(null);
		const previous = record.values?.[field.slug];
		if (previous === next) {
			return;
		}
		setRecords((current) =>
			current.map((row) =>
				row.id === record.id
					? { ...row, values: { ...row.values, [field.slug]: next } }
					: row
			)
		);
		try {
			const updated = await client.updateRecord(record.id, {
				[field.slug]: next,
			});
			setRecords((current) =>
				current.map((row) => (row.id === record.id ? updated : row))
			);
			setError(null);
		} catch (cause) {
			setRecords((current) =>
				current.map((row) =>
					row.id === record.id
						? { ...row, values: { ...row.values, [field.slug]: previous } }
						: row
				)
			);
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	};

	const allSelected =
		records.length > 0 && records.every((r) => selected.has(r.id));

	const toggleAll = () => {
		setSelected(allSelected ? new Set() : new Set(records.map((r) => r.id)));
	};

	const deleteSelected = async () => {
		const ids = [...selected];
		const results = await Promise.allSettled(
			ids.map((id) => client.deleteRecord(id))
		);
		const failedIds = ids.filter(
			(_, index) => results[index]?.status === "rejected"
		);
		setSelected(new Set(failedIds));
		await load();
		const failure = results.find(
			(result): result is PromiseRejectedResult => result.status === "rejected"
		);
		if (failure) {
			const cause: unknown = failure.reason;
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	};

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex items-center justify-between gap-2 border-b px-3 py-2">
				<div className="text-muted-foreground text-xs">
					{loading && records.length === 0
						? "Loading…"
						: `${formatNumber(total)} ${
								total === 1 ? subject.object.singular : subject.object.plural
							}`}
				</div>
				<div className="flex items-center gap-2">
					{selected.size > 0 && (
						<>
							<span className="text-muted-foreground text-xs">
								{tl("{selectedCount} selected", {
									selectedCount: String(selected.size),
								})}
							</span>
							<Button
								onClick={() => void deleteSelected()}
								size="sm"
								variant="destructive"
							>
								Delete
							</Button>
						</>
					)}
					{view && (
						<Button
							onClick={() => {
								// Exports what the VIEW currently resolves to, server-side —
								// not the loaded page — so a 4,000-row object exports 4,000
								// rows rather than the fifty on screen.
								void client
									.exportView(view.id)
									.then((csv) => {
										const url = URL.createObjectURL(
											new Blob([csv], { type: "text/csv" })
										);
										const link = document.createElement("a");
										link.href = url;
										link.download = `${subject.object.slug}-${view.name}.csv`;
										link.click();
										URL.revokeObjectURL(url);
									})
									.catch((cause) =>
										setError(
											cause instanceof Error ? cause.message : String(cause)
										)
									);
							}}
							size="sm"
							variant="ghost"
						>
							Export CSV
						</Button>
					)}
					<Button onClick={onRequestCreate} size="sm" variant="ghost">
						<HugeiconsIcon icon={PlusSignIcon} size={14} />
						{tl("New {objectSingular}", {
							objectSingular: subject.object.singular,
						})}
					</Button>
				</div>
			</div>

			{error && (
				<div className="flex items-start gap-2 border-b bg-destructive/10 px-3 py-2 text-status-destructive text-xs">
					<HugeiconsIcon icon={Alert01Icon} size={14} />
					<span>{error}</span>
				</div>
			)}

			{/* Wide tables scroll inside their own container so the panel body never
			    scrolls horizontally. */}
			<div className="min-h-0 flex-1 overflow-auto">
				<Table>
					<TableHeader appearance="record" className="sticky top-0 z-10">
						<TableRow>
							<TableHead className="w-8">
								<Checkbox
									aria-label="Select all rows on this page"
									checked={allSelected}
									onCheckedChange={toggleAll}
								/>
							</TableHead>
							<TableHead className="min-w-48">Name</TableHead>
							{columns.map((field) => {
								const sort = sorts.find((s) => s.field_id === field.id);
								return (
									<TableHead
										className={cn(
											"min-w-32",
											isNumericField(field) && "text-right"
										)}
										key={field.id}
									>
										<button
											className="inline-flex items-center gap-1 hover:text-foreground"
											onClick={() => toggleSort(field)}
											type="button"
										>
											{field.name}
											{sort && (
												<span aria-hidden="true">
													{sort.direction === "desc" ? "↓" : "↑"}
												</span>
											)}
											<span className="sr-only">
												{sort
													? tl(
															"sorted {direction, select, desc {descending} other {ascending}}, activate to reverse",
															{ direction: sort.direction }
														)
													: "activate to sort"}
											</span>
										</button>
									</TableHead>
								);
							})}
						</TableRow>
					</TableHeader>
					<TableBody>
						{loading && records.length === 0
							? Array.from({ length: 6 }, (_, index) => (
									// skeleton rows have no identity
									<TableRow key={`skeleton-${index}`}>
										<TableCell colSpan={columns.length + 2}>
											<Skeleton className="h-4 w-full" />
										</TableCell>
									</TableRow>
								))
							: records.map((record) => (
									<TableRow key={record.id}>
										<TableCell>
											<Checkbox
												aria-label={tl("Select {recordTitle}", {
													recordTitle: recordTitle(
														record.title,
														record.values,
														titleField
													),
												})}
												checked={selected.has(record.id)}
												onCheckedChange={(checked) =>
													setSelected((current) => {
														const next = new Set(current);
														if (checked) {
															next.add(record.id);
														} else {
															next.delete(record.id);
														}
														return next;
													})
												}
											/>
										</TableCell>
										<TableCell>
											<button
												className="truncate text-left font-medium hover:underline"
												onClick={() => onOpenRecord(record.id)}
												title={recordTitle(
													record.title,
													record.values,
													titleField
												)}
												type="button"
											>
												{recordTitle(record.title, record.values, titleField)}
											</button>
										</TableCell>
										{columns.map((field) => {
											const isEditing =
												editing?.recordId === record.id &&
												editing.fieldSlug === field.slug;
											const value = record.values?.[field.slug];
											return (
												<TableCell
													className={cn(isNumericField(field) && "text-right")}
													key={field.id}
												>
													{isEditing ? (
														<FieldEditor
															autoFocus
															field={field}
															onCancel={() => setEditing(null)}
															onCommit={(next) =>
																void commitCell(record, field, next)
															}
															value={value}
														/>
													) : (
														<button
															className="w-full truncate text-left"
															disabled={field.is_system}
															onClick={() =>
																setEditing({
																	fieldSlug: field.slug,
																	recordId: record.id,
																})
															}
															type="button"
														>
															<FieldValue field={field} value={value} />
														</button>
													)}
												</TableCell>
											);
										})}
									</TableRow>
								))}
						{!loading && records.length === 0 && (
							<TableRow>
								<TableCell
									colSpan={columns.length + 2}
									presentation="record-empty"
								>
									{search.trim()
										? tl("No {objectPlural} match “{search}”.", {
												objectPlural: subject.object.plural,
												search,
											})
										: tl(
												"No {objectPlural} yet. Create one, or import a CSV.",
												{
													objectPlural: subject.object.plural,
												}
											)}
								</TableCell>
							</TableRow>
						)}
					</TableBody>
				</Table>
			</div>

			{(offset > 0 || hasMore) && (
				<div className="flex items-center justify-between border-t px-3 py-2 text-xs">
					<Button
						disabled={offset === 0}
						onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
						size="sm"
						variant="ghost"
					>
						Previous
					</Button>
					<span className="text-muted-foreground">
						{formatNumber(offset + 1)}–{formatNumber(offset + records.length)}{" "}
						of {formatNumber(total)}
					</span>
					<Button
						disabled={!hasMore}
						onClick={() => setOffset(offset + PAGE_SIZE)}
						size="sm"
						variant="ghost"
					>
						Next
					</Button>
				</div>
			)}
		</div>
	);
}
