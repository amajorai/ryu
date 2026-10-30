import type { ValueBag } from "@/src/lib/api/crm.ts";
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

import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	FieldEditor,
	FieldValue,
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
import { renderActivityComposer } from "./record-activity-composer.tsx";
import { TimelineEntry } from "./record-detail-parts.tsx";
import { renderRelatedGroups } from "./record-related-groups.tsx";

const TIMELINE_LIMIT = 100;

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
	onOpenRecord: (recordId: string, objectSlug?: string) => void;
	recordId: string;
	subject: ObjectWithFields;
}) {
	const tl = useLiteralMessages();
	const [record, setRecord] = useState<CrmRecord | null>(null);
	const [related, setRelated] = useState<RelatedGroup[]>([]);
	const [timeline, setTimeline] = useState<Activity[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [editingField, setEditingField] = useState<string | null>(null);
	const [failedFieldDraft, setFailedFieldDraft] = useState<{
		fieldId: string;
		value: unknown;
	} | null>(null);

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

	const commitField = async (field: Field, next: ValueBag[string]) => {
		setEditingField(null);
		setFailedFieldDraft(null);
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
			setFailedFieldDraft(null);
			// A field write produces an audit entry, so the timeline is now stale.
			try {
				const refreshed = await client.getTimeline(record.id, TIMELINE_LIMIT);
				setTimeline(refreshed.items);
				setError(null);
			} catch (cause) {
				// The record write is already authoritative. A failed audit refresh must
				// not paint the old value back over a successful server mutation.
				setError(cause instanceof Error ? cause.message : String(cause));
			}
		} catch (cause) {
			setRecord({
				...record,
				values: { ...record.values, [field.slug]: previous },
			});
			setFailedFieldDraft({ fieldId: field.id, value: next });
			setEditingField(field.id);
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
			setError(null);
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
			setError(null);
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
			setError(null);
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
						<h2
							className="truncate font-semibold text-sm"
							title={recordTitle(record.title, record.values, titleField)}
						>
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
								.catch((cause) =>
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
				<div className="border-b bg-destructive/10 px-4 py-2 text-status-destructive text-xs">
					{error}
				</div>
			)}

			<div className="grid min-h-0 flex-1 grid-cols-1 gap-0 overflow-hidden lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
				{/* Fields + relations */}
				<aside className="scroll-fade min-h-0 overflow-y-auto border-b p-4 lg:border-r lg:border-b-0">
					<h3 className="mb-1 font-semibold text-foreground text-sm">
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
												onCancel={() => {
													setEditingField(null);
													setFailedFieldDraft(null);
													setError(null);
												}}
												onCommit={(next) => void commitField(field, next)}
												value={
													failedFieldDraft?.fieldId === field.id
														? failedFieldDraft.value
														: record.values?.[field.slug]
												}
											/>
										) : (
											<button
												className="w-full rounded-lg px-1 py-0.5 text-left hover:bg-muted"
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

					{renderRelatedGroups({
						changeLink,
						client,
						linking,
						objectsBySlug,
						onOpenRecord,
						related,
						tl,
					})}
				</aside>

				{/* Timeline */}
				<section className="flex min-h-0 flex-col">
					{renderActivityComposer({
						composerBody,
						composerDue,
						composerKind,
						composerTitle,
						saving,
						setComposerBody,
						setComposerDue,
						setComposerKind,
						setComposerTitle,
						submitActivity,
					})}

					<ol className="scroll-fade min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
						{timeline.map((entry) => (
							<TimelineEntry
								activity={entry}
								fieldsById={fieldsById}
								key={entry.id}
								onDelete={() => {
									void client
										.deleteActivity(entry.id)
										.then(() => {
											setTimeline((current) =>
												current.filter((row) => row.id !== entry.id)
											);
											setError(null);
										})
										.catch((cause) =>
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
