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
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import { Checkbox } from "@ryu/ui/components/checkbox";
import { Input } from "@ryu/ui/components/input";
import { Label } from "@ryu/ui/components/label";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select";
import { Separator } from "@ryu/ui/components/separator";
import { useState } from "react";
import type {
	CrmClient,
	Field,
	FieldType,
	ObjectWithFields,
	SelectOption,
} from "@/src/lib/api/crm.ts";

/** Every type a user may create, with the label the picker shows.
 *
 *  `relation` is offered but needs a target object, so it is the one type whose
 *  config is REQUIRED rather than optional — a relation with no target is a field
 *  that can never hold anything. */
const FIELD_TYPES: { label: string; value: FieldType }[] = [
	{ label: "Text", value: "text" },
	{ label: "Long text", value: "long_text" },
	{ label: "Number", value: "number" },
	{ label: "Currency", value: "currency" },
	{ label: "Percent", value: "percent" },
	{ label: "Checkbox", value: "checkbox" },
	{ label: "Date", value: "date" },
	{ label: "Date & time", value: "datetime" },
	{ label: "Select (one)", value: "select" },
	{ label: "Select (many)", value: "multi_select" },
	{ label: "Status (pipeline stage)", value: "status" },
	{ label: "Email", value: "email" },
	{ label: "Phone", value: "phone" },
	{ label: "URL", value: "url" },
	{ label: "Rating", value: "rating" },
	{ label: "Relation", value: "relation" },
	{ label: "User", value: "user" },
];

/** Types whose config is a list of options. */
const OPTION_TYPES = new Set<FieldType>(["select", "multi_select", "status"]);

/** A slug the store will accept, derived from the display name so nobody has to
 *  think about it — but shown, because it is what agent tools and CSV mappings
 *  address the field by. */
function slugify(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 48);
}

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
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [addingField, setAddingField] = useState(false);
	const [editingFieldId, setEditingFieldId] = useState<string | null>(null);
	const [addingObject, setAddingObject] = useState(false);

	const run = async (work: () => Promise<unknown>) => {
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
					<h2 className="font-medium text-base capitalize">
						{subject.object.plural} schema
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
				<div className="flex items-start gap-2 border-b bg-destructive/10 px-4 py-2 text-destructive text-xs">
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
							<li className="rounded-md border bg-card p-3" key={field.id}>
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
												<Badge className="font-normal" variant="secondary">
													{FIELD_TYPES.find((t) => t.value === field.field_type)
														?.label ?? field.field_type}
												</Badge>
												{field.is_system && (
													<Badge className="font-normal" variant="outline">
														system
													</Badge>
												)}
												{field.is_required && (
													<Badge className="font-normal" variant="outline">
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
															className="font-normal"
															key={option.id}
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
												aria-label={`Move ${field.name} up`}
												disabled={busy || index === 0}
												onClick={() => void move(field, -1)}
												size="icon"
												variant="ghost"
											>
												↑
											</Button>
											<Button
												aria-label={`Move ${field.name} down`}
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
													aria-label={`Delete ${field.name}`}
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
						<div className="rounded-md border bg-card p-3">
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
							Delete the {subject.object.singular} object
						</Button>
						<p className="mt-1 text-muted-foreground text-xs">
							This deletes every {subject.object.singular} record with it.
						</p>
					</>
				)}
			</div>
		</div>
	);
}

/** Create a custom object. Slug is derived and shown, because it is what agent
 *  tools and CSV mappings address the object by. */
function ObjectForm({
	busy,
	onCancel,
	onSubmit,
}: {
	busy: boolean;
	onCancel: () => void;
	onSubmit: (draft: { plural: string; singular: string; slug: string }) => void;
}) {
	const [singular, setSingular] = useState("");
	const [plural, setPlural] = useState("");
	const slug = slugify(singular);

	return (
		<div className="mb-4 rounded-md border bg-card p-3">
			<div className="grid gap-2 sm:grid-cols-2">
				<div>
					<Label htmlFor="crm-object-singular">Name (one)</Label>
					<Input
						id="crm-object-singular"
						onChange={(event) => setSingular(event.target.value)}
						placeholder="Investor"
						value={singular}
					/>
				</div>
				<div>
					<Label htmlFor="crm-object-plural">Name (many)</Label>
					<Input
						id="crm-object-plural"
						onChange={(event) => setPlural(event.target.value)}
						placeholder="Investors"
						value={plural}
					/>
				</div>
			</div>
			<p className="mt-1 font-mono text-muted-foreground text-xs">
				slug: {slug || "—"}
			</p>
			<div className="mt-2 flex justify-end gap-2">
				<Button onClick={onCancel} size="sm" variant="ghost">
					Cancel
				</Button>
				<Button
					disabled={busy || slug === ""}
					onClick={() =>
						onSubmit({
							plural: plural.trim() || `${singular.trim()}s`,
							singular: singular.trim(),
							slug,
						})
					}
					size="sm"
				>
					Create
				</Button>
			</div>
		</div>
	);
}

