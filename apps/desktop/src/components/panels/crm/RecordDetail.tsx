// The record page: fields, related records, and the unified activity timeline.
//
// The timeline is the reason a CRM is worth having, and the reason it is ONE list
// here rather than three tabs: notes a person wrote, tasks somebody owes, and the
// field- and stage-change entries the STORE writes on every mutation all interleave
// in time. Reading "what happened with this account" should not mean correlating
// three chronologies by hand.
//
// The audit entries (`field_change`, `stage_change`) are read-only by construction —
// the store authors them, no route accepts them — so they render differently from
// the entries a person wrote, and carry no edit affordance.

import {
	Calendar01Icon,
	CheckmarkCircle01Icon,
	Delete01Icon,
	Note01Icon,
	TelephoneIcon,
	UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import { Checkbox } from "@ryu/ui/components/checkbox";
import { Input } from "@ryu/ui/components/input";
import { Label } from "@ryu/ui/components/label";
import { Separator } from "@ryu/ui/components/separator";
import { Skeleton } from "@ryu/ui/components/skeleton";
import { Textarea } from "@ryu/ui/components/textarea";
import { cn } from "@ryu/ui/lib/utils";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	FieldEditor,
	FieldValue,
	formatValue,
	recordTitle,
} from "@/src/components/panels/crm/fields.tsx";
import type {
	Activity,
	ActivityKind,
	CrmClient,
	CrmRecord,
	Field,
	ObjectWithFields,
	RelatedGroup,
} from "@/src/lib/api/crm.ts";
import { formatDateTime } from "@/src/lib/timezone.ts";

const TIMELINE_LIMIT = 100;

/** Which kinds a person can author. `field_change` / `stage_change` are absent on
 *  purpose — they are the store's audit trail, not something anyone writes. */
const AUTHORABLE: {
	icon: typeof Note01Icon;
	kind: ActivityKind;
	label: string;
}[] = [
	{ icon: Note01Icon, kind: "note", label: "Note" },
	{ icon: TelephoneIcon, kind: "call", label: "Call" },
	{ icon: Calendar01Icon, kind: "meeting", label: "Meeting" },
	{ icon: CheckmarkCircle01Icon, kind: "task", label: "Task" },
];

