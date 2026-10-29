import type { CSSProperties } from "react";
import crmStyles from "./crm-values.module.css";

interface CrmDataStyle extends CSSProperties {
	"--crm-color"?: string;
	"--crm-share"?: string;
}

import {
	isNativeNumber,
	isNativeText,
} from "@ryu/ui/lib/native-primitive-observation.ts";
// Per-field-type rendering and editing for Harbor (`@ryu/crm`).
//
// Harbor's schema is user-defined, so nothing in the panel can switch on a fixed
// set of columns: a grid cell, a board card line, and a detail row all have to ask
// the SAME question — "given this field's type and config, how do I show and edit
// this value?" — and get the same answer. That question is answered exactly once,
// here. A new field type is one case added to two switches, not a hunt through
// four components.
//
// Money is integer cents on the wire and divides once, at `formatValue`. No
// currency arithmetic happens in floats anywhere above this file.

import { Badge } from "@ryu/ui/components/badge.tsx";
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import {
	formatMinorCurrency,
	formatNumber,
} from "@ryu/ui/lib/number-format.ts";
import { useRef } from "react";
import {
	safeHref,
	safeMailtoHref,
} from "@/src/components/panels/crm/url-safety.ts";
import type { Field, SelectOption, ValueBag } from "@/src/lib/api/crm.ts";
import {
	formatDate as formatDateInZone,
	formatDateTime as formatDateTimeInZone,
} from "@/src/lib/timezone.ts";

/** Shown wherever a value is absent. One constant so an empty cell, an empty
 *  detail row and an empty card line are visibly the same kind of nothing. */
export const EMPTY = "—";

/** Integer cents → a localized amount, dividing exactly once.
 *
 *  `Intl` is given the currency so it places the symbol and the decimal count the
 *  way that currency actually does — a JPY amount has no minor unit, and hardcoding
 *  `/ 100` with two decimals would render ¥4,200.00 for ¥420,000. */
export function formatCents(cents: number, currency = "USD"): string {
	try {
		return formatMinorCurrency(cents, currency);
	} catch {
		// An unknown/invalid currency code from a hand-edited field config must not
		// take the grid down with it.
		return `${formatNumber(cents / 100)} ${currency}`;
	}
}

/** A date-only value, rendered without a time so a `date` field does not imply a
 *  precision it does not have. */
function formatDate(raw: string): string {
	const at = new Date(raw);
	return Number.isNaN(at.getTime()) ? raw : formatDateInZone(at);
}

function formatDatetime(raw: string): string {
	const at = new Date(raw);
	return Number.isNaN(at.getTime()) ? raw : formatDateTimeInZone(at);
}

/** Look a select/status option up by its id.
 *
 *  Falls back to rendering the raw id rather than blanking: a value whose option
 *  was deleted from the field config is still real data, and hiding it would make
 *  a row look empty when it is not. */
function optionFor<TValue>(
	field: Field,
	value: TValue
): SelectOption | undefined {
	return field.config?.options?.find((o) => o.id === value);
}

/**
 * The display string for one value. Pure — no JSX, so it is also what search,
 * export, and a card's subtitle use.
 */
export function formatValue<TValue>(field: Field, value: TValue): string {
	if (value === null || value === undefined || value === "") {
		return EMPTY;
	}
	switch (field.field_type) {
		case "currency":
			return isNativeNumber(value)
				? formatCents(value, field.config?.currency_code ?? "USD")
				: String(value);
		case "percent":
			return isNativeNumber(value) ? `${value}%` : String(value);
		case "checkbox":
			return value ? "Yes" : "No";
		case "date":
			return formatDate(String(value));
		case "datetime":
			return formatDatetime(String(value));
		case "select":
		case "status":
			return optionFor(field, value)?.label ?? String(value);
		case "multi_select":
			return Array.isArray(value)
				? value.map((v) => optionFor(field, v)?.label ?? String(v)).join(", ")
				: String(value);
		case "rating": {
			const max = field.config?.max_rating ?? 5;
			return isNativeNumber(value) ? `${value}/${max}` : String(value);
		}
		case "relation":
			// The grid shows a count; the detail view resolves the actual records
			// through `getRelated`, which is a separate read on purpose — resolving
			// every relation for every row would be N+1 per page.
			return Array.isArray(value) ? `${value.length} linked` : String(value);
		default:
			return String(value);
	}
}

/** Right-align the types people scan as columns of digits, left-align prose. */
export function isNumericField(field: Field): boolean {
	return (
		field.field_type === "currency" ||
		field.field_type === "number" ||
		field.field_type === "percent" ||
		field.field_type === "rating"
	);
}

/** Read-only presentation. Select/status get their option colour as a badge so a
 *  pipeline stage is recognisable at a glance in every surface that shows one. */
