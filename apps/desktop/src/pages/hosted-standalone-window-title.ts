import type { LiteralMessage } from "@ryu/i18n/react";
import { useEffect } from "react";
import { applyAuxWindowTitle } from "@/src/boot/use-aux-window-title.ts";

interface NamedCompanion {
	label?: string | null;
	name?: string | null;
}

/**
 * An app name in the reader's language. Names are data, not ICU messages: a
 * name with braces would lose them to the message formatter, so it is shown
 * verbatim.
 */
export function translatedAppName(tl: LiteralMessage, name: string): string {
	return name.includes("{") ? name : tl(name);
}

/**
 * The standalone window's name in the reader's language. Catalog words such
 * as "Forms" translate; brand names are not catalog keys and pass through.
 */
export function standaloneWindowTitle(
	tl: LiteralMessage,
	companion: NamedCompanion | undefined
): string | undefined {
	const name = companion?.label || companion?.name;
	return name ? translatedAppName(tl, name) : undefined;
}

/**
 * Keep the standalone window's native and document titles localized. Until
 * the companion resolves, the title the window was opened with stays put.
 */
export function useStandaloneWindowTitle(title: string | undefined): void {
	useEffect(() => {
		if (!title) {
			return;
		}
		document.title = title;
		applyAuxWindowTitle(title);
	}, [title]);
}
