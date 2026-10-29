import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { type CliStateEnvironment, cliStatePath } from "./cliStatePath.ts";

/** An explicit sidebar choice; `"auto"` follows the terminal width. */
export const SIDEBAR_VISIBILITIES = ["auto", "shown", "hidden"] as const;
export type SidebarVisibility = (typeof SIDEBAR_VISIBILITIES)[number];

/** Below this many columns an "auto" sidebar hides so the pane keeps its room. */
export const SIDEBAR_AUTO_MIN_COLUMNS = 100;

export interface LayoutPreference {
	sidebar: SidebarVisibility;
}

const layoutPreferenceSchema = z.object({
	sidebar: z.enum(SIDEBAR_VISIBILITIES).catch("auto"),
});

export function defaultLayoutPreference(): LayoutPreference {
	return { sidebar: "auto" };
}

/** The TUI's layout preference file: `<data dir>/state/cli/cli-layout.json`,
 * or `cli-layout.json` directly in `RYU_CLI_CONFIG_DIR` when that is set. */
export function layoutPreferencePath(
	environment: CliStateEnvironment = process.env
): string {
	return cliStatePath("cli-layout.json", environment);
}

/** Validate a parsed value; any unreadable field falls back to auto. */
export function parseLayoutPreference(
	value: Parameters<typeof layoutPreferenceSchema.safeParse>[0]
): LayoutPreference {
	const parsed = layoutPreferenceSchema.safeParse(value);
	return parsed.success ? parsed.data : defaultLayoutPreference();
}

export function readLayoutPreference(
	path = layoutPreferencePath()
): LayoutPreference {
	try {
		return parseLayoutPreference(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return defaultLayoutPreference();
	}
}

/** Persist best-effort: a read-only home never breaks the toggle itself. */
export function writeLayoutPreference(
	preference: LayoutPreference,
	path = layoutPreferencePath()
): LayoutPreference {
	const normalized = parseLayoutPreference(preference);
	try {
		mkdirSync(dirname(path), { recursive: true });
		const temporary = `${path}.${process.pid}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, {
			mode: 0o600,
		});
		renameSync(temporary, path);
	} catch {
		// Keep the in-memory choice for this session.
	}
	return normalized;
}

/** Whether the sidebar shows: an explicit choice wins, else the width decides. */
export function resolveSidebarVisible(
	sidebar: SidebarVisibility,
	columns: number
): boolean {
	if (sidebar === "auto") {
		return columns >= SIDEBAR_AUTO_MIN_COLUMNS;
	}
	return sidebar === "shown";
}
