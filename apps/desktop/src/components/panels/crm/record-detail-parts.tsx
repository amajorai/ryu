import { Delete01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useEffect, useState } from "react";
import {
	formatValue,
	recordTitle,
} from "@/src/components/panels/crm/fields.tsx";
import type {
	Activity,
	CrmClient,
	CrmRecord,
	Field,
} from "@/src/lib/api/crm.ts";
import { formatDateTime } from "@/src/lib/timezone.ts";

/** One timeline row. Audit entries render as a compact sentence with no controls;
 *  authored entries get their body and, for tasks, a completion checkbox. */
export function TimelineEntry({
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
	const tl = useLiteralMessages();
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
					{tl("{field} changed", { field: field?.name ?? tl("A field") })}
					{activity.from_value !== undefined && field
						? ` ${tl("from {value}", { value: formatValue(field, activity.from_value) })}`
						: ""}
					{activity.to_value !== undefined && field
						? ` ${tl("to {value}", { value: formatValue(field, activity.to_value) })}`
						: ""}
					{activity.author ? ` · ${activity.author}` : ""}
				</span>
			</li>
		);
	}

	const done = Boolean(activity.completed_at);

	return (
		<li className="rounded-lg border bg-card p-3">
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
							<Badge typography="normal" variant="secondary">
								{activity.kind}
							</Badge>
							<span className="tabular-nums">{stamp}</span>
							{activity.assignee && <span>· {activity.assignee}</span>}
							{activity.due_at && (
								<span>
									{tl("· due {date}", {
										date: formatDateTime(activity.due_at),
									})}
								</span>
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
export function RelationPicker({
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
	const tl = useLiteralMessages();
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
				aria-label={tl("Link a {objectSlug}", { objectSlug })}
				disabled={disabled}
				onChange={(event) => setQuery(event.target.value)}
				placeholder={tl("Link a {objectSlug}…", { objectSlug })}
				value={query}
			/>
			{hits.length > 0 && (
				<ul className="mt-1 space-y-0.5 rounded-lg border bg-card p-1">
					{hits.map((hit) => (
						<li key={hit.id}>
							<button
								className="w-full truncate rounded-lg px-1 py-0.5 text-left text-sm hover:bg-muted"
								onClick={() => {
									onPick(hit.id);
									setQuery("");
									setHits([]);
								}}
								title={recordTitle(hit.title, hit.values, titleField)}
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
