import { lazy, Suspense, useState } from "react";
import { useTabSelector } from "@/src/contexts/TabsContext.tsx";
import { usePaletteOpenTriggers } from "./use-palette-search.ts";

// The palette (search lanes, compose box, import dialogs) is not part of the
// shell's first paint. It loads on the first ⌘K, search click or tray action
// and then stays mounted, owning its own triggers from there on.
const CommandPalette = lazy(() =>
	import("@/src/components/layout/CommandPalette.tsx").then((module) => ({
		default: module.CommandPalette,
	}))
);

/** Listens for the palette's open triggers until the palette itself has loaded. */
function PaletteWakeTriggers({ onWake }: { onWake: () => void }) {
	const openTab = useTabSelector((state) => state.openTab);
	usePaletteOpenTriggers((next) => {
		const wantsOpen = typeof next === "function" ? next(false) : next;
		if (wantsOpen) {
			onWake();
		}
	}, openTab);
	return null;
}

export function DeferredCommandPalette() {
	const [requested, setRequested] = useState(false);
	if (!requested) {
		return <PaletteWakeTriggers onWake={() => setRequested(true)} />;
	}
	return (
		<Suspense fallback={null}>
			<CommandPalette defaultOpen />
		</Suspense>
	);
}
