import type { LiteralMessage } from "@ryu/i18n/react";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import type {
	AgentSyncExportResult,
	AgentSyncImportResult,
	AgentSyncResumeResult,
	AgentSyncStatus,
} from "@/src/lib/api/agent-sync.ts";

// The "Sync proof" row values as whole ICU messages: each count gets the
// locale's plural form and digits, and the " · " joins stay inside one
// translatable sentence instead of English template literals.

function countText(value: number): string {
	return formatCount(value) ?? String(value);
}

function replayCounts(entries: readonly { mode: string }[]) {
	const replayed = entries.filter((entry) => entry.mode === "replay").length;
	return { replayed, resumed: entries.length - replayed };
}

export function exportCountsText(
	tl: LiteralMessage,
	result: AgentSyncExportResult
): string {
	return tl(
		"{agents, plural, one {{agentsText} agent} other {{agentsText} agents}} · {skills, plural, one {{skillsText} skill} other {{skillsText} skills}} · {conversations, plural, one {{conversationsText} conversation} other {{conversationsText} conversations}} · {messages, plural, one {{messagesText} message} other {{messagesText} messages}}",
		{
			agents: result.agents,
			agentsText: countText(result.agents),
			conversations: result.conversations,
			conversationsText: countText(result.conversations),
			messages: result.messages,
			messagesText: countText(result.messages),
			skills: result.skills,
			skillsText: countText(result.skills),
		}
	);
}

export function acpPersistenceText(
	tl: LiteralMessage,
	result: AgentSyncExportResult
): string {
	const { replayed, resumed } = replayCounts(result.acpResume);
	return tl(
		"{resumed, plural, one {{resumedText} ACP load/resume} other {{resumedText} ACP loads/resumes}} · {replayed, plural, one {{replayedText} transcript replay} other {{replayedText} transcript replays}}",
		{
			replayed,
			replayedText: countText(replayed),
			resumed,
			resumedText: countText(resumed),
		}
	);
}

export function exportSafetyText(
	tl: LiteralMessage,
	result: AgentSyncExportResult
): string {
	return tl(
		"{conflicts, plural, one {{conflictsText} conflict} other {{conflictsText} conflicts}} · {files, plural, one {{filesText} file written} other {{filesText} files written}}",
		{
			conflicts: result.conflicts,
			conflictsText: countText(result.conflicts),
			files: result.projectedFiles,
			filesText: countText(result.projectedFiles),
		}
	);
}

export function resumeProofText(
	tl: LiteralMessage,
	results: readonly AgentSyncResumeResult[]
): string {
	const { replayed, resumed } = replayCounts(results);
	return tl(
		"{resumed, plural, one {{resumedText} load/resume} other {{resumedText} loads/resumes}} · {replayed, plural, one {{replayedText} replay fallback} other {{replayedText} replay fallbacks}}",
		{
			replayed,
			replayedText: countText(replayed),
			resumed,
			resumedText: countText(resumed),
		}
	);
}

export function importBindingsText(
	tl: LiteralMessage,
	status: AgentSyncStatus | null | undefined
): string {
	const profiles = status?.profiles.length ?? 0;
	const bindings = status?.bindings.length ?? 0;
	return tl(
		"{profiles, plural, one {{profilesText} profile} other {{profilesText} profiles}} · {bindings, plural, one {{bindingsText} ACP binding} other {{bindingsText} ACP bindings}}",
		{
			bindings,
			bindingsText: countText(bindings),
			profiles,
			profilesText: countText(profiles),
		}
	);
}

export function importCountsText(
	tl: LiteralMessage,
	result: AgentSyncImportResult
): string {
	return tl("{imported} imported · {skipped} skipped · {failed} failed", {
		failed: countText(result.failed),
		imported: countText(result.imported),
		skipped: countText(result.skipped),
	});
}

/** Bindings that recorded a `loadSession` capability, i.e. the sessions an ACP
    agent can resume natively rather than through transcript replay. */
export function capabilityRecordCount(
	status: AgentSyncStatus | null | undefined
): number {
	return (
		status?.bindings.filter(
			(binding) =>
				binding.capabilities &&
				JSON.stringify(binding.capabilities).includes("loadSession")
		).length ?? 0
	);
}

export function capabilityRecordsText(
	tl: LiteralMessage,
	status: AgentSyncStatus | null | undefined
): string {
	const records = capabilityRecordCount(status);
	return tl(
		"{records, plural, one {{recordsText} capability record} other {{recordsText} capability records}} · replay fallback remains available",
		{ records, recordsText: countText(records) }
	);
}
