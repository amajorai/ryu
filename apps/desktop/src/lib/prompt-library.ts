import {
	diffPromptVersions,
	isAssignablePromptLabel,
	LATEST_LABEL,
	type PromptDiffLine,
	promptVersionText,
} from "@ryuhq/protocol/prompt-hub";
import type {
	PromptSummary,
	PromptVersion,
	PromptVersionDraft,
} from "./api/prompts.ts";

/**
 * Pure helpers behind the Prompt Studio prompt library: filtering, what a
 * version contributes to an agent's system prompt, and the diff rows.
 */

/** Case-insensitive match on name, description, tags, and label names. */
export function filterPrompts(
	prompts: readonly PromptSummary[],
	query: string
): PromptSummary[] {
	const needle = query.trim().toLowerCase();
	if (needle === "") {
		return [...prompts];
	}
	return prompts.filter((prompt) =>
		[
			prompt.name,
			prompt.description ?? "",
			...prompt.tags,
			...Object.keys(prompt.labels),
		].some((field) => field.toLowerCase().includes(needle))
	);
}

/** Label badges for an entry, production first, then alphabetical. */
export function labelEntries(
	prompt: Pick<PromptSummary, "labels">
): Array<{ label: string; version: number }> {
	return Object.entries(prompt.labels)
		.map(([label, version]) => ({ label, version }))
		.sort((left, right) => {
			if (left.label === "production") {
				return -1;
			}
			if (right.label === "production") {
				return 1;
			}
			return left.label.localeCompare(right.label);
		});
}

/** The body shown for a version (template, or one block per chat entry). */
export function versionBody(version: PromptVersion): string {
	return promptVersionText(version);
}

/**
 * The text a version puts into an agent's system prompt: the template of a
 * text prompt, or the system and developer messages of a chat prompt. The
 * template is kept unrendered so its `{{variables}}` stay editable.
 */
export function instructionsFromVersion(version: PromptVersion): string {
	if (version.type === "text") {
		return version.template ?? "";
	}
	return (version.messages ?? [])
		.flatMap((entry) =>
			"content" in entry &&
			(entry.role === "system" || entry.role === "developer")
				? [entry.content]
				: []
		)
		.join("\n\n");
}

export interface PromptDiffRow extends PromptDiffLine {
	id: string;
}

/** Diff rows between two versions, keyed for rendering. */
export function versionDiffRows(
	from: PromptVersion,
	to: PromptVersion
): {
	modelConfig: string[];
	rows: PromptDiffRow[];
	variables: { added: string[]; removed: string[] };
} {
	const diff = diffPromptVersions(from, to);
	return {
		rows: diff.lines.map((line, index) => ({ ...line, id: `${index}` })),
		variables: diff.variables,
		modelConfig: Object.entries(diff.modelConfig).map(
			([key, change]) =>
				`${key}: ${JSON.stringify(change.from)} → ${JSON.stringify(change.to)}`
		),
	};
}

/** Normalize a typed label; null when it cannot be assigned. */
export function assignableLabel(raw: string): string | null {
	const label = raw.trim().toLowerCase();
	return label !== LATEST_LABEL && isAssignablePromptLabel(label)
		? label
		: null;
}

/** Whether this node may edit the entry (organization mirrors are read-only). */
export function isEditablePrompt(prompt: Pick<PromptSummary, "source">) {
	return prompt.source !== "cloud";
}

/**
 * The next version when the editor text is committed to `latest` (the
 * prompt's newest version). A text prompt takes the text as its template. A
 * chat prompt stays a chat prompt: the text replaces its system and developer
 * messages (at the first one's position, or first when there are none) and
 * every other message and placeholder is kept. `expectedLatestVersion` makes
 * the commit fail if someone committed after `latest` was loaded. The new
 * version carries `latest`'s model settings forward, since the registries store
 * `{}` for a draft that omits them.
 */
export function editorCommitDraft(
	latest: PromptVersion,
	text: string
): PromptVersionDraft {
	if (latest.type === "text") {
		return {
			type: "text",
			template: text,
			modelConfig: latest.modelConfig,
			expectedLatestVersion: latest.version,
		};
	}
	const entries = latest.messages ?? [];
	const isInstruction = (entry: (typeof entries)[number]) =>
		"content" in entry &&
		(entry.role === "system" || entry.role === "developer");
	const first = entries.findIndex(isInstruction);
	const kept = entries.filter((entry) => !isInstruction(entry));
	// Entries before the first instruction are all kept, so it keeps its index.
	const at = first === -1 ? 0 : first;
	return {
		type: "chat",
		messages: [
			...kept.slice(0, at),
			{ role: "system", content: text },
			...kept.slice(at),
		],
		modelConfig: latest.modelConfig,
		expectedLatestVersion: latest.version,
	};
}
