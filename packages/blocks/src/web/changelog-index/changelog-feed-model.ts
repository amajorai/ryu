import type { ChangelogEntryData } from "../changelog.tsx";

/**
 * One release as the changelog index feed shows it: the block's entry shape
 * plus the one-line `summary` the page chose to print (none when the
 * frontmatter description only restates the title, version, and date).
 */
export interface ChangelogFeedEntry extends ChangelogEntryData {
	summary?: string;
}

function timeOf(entry: { date: string }): number {
	const time = Date.parse(entry.date);
	return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

/** Newest release first; a stable sort keeps same-day releases in order. */
export function newestReleasesFirst<T extends { date: string }>(
	entries: readonly T[]
): T[] {
	return [...entries].sort((a, b) => timeOf(b) - timeOf(a));
}

/** "v0.5.0" for a version, `undefined` when the release has none. */
export function versionLabel(version?: string): string | undefined {
	const trimmed = version?.trim().replace(/^v/i, "");
	return trimmed ? `v${trimmed}` : undefined;
}

/** True when the release's title, summary, notes text, version, or type matches. */
export function releaseMatchesQuery(
	entry: ChangelogFeedEntry,
	query: string
): boolean {
	const needle = query.trim().toLowerCase();
	if (!needle) {
		return true;
	}
	return [
		entry.title,
		entry.summary,
		entry.content,
		entry.version,
		entry.type,
	].some((field) => field?.toLowerCase().includes(needle));
}
