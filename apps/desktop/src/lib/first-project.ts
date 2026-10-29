// apps/desktop/src/lib/first-project.ts
//
// Pure helpers for the onboarding "Create your first project" step. The step
// itself (`FirstProjectStep`) is presentation; validation and the request it
// sends live here so they are testable without rendering.

import type { GlyphValue } from "@ryu/ui/components/glyph.ts";
import type { NewProjectInput } from "@/src/lib/api/hierarchy.ts";

/** Pre-filled name suggestion. */
export const FIRST_PROJECT_SUGGESTION = "My first project";

/** Longest project name the step accepts. */
export const FIRST_PROJECT_NAME_MAX = 80;

/** Longest "What is this project about?" text the step accepts. */
export const FIRST_PROJECT_ABOUT_MAX = 2000;

export interface FirstProjectDraft {
	about: string;
	folder: string | null;
	icon: GlyphValue;
	name: string;
}

/** The validation message for a draft, or null when it can be created. */
export function firstProjectError(draft: FirstProjectDraft): string | null {
	const name = draft.name.trim();
	if (!name) {
		return "Give your project a name.";
	}
	if ([...name].length > FIRST_PROJECT_NAME_MAX) {
		return `Keep the name under ${FIRST_PROJECT_NAME_MAX} characters.`;
	}
	if ([...draft.about].length > FIRST_PROJECT_ABOUT_MAX) {
		return `Keep the description under ${FIRST_PROJECT_ABOUT_MAX} characters.`;
	}
	return null;
}

/**
 * The project the step creates. The agent personalized on the previous step
 * coordinates it, and the "about" text becomes the project instructions every
 * member thread receives.
 */
export function buildFirstProjectInput(
	draft: FirstProjectDraft,
	coordinatorAgentId: string
): NewProjectInput {
	const about = draft.about.trim();
	return {
		name: draft.name.trim(),
		description: about,
		instructions: about,
		icon: draft.icon ?? null,
		coordinatorAgent: coordinatorAgentId,
		...(draft.folder ? { cwd: draft.folder } : undefined),
	};
}

/** Set when the user skipped the onboarding project step; the getting-started
 * checklist offers "Create your first project" until a project exists. */
export const FIRST_PROJECT_SKIPPED_KEY = "ryu:onboarding-first-project-skipped";

export function markFirstProjectSkipped(): void {
	try {
		localStorage.setItem(FIRST_PROJECT_SKIPPED_KEY, "1");
	} catch {
		// Storage can be unavailable (private window); the checklist then simply
		// falls back to "no project yet", which offers the same item.
	}
}
