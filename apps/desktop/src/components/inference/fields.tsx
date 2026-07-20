// apps/desktop/src/components/inference/fields.tsx
//
// Small, reusable form primitives for the advanced inference editors (sampling
// + launch config). Each maps a single optional config field: an empty/cleared
// control means "unset" (the key is omitted) so Core keeps the engine default.

import { Input } from "@ryu/ui/components/input";
import { Label } from "@ryu/ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select";
import { Switch } from "@ryu/ui/components/switch";
import type { ReactNode } from "react";

let fieldSeq = 0;
const nextId = (prefix: string): string => {
	fieldSeq += 1;
	return `${prefix}-${fieldSeq}`;
};

/** Splits a comma- or newline-separated list into trimmed, non-empty entries. */
const LIST_SEPARATOR = /[\n,]/;

function FieldShell({
	id,
	label,
	hint,
	children,
}: {
	id: string;
	label: string;
	hint?: string;
	children: ReactNode;
}) {
	return (
		<div className="flex flex-col gap-1.5">
			<Label htmlFor={id}>{label}</Label>
			{children}
			{hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
		</div>
	);
}

export function NumberField({
	label,
	value,
	onChange,
	disabled,
	placeholder,
	step,
	min,
	max,
	hint,
}: {
	label: string;
	value: number | undefined;
	onChange: (v: number | undefined) => void;
	disabled?: boolean;
	placeholder?: string;
	step?: number;
	min?: number;
	max?: number;
	hint?: string;
}) {
	const id = nextId("num");
	return (
		<FieldShell hint={hint} id={id} label={label}>
			<Input
				disabled={disabled}
				id={id}
				inputMode="decimal"
				max={max}
				min={min}
				onChange={(e) => {
					const raw = e.target.value.trim();
					if (raw === "") {
						onChange(undefined);
						return;
					}
					const n = Number(raw);
					onChange(Number.isNaN(n) ? undefined : n);
				}}
				placeholder={placeholder ?? "default"}
				step={step}
				type="number"
				value={value ?? ""}
			/>
		</FieldShell>
	);
}

export function TextField({
	label,
	value,
	onChange,
	disabled,
	placeholder,
	hint,
}: {
	label: string;
	value: string | undefined;
	onChange: (v: string | undefined) => void;
	disabled?: boolean;
	placeholder?: string;
	hint?: string;
}) {
	const id = nextId("txt");
	return (
		<FieldShell hint={hint} id={id} label={label}>
			<Input
				disabled={disabled}
				id={id}
				onChange={(e) => {
					const v = e.target.value;
					onChange(v === "" ? undefined : v);
				}}
				placeholder={placeholder ?? "default"}
				value={value ?? ""}
			/>
		</FieldShell>
	);
}

export function BoolField({
	label,
	value,
	onChange,
	disabled,
	hint,
}: {
	label: string;
	value: boolean | undefined;
	onChange: (v: boolean) => void;
	disabled?: boolean;
	hint?: string;
}) {
	const id = nextId("bool");
	return (
		<div className="flex items-start gap-3 py-1">
			<Switch
				checked={value ?? false}
				disabled={disabled}
				id={id}
				onCheckedChange={onChange}
			/>
			<div className="flex flex-col gap-0.5">
				<Label className="cursor-pointer" htmlFor={id}>
					{label}
				</Label>
				{hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
			</div>
		</div>
	);
}

export function EnumField({
	label,
	value,
	options,
	onChange,
	disabled,
	hint,
}: {
	label: string;
	value: string | undefined;
	options: { value: string; label: string }[];
	onChange: (v: string | undefined) => void;
	disabled?: boolean;
	hint?: string;
}) {
	const id = nextId("enum");
	// A leading "default" sentinel maps back to `undefined` (omit the field).
	const SENTINEL = "__default__";
	const items = [{ value: SENTINEL, label: "Default" }, ...options];
	return (
		<FieldShell hint={hint} id={id} label={label}>
			<Select
				disabled={disabled}
				items={items}
				onValueChange={(v) => onChange(v && v !== SENTINEL ? v : undefined)}
				value={value ?? SENTINEL}
			>
				<SelectTrigger id={id}>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{items.map((opt) => (
						<SelectItem key={opt.value} value={opt.value}>
							{opt.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</FieldShell>
	);
}

/** A comma/newline-separated list of strings (e.g. stop sequences, extra args). */
export function StringListField({
	label,
	value,
	onChange,
	disabled,
	placeholder,
	hint,
}: {
	label: string;
	value: string[] | undefined;
	onChange: (v: string[] | undefined) => void;
	disabled?: boolean;
	placeholder?: string;
	hint?: string;
}) {
	const id = nextId("list");
	return (
		<FieldShell hint={hint} id={id} label={label}>
			<Input
				disabled={disabled}
				id={id}
				onChange={(e) => {
					const parts = e.target.value
						.split(LIST_SEPARATOR)
						.map((s) => s.trim())
						.filter((s) => s.length > 0);
					onChange(parts.length > 0 ? parts : undefined);
				}}
				placeholder={placeholder ?? "comma-separated"}
				value={(value ?? []).join(", ")}
			/>
		</FieldShell>
	);
}

/** A two-column responsive grid wrapper used to lay fields out compactly. */
export function FieldGrid({ children }: { children: ReactNode }) {
	return (
		<div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
			{children}
		</div>
	);
}

/** A labelled group inside an editor, with an optional one-line description. */
export function FieldGroup({
	title,
	description,
	children,
}: {
	title: string;
	description?: string;
	children: ReactNode;
}) {
	return (
		<section className="flex flex-col gap-3">
			<div className="flex flex-col gap-0.5">
				<h4 className="font-medium text-sm">{title}</h4>
				{description ? (
					<p className="text-muted-foreground text-xs">{description}</p>
				) : null}
			</div>
			{children}
		</section>
	);
}
