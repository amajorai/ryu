import { translate as tl } from "@ryu/i18n/core";
import { formatDurationUnit } from "@ryu/i18n/format-intl";
import { formatCurrency } from "@ryu/ui/lib/number-format.ts";
import { z } from "zod";
import type { OrganizationAuditEntry } from "@/src/lib/api/orgs.ts";

// The Agent Passport activity row's details line. Every part is one whole
// message in the UI language with its value formatted there (grouped token
// counts, the locale's duration unit, the locale's currency form), so a
// Japanese row reads "1,234 トークン · レイテンシ 840ミリ秒" instead of
// "tokens 1234 · latency 840ms". Parts join with the existing " · ".

const DETAIL_SEPARATOR = " · ";
const MICRO_PER_DOLLAR = 1_000_000;

/** Request cost kept to the micro-dollar the Gateway records. */
const MICRO_USD: Intl.NumberFormatOptions = {
	maximumFractionDigits: 6,
	minimumFractionDigits: 2,
};

/** One Gateway activity row's metadata, as the details line reads it. */
export interface PassportGatewayDetailsInput {
	backend: string | null;
	command: string | null;
	costMicroUsd?: number | null;
	durationMs: number | null;
	error: string | null;
	eventType: string;
	feature: string | null;
	inputTokens: number;
	latencyMs: number;
	model?: string | null;
	outputTokens: number;
	provider: string;
}

function milliseconds(value: number): string {
	return formatDurationUnit(value, "millisecond");
}

function surfacePart(feature: string): string {
	return tl("Surface {name}", { name: feature });
}

function errorPart(error: string): string {
	return tl("Error: {message}", { message: error });
}

/** "openai · gpt-5 · 15 tokens · Latency 42ms · Surface chat". */
export function passportGatewayDetails(
	entry: PassportGatewayDetailsInput
): string {
	const parts: string[] = [];
	if (entry.eventType === "model_call") {
		parts.push(`${entry.provider}${DETAIL_SEPARATOR}${entry.model}`);
		parts.push(
			tl("{count, plural, one {# token} other {# tokens}}", {
				count: entry.inputTokens + entry.outputTokens,
			})
		);
		parts.push(
			tl("Latency {duration}", { duration: milliseconds(entry.latencyMs) })
		);
	} else {
		if (entry.backend) {
			parts.push(entry.backend);
		}
		if (entry.command) {
			parts.push(entry.command);
		}
		if (entry.durationMs !== null) {
			parts.push(
				tl("Duration {duration}", { duration: milliseconds(entry.durationMs) })
			);
		}
	}
	if (entry.feature) {
		parts.push(surfacePart(entry.feature));
	}
	if (entry.costMicroUsd !== undefined && entry.costMicroUsd !== null) {
		parts.push(
			tl("Cost {amount}", {
				amount: formatCurrency(
					entry.costMicroUsd / MICRO_PER_DOLLAR,
					"USD",
					MICRO_USD
				),
			})
		);
	}
	if (entry.error) {
		parts.push(errorPart(entry.error));
	}
	return parts.join(DETAIL_SEPARATOR) || tl("No additional metadata");
}

const controlDetailBooleanSchema = z.boolean();
const controlDetailScalarSchema = z.union([
	z.string(),
	z.number(),
	controlDetailBooleanSchema,
]);

/** A control-plane detail value: booleans read "Yes"/"No" in the UI language. */
function controlDetailValue(value: unknown): string | null {
	if (value === null || value === undefined) {
		return null;
	}
	const printable = controlDetailScalarSchema.safeParse(value);
	if (!printable.success) {
		return null;
	}
	const boolean = controlDetailBooleanSchema.safeParse(printable.data);
	if (boolean.success) {
		return boolean.data ? tl("Yes") : tl("No");
	}
	return String(printable.data);
}

/** "Surface control · status: 200 · dryRun: No". */
export function passportControlDetails(entry: OrganizationAuditEntry): string {
	const parts: string[] = [];
	if (entry.feature) {
		parts.push(surfacePart(entry.feature));
	}
	for (const [key, raw] of Object.entries(entry.details)) {
		const value = controlDetailValue(raw);
		if (value !== null) {
			// The key is the control plane's own data name, shown as recorded.
			parts.push(`${key}: ${value}`);
		}
	}
	if (entry.error) {
		parts.push(errorPart(entry.error));
	}
	return (
		parts.join(DETAIL_SEPARATOR) || tl("Change accepted by the control plane")
	);
}
