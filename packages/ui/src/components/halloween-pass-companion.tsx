"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import { useEffect, useState } from "react";
import { GHOST_COSTUME_PRESETS } from "./ghost-costume.ts";
import { GhostCostumeArt } from "./ghost-costume-art.tsx";
import { useHalloweenSeason } from "./halloween-season.ts";

/* A costumed ghost that peeks over the waitlist pass during Halloween season.
   The chosen preset is a per-viewer nicety kept in localStorage; nothing is sent to
   a server. Outside the season it renders nothing. */

const STORAGE_KEY = "ryu-halloween-costume";

function readStoredIndex() {
	try {
		const id = localStorage.getItem(STORAGE_KEY);
		return Math.max(
			0,
			GHOST_COSTUME_PRESETS.findIndex((preset) => preset.id === id)
		);
	} catch {
		return 0;
	}
}

export function HalloweenPassCompanion({
	now,
}: {
	/** Injectable clock for stories and tests. */
	now?: Date;
}) {
	/* Re-checked at each local midnight, so a page left open across
	   1 October or 3 November gains or drops the ghost on its own. */
	const inSeason = useHalloweenSeason(now);
	const [index, setIndex] = useState(0);
	const tl = useLiteralMessages();

	/* Storage is read after mount so server and client agree. */
	useEffect(() => {
		setIndex(readStoredIndex());
	}, []);

	if (!inSeason) {
		return null;
	}
	const preset =
		GHOST_COSTUME_PRESETS[index % GHOST_COSTUME_PRESETS.length] ??
		GHOST_COSTUME_PRESETS[0];
	if (!preset) {
		return null;
	}

	const next = () => {
		const nextIndex = (index + 1) % GHOST_COSTUME_PRESETS.length;
		setIndex(nextIndex);
		try {
			localStorage.setItem(
				STORAGE_KEY,
				GHOST_COSTUME_PRESETS[nextIndex]?.id ?? ""
			);
		} catch {
			/* Storage can be unavailable; the costume still changes this visit. */
		}
	};

	return (
		<div className="pointer-events-none absolute inset-0 z-10">
			<span className="absolute -top-16 right-3 block transition-transform duration-300 motion-safe:hover:-translate-y-1">
				<GhostCostumeArt costume={preset.costume} framing="avatar" size={84} />
			</span>
			<button
				className="pointer-events-auto absolute right-3 -bottom-11 rounded-full border border-border bg-card/90 px-2.5 py-1 text-[11px] text-muted-foreground shadow-sm backdrop-blur transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
				onClick={next}
				type="button"
			>
				{tl("{label} · change costume", { label: preset.label })}
			</button>
		</div>
	);
}
