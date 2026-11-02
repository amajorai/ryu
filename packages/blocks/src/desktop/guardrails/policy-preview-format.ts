// One-line readouts of the values in a named policy's effective-rules
// preview. Every sentence goes through `tl()` and amounts through the UI
// locale's currency format, so the preview reads in the user's language.
// The formatters stay pure: a component passes its own `tl` (from
// `useLiteralMessages()`), and code outside React gets the active runtime's.

import {
	activeLocale,
	numberFormatter,
	translate as translateLiteral,
} from "@ryu/i18n/core";
import { GUARDRAIL_ACTION_LABELS } from "./copy.ts";

/** `tl(source, values)`, as `useLiteralMessages()` returns it. */
export type PreviewTranslator = (
	source: string,
	values?: Record<string, string | number>
) => string;

/** `POLICY_DENY_ALL` in `packages/db/src/models/control-plane.model.ts`. */
const POLICY_DENY_ALL_MARKER = "<deny-all>";

function actionLabelFor(
	value: string,
	tl: PreviewTranslator
): string | undefined {
	const label = Object.entries(GUARDRAIL_ACTION_LABELS).find(
		([action]) => action === value
	)?.[1];
	return label === undefined ? undefined : tl(label);
}

/** Microdollars as US dollars in the UI locale: "$30", "$12.50", "30 $". */
export function formatPolicyUsd(
	usdMicro: number,
	locale: string = activeLocale()
): string {
	const usd = usdMicro / 1_000_000;
	const whole = Number.isInteger(usd);
	return numberFormatter(locale, {
		currency: "USD",
		maximumFractionDigits: whole ? 0 : 6,
		minimumFractionDigits: whole ? 0 : 2,
		style: "currency",
	}).format(usd);
}

/** A spend cap with its window: "$30 per day". */
function formatBudget(
	usdMicro: number,
	window: unknown,
	tl: PreviewTranslator
): string {
	const amount = formatPolicyUsd(usdMicro);
	switch (window) {
		case "daily":
			return tl("{amount} per day", { amount });
		case "weekly":
			return tl("{amount} per week", { amount });
		case "monthly":
			return tl("{amount} per month", { amount });
		default:
			return amount;
	}
}

/** An evaluator entry: "pii: Block", with "(off)" when it is turned off. */
function formatEvaluator(
	record: Record<string, unknown>,
	id: string,
	tl: PreviewTranslator
): string {
	const action =
		typeof record.inlineAction === "string"
			? (actionLabelFor(record.inlineAction, tl) ?? record.inlineAction)
			: null;
	const label = action ? tl("{id}: {action}", { action, id }) : id;
	return record.enabled === false ? tl("{id} (off)", { id: label }) : label;
}

function formatPreviewRecord(value: object, tl: PreviewTranslator): string {
	const record: Record<string, unknown> = Object.fromEntries(
		Object.entries(value)
	);
	if (typeof record.usdMicro === "number") {
		return formatBudget(record.usdMicro, record.window, tl);
	}
	if (typeof record.name === "string") {
		return record.name;
	}
	if (typeof record.id === "string") {
		return formatEvaluator(record, record.id, tl);
	}
	return JSON.stringify(value);
}

/** One line describing a preview value. */
export function formatPreviewValue(
	value: unknown,
	tl: PreviewTranslator = translateLiteral
): string {
	if (value === null || value === undefined) {
		return tl("Not set");
	}
	if (typeof value === "boolean") {
		return value ? tl("On") : tl("Off");
	}
	if (typeof value === "string") {
		return actionLabelFor(value, tl) ?? value;
	}
	if (typeof value === "number") {
		return numberFormatter(activeLocale()).format(value);
	}
	if (Array.isArray(value)) {
		if (value.length === 0) {
			return tl("No restriction");
		}
		// The control plane's marker for an allowlist that intersected to empty.
		if (value.includes(POLICY_DENY_ALL_MARKER)) {
			return tl("Nothing allowed");
		}
		return value.map((entry) => formatPreviewValue(entry, tl)).join(", ");
	}
	if (typeof value === "object") {
		return formatPreviewRecord(value, tl);
	}
	return String(value);
}
