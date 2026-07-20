// Thin wrapper: the presentational suggestion chip now lives in
// @ryu/blocks/island. This file adapts the island's richer `IslandSuggestion`
// (id/source/confidence/...) onto the block's structural `{title, body}` view.
//
// Prior art: apps/desktop/src/components/companion/SuggestionChip.tsx.

import { IslandSuggestionChip as IslandSuggestionChipBlock } from "@ryu/blocks/island/suggestion-chip";
import type { IslandSuggestion } from "../../shared/ipc.ts";

export interface IslandSuggestionChipProps {
	suggestion: IslandSuggestion;
}

export function IslandSuggestionChip({
	suggestion,
}: IslandSuggestionChipProps) {
	return (
		<IslandSuggestionChipBlock
			suggestion={{ title: suggestion.title, body: suggestion.body }}
		/>
	);
}
