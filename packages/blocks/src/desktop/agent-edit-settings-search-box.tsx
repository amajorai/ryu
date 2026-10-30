"use client";

import { Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Input } from "@ryu/ui/components/input";
import {
	AGENT_TAB_LABELS,
	type AgentSettingsEntry,
	type AgentSettingsHit,
} from "./agent-settings-search.ts";

/** The editor's settings search: a query box plus a hit list that names the
 *  tab (and group) each row lives under. */
export function AgentSettingsSearchBox({
	handleSelectSetting,
	setSettingsQuery,
	settingsQuery,
	visibleHits,
}: {
	handleSelectSetting: (entry: AgentSettingsEntry) => void;
	setSettingsQuery: (query: string) => void;
	settingsQuery: string;
	visibleHits: AgentSettingsHit[];
}) {
	const tl = useLiteralMessages();
	return (
		<div className="relative w-full shrink-0 sm:w-56">
			<HugeiconsIcon
				className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
				icon={Search01Icon}
			/>
			<Input
				aria-label="Search agent settings"
				leadingAdornment="compact"
				onChange={(e) => setSettingsQuery(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Escape") {
						setSettingsQuery("");
					}
					// Enter takes the top hit — the shortest path when you already know
					// the name of the setting and just typed enough of it.
					const firstHit = visibleHits[0];
					if (e.key === "Enter" && firstHit) {
						e.preventDefault();
						handleSelectSetting(firstHit);
					}
				}}
				placeholder="Search settings…"
				size="settings-search"
				value={settingsQuery}
			/>
			{settingsQuery.trim() ? (
				<div className="absolute top-9 right-0 z-30 max-h-80 w-full min-w-64 overflow-y-auto rounded-lg border bg-popover p-1 shadow-md">
					{visibleHits.length === 0 ? (
						<p className="px-2.5 py-2 text-muted-foreground text-sm">
							{tl("No settings match “{query}”.", {
								query: settingsQuery.trim(),
							})}
						</p>
					) : (
						visibleHits.map((hit) => (
							<button
								className="flex w-full flex-col items-start gap-0.5 rounded-md px-2.5 py-1.5 text-left hover:bg-accent"
								key={hit.id}
								onClick={() => handleSelectSetting(hit)}
								type="button"
							>
								<span className="font-medium text-sm">{hit.label}</span>
								{/* Where it lives, so a hit is a direction and not just a
								    name. */}
								<span className="text-muted-foreground text-xs">
									{AGENT_TAB_LABELS[hit.tab]}
									{hit.group ? ` › ${hit.group}` : ""}
								</span>
							</button>
						))
					)}
				</div>
			) : null}
		</div>
	);
}
