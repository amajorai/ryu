// The CRM schema editor's object and field forms and their helpers, split out
// of apps/desktop/src/components/panels/crm/SchemaEditor.tsx so that file
// stays under the size limit.

import { Delete01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
import { ColorPickerPopover } from "@ryu/ui/components/color-picker.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { useState } from "react";
import type {
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
export const FIELD_TYPES: { label: string; value: FieldType }[] = [
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
export const OPTION_TYPES = new Set<FieldType>([
	"select",
	"multi_select",
	"status",
]);

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

function uniqueOptionId(label: string, options: SelectOption[]): string {
	const base = slugify(label);
	if (!base) {
		return "";
	}

	const taken = new Set(options.map((option) => option.id));
	if (!taken.has(base)) {
		return base;
	}

	for (let suffix = 2; ; suffix += 1) {
		const suffixText = `_${suffix}`;
		const candidate = `${base.slice(0, 48 - suffixText.length)}${suffixText}`;
		if (!taken.has(candidate)) {
			return candidate;
		}
	}
}

/** Create a custom object. Slug is derived and shown, because it is what agent
 *  tools and CSV mappings address the object by. */
export function ObjectForm({
	busy,
	onCancel,
	onSubmit,
}: {
	busy: boolean;
	onCancel: () => void;
	onSubmit: (draft: { plural: string; singular: string; slug: string }) => void;
}) {
	const tl = useLiteralMessages();
	const [singular, setSingular] = useState("");
	const [plural, setPlural] = useState("");
	const slug = slugify(singular);

	return (
		<div className="mb-4 rounded-lg border bg-card p-3">
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
				{tl("slug: {slug}", { slug: slug || "—" })}
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
export function FieldForm({
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
	const tl = useLiteralMessages();
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
		const config: NonNullable<Field["config"]> = {};
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
						onChange={(event) =>
							setFieldType(
								/* SAFETY: This NativeSelect renders only FIELD_TYPES values, whose owner type is FieldType. This is a native UI selection, not a decoder for arbitrary synthetic events. */ event
									.target.value as FieldType
							)
						}
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
									aria-label={tl("Option {number} label", {
										number: String(index + 1),
									})}
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
								<ColorPickerPopover
									onValueChange={(value) =>
										setOptions((current) =>
											current.map((o) =>
												o.id === option.id ? { ...o, color: value } : o
											)
										)
									}
									triggerAriaLabel={tl("Option {label} colour", {
										label: option.label,
									})}
									triggerClassName="h-9 w-14 shrink-0"
									triggerShowValue={false}
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
									aria-label={tl("Remove option {label}", {
										label: option.label,
									})}
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
											id: uniqueOptionId(optionDraft, current),
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
						<p className="mt-1 text-status-destructive text-xs">
							{tl(
								"Removing {labels} affects records that still hold {count, plural, one {it} other {them}}.",
								{
									count: removedOptions.length,
									labels: removedOptions.map((o) => o.label).join(", "),
								}
							)}
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
