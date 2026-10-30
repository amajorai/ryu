import { formatCount as formatSharedCount } from "@ryu/ui/lib/number-format.ts";
import type { ListingStat } from "./detail/listing-detail-shell.tsx";
import type { CatalogHost } from "./host.tsx";
import type { SkillCard, SkillDetail } from "./types.ts";

/** Shared count policy, exported for the catalog helper tests. */
export function formatCount(n: number): string {
	return formatSharedCount(n) ?? "—";
}

export function skillTrustLabel(
	value: string | null | undefined
): string | null {
	if (value === "builtin") {
		return "Built-in source";
	}
	if (value === "trusted") {
		return "Trusted source";
	}
	if (value === "community") {
		return "Community source";
	}
	return value?.trim() || null;
}

/**
 * Resolve a catalog card to the on-disk skill id used by the enable/disable
 * toggle. The installed id (the `~/.claude/skills/<id>/` dir name) usually equals
 * the catalog slug; fall back to the card id. Returns `null` when neither is a
 * known installed key, so the caller can hide the toggle instead of targeting a
 * non-existent id.
 */
export function resolveSkillKey(
	enabledByKey: Record<string, boolean>,
	card: SkillCard
): string | null {
	if (enabledByKey[card.slug] !== undefined) {
		return card.slug;
	}
	if (enabledByKey[card.id] !== undefined) {
		return card.id;
	}
	return null;
}

export function formatDateLabel(value: string | null): string | null {
	if (!value) {
		return null;
	}
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) {
		return value;
	}
	return parsed.toLocaleDateString(undefined, {
		day: "numeric",
		month: "short",
		year: "numeric",
	});
}

export function isMarkdownFile(path: string): boolean {
	const lower = path.toLowerCase();
	return lower.endsWith(".md") || lower.endsWith(".mdx");
}

/**
 * Whether to render the SKILL.md authoring affordances (New skill / Edit).
 *
 * Two independent conditions, and getting only the first was a live bug:
 *   1. `navigate` — the host CAN deep link. A read-only surface (web) omits it.
 *   2. `canAuthorSkills` — the deep link LANDS somewhere. The editor is a Ryu App
 *      (`@ryu/skill-editor`) that ships default-OFF, and desktop always has
 *      `navigate`, so on a fresh install every New/Edit button opened a tab reading
 *      "App not enabled". Omitted ⇒ `true`, so hosts with no notion of app
 *      enablement keep the old `navigate`-only behaviour.
 *
 * Exported (rather than inlined at the use site) because both consumers — the filter
 * panel's "New skill" button and the detail pane's Edit — mount inside the
 * Dialog-portaled preview that `renderToStaticMarkup` never emits, so this is the
 * only place the rule can actually be asserted. Deliberately NOT named
 * `canAuthorSkills`: that is the host FIELD this reads, and a function sharing its
 * name invites `host.canAuthorSkills` where the two-condition rule was meant.
 */
export function skillAuthoringEnabled(
	host: Pick<CatalogHost, "canAuthorSkills" | "navigate">
): boolean {
	return Boolean(host.navigate) && host.canAuthorSkills !== false;
}

export interface SkillSourceSection {
	id: string;
	label: string;
	skills: SkillCard[];
}

/** Group the federated result by the registry that produced each card. */
export function groupSkillsBySource(
	skills: readonly SkillCard[]
): SkillSourceSection[] {
	const sections = new Map<string, SkillSourceSection>();
	for (const skill of skills) {
		const id = skill.catalogSourceId ?? skill.source ?? "other";
		const existing = sections.get(id);
		if (existing) {
			existing.skills.push(skill);
			continue;
		}
		sections.set(id, {
			id,
			label: skill.catalogSourceName ?? skill.source ?? "Other marketplaces",
			skills: [skill],
		});
	}
	return [...sections.values()];
}

/** The skill stat strip. Only facts the source ACTUALLY reported get a cell —
 *  the old metadata grid rendered "Not reported" in seven boxes for a skill with
 *  no GitHub link, which is a wall of nothing where the headline numbers go. The
 *  unreported ones still appear, as rows, in the rail. */
export function skillStatItems({
	downloads,
	installs,
	metadata,
}: {
	downloads: string | null;
	installs: string | null;
	metadata: SkillDetail["metadata"];
}): ListingStat[] {
	const audits = metadata.securityAudits;
	const passed = audits.filter((a) => a.status.toLowerCase() === "pass").length;
	const cells: (ListingStat | null)[] = [
		installs ? { label: "Installs", value: installs } : null,
		downloads ? { label: "Downloads", value: downloads } : null,
		metadata.githubStars
			? { label: "Stars", value: metadata.githubStars }
			: null,
		formatDateLabel(metadata.githubPushedAt)
			? {
					label: "Last push",
					value: formatDateLabel(metadata.githubPushedAt),
				}
			: null,
		metadata.firstSeen
			? { label: "First seen", value: metadata.firstSeen }
			: null,
		audits.length > 0
			? {
					label: "Audits",
					sub: `${passed}/${audits.length} pass`,
					value: formatCount(audits.length) ?? "—",
				}
			: null,
	];
	return cells.filter((cell): cell is ListingStat => cell !== null);
}