export function FieldValue({ field, value }: { field: Field; value: unknown }) {
	if (value === null || value === undefined || value === "") {
		return <span className="text-muted-foreground">{EMPTY}</span>;
	}

	if (field.field_type === "select" || field.field_type === "status") {
		const option = optionFor(field, value);
		const colorStyle: CrmDataStyle | undefined = option?.color
			? { "--crm-color": option.color }
			: undefined;
		return (
			<span
				className={option?.color ? crmStyles.option : undefined}
				style={colorStyle}
			>
				<Badge
					typography="normal"
					variant={option?.color ? "default" : "secondary"}
				>
					{option?.label ?? String(value)}
				</Badge>
			</span>
		);
	}

	if (field.field_type === "multi_select" && Array.isArray(value)) {
		return (
			<div className="flex flex-wrap gap-1">
				{value.map((v) => {
					const option = optionFor(field, v);
					return (
						<Badge key={String(v)} typography="normal" variant="secondary">
							{option?.label ?? String(v)}
						</Badge>
					);
				})}
			</div>
		);
	}

	if (field.field_type === "checkbox") {
		return (
			<Checkbox aria-label={field.name} checked={Boolean(value)} disabled />
		);
	}

	if (field.field_type === "url" && isNativeText(value)) {
		// A `url` field's value is USER DATA and reaches an `href` — and the widest
		// path into it is CSV import, which means the author of a spreadsheet
		// somebody else imports gets to choose the scheme. `javascript:` in an href
		// executes in the desktop app's own origin on click, so the scheme is
		// allowlisted rather than sanitized: anything not plainly navigable renders
		// as inert text, still fully visible, just not clickable.
		const safe = safeHref(value);
		if (!safe) {
			return (
				<span className="truncate" title={value}>
					{value}
				</span>
			);
		}
		return (
			// `rel="noopener"` is required alongside `target="_blank"` — the opened
			// page gets a `window.opener` handle without it.
			<a
				className="text-primary underline-offset-2 hover:underline"
				href={safe}
				rel="noopener noreferrer"
				target="_blank"
			>
				{value}
			</a>
		);
	}

	if (field.field_type === "email" && isNativeText(value)) {
		const href = safeMailtoHref(value);
		if (!href) {
			return (
				<span className="truncate" title={value}>
					{value}
				</span>
			);
		}
		return (
			<a
				className="text-primary underline-offset-2 hover:underline"
				href={href}
			>
				{value}
			</a>
		);
	}

	return (
		<span className="truncate" title={formatValue(field, value)}>
			{formatValue(field, value)}
		</span>
	);
}

/**
 * The editor for one value.
 *
 * Uncontrolled-on-blur rather than controlled-on-change: a grid commits a cell
 * edit when focus leaves, and re-rendering the whole page on every keystroke of a
 * 500-row table is the difference between a usable grid and a janky one. `onCommit`
 * receives the value already coerced to its field's wire type — cents as an
 * integer, a checkbox as a boolean — so no caller has to re-parse.
 */
