import type { ViewField, ViewSpec } from "@ryu/app-host/views";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { useState } from "react";
import { Actions, buttonVariant } from "./DeclarativeView.parts.tsx";
import type { ViewActionHandler } from "./DeclarativeView.tsx";

/** One controlled form field, rendered by its declared `type`. */
export function FormField({
	field,
	value,
	onChange,
}: {
	field: ViewField;
	value: ViewField["value"];
	onChange: (next: ViewField["value"]) => void;
}) {
	switch (field.type) {
		case "switch":
			return (
				<Switch
					checked={value === true}
					id={field.id}
					onCheckedChange={(checked) => onChange(checked)}
				/>
			);
		case "select":
			return (
				<NativeSelect
					id={field.id}
					onChange={(e) => onChange(e.target.value)}
					required={field.required}
					value={String(value ?? "")}
				>
					{(field.options ?? []).map((opt) => (
						<NativeSelectOption key={opt.value} value={opt.value}>
							{opt.label}
						</NativeSelectOption>
					))}
				</NativeSelect>
			);
		case "textarea":
			return (
				<Textarea
					id={field.id}
					onChange={(e) => onChange(e.target.value)}
					placeholder={field.placeholder}
					required={field.required}
					value={String(value ?? "")}
				/>
			);
		case "number":
			return (
				<Input
					id={field.id}
					onChange={(e) =>
						onChange(e.target.value === "" ? "" : Number(e.target.value))
					}
					placeholder={field.placeholder}
					required={field.required}
					type="number"
					value={String(value ?? "")}
				/>
			);
		default:
			return (
				<Input
					id={field.id}
					onChange={(e) => onChange(e.target.value)}
					placeholder={field.placeholder}
					required={field.required}
					type="text"
					value={String(value ?? "")}
				/>
			);
	}
}

export function initialFormValues(fields: ViewField[]) {
	const values: Record<string, ViewField["value"]> = {};
	for (const field of fields) {
		values[field.id] =
			field.value ??
			(field.type === "switch"
				? false
				: field.type === "select"
					? (field.options?.[0]?.value ?? "")
					: "");
	}
	return values;
}

export function FormRenderer({
	spec,
	onAction,
}: {
	spec: Extract<ViewSpec, { view: "form" }>;
	onAction?: ViewActionHandler;
}) {
	// Controlled inputs: the collected values ARE the form-submit contract — the
	// `Record<string,unknown>` handed to every action fired from this form.
	const [values, setValues] = useState<Record<string, ViewField["value"]>>(() =>
		initialFormValues(spec.fields)
	);
	const [pending, setPending] = useState(false);
	const setField = (id: string, next: ViewField["value"]) =>
		setValues((prev) => ({ ...prev, [id]: next }));
	return (
		<form
			className="flex max-w-md flex-col gap-4"
			onSubmit={async (e) => {
				e.preventDefault();
				if (spec.submit) {
					setPending(true);
					try {
						await onAction?.(spec.submit, { values });
					} finally {
						setPending(false);
					}
				}
			}}
		>
			{spec.fields.map((field) => (
				<div className="flex flex-col gap-1.5" key={field.id}>
					<Label htmlFor={field.id}>{field.label}</Label>
					<FormField
						field={field}
						onChange={(next) => setField(field.id, next)}
						value={values[field.id]}
					/>
				</div>
			))}
			<Actions actions={spec.actions} ctx={{ values }} onAction={onAction} />
			{spec.submit ? (
				<Button
					disabled={pending}
					type="submit"
					variant={buttonVariant(spec.submit.style)}
				>
					{spec.submit.label}
				</Button>
			) : null}
		</form>
	);
}