export function RecordDetail({
	client,
	objectsBySlug,
	onBack,
	onOpenRecord,
	recordId,
	subject,
}: {
	client: CrmClient;
	/** Used to name a related record's object without another round-trip. */
	objectsBySlug: Map<string, ObjectWithFields>;
	onBack: () => void;
	onOpenRecord: (recordId: string) => void;
	recordId: string;
	subject: ObjectWithFields;
}) {
	const [record, setRecord] = useState<CrmRecord | null>(null);
	const [related, setRelated] = useState<RelatedGroup[]>([]);
	const [timeline, setTimeline] = useState<Activity[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [editingField, setEditingField] = useState<string | null>(null);

	const [composerKind, setComposerKind] = useState<ActivityKind>("note");
	const [composerTitle, setComposerTitle] = useState("");
	const [composerBody, setComposerBody] = useState("");
	const [composerDue, setComposerDue] = useState("");
	const [saving, setSaving] = useState(false);
	const [linking, setLinking] = useState(false);

	const titleField = useMemo(
		() => subject.fields.find((f) => f.id === subject.object.title_field_id),
		[subject.fields, subject.object.title_field_id]
	);

	const fieldsById = useMemo(() => {
		const map = new Map<string, Field>();
		for (const field of subject.fields) {
			map.set(field.id, field);
		}
		return map;
	}, [subject.fields]);

	const load = useCallback(
		async (signal?: AbortSignal) => {
			setLoading(true);
			setError(null);
			try {
				// Three independent reads, issued together rather than awaited in
				// sequence: the detail page is not usable until all three land, so
				// serializing them would triple the time to first paint for no gain.
				const [next, relatedResult, timelineResult] = await Promise.all([
					client.getRecord(recordId, signal),
					client.getRelated(recordId, signal).catch(() => ({ groups: [] })),
					client.getTimeline(recordId, TIMELINE_LIMIT, signal).catch(() => ({
						has_more: false,
						items: [],
						limit: 0,
						offset: 0,
						total: 0,
					})),
				]);
				setRecord(next);
				setRelated(relatedResult.groups);
				setTimeline(timelineResult.items);
			} catch (cause) {
				if (!signal?.aborted) {
					setError(cause instanceof Error ? cause.message : String(cause));
				}
			} finally {
				if (!signal?.aborted) {
					setLoading(false);
				}
			}
		},
		[client, recordId]
	);

	useEffect(() => {
		const controller = new AbortController();
		void load(controller.signal);
		return () => controller.abort();
	}, [load]);

	const commitField = async (field: Field, next: unknown) => {
		setEditingField(null);
		if (!record) {
			return;
		}
		const previous = record.values?.[field.slug];
		if (previous === next) {
			return;
		}
		setRecord({ ...record, values: { ...record.values, [field.slug]: next } });
		try {
			const updated = await client.updateRecord(record.id, {
				[field.slug]: next,
			});
			setRecord(updated);
			// A field write produces an audit entry, so the timeline is now stale.
			const refreshed = await client.getTimeline(record.id, TIMELINE_LIMIT);
			setTimeline(refreshed.items);
		} catch (cause) {
			setRecord({
				...record,
				values: { ...record.values, [field.slug]: previous },
			});
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	};

	const submitActivity = async () => {
		if (composerTitle.trim() === "") {
			return;
		}
		setSaving(true);
		try {
			await client.logActivity({
				body: composerBody.trim() === "" ? undefined : composerBody,
				due_at:
					composerKind === "task" && composerDue !== ""
						? new Date(composerDue).toISOString()
						: undefined,
				kind: composerKind,
				record_id: recordId,
				title: composerTitle.trim(),
			});
			setComposerTitle("");
			setComposerBody("");
			setComposerDue("");
			const refreshed = await client.getTimeline(recordId, TIMELINE_LIMIT);
			setTimeline(refreshed.items);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSaving(false);
		}
	};

	// Relations are EDGES, so adding or removing one is `link`/`unlink` with target
	// ids — not a value written into the record's bag. That is why the grid renders
	// a relation cell read-only and points here: this is the only place that holds
	// the target object's record list to pick from.
	const changeLink = async (
		group: RelatedGroup,
		targetId: string,
		add: boolean
	) => {
		setLinking(true);
		try {
			await (add
				? client.link(recordId, group.field_id, [targetId])
				: client.unlink(recordId, group.field_id, [targetId]));
			const refreshed = await client.getRelated(recordId);
			setRelated(refreshed.groups);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setLinking(false);
		}
	};

	const toggleTask = async (activity: Activity) => {
		const completed = !activity.completed_at;
		setTimeline((current) =>
			current.map((entry) =>
				entry.id === activity.id
					? {
							...entry,
							completed_at: completed ? new Date().toISOString() : null,
						}
					: entry
			)
		);
		try {
			await client.completeActivity(activity.id, completed);
		} catch (cause) {
			setTimeline((current) =>
				current.map((entry) =>
					entry.id === activity.id
						? { ...entry, completed_at: activity.completed_at }
						: entry
				)
			);
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	};

	if (loading && !record) {
		return (
			<div className="space-y-3 p-4">
				<Skeleton className="h-7 w-64" />
				<Skeleton className="h-40 w-full" />
			</div>
		);
	}

	if (!record) {
		return (
			<div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
				<p className="text-muted-foreground text-sm">
					{error ?? "That record could not be loaded."}
				</p>
				<Button onClick={onBack} size="sm" variant="ghost">
					Back
				</Button>
			</div>
		);
	}

	return (
		<div className="flex h-full min-h-0 flex-col">
			<header className="flex items-center justify-between gap-2 border-b px-4 py-3">
				<div className="flex min-w-0 items-center gap-3">
					<Button onClick={onBack} size="sm" variant="ghost">
						← Back
					</Button>
					<div className="min-w-0">
						<h2 className="truncate font-medium text-base">
							{recordTitle(record.title, record.values, titleField)}
						</h2>
						<p className="text-muted-foreground text-xs">
							{subject.object.singular}
							{record.deleted_at ? " · deleted" : ""}
						</p>
					</div>
				</div>
				{record.deleted_at && (
					<Button
						onClick={() => {
							void client
								.restoreRecord(record.id)
								.then(() => load())
								.catch((cause: unknown) =>
									setError(
										cause instanceof Error ? cause.message : String(cause)
									)
								);
						}}
						size="sm"
						variant="ghost"
					>
						Restore
					</Button>
				)}
			</header>

			{error && (
				<div className="border-b bg-destructive/10 px-4 py-2 text-destructive text-xs">
					{error}
				</div>
			)}

			<div className="grid min-h-0 flex-1 grid-cols-1 gap-0 overflow-hidden lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
				{/* Fields + relations */}
				<aside className="scroll-fade min-h-0 overflow-y-auto border-b p-4 lg:border-r lg:border-b-0">
					<h3 className="mb-2 font-medium text-muted-foreground text-xs uppercase tracking-wide">
						Details
					</h3>
					<dl className="space-y-2">
						{subject.fields
							.filter((field) => !field.is_system)
							.map((field) => (
								<div key={field.id}>
									<dt className="text-muted-foreground text-xs">
										{field.name}
									</dt>
									<dd className="mt-0.5 text-sm">
										{editingField === field.id ? (
											<FieldEditor
												autoFocus
												field={field}
												onCancel={() => setEditingField(null)}
												onCommit={(next) => void commitField(field, next)}
												value={record.values?.[field.slug]}
											/>
										) : (
											<button
												className="w-full rounded px-1 py-0.5 text-left hover:bg-muted"
												onClick={() => setEditingField(field.id)}
												type="button"
											>
												<FieldValue
													field={field}
													value={record.values?.[field.slug]}
												/>
											</button>
										)}
									</dd>
								</div>
							))}
					</dl>

					{related.length > 0 && (
						<>
							<Separator className="my-4" />
							<h3 className="mb-2 font-medium text-muted-foreground text-xs uppercase tracking-wide">
								Related
							</h3>
							<div className="space-y-3">
								{related.map((group) => (
									<div key={group.field_id}>
										<div className="mb-1 flex items-center gap-1.5 text-muted-foreground text-xs">
											<HugeiconsIcon icon={UserGroupIcon} size={12} />
											{group.field_name}
											<Badge className="font-normal" variant="secondary">
												{group.records.length}
											</Badge>
										</div>
										<ul className="space-y-0.5">
											{group.records.map((linked) => (
												<li className="flex items-center gap-1" key={linked.id}>
													<button
														className="min-w-0 flex-1 truncate rounded px-1 py-0.5 text-left text-sm hover:bg-muted"
														onClick={() => onOpenRecord(linked.id)}
														type="button"
													>
														{recordTitle(
															linked.title,
															linked.values,
															objectsBySlug
																.get(group.object_slug)
																?.fields.find(
																	(f) =>
																		f.id ===
																		objectsBySlug.get(group.object_slug)?.object
																			.title_field_id
																)
														)}
													</button>
													<Button
														aria-label={`Unlink ${linked.title}`}
														disabled={linking}
														onClick={() =>
															void changeLink(group, linked.id, false)
														}
														size="icon"
														variant="ghost"
													>
														<HugeiconsIcon icon={Delete01Icon} size={12} />
													</Button>
												</li>
											))}
										</ul>
										<RelationPicker
											client={client}
											disabled={linking}
											objectSlug={group.object_slug}
											onPick={(targetId) =>
												void changeLink(group, targetId, true)
											}
											titleField={objectsBySlug
												.get(group.object_slug)
												?.fields.find(
													(f) =>
														f.id ===
														objectsBySlug.get(group.object_slug)?.object
															.title_field_id
												)}
										/>
									</div>
								))}
							</div>
						</>
					)}
				</aside>

				{/* Timeline */}
				<section className="flex min-h-0 flex-col">
					<div className="border-b p-3">
						<div className="mb-2 flex flex-wrap gap-1">
							{AUTHORABLE.map((option) => (
								<Button
									key={option.kind}
									onClick={() => setComposerKind(option.kind)}
									size="sm"
									variant={composerKind === option.kind ? "secondary" : "ghost"}
								>
									<HugeiconsIcon icon={option.icon} size={13} />
									{option.label}
								</Button>
							))}
						</div>
						<div className="space-y-2">
							<div>
								<Label className="sr-only" htmlFor="crm-activity-title">
									Title
								</Label>
								<Input
									id="crm-activity-title"
									onChange={(event) => setComposerTitle(event.target.value)}
									placeholder={
										composerKind === "task"
											? "What needs doing?"
											: "What happened?"
									}
									value={composerTitle}
								/>
							</div>
							<div>
								<Label className="sr-only" htmlFor="crm-activity-body">
									Detail
								</Label>
								<Textarea
									id="crm-activity-body"
									onChange={(event) => setComposerBody(event.target.value)}
									placeholder="Detail (optional)"
									rows={2}
									value={composerBody}
								/>
							</div>
							{composerKind === "task" && (
								<div className="flex items-center gap-2">
									<Label className="text-xs" htmlFor="crm-activity-due">
										Due
									</Label>
									<Input
										className="w-56"
										id="crm-activity-due"
										onChange={(event) => setComposerDue(event.target.value)}
										type="datetime-local"
										value={composerDue}
									/>
									<span className="text-muted-foreground text-xs">
										A task with no due time never announces itself.
									</span>
								</div>
							)}
							<div className="flex justify-end">
								<Button
									disabled={saving || composerTitle.trim() === ""}
									onClick={() => void submitActivity()}
									size="sm"
								>
									{saving ? "Saving…" : "Add"}
								</Button>
							</div>
						</div>
					</div>

					<ol className="scroll-fade min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
						{timeline.map((entry) => (
							<TimelineEntry
								activity={entry}
								fieldsById={fieldsById}
								key={entry.id}
								onDelete={() => {
									void client
										.deleteActivity(entry.id)
										.then(() =>
											setTimeline((current) =>
												current.filter((row) => row.id !== entry.id)
											)
										)
										.catch((cause: unknown) =>
											setError(
												cause instanceof Error ? cause.message : String(cause)
											)
										);
								}}
								onToggle={() => void toggleTask(entry)}
							/>
						))}
						{timeline.length === 0 && (
							<li className="py-8 text-center text-muted-foreground text-sm">
								Nothing has happened here yet.
							</li>
						)}
					</ol>
				</section>
			</div>
		</div>
	);
}

/** One timeline row. Audit entries render as a compact sentence with no controls;
 *  authored entries get their body and, for tasks, a completion checkbox. */
function TimelineEntry({
	activity,
	fieldsById,
	onDelete,
	onToggle,
}: {
	activity: Activity;
	fieldsById: Map<string, Field>;
	onDelete: () => void;
	onToggle: () => void;
}) {
	const when = new Date(activity.created_at);
	const stamp = Number.isNaN(when.getTime())
		? activity.created_at
		: formatDateTime(when);

	if (activity.kind === "field_change" || activity.kind === "stage_change") {
		const field = activity.field_id
			? fieldsById.get(activity.field_id)
			: undefined;
		return (
			<li className="flex items-baseline gap-2 text-muted-foreground text-xs">
				<span className="shrink-0 tabular-nums opacity-70">{stamp}</span>
				<span>
					{field?.name ?? "A field"} changed
					{activity.from_value !== undefined && field
						? ` from ${formatValue(field, activity.from_value)}`
						: ""}
					{activity.to_value !== undefined && field
						? ` to ${formatValue(field, activity.to_value)}`
						: ""}
					{activity.author ? ` · ${activity.author}` : ""}
				</span>
			</li>
		);
	}

	const done = Boolean(activity.completed_at);

	return (
		<li className="rounded-md border bg-card p-3">
			<div className="flex items-start justify-between gap-2">
				<div className="flex min-w-0 items-start gap-2">
					{activity.kind === "task" && (
						<Checkbox
							aria-label={done ? "Reopen this task" : "Mark this task complete"}
							checked={done}
							className="mt-0.5"
							onCheckedChange={onToggle}
						/>
					)}
					<div className="min-w-0">
						<div
							className={cn(
								"font-medium text-sm",
								done && "text-muted-foreground line-through"
							)}
						>
							{activity.title || "(untitled)"}
						</div>
						{activity.body && (
							<p className="mt-1 whitespace-pre-wrap text-muted-foreground text-sm">
								{activity.body}
							</p>
						)}
						<div className="mt-1 flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
							<Badge className="font-normal" variant="secondary">
								{activity.kind}
							</Badge>
							<span className="tabular-nums">{stamp}</span>
							{activity.assignee && <span>· {activity.assignee}</span>}
							{activity.due_at && (
								<span>· due {formatDateTime(activity.due_at)}</span>
							)}
						</div>
					</div>
				</div>
				<Button
					aria-label="Delete this entry"
					onClick={onDelete}
					size="icon"
					variant="ghost"
				>
					<HugeiconsIcon icon={Delete01Icon} size={14} />
				</Button>
			</div>
		</li>
	);
}

/** Search the target object and link a record.
 *
 * Its own component so each relation group keeps its own query state — one shared
 * search box across every group would make typing in "People" filter "Deals" too.
 * Debounced, and it queries the SERVER rather than filtering a preloaded list,
 * because the target object can be arbitrarily large.
 */
function RelationPicker({
	client,
	disabled,
	objectSlug,
	onPick,
	titleField,
}: {
	client: CrmClient;
	disabled: boolean;
	objectSlug: string;
	onPick: (recordId: string) => void;
	titleField: Field | undefined;
}) {
	const [query, setQuery] = useState("");
	const [hits, setHits] = useState<CrmRecord[]>([]);

	useEffect(() => {
		const needle = query.trim();
		if (needle.length < 2) {
			setHits([]);
			return;
		}
		const controller = new AbortController();
		const timer = setTimeout(() => {
			client
				.queryRecords(
					objectSlug,
					{ limit: 6, search: needle },
					controller.signal
				)
				.then((page) => setHits(page.items))
				.catch(() => {
					// A failed lookup leaves the previous hits alone rather than
					// surfacing an error over the whole record page.
				});
		}, 250);
		return () => {
			clearTimeout(timer);
			controller.abort();
		};
	}, [client, objectSlug, query]);

	return (
		<div className="mt-1">
			<Input
				aria-label={`Link a ${objectSlug}`}
				disabled={disabled}
				onChange={(event) => setQuery(event.target.value)}
				placeholder={`Link a ${objectSlug}…`}
				value={query}
			/>
			{hits.length > 0 && (
				<ul className="mt-1 space-y-0.5 rounded-md border bg-card p-1">
					{hits.map((hit) => (
						<li key={hit.id}>
							<button
								className="w-full truncate rounded px-1 py-0.5 text-left text-sm hover:bg-muted"
								onClick={() => {
									onPick(hit.id);
									setQuery("");
									setHits([]);
								}}
								type="button"
							>
								{recordTitle(hit.title, hit.values, titleField)}
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