/** Create or edit one field, with the per-type config the type actually needs. */
function FieldForm({
	busy,
	existing,
	objects,
	onCancel,
	onSubmit,
}: {
	busy: boolean;
	existing?: Field;
	objects: ObjectWithFields[];
	onCancel: () => void;
	onSubmit: (draft: Partial<Field>) => void;
}) {
	const [name, setName] = useState(existing?.name ?? "");
	const [fieldType, setFieldType] = useState<FieldType>(
		existing?.field_type ?? "text"
	);
	const [required, setRequired] = useState(existing?.is_required ?? false);
	const [currency, setCurrency] = useState(
		existing?.config?.currency_code ?? "USD"
	);
	const [relationTarget, setRelationTarget] = useState(
		existing?.config?.relation_object_id ?? ""
	);
	const [maxRating, setMaxRating] = useState(
		String(existing?.config?.max_rating ?? 5)
	);
	const [options, setOptions] = useState<SelectOption[]>(
		existing?.config?.options ?? []
	);
	const [optionDraft, setOptionDraft] = useState("");

	const slug = existing?.slug ?? slugify(name);
	const needsOptions = OPTION_TYPES.has(fieldType);

	// Retyping an existing field would reinterpret every value already stored under
	// it, so the type is fixed once created. Delete and re-add is the honest path,
	// and it makes the data loss explicit instead of silent.
	const typeLocked = Boolean(existing);

	/** Options a record may still be pointing at. Removing one is the destructive
	 *  edit, so it is called out before saving rather than discovered afterwards. */
	const removedOptions = (existing?.config?.options ?? []).filter(
		(before) => !options.some((after) => after.id === before.id)
	);

	const submit = () => {
		const config: Record<string, unknown> = {};
		if (needsOptions) {
			config.options = options.map((option, index) => ({
				...option,
				position: index,
			}));
		}
		if (fieldType === "currency") {
			config.currency_code = currency.trim().toUpperCase() || "USD";
		}
		if (fieldType === "relation") {
			config.relation_object_id = relationTarget;
		}
		if (fieldType === "rating") {
			config.max_rating = Number(maxRating) || 5;
		}
		onSubmit({
			config,
			field_type: fieldType,
			is_required: required,
			name: name.trim(),
			slug,
		});
	};

	return (
		<div className="space-y-3">
			<div className="grid gap-2 sm:grid-cols-2">
				<div>
					<Label htmlFor="crm-field-name">Field name</Label>
					<Input
						id="crm-field-name"
						onChange={(event) => setName(event.target.value)}
						placeholder="Annual contract value"
						value={name}
					/>
					<p className="mt-0.5 font-mono text-muted-foreground text-xs">
						{slug || "—"}
					</p>
				</div>
				<div>
					<Label htmlFor="crm-field-type">Type</Label>
					<NativeSelect
						disabled={typeLocked}
						id="crm-field-type"
						onChange={(event) => setFieldType(event.target.value as FieldType)}
						value={fieldType}
					>
						{FIELD_TYPES.map((type) => (
							<NativeSelectOption key={type.value} value={type.value}>
								{type.label}
							</NativeSelectOption>
						))}
					</NativeSelect>
					{typeLocked && (
						<p className="mt-0.5 text-muted-foreground text-xs">
							A field's type is fixed once it holds data. Delete and re-add to
							change it.
						</p>
					)}
				</div>
			</div>

			{fieldType === "currency" && (
				<div>
					<Label htmlFor="crm-field-currency">Currency code</Label>
					<Input
						className="w-28"
						id="crm-field-currency"
						maxLength={3}
						onChange={(event) => setCurrency(event.target.value)}
						value={currency}
					/>
					<p className="mt-0.5 text-muted-foreground text-xs">
						Amounts are stored as integer minor units, so the code decides how
						they are displayed, not how they are stored.
					</p>
				</div>
			)}

			{fieldType === "relation" && (
				<div>
					<Label htmlFor="crm-field-relation">Links to</Label>
					<NativeSelect
						id="crm-field-relation"
						onChange={(event) => setRelationTarget(event.target.value)}
						value={relationTarget}
					>
						<NativeSelectOption value="">Pick an object…</NativeSelectOption>
						{objects.map((entry) => (
							<NativeSelectOption key={entry.object.id} value={entry.object.id}>
								{entry.object.plural}
							</NativeSelectOption>
						))}
					</NativeSelect>
					<p className="mt-0.5 text-muted-foreground text-xs">
						The reverse side is created for you — the linked object will show
						these records back without a second field.
					</p>
				</div>
			)}

			{fieldType === "rating" && (
				<div>
					<Label htmlFor="crm-field-max-rating">Out of</Label>
					<Input
						className="w-24"
						id="crm-field-max-rating"
						max={10}
						min={2}
						onChange={(event) => setMaxRating(event.target.value)}
						type="number"
						value={maxRating}
					/>
				</div>
			)}

			{needsOptions && (
				<div>
					<Label>Options</Label>
					<ul className="mt-1 space-y-1">
						{options.map((option, index) => (
							<li className="flex items-center gap-2" key={option.id}>
								<Input
									aria-label={`Option ${index + 1} label`}
									className="flex-1"
									onChange={(event) =>
										setOptions((current) =>
											current.map((o) =>
												o.id === option.id
													? { ...o, label: event.target.value }
													: o
											)
										)
									}
									value={option.label}
								/>
								<Input
									aria-label={`Option ${option.label} colour`}
									className="h-9 w-14 p-1"
									onChange={(event) =>
										setOptions((current) =>
											current.map((o) =>
												o.id === option.id
													? { ...o, color: event.target.value }
													: o
											)
										)
									}
									type="color"
									value={option.color ?? "#888888"}
								/>
								{fieldType === "status" && (
									<>
										<label className="flex items-center gap-1 text-xs">
											<Checkbox
												checked={Boolean(option.is_won)}
												onCheckedChange={(checked) =>
													setOptions((current) =>
														current.map((o) =>
															o.id === option.id
																? { ...o, is_won: Boolean(checked) }
																: o
														)
													)
												}
											/>
											won
										</label>
										<label className="flex items-center gap-1 text-xs">
											<Checkbox
												checked={Boolean(option.is_lost)}
												onCheckedChange={(checked) =>
													setOptions((current) =>
														current.map((o) =>
															o.id === option.id
																? { ...o, is_lost: Boolean(checked) }
																: o
														)
													)
												}
											/>
											lost
										</label>
									</>
								)}
								<Button
									aria-label={`Remove option ${option.label}`}
									onClick={() =>
										setOptions((current) =>
											current.filter((o) => o.id !== option.id)
										)
									}
									size="icon"
									variant="ghost"
								>
									<HugeiconsIcon icon={Delete01Icon} size={14} />
								</Button>
							</li>
						))}
					</ul>
					<div className="mt-1 flex gap-2">
						<Input
							aria-label="New option label"
							onChange={(event) => setOptionDraft(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter" && optionDraft.trim() !== "") {
									event.preventDefault();
									setOptions((current) => [
										...current,
										{
											id: slugify(optionDraft),
											label: optionDraft.trim(),
											position: current.length,
										},
									]);
									setOptionDraft("");
								}
							}}
							placeholder="Add an option and press Enter"
							value={optionDraft}
						/>
					</div>
					{fieldType === "status" && (
						<p className="mt-1 text-muted-foreground text-xs">
							Marking a stage won or lost is what lets the pipeline report
							compute a win rate without anyone hardcoding a stage name.
						</p>
					)}
					{removedOptions.length > 0 && (
						<p className="mt-1 text-destructive text-xs">
							Removing {removedOptions.map((o) => o.label).join(", ")} affects
							records that still hold{" "}
							{removedOptions.length === 1 ? "it" : "them"}.
						</p>
					)}
				</div>
			)}

			<label className="flex items-center gap-2 text-sm">
				<Checkbox
					checked={required}
					onCheckedChange={(checked) => setRequired(Boolean(checked))}
				/>
				Required
			</label>

			<div className="flex justify-end gap-2">
				<Button onClick={onCancel} size="sm" variant="ghost">
					Cancel
				</Button>
				<Button
					disabled={
						busy ||
						name.trim() === "" ||
						(fieldType === "relation" && relationTarget === "") ||
						(needsOptions && options.length === 0)
					}
					onClick={submit}
					size="sm"
				>
					{existing ? "Save" : "Add field"}
				</Button>
			</div>
		</div>
	);
}
