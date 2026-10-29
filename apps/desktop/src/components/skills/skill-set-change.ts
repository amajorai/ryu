/**
 * Labels for the prompt-cache confirmation shown before a global skill change.
 *
 * Core injects the enabled skill set into the system prompt of every thread
 * that loads skills, so installing, enabling, or disabling a skill changes that
 * prefix for all of them; updating an enabled skill can rewrite its name and
 * description there too. The confirmation copy itself comes from
 * `promptEditCacheWarning(labels, "skill-threads")`; this module only names the
 * skills that change, and decides when nothing changes.
 */

import type { ApiTarget } from "@/src/lib/api/client.ts";
import { type InstalledSkill, listSkills } from "@/src/lib/api/skills.ts";

/** How many skill names a confirmation lists before summarising the rest. */
const MAX_LISTED_SKILLS = 3;

/** The display name for a catalog id such as `owner/repo/skill`. */
export function skillDisplayName(id: string, name?: string | null): string {
	const named = name?.trim();
	if (named) {
		return named;
	}
	return id.split("/").filter(Boolean).at(-1) ?? id;
}

/**
 * Field labels for `promptEditCacheWarning`. One skill reads "The X skill";
 * several are listed by name, with any past the first three summarised.
 */
export function skillSetChangeLabels(names: readonly string[]): string[] {
	const unique = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
	if (unique.length === 0) {
		return [];
	}
	if (unique.length === 1) {
		return [`The ${unique[0]} skill`];
	}
	if (unique.length <= MAX_LISTED_SKILLS + 1) {
		return unique;
	}
	const rest = unique.length - MAX_LISTED_SKILLS;
	return [...unique.slice(0, MAX_LISTED_SKILLS), `${rest} more skills`];
}

/**
 * Whether toggling a skill changes the enabled set. An unknown current state
 * counts as a change, so the user is asked rather than surprised.
 */
export function skillToggleChangesSet(
	current: boolean | undefined,
	next: boolean
): boolean {
	return current !== next;
}

/** A skill that an install may add, such as a bundle's skill member. */
export interface SkillInstallCandidate {
	readonly id: string;
	readonly name?: string | null;
}

/**
 * Names of the candidates not yet installed. Core stores an installed skill
 * under its slug (the catalog id's last segment), so a candidate counts as
 * present when either its full id or that slug is installed.
 */
export function skillsNotInstalled(
	candidates: readonly SkillInstallCandidate[],
	installedIds: ReadonlySet<string>
): string[] {
	const names: string[] = [];
	for (const candidate of candidates) {
		const slug = skillDisplayName(candidate.id);
		if (installedIds.has(candidate.id) || installedIds.has(slug)) {
			continue;
		}
		names.push(skillDisplayName(candidate.id, candidate.name));
	}
	return names;
}

/**
 * The skill members of a bundle that installing it would add to the node's
 * enabled skill set, for `confirmSkillSetChange`. When the installed list
 * cannot be read, every skill member is named, so the user is asked rather
 * than surprised.
 */
export async function bundleSkillChanges(
	target: ApiTarget,
	members: readonly (SkillInstallCandidate & { readonly kind: string })[]
): Promise<string[]> {
	const skills = members.filter((member) => member.kind === "skill");
	if (skills.length === 0) {
		return [];
	}
	let installedIds: ReadonlySet<string>;
	try {
		installedIds = new Set((await listSkills(target)).map((skill) => skill.id));
	} catch {
		installedIds = new Set();
	}
	return skillsNotInstalled(skills, installedIds);
}

/** An available skill update, as `useAvailableUpdates` reports it. */
export interface SkillUpdateCandidate {
	/** The catalog id the update re-installs. */
	readonly id: string;
	readonly name?: string | null;
	/** The installed slug, when the update check reported one. */
	readonly slug?: string | null;
}

/**
 * Names of the updates whose skill is enabled. Updating rewrites the skill's
 * name and description in the skills block, which only enabled skills reach,
 * so a disabled skill updates without a confirmation. A skill missing from the
 * installed list counts as enabled, so the user is asked rather than surprised.
 */
export function enabledSkillUpdates(
	updates: readonly SkillUpdateCandidate[],
	installed: readonly Pick<InstalledSkill, "enabled" | "id">[]
): string[] {
	const enabledById = new Map(
		installed.map((skill) => [skill.id, skill.enabled])
	);
	const names: string[] = [];
	for (const update of updates) {
		const keys = [update.slug, update.id, skillDisplayName(update.id)];
		const known = keys.find((key) => key && enabledById.has(key));
		if (known && enabledById.get(known) === false) {
			continue;
		}
		names.push(skillDisplayName(update.id, update.name));
	}
	return names;
}

/**
 * The enabled skills an update run would change, for `confirmSkillSetChange`.
 * When the installed list cannot be read, every update is named.
 */
export async function skillUpdateChanges(
	target: ApiTarget,
	updates: readonly SkillUpdateCandidate[],
	list: (target: ApiTarget) => Promise<InstalledSkill[]> = listSkills
): Promise<string[]> {
	if (updates.length === 0) {
		return [];
	}
	let installed: readonly InstalledSkill[];
	try {
		installed = await list(target);
	} catch {
		installed = [];
	}
	return enabledSkillUpdates(updates, installed);
}
