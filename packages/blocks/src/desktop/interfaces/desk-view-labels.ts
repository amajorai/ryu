import type { LiteralMessage } from "@ryu/i18n/react";
import type { DeskView } from "@ryuhq/protocol/interfaces";
import { DESK_NEEDS_YOU_VIEW_ID } from "./desk-model.ts";

/** How the empty pane names a scoped view: "Atlas's inbox", "Launch Crew". */
export function noSelectionViewLabel(
	view: DeskView | undefined,
	tl: LiteralMessage
): string | null {
	if (!view || view.kind === "all" || view.id === DESK_NEEDS_YOU_VIEW_ID) {
		return null;
	}
	return view.kind === "agent"
		? tl("{label}'s inbox", { label: view.label })
		: view.label;
}
