// The timeline sentence for a `field_change` / `stage_change` audit entry.
// It is one whole message per shape, never "{field} changed" + " from X" +
// " to Y" fragments, so a translator can reorder the sentence, and the values
// go through `formatValue` with the same `tl` so a checkbox reads "Ja"/"Nein"
// inside a German sentence instead of "Yes"/"No".

import type { LiteralMessage } from "@ryu/i18n/react";
import type { Activity, Field } from "@/src/lib/api/crm.ts";
import { formatValue } from "./fields.tsx";

export function fieldChangeLine(
	tl: LiteralMessage,
	activity: Pick<Activity, "from_value" | "to_value">,
	field: Field | undefined
): string {
	if (!field) {
		return tl("{field} changed", { field: tl("A field") });
	}
	const hasFrom = activity.from_value !== undefined;
	const hasTo = activity.to_value !== undefined;
	const from = hasFrom ? formatValue(field, activity.from_value, tl) : "";
	const to = hasTo ? formatValue(field, activity.to_value, tl) : "";
	if (hasFrom && hasTo) {
		return tl("{field} changed from {from} to {to}", {
			field: field.name,
			from,
			to,
		});
	}
	if (hasTo) {
		return tl("{field} changed to {to}", { field: field.name, to });
	}
	if (hasFrom) {
		return tl("{field} changed from {from}", { field: field.name, from });
	}
	return tl("{field} changed", { field: field.name });
}
