// The Smart Intake Form widget (spec §6.2): the agent pre-fills a typed form via
// `app.form.render`; the user reviews, corrects with native inputs, and submits.
// Submitting calls the widgetAccessible `app.form.submit` tool with the confirmed
// values plus the set of `edited_keys` the user changed, then hands a concise
// confirmation back to the model via `sendFollowUpMessage`.

import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useRyuGlobal } from "../../shared/useRyuGlobal";

// The wire tool id is `<server>__<tool>` (see `shared/meta.ts`): server `app.form`
// + tool `submit`. The host pins the origin server; the frame supplies this name.
const SUBMIT_TOOL = "app.form__submit";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type FieldType = "text" | "number" | "date" | "select" | "toggle" | "email";

interface FormField {
	key: string;
	label: string;
	type: FieldType;
	value?: unknown;
	options?: string[];
	required?: boolean;
}

interface RenderOutput {
	formId: string;
	fields: FormField[];
	status: string;
}

type FieldValue = string | boolean;
type ValueMap = Record<string, FieldValue>;

interface PersistedState {
	values?: ValueMap;
	submitted?: boolean;
}

type SubmitState = "idle" | "submitting" | "confirmed" | "error";

/** Normalize a field's pre-filled value into an editable control value. */
function initialValue(field: FormField): FieldValue {
	if (field.type === "toggle") {
		return field.value === true;
	}
	return field.value == null ? "" : String(field.value);
}

/** Validate one field's current value; returns an error message or `null`. */
function validateField(field: FormField, value: FieldValue): string | null {
	if (field.type === "toggle") {
		return null;
	}
	const str = typeof value === "string" ? value.trim() : "";
	if (field.required && str.length === 0) {
		return `${field.label} is required.`;
	}
	if (str.length === 0) {
		return null;
	}
	if (field.type === "email" && !EMAIL_RE.test(str)) {
		return "Enter a valid email address.";
	}
	if (field.type === "number" && Number.isNaN(Number(str))) {
		return "Enter a valid number.";
	}
	return null;
}

/** Coerce editable control values into the typed payload the tool receives. */
function buildSubmitValues(
	fields: FormField[],
	values: ValueMap,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const field of fields) {
		const raw = values[field.key];
		if (field.type === "toggle") {
			out[field.key] = raw === true;
			continue;
		}
		const str = typeof raw === "string" ? raw : "";
		if (field.type === "number") {
			out[field.key] = str.length === 0 ? null : Number(str);
			continue;
		}
		out[field.key] = str;
	}
	return out;
}

/** The native input type backing each non-toggle, non-select field. */
function inputTypeFor(type: FieldType): string {
	if (type === "email") {
		return "email";
	}
	if (type === "number") {
		return "number";
	}
	if (type === "date") {
		return "date";
	}
	return "text";
}

interface FieldControlProps {
	field: FormField;
	value: FieldValue;
	invalid: boolean;
	disabled: boolean;
	describedBy?: string;
	onChange: (value: FieldValue) => void;
}

function FieldControl({
	field,
	value,
	invalid,
	disabled,
	describedBy,
	onChange,
}: FieldControlProps) {
	if (field.type === "toggle") {
		return (
			<label className="intake-toggle" htmlFor={field.key}>
				<input
					aria-describedby={describedBy}
					checked={value === true}
					disabled={disabled}
					id={field.key}
					onChange={(event) => onChange(event.target.checked)}
					type="checkbox"
				/>
				<span>{value === true ? "Yes" : "No"}</span>
			</label>
		);
	}

	if (field.type === "select") {
		const options = field.options ?? [];
		return (
			<select
				aria-describedby={describedBy}
				aria-invalid={invalid}
				className="intake-select"
				disabled={disabled}
				id={field.key}
				onChange={(event) => onChange(event.target.value)}
				value={typeof value === "string" ? value : ""}
			>
				<option value="">Select…</option>
				{options.map((option) => (
					<option key={option} value={option}>
						{option}
					</option>
				))}
			</select>
		);
	}

	return (
		<input
			aria-describedby={describedBy}
			aria-invalid={invalid}
			className="intake-input"
			disabled={disabled}
			id={field.key}
			onChange={(event) => onChange(event.target.value)}
			type={inputTypeFor(field.type)}
			value={typeof value === "string" ? value : ""}
		/>
	);
}

function CheckIcon() {
	return (
		<svg
			aria-hidden="true"
			className="intake-icon"
			fill="none"
			viewBox="0 0 16 16"
		>
			<path
				d="M3 8.5l3 3 7-7"
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.6"
			/>
		</svg>
	);
}

function AlertIcon() {
	return (
		<svg
			aria-hidden="true"
			className="intake-icon"
			fill="none"
			viewBox="0 0 16 16"
		>
			<path
				d="M8 5.5v3.5M8 11.5h.01M8 1.5l6.5 11.5H1.5L8 1.5z"
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.4"
			/>
		</svg>
	);
}

