// Duplicate detection and merge.
//
// The half of a CRM that decides whether it stays usable a year in. Every import,
// every form fill, and every agent that skipped `crm.find_record` adds another
// near-copy, and without a merge the answer to "which Acme is the real one" becomes
// "all of them".
//
// A merge is destructive in one direction and NOT in the other: the loser is soft-
// deleted (restorable), but its activities, list memberships and relation edges are
// REPARENTED onto the survivor first, so the history is not what gets lost. That is
// the whole reason to merge rather than delete-and-retype, and it is why the
// confirm copy says which side keeps what.

import { Alert01Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import { Skeleton } from "@ryu/ui/components/skeleton";
import { cn } from "@ryu/ui/lib/utils";
import { useCallback, useEffect, useState } from "react";
import {
	formatValue,
	recordTitle,
} from "@/src/components/panels/crm/fields.tsx";
import type {
	CrmClient,
	CrmRecord,
	DuplicateGroup,
	ObjectWithFields,
} from "@/src/lib/api/crm.ts";
import { formatDate } from "@/src/lib/timezone.ts";

export function Duplicates({
	client,
	onOpenRecord,
	subject,
}: {
	client: CrmClient;
	onOpenRecord: (recordId: string) => void;
	subject: ObjectWithFields;
}) {
	const [groups, setGroups] = useState<DuplicateGroup[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [busyGroup, setBusyGroup] = useState<number | null>(null);
	/** Which record wins, per group index. Defaults to the OLDEST — the one other
	 *  rows are most likely already pointing at. */
	const [survivors, setSurvivors] = useState<Record<number, string>>({});

	const slug = subject.object.slug;

	const titleField = subject.fields.find(
		(f) => f.id === subject.object.title_field_id
	);

	const load = useCallback(
		(signal?: AbortSignal) => {
			setLoading(true);
			setError(null);
			setSurvivors({});
			return client
				.findDuplicates(slug, signal)
				.then((result) => setGroups(result.groups))
				.catch((cause: unknown) => {
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
		[client, slug]
	);

	useEffect(() => {
		const controller = new AbortController();
		void load(controller.signal);
		return () => controller.abort();
	}, [load]);

	/** Oldest first, so index 0 is the default survivor. */
	const ordered = (records: CrmRecord[]) =>
		[...records].sort((a, b) => a.created_at.localeCompare(b.created_at));

	const merge = async (index: number, group: DuplicateGroup) => {
		const records = ordered(group.records);
		const survivorId = survivors[index] ?? records[0]?.id;
		if (!survivorId) {
			return;
		}
		const loserIds = records
			.map((record) => record.id)
			.filter((id) => id !== survivorId);
		if (loserIds.length === 0) {
			return;
		}
		setBusyGroup(index);
		try {
			await client.mergeRecords({
				loser_ids: loserIds,
				survivor_id: survivorId,
			});
			await load();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusyGroup(null);
		}
	};

	/** The fields worth showing side by side — the ones that actually differ across
	 *  the group, since identical columns tell you nothing about which to keep. */
	const differingFields = (records: CrmRecord[]) =>
		subject.fields.filter((field) => {
			if (field.is_system) {
				return false;
			}
			const first = JSON.stringify(records[0]?.values?.[field.slug] ?? null);
			return records.some(
				(record) =>
					JSON.stringify(record.values?.[field.slug] ?? null) !== first
			);
		});

	return (
		<div className="flex h-full min-h-0 flex-col">
			<header className="flex items-start justify-between gap-2 border-b px-4 py-3">
				<div>
					<h2 className="font-medium text-base capitalize">
						Duplicate {subject.object.plural}
					</h2>
					<p className="text-muted-foreground text-xs">
						Merging keeps one record and folds the others into it. Their notes,
						tasks, list memberships and links move across first — only the
						emptied record is removed, and that is a soft delete.
					</p>
				</div>
				<Button
					disabled={loading}
					onClick={() => void load()}
					size="sm"
					variant="ghost"
				>
					<HugeiconsIcon icon={RefreshIcon} size={14} />
					Rescan
				</Button>
			</header>

			{error && (
				<div className="flex items-start gap-2 border-b bg-destructive/10 px-4 py-2 text-destructive text-xs">
					<HugeiconsIcon icon={Alert01Icon} size={14} />
					<span>{error}</span>
				</div>
			)}

			<div className="scroll-fade min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
				{loading && groups.length === 0 && <Skeleton className="h-28 w-full" />}

				{!loading && groups.length === 0 && (
					<p className="py-10 text-center text-muted-foreground text-sm">
						No duplicate {subject.object.plural} found.
					</p>
				)}

				{groups.map((group, index) => {
					const records = ordered(group.records);
					const survivorId = survivors[index] ?? records[0]?.id;
					const matchedOn = subject.fields.find((f) => f.id === group.field_id);
					const columns = differingFields(records);
					return (
						<section
							className="rounded-md border bg-card p-3"
							// biome-ignore lint/suspicious/noArrayIndexKey: a duplicate group has no id of its own; the list is fully replaced on every rescan
							key={`group-${index}`}
						>
							<div className="mb-2 flex items-center gap-2">
								<Badge className="font-normal" variant="secondary">
									{records.length} records
								</Badge>
								{matchedOn && (
									<span className="text-muted-foreground text-xs">
										same {matchedOn.name}
									</span>
								)}
							</div>

							<div className="overflow-x-auto">
								<table className="w-full text-sm">
									<thead>
										<tr className="text-muted-foreground text-xs">
											<th className="p-1 text-left font-normal">Keep</th>
											<th className="p-1 text-left font-normal">Record</th>
											{columns.map((field) => (
												<th
													className="p-1 text-left font-normal"
													key={field.id}
												>
													{field.name}
												</th>
											))}
											<th className="p-1 text-left font-normal">Created</th>
										</tr>
									</thead>
									<tbody>
										{records.map((record) => (
											<tr
												className={cn(
													record.id === survivorId && "bg-muted/50"
												)}
												key={record.id}
											>
												<td className="p-1">
													<input
														aria-label={`Keep ${recordTitle(record.title, record.values, titleField)}`}
														checked={record.id === survivorId}
														name={`survivor-${index}`}
														onChange={() =>
															setSurvivors((current) => ({
																...current,
																[index]: record.id,
															}))
														}
														type="radio"
													/>
												</td>
												<td className="p-1">
													<button
														className="truncate text-left hover:underline"
														onClick={() => onOpenRecord(record.id)}
														type="button"
													>
														{recordTitle(
															record.title,
															record.values,
															titleField
														)}
													</button>
												</td>
												{columns.map((field) => (
													<td
														className="p-1 text-muted-foreground"
														key={field.id}
													>
														{formatValue(field, record.values?.[field.slug])}
													</td>
												))}
												<td className="p-1 text-muted-foreground text-xs tabular-nums">
													{formatDate(record.created_at)}
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>

							<div className="mt-2 flex justify-end">
								<Button
									disabled={busyGroup === index}
									onClick={() => void merge(index, group)}
									size="sm"
								>
									{busyGroup === index
										? "Merging…"
										: `Merge ${records.length - 1} into the kept record`}
								</Button>
							</div>
						</section>
					);
				})}
			</div>
		</div>
	);
}
