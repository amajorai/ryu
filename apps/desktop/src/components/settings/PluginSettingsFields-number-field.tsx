import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { Input } from "@ryu/ui/components/input.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { useState } from "react";
import type { PluginSettingsField } from "@/src/lib/pluginSettings.ts";
import {
	type FieldControlProps,
	saveField,
} from "./PluginSettingsFields-save-field.ts";
import { SettingsItem } from "./shared/settings-items.tsx";

/**
 * Check a `number` field's raw input against the bounds it declared, returning
 * either the string to persist or the reason it was rejected.
 *
 * Two things this deliberately does NOT do. It does not persist `Number(raw)` —
 * preferences are bare strings and the trimmed input already IS the canonical
 * form, so round-tripping through a float would rewrite `1.50` as `1.5` behind
 * the user's back. And it treats an emptied box as "unset", not as zero:
 * `Number("")` is `0`, so a naive parse would silently write a real `0` the user
 * never typed.
 */
function validateNumberInput(
	raw: string,
	field: PluginSettingsField,
	tl: LiteralMessage
): { error: string } | { value: string } {
	const trimmed = raw.trim();
	if (trimmed === "") {
		return { value: "" };
	}
	const parsed = Number(trimmed);
	if (!Number.isFinite(parsed)) {
		return { error: "Enter a number." };
	}
	if (field.min !== undefined && parsed < field.min) {
		return {
			error: tl("Must be {min} or more.", { min: String(field.min) }),
		};
	}
	if (field.max !== undefined && parsed > field.max) {
		return {
			error: tl("Must be {max} or less.", { max: String(field.max) }),
		};
	}
	return { value: trimmed };
}

export function NumberField({
	field,
	target,
	storedPreference,
}: FieldControlProps) {
	const tl = useLiteralMessages();
	const fallback =
		field.default === undefined || field.default === null
			? ""
			: String(field.default);
	const [value, setValue] = useState(storedPreference ?? fallback);
	// The last value we actually persisted, so a rejected edit has somewhere to
	// snap back to instead of leaving invalid text sitting in a saved-looking box.
	const [committed, setCommitted] = useState(storedPreference ?? fallback);

	// Validate on commit, never mid-keystroke: a bounded field would otherwise
	// fight anyone typing "10" into a min-of-5 box the moment they press "1".
	const save = async (input: HTMLInputElement) => {
		// `badInput` is load-bearing. A `type="number"` input runs the DOM's value
		// sanitization algorithm, so unparseable text ("abc", "1.2.3") never
		// reaches React — `e.target.value` arrives as `""`, indistinguishable from
		// the user clearing the box, and would quietly persist as "unset".
		// `validity.badInput` is the only thing that tells the two apart. The
		// element is reset directly because React's `value` may already equal
		// `committed`, in which case a setState alone re-renders nothing and the
		// rejected text stays on screen.
		if (input.validity.badInput) {
			input.value = committed;
			setValue(committed);
			toast.error(tl("{label} — Enter a number.", { label: field.label }));
			return;
		}
		// `step` only constrains the stepper buttons; a TYPED value off the grid
		// (3 where step is 5) is a `stepMismatch`, not `badInput`, and would
		// otherwise persist despite the field declaring a granularity.
		if (field.step !== undefined && input.validity.stepMismatch) {
			setValue(committed);
			// Same suppression the bounds branch below uses: a stored value that
			// violates a granularity the plugin tightened LATER would otherwise toast
			// on every blur, nagging about a value the user never touched.
			if (value !== committed) {
				toast.error(
					tl("{label} — Must be a multiple of {step}.", {
						label: field.label,
						step: String(field.step),
					})
				);
			}
			return;
		}
		const result = validateNumberInput(value, field, tl);
		if ("error" in result) {
			// Don't nag when the text never changed — a stored value that violates
			// bounds the plugin tightened later would otherwise toast on every blur.
			if (value !== committed) {
				toast.error(`${field.label} — ${result.error}`);
			}
			setValue(committed);
			return;
		}
		if (result.value === committed) {
			setValue(result.value);
			return;
		}
		const previous = committed;
		setValue(result.value);
		setCommitted(result.value);
		try {
			const ok = await saveField(target, field.prefKey, result.value);
			if (!ok) {
				setValue(previous);
				setCommitted(previous);
			}
		} catch {
			// A throwing transport (no node URL configured) still has to roll back —
			// saveField only toasts on a clean non-ok response.
			setValue(previous);
			setCommitted(previous);
		}
	};

	return (
		<SettingsItem title={field.label}>
			<Input
				aria-label={field.label}
				max={field.max}
				min={field.min}
				onBlur={async (e) => {
					await save(e.currentTarget);
				}}
				onChange={(e) => setValue(e.target.value)}
				placeholder={field.placeholder}
				size="settings-search"
				step={field.step}
				type="number"
				value={value}
			/>
		</SettingsItem>
	);
}