export function FieldEditor({
	autoFocus,
	field,
	onCancel,
	onCommit,
	value,
}: {
	autoFocus?: boolean;
	field: Field;
	onCancel?: () => void;
	onCommit: (next: ValueBag[string]) => void;
	value: unknown;
}) {
	const canceled = useRef(false);
	const commit = (next: ValueBag[string]) => {
		if (!canceled.current) {
			onCommit(next);
		}
	};
	const stopOnEscape = (event: React.KeyboardEvent) => {
		if (event.key === "Escape") {
			event.preventDefault();
			canceled.current = true;
			onCancel?.();
		}
	};

	switch (field.field_type) {
		case "checkbox":
			return (
				<Checkbox
					aria-label={field.name}
					checked={Boolean(value)}
					onCheckedChange={(next) => commit(Boolean(next))}
				/>
			);

		case "select":
		case "status":
			return (
				<NativeSelect
					aria-label={field.name}
					autoFocus={autoFocus}
					defaultValue={isNativeText(value) ? value : ""}
					onChange={(event) => commit(event.target.value || null)}
					onKeyDown={stopOnEscape}
				>
					<NativeSelectOption value="">{EMPTY}</NativeSelectOption>
					{(field.config?.options ?? []).map((option) => (
						<NativeSelectOption key={option.id} value={option.id}>
							{option.label}
						</NativeSelectOption>
					))}
				</NativeSelect>
			);

		case "relation":
			// A relation is an EDGE, not a string: writing one means calling
			// `link`/`unlink` with target record ids, which needs a record picker the
			// detail view owns. A text input here would let someone type a name, have
			// the store reject it as an invalid relation value, and learn nothing
			// about why. Read-only in the grid, edited on the record page.
			return (
				<span className="text-muted-foreground text-xs">
					Edit links on the record
				</span>
			);

		case "long_text":
			return (
				<Textarea
					aria-label={field.name}
					autoFocus={autoFocus}
					defaultValue={isNativeText(value) ? value : ""}
					onBlur={(event) => commit(event.target.value)}
					onKeyDown={stopOnEscape}
					rows={4}
				/>
			);

		case "currency":
			return (
				<Input
					aria-label={`${field.name} (${field.config?.currency_code ?? "USD"})`}
					autoFocus={autoFocus}
					// Shown as a decimal amount, committed as integer cents. Rounding
					// happens once, here, so a value typed as 42.005 cannot drift into
					// the database as a float.
					defaultValue={isNativeNumber(value) ? String(value / 100) : ""}
					inputMode="decimal"
					onBlur={(event) => {
						const raw = event.target.value.trim();
						if (raw === "") {
							commit(null);
							return;
						}
						const parsed = Number(raw);
						if (
							!(
								/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw) &&
								Number.isFinite(parsed) &&
								Number.isSafeInteger(Math.round(parsed * 100))
							)
						) {
							event.target.setCustomValidity("Enter a valid currency amount.");
							event.target.reportValidity();
							return;
						}
						event.target.setCustomValidity("");
						commit(Math.round(parsed * 100));
					}}
					onChange={(event) => event.target.setCustomValidity("")}
					onKeyDown={stopOnEscape}
					type="text"
				/>
			);

		case "number":
		case "percent":
		case "rating":
			return (
				<Input
					aria-label={field.name}
					autoFocus={autoFocus}
					defaultValue={isNativeNumber(value) ? String(value) : ""}
					max={
						field.field_type === "rating"
							? (field.config?.max_rating ?? 5)
							: undefined
					}
					min={field.field_type === "number" ? undefined : 0}
					onBlur={(event) => {
						const raw = event.target.value.trim();
						if (raw === "") {
							commit(null);
							return;
						}
						const parsed = Number(raw);
						if (!(Number.isFinite(parsed) && event.target.checkValidity())) {
							event.target.reportValidity();
							return;
						}
						commit(parsed);
					}}
					onKeyDown={stopOnEscape}
					step={field.field_type === "rating" ? 1 : "any"}
					type="number"
				/>
			);

		case "date":
		case "datetime":
			return (
				<Input
					aria-label={field.name}
					autoFocus={autoFocus}
					defaultValue={toInputDate(value, field.field_type)}
					onBlur={(event) => {
						const raw = event.target.value;
						if (!raw) {
							commit(null);
							return;
						}
						// The store wants RFC-3339. A `date` input yields `YYYY-MM-DD`
						// and a `datetime-local` yields `YYYY-MM-DDTHH:mm` with no
						// zone — parsing through `Date` stamps the user's own zone,
						// which is what they meant when they picked it.
						const at = new Date(raw);
						commit(Number.isNaN(at.getTime()) ? null : at.toISOString());
					}}
					onKeyDown={stopOnEscape}
					type={field.field_type === "date" ? "date" : "datetime-local"}
				/>
			);

		default:
			return (
				<Input
					aria-label={field.name}
					autoFocus={autoFocus}
					defaultValue={isNativeText(value) ? value : ""}
					onBlur={(event) => commit(event.target.value)}
					onKeyDown={stopOnEscape}
					type={
						field.field_type === "email"
							? "email"
							: field.field_type === "url"
								? "url"
								: field.field_type === "phone"
									? "tel"
									: "text"
					}
				/>
			);
	}
}

/** RFC-3339 → the value shape an `<input type="date">` / `"datetime-local"` wants. */
function toInputDate<TValue>(value: TValue, type: "date" | "datetime"): string {
	if (!isNativeText(value)) {
		return "";
	}
	const at = new Date(value);
	if (Number.isNaN(at.getTime())) {
		return "";
	}
	// Shift into local time before slicing, or a user east of UTC sees yesterday.
	const local = new Date(at.getTime() - at.getTimezoneOffset() * 60_000);
	return type === "date"
		? local.toISOString().slice(0, 10)
		: local.toISOString().slice(0, 16);
}

/** The record's display title, falling back through the object's title field and
 *  then to the server-computed `title`, so a row is never nameless. */
export function recordTitle(
	title: string | undefined,
	values: ValueBag | undefined,
	titleField: Field | undefined
): string {
	if (title && title.trim() !== "") {
		return title;
	}
	if (titleField && values) {
		const raw = values[titleField.slug];
		if (isNativeText(raw) && raw.trim() !== "") {
			return raw;
		}
	}
	return "Untitled";
}