export function IntakeForm() {
	const output = useRyuGlobal("toolOutput") as RenderOutput | undefined;
	const persisted = useRyuGlobal("widgetState") as PersistedState | undefined;
	const theme = useRyuGlobal("theme");

	const [values, setValues] = useState<ValueMap>({});
	const [touched, setTouched] = useState(false);
	const [submitState, setSubmitState] = useState<SubmitState>("idle");
	const [errorMessage, setErrorMessage] = useState("");
	const [seededFormId, setSeededFormId] = useState<string | null>(null);
	const originalsRef = useRef<ValueMap>({});

	const fields = useMemo(() => output?.fields ?? [], [output?.fields]);
	const formId = output?.formId;

	// Seed editable values once per form: pre-filled defaults overlaid with any
	// persisted user edits (D4) so a reload restores in-progress corrections.
	useEffect(() => {
		if (!formId || seededFormId === formId) {
			return;
		}
		const base: ValueMap = {};
		for (const field of fields) {
			base[field.key] = initialValue(field);
		}
		originalsRef.current = base;
		setValues({ ...base, ...(persisted?.values ?? {}) });
		if (persisted?.submitted === true) {
			setSubmitState("confirmed");
		}
		setSeededFormId(formId);
	}, [formId, fields, persisted?.values, persisted?.submitted, seededFormId]);

	const errors = useMemo(() => {
		const map: Record<string, string> = {};
		for (const field of fields) {
			const message = validateField(field, values[field.key] ?? "");
			if (message) {
				map[field.key] = message;
			}
		}
		return map;
	}, [fields, values]);

	const editedKeys = useMemo(
		() =>
			fields
				.filter(
					(field) => values[field.key] !== originalsRef.current[field.key],
				)
				.map((field) => field.key),
		[fields, values],
	);

	// Report an initial intrinsic height so the host frame sizes to fit on first
	// paint; subsequent content-shape changes are reported explicitly from the
	// handlers below (and by WidgetRoot's ResizeObserver).
	useEffect(() => {
		window.ryu?.notifyIntrinsicHeight(Math.ceil(document.body.scrollHeight));
	}, []);

	const isConfirmed = submitState === "confirmed";
	const hasErrors = Object.keys(errors).length > 0;

	const handleChange = (key: string, next: FieldValue) => {
		const nextValues = { ...values, [key]: next };
		setValues(nextValues);
		setTouched(true);
		if (submitState !== "submitting") {
			setSubmitState("idle");
		}
		void window.ryu?.setWidgetState({ values: nextValues, submitted: false });
		// A newly shown/hidden validation error changes content height; re-report so
		// the host frame tracks it even where a ResizeObserver is unavailable.
		window.ryu?.notifyIntrinsicHeight(Math.ceil(document.body.scrollHeight));
	};

	const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		setTouched(true);
		if (hasErrors || !formId) {
			return;
		}
		setSubmitState("submitting");
		setErrorMessage("");
		const payload = buildSubmitValues(fields, values);
		try {
			await window.ryu?.callTool(SUBMIT_TOOL, { formId, values: payload });
			setSubmitState("confirmed");
			void window.ryu?.setWidgetState({ values, submitted: true });
			const editedSummary =
				editedKeys.length > 0
					? `Corrected: ${editedKeys.join(", ")}.`
					: "No fields were changed from the pre-filled draft.";
			void window.ryu?.sendFollowUpMessage({
				prompt: `I confirmed the "${
					output?.status ? output.status : "intake"
				}" form (${output?.formId}). ${editedSummary}`,
			});
		} catch (error) {
			setSubmitState("error");
			setErrorMessage(
				error instanceof Error ? error.message : "Submission failed.",
			);
		} finally {
			window.ryu?.notifyIntrinsicHeight(Math.ceil(document.body.scrollHeight));
		}
	};

	// Loading: the host has not injected the render output yet.
	if (output === undefined) {
		return (
			<div className="intake-loading">
				<div className="intake-skeleton" />
				<div className="intake-skeleton" />
				<div className="intake-skeleton" />
			</div>
		);
	}

	// Empty: a render call with no fields to correct.
	if (fields.length === 0) {
		return (
			<div className="intake-empty">
				<strong>Nothing to fill in</strong>
				<span>This form has no fields.</span>
			</div>
		);
	}

	const submitLabel =
		typeof output.status === "string" && submitState === "submitting"
			? "Submitting…"
			: "Submit";

	return (
		<form className="intake" data-theme={theme} onSubmit={handleSubmit}>
			<div className="intake-header">
				<h1 className="intake-title">Review &amp; confirm</h1>
				<p className="intake-subtitle">
					Correct anything the agent got wrong, then submit.
				</p>
			</div>

			<fieldset className="intake-fields" disabled={isConfirmed}>
				{fields.map((field) => {
					const value = values[field.key] ?? "";
					const error = touched ? errors[field.key] : undefined;
					const errorId = error ? `${field.key}-error` : undefined;
					const isEdited = editedKeys.includes(field.key);
					return (
						<div className="intake-field" key={field.key}>
							<label className="intake-label" htmlFor={field.key}>
								<span>{field.label}</span>
								{field.required ? (
									<span aria-hidden="true" className="intake-required">
										*
									</span>
								) : null}
								{isEdited ? (
									<span className="intake-edited">edited</span>
								) : null}
							</label>
							<FieldControl
								describedBy={errorId}
								disabled={isConfirmed || submitState === "submitting"}
								field={field}
								invalid={Boolean(error)}
								onChange={(next) => handleChange(field.key, next)}
								value={value}
							/>
							{error ? (
								<span className="intake-error" id={errorId} role="alert">
									<AlertIcon />
									{error}
								</span>
							) : null}
						</div>
					);
				})}
			</fieldset>

			{submitState === "error" ? (
				<div className="intake-status intake-status-error" role="alert">
					<AlertIcon />
					<span>{errorMessage}</span>
				</div>
			) : null}

			{isConfirmed ? (
				<div className="intake-status intake-status-confirmed">
					<CheckIcon />
					<span>
						Submitted
						{editedKeys.length > 0 ? ` with ${editedKeys.length} ` : " "}
						{editedKeys.length > 0 ? "correction" : ""}
						{editedKeys.length > 1 ? "s" : ""}.
					</span>
				</div>
			) : (
				<div className="intake-actions">
					<button
						className="intake-button"
						disabled={submitState === "submitting" || (touched && hasErrors)}
						type="submit"
					>
						{submitLabel}
					</button>
				</div>
			)}
		</form>
	);
}
