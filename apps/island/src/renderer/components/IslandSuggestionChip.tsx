// Thin wrapper: the presentational suggestion chip lives in @ryu/blocks/island.
// This file adapts the island's richer `IslandSuggestion` (id/source/confidence/...)
// onto the block's structural `{title, body}` view and supplies its one row of
// actions: Accept, Dismiss and, behind "More", Snooze. The actions sit inside the
// chip, so the chip's measured height (not a second row of floating shapes) sizes
// the Island.
//
// Prior art: apps/desktop/src/components/companion/SuggestionChip.tsx.

import { MoreHorizontalIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { IslandSuggestionChip as IslandSuggestionChipBlock } from "@ryu/blocks/island/suggestion-chip";
import { useI18n } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { useEffect, useRef, useState } from "react";
import type { IslandSuggestion } from "../../shared/ipc.ts";

export interface IslandSuggestionActions {
	onAccept: () => void;
	onDismiss: () => void;
	/** Omitted for prompts that have no snooze (meetings, quests). */
	onSnooze?: () => void;
}

export interface IslandSuggestionChipProps {
	actions?: IslandSuggestionActions;
	suggestion: IslandSuggestion;
	/** Wrap the title/body instead of truncating (the island grows to fit). */
	wrap?: boolean;
}

function SuggestionActionRow({
	onAccept,
	onDismiss,
	onSnooze,
}: IslandSuggestionActions) {
	const { t } = useI18n();
	const [showMore, setShowMore] = useState(false);
	const snoozeRef = useRef<HTMLButtonElement>(null);
	// "More" unmounts as Snooze appears; keep keyboard focus on the row.
	useEffect(() => {
		if (showMore) {
			snoozeRef.current?.focus();
		}
	}, [showMore]);
	return (
		<>
			<Button onClick={onAccept} size="xs" variant="mono">
				{t("island.accept", undefined, "Accept")}
			</Button>
			<Button onClick={onDismiss} size="xs" variant="ghost-muted">
				{t("common.dismiss")}
			</Button>
			{onSnooze ? (
				showMore ? (
					<Button
						onClick={onSnooze}
						ref={snoozeRef}
						size="xs"
						variant="ghost-muted"
					>
						{t("island.snooze", undefined, "Snooze")}
					</Button>
				) : (
					<Button
						aria-label={t("common.more")}
						onClick={() => setShowMore(true)}
						size="icon-xs"
						title={t("common.more")}
						variant="ghost-muted"
					>
						<HugeiconsIcon className="size-3.5" icon={MoreHorizontalIcon} />
					</Button>
				)
			) : null}
		</>
	);
}

export function IslandSuggestionChip({
	actions,
	suggestion,
	wrap,
}: IslandSuggestionChipProps) {
	return (
		<IslandSuggestionChipBlock
			actions={
				actions ? (
					// Keyed by suggestion so "More" folds back for each new one.
					<SuggestionActionRow key={suggestion.id} {...actions} />
				) : undefined
			}
			suggestion={{ title: suggestion.title, body: suggestion.body }}
			wrap={wrap}
		/>
	);
}
