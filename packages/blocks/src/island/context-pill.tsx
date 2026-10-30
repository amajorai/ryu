// The idle/context detail pill (Island U4).
//
// This is the trailing island that splits out beside the logo circle, so it
// carries the *text* only (the logo lives in the separate circle). When live
// context is available (Shadow up, capturing, `contextRead` granted) it shows
// the active app name with a pulsing "live" dot. When degraded (consent off or
// Shadow down) it falls back to the plain "Ryu" label with no live indicator
// and a "context unavailable" tooltip, so the surface never errors.

/** Structural shape of the active screen context (matches the island hook). */
export interface IslandActiveContext {
	appName: string | null;
	degraded: boolean;
	live: boolean;
}

const DEGRADED_CONTEXT: IslandActiveContext = {
	appName: null,
	degraded: true,
	live: false,
};

/** Matches each whitespace-separated word so we can cap its first letter. */
const WORD_RE = /\S+/g;

/**
 * Capitalize the first letter of every word in the active app's title (e.g.
 * "visual studio code" -> "Visual Studio Code"). Only the leading character is
 * touched so existing acronyms/camelCase (VS, iTerm) are left intact.
 */
function titleCaseAppName(value: string): string {
	return value.replace(
		WORD_RE,
		(word) => word.charAt(0).toUpperCase() + word.slice(1)
	);
}

export function ContextPill({
	context = DEGRADED_CONTEXT,
	wrap = false,
}: {
	context?: IslandActiveContext;
	/**
	 * Let a long app name wrap onto more lines instead of truncating to one. Only
	 * safe on a surface whose height tracks its content (the desktop island pill);
	 * fixed-height hosts keep the default single truncated line.
	 */
	wrap?: boolean;
}) {
	const hasLiveApp = context.live && context.appName !== null;

	if (hasLiveApp) {
		return (
			<div
				className={`flex gap-2 text-current ${wrap ? "items-start" : "items-center"}`}
				title={context.appName ?? ""}
			>
				<span
					className={`size-2 shrink-0 rounded-full bg-info ${wrap ? "mt-1.5" : ""}`}
				/>
				<span
					className={`font-medium text-sm ${wrap ? "min-w-0 break-words" : "max-w-36 truncate"}`}
				>
					{titleCaseAppName(context.appName ?? "")}
				</span>
			</div>
		);
	}

	// Degraded / plain idle: just the "Ryu" label, with an explanatory tooltip
	// only when context is actually unavailable.
	return (
		<div
			className="flex items-center text-current"
			title={context.degraded ? "context unavailable" : undefined}
		>
			<span className="font-medium text-sm">Ryu</span>
		</div>
	);
}
