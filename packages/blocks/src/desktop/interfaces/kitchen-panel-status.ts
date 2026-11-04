import type { LiteralMessage } from "@ryu/i18n/react";
import type { InterfaceAgentAct } from "@ryuhq/protocol/interfaces";
import type { KitchenStation } from "./kitchen-model.ts";
import { chefActStatus, STATION_NAMES } from "./kitchen-panel-chef.tsx";

/**
 * The chef sheet subtitle ("Grill · Cooking"), built as one translated message
 * with each table word translated first. A raw `${a} · ${b}` template left the
 * whole line in English: no catalog key or template matched the composite.
 */
export function chefSheetSubtitle(
	tl: LiteralMessage,
	station: Pick<KitchenStation, "burnt" | "kind" | "working">,
	act: InterfaceAgentAct | null
): string {
	let status = tl("Idle");
	if (act) {
		status = tl(chefActStatus(act).label);
	} else if (station.working) {
		status = tl("Cooking");
	} else if (station.burnt) {
		status = tl("Has a burnt order");
	}
	return tl("{station} · {status}", {
		station: tl(STATION_NAMES[station.kind]),
		status,
	});
}
