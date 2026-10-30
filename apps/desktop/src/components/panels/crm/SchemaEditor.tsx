// The schema editor — the thing that makes Harbor a CRM you shape rather than a
// CRM you accept.
//
// Everything else in this panel READS the schema; this is the one surface that
// writes it. Create an object, give it typed fields with their per-type config,
// reorder them, and every grid, board, filter and report picks the change up on the
// next read with no migration and no redeploy.
//
// Two guards are deliberate and visible rather than silent:
//
//   * System fields and standard objects cannot be deleted or retyped. The store
//     enforces this too — this UI just does not offer the affordance, so the user
//     never discovers the rule by hitting an error.
//   * Changing a select field's options is an edit to data other rows point AT.
//     Removing an option that records still hold is the destructive case, so the
//     editor says so before it lets you save rather than after.

import {
	Alert01Icon,
	Delete01Icon,
	PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Separator } from "@ryu/ui/components/separator.tsx";
import { useState } from "react";
import type { CrmClient, Field, ObjectWithFields } from "@/src/lib/api/crm.ts";
import {
	FIELD_TYPES,
	FieldForm,
	ObjectForm,
	OPTION_TYPES,
} from "./schema-forms.tsx";

export function SchemaEditor({
	client,
	objects,
	onChanged,
	subject,
}: {
	client: CrmClient;
	/** Every object, so a relation field can pick its target. */
	objects: ObjectWithFields[];
	/** Refetch the schema — the whole panel reads it, so a write here invalidates
	 *  the rail, the grid's columns and the board's groups all at once. */
	onChanged: () => void;
	subject: ObjectWithFields;
}) {
	const tl = useLiteralMessages();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [addingField, setAddingField] = useState(false);
	const [editingFieldId, setEditingFieldId] = useState<string | null>(null);
	const [addingObject, setAddingObject] = useState(false);

	const run = async <TResult,>(work: () => Promise<TResult>) => {
		setBusy(true);
		setError(null);
		try {
			await work();
			onChanged();
			return true;
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			return false;
		} finally {
			setBusy(false);
		}
	};

	const move = async (field: Field, delta: number) => {
		const ordered = [...subject.fields].sort((a, b) => a.position - b.position);
		const from = ordered.findIndex((f) => f.id === field.id);
		const to = from + delta;
		if (from < 0 || to < 0 || to >= ordered.length) {
			return;
		}
		const [moved] = ordered.splice(from, 1);
		ordered.splice(to, 0, moved);
		await run(() =>
			client.reorderFields(
				subject.object.slug,
				ordered.map((f) => f.id)
			)
		);
	};

	return (
		<div className="flex h-full min-h-0 flex-col">
			<header className="flex items-start justify-between gap-2 border-b px-4 py-3">
				<div>
					<h2 className="font-semibold text-sm capitalize">
						{tl("{plural} schema", { plural: subject.object.plural })}
					</h2>
					<p className="text-muted-foreground text-xs">
						Fields you add here appear in every view, filter, board and report
						immediately — there is no migration step.
					</p>
				</div>
				<Button
					disabled={busy}
					onClick={() => setAddingObject(true)}
					size="sm"
					variant="ghost"
				>
					<HugeiconsIcon icon={PlusSignIcon} size={14} />
					New object
				</Button>
			</header>

			{error && (
				<div className="flex items-start gap-2 border-b bg-destructive/10 px-4 py-2 text-status-destructive text-xs">
					<HugeiconsIcon icon={Alert01Icon} size={14} />
					<span>{error}</span>
				</div>
			)}

			<div className="scroll-fade min-h-0 flex-1 overflow-y-auto p-4">
				{addingObject && (
					<ObjectForm
						busy={busy}
						onCancel={() => setAddingObject(false)}
						onSubmit={async (draft) => {
							const ok = await run(() => client.createObject(draft));
							if (ok) {
								setAddingObject(false);
							}
						}}
					/>
				)}

				<ul className="space-y-2">
					{[...subject.fields]
						.sort((a, b) => a.position - b.position)
						.map((field, index, all) => (
							<li className="rounded-lg border bg-card p-3" key={field.id}>
								{editingFieldId === field.id ? (
									<FieldForm
										busy={busy}
										existing={field}
										objects={objects}
										onCancel={() => setEditingFieldId(null)}
										onSubmit={async (draft) => {
											const ok = await run(() =>
												client.updateField(field.id, draft)
											);
											if (ok) {
												setEditingFieldId(null);
											}
										}}
									/>
								) : (
									<div className="flex items-start justify-between gap-3">
										<div className="min-w-0">
											<div className="flex flex-wrap items-center gap-2">
												<span className="font-medium text-sm">
													{field.name}
												</span>
												<Badge typography="normal" variant="secondary">
													{FIELD_TYPES.find((t) => t.value === field.field_type)
														?.label ?? field.field_type}
												</Badge>
												{field.is_system && (
													<Badge typography="normal" variant="outline">
														system
													</Badge>
												)}
												{field.is_required && (
													<Badge typography="normal" variant="outline">
														required
													</Badge>
												)}
											</div>
											<div className="mt-0.5 font-mono text-muted-foreground text-xs">
												{field.slug}
											</div>
											{OPTION_TYPES.has(field.field_type) && (
												<div className="mt-1 flex flex-wrap gap-1">
													{(field.config?.options ?? []).map((option) => (
														<Badge
															key={option.id}
															typography="normal"
															variant="secondary"
														>
															{option.label}
															{option.is_won ? " · won" : ""}
															{option.is_lost ? " · lost" : ""}
														</Badge>
													))}
												</div>
											)}
										</div>
										<div className="flex shrink-0 items-center gap-1">
											<Button
												aria-label={tl("Move {name} up", { name: field.name })}
												disabled={busy || index === 0}
												onClick={() => void move(field, -1)}
												size="icon"
												variant="ghost"
											>
												↑
											</Button>
											<Button
												aria-label={tl("Move {name} down", {
													name: field.name,
												})}
												disabled={busy || index === all.length - 1}
												onClick={() => void move(field, 1)}
												size="icon"
												variant="ghost"
											>
												↓
											</Button>
											<Button
												disabled={busy}
												onClick={() => setEditingFieldId(field.id)}
												size="sm"
												variant="ghost"
											>
												Edit
											</Button>
											{/* A system field backs behaviour elsewhere (the title,
											    the pipeline stage), so deleting it is not offered at
											    all rather than offered and refused. */}
											{!field.is_system && (
												<Button
													aria-label={tl("Delete {name}", { name: field.name })}
													disabled={busy}
													onClick={() => {
														void run(() => client.deleteField(field.id));
													}}
													size="icon"
													variant="ghost"
												>
													<HugeiconsIcon icon={Delete01Icon} size={14} />
												</Button>
											)}
										</div>
									</div>
								)}
							</li>
						))}
				</ul>

				<div className="mt-3">
					{addingField ? (
						<div className="rounded-lg border bg-card p-3">
							<FieldForm
								busy={busy}
								objects={objects}
								onCancel={() => setAddingField(false)}
								onSubmit={async (draft) => {
									const ok = await run(() =>
										client.createField(subject.object.slug, draft)
									);
									if (ok) {
										setAddingField(false);
									}
								}}
							/>
						</div>
					) : (
						<Button
							disabled={busy}
							onClick={() => setAddingField(true)}
							size="sm"
							variant="ghost"
						>
							<HugeiconsIcon icon={PlusSignIcon} size={14} />
							Add field
						</Button>
					)}
				</div>

				{!subject.object.is_standard && (
					<>
						<Separator className="my-4" />
						<Button
							disabled={busy}
							onClick={() => {
								void run(() => client.deleteObject(subject.object.slug));
							}}
							size="sm"
							variant="destructive"
						>
							{tl("Delete the {singular} object", {
								singular: subject.object.singular,
							})}
						</Button>
						<p className="mt-1 text-muted-foreground text-xs">
							{tl("This deletes every {singular} record with it.", {
								singular: subject.object.singular,
							})}
						</p>
					</>
				)}
			</div>
		</div>
	);
}
