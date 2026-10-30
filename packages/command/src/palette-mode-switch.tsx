// The Search / Compose switch, inside the palette frame as a subtle h-8 pair.

import { useLocalizedString } from "@ryu/i18n/react";
import { Kbd } from "@ryu/ui/components/kbd.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { CommandPaletteMode } from "./types.ts";

function modeClass(active: boolean) {
	return cn(
		"flex h-8 items-center gap-2 rounded-lg px-2 text-sm transition-colors duration-150 hover:duration-0",
		active
			? "bg-muted text-foreground"
			: "text-muted-foreground hover:text-foreground"
	);
}

export function PaletteModeSwitch({
	active,
	onChange,
	searchTabId,
	composeTabId,
}: {
	active: CommandPaletteMode;
	onChange: (mode: CommandPaletteMode) => void;
	searchTabId: string;
	composeTabId: string;
}) {
	const searchLabel = useLocalizedString("Search");
	const composeLabel = useLocalizedString("Compose");
	const switchLabel = useLocalizedString("Search and compose");

	return (
		<div
			aria-label={switchLabel}
			className="flex items-center gap-1 px-2 pt-2"
			role="tablist"
		>
			<button
				aria-label={searchLabel}
				aria-selected={active === "search"}
				className={modeClass(active === "search")}
				id={searchTabId}
				onClick={() => onChange("search")}
				role="tab"
				tabIndex={active === "search" ? 0 : -1}
				type="button"
			>
				{searchLabel}
			</button>
			<button
				aria-label={composeLabel}
				aria-selected={active === "compose"}
				className={modeClass(active === "compose")}
				id={composeTabId}
				onClick={() => onChange("compose")}
				role="tab"
				tabIndex={active === "compose" ? 0 : -1}
				type="button"
			>
				{composeLabel}
			</button>
			<Kbd className="ml-auto" data-slot="command-palette-mode-hint">
				Tab
			</Kbd>
		</div>
	);
}
