// The island declarative-view renderer's compact `form` view: controlled fields
// whose collected values are handed to every action fired from the form.

import type { ViewField, ViewSpec } from "@ryu/app-host/views";
import { useState } from "react";
import {
	ActionPanel,
	type IslandViewActionHandler,
	type PanelEntry,
	withCtx,
} from "./declarative-view-parts.tsx";

/** One compact, controlled form field in the island idiom. */
function CompactField({
	field,
	value,
	onChange,
}: {
	field: ViewField;
	value: ViewField["value"];
	onChange: (next: NonNullable<ViewField["value"]>) => void;
}) {
	if (field.type === "switch") {
		const on = value === true;
		return (
			<button
				aria-label={field.label}
				aria-pressed={on}
				className={`rounded-lg px-2 py-0.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring ${
					on
						? "bg-foreground/10 text-foreground"
						: "text-muted-foreground hover:bg-foreground/5"
				}`}
				onClick={() => onChange(!on)}
				type="button"
			>
				{on ? "On" : "Off"}
			</button>
		);
	}
	if (field.type === "select") {
		return (
			<select
				aria-label={field.label}
				className="max-w-40 rounded-lg bg-foreground/5 px-1.5 py-0.5 text-foreground text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
				onChange={(e) => onChange(e.target.value)}
				value={String(value ?? "")}
			>
				{(field.options ?? []).map((opt) => (
					<option key={opt.value} value={opt.value}>
						{opt.label}
					</option>
				))}
			</select>
		);
	}
	return (
		<input
			aria-label={field.label}
			className="max-w-40 rounded-lg bg-foreground/5 px-1.5 py-0.5 text-foreground text-xs outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
			onChange={(e) =>
				onChange(
					field.type === "number" && e.target.value !== ""
						? Number(e.target.value)
						: e.target.value
				)
			}
			placeholder={field.placeholder}
			type={field.type === "number" ? "number" : "text"}
			value={String(value ?? "")}
		/>
	);
}

type CompactFormValues = Record<string, ViewField["value"]>;

function initialFormValues(fields: ViewField[]) {
	const values: CompactFormValues = {};
	for (const field of fields) {
		values[field.id] = field.value ?? (field.type === "switch" ? false : "");
	}
	return values;
}

export function CompactForm({
	spec,
	onAction,
}: {
	spec: Extract<ViewSpec, { view: "form" }>;
	onAction?: IslandViewActionHandler;
}) {
	// Controlled inputs: the collected values ARE the form-submit contract — the
	// typed field values handed to every action fired from this form.
	const [values, setValues] = useState<CompactFormValues>(() =>
		initialFormValues(spec.fields)
	);
	const setField = (id: string, next: NonNullable<ViewField["value"]>) =>
		setValues((prev) => ({ ...prev, [id]: next }));
	const entries: PanelEntry[] = [
		...withCtx(spec.submit ? [spec.submit] : undefined, { values }),
		...withCtx(spec.actions, { values }),
	];
	return (
		<div className="flex flex-col">
			<div className="flex flex-col gap-1 p-2">
				{spec.fields.map((field) => (
					<div
						className="flex items-center justify-between gap-2 text-xs"
						key={field.id}
					>
						<span className="text-muted-foreground">{field.label}</span>
						<CompactField
							field={field}
							onChange={(next) => setField(field.id, next)}
							value={values[field.id]}
						/>
					</div>
				))}
			</div>
			<ActionPanel entries={entries} onAction={onAction} />
		</div>
	);
}
