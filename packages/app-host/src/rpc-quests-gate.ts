import { z } from "zod";
import { allowlistRecord, allowlistRows } from "./allowlist-projection.ts";
import type { HostServices } from "./rpc.ts";
import { CodedRpcError } from "./rpc-errors.ts";

/**
 * Who may reach the quest board through the host.
 *
 * The grants `quests:crud` and `quests:capture` are approvable for any app id,
 * and the board has one store with no owner per row. The host calls
 * `/api/quests/*` with the owner's node token, so it is the one place that
 * knows which app asked. A grant alone would hand any app every quest, the
 * text the person kept from other apps with the app, window title and URL it
 * came from, and the scratchpad, and would let it change or delete all of it.
 *
 * The rule is by exact app id, the same form as the workflows guard. Desktop
 * and mobile both apply it, so neither client is the softer door.
 */
const QUEST_BOARD_OWNERS: ReadonlySet<string> = new Set([
	"@ryu/quests",
	"com.ryu.quests",
]);

/** The unified inbox shows quests the engine flagged as maybe done. */
const QUEST_INBOX_READERS: ReadonlySet<string> = new Set([
	"@ryu/approvals",
	"com.ryu.approvals",
]);

/** Every host verb of the quest family. */
export const QUEST_VERBS = [
	"questsAcceptSuggestion",
	"questsCapture",
	"questsComplete",
	"questsCreate",
	"questsDelete",
	"questsDismiss",
	"questsDismissSuggestion",
	"questsJudge",
	"questsList",
	"questsOpenDetectionSettings",
	"questsPin",
	"questsScratchpad",
	"questsSetScratchpad",
	"questsUpdate",
	"questsUse",
] as const satisfies readonly (keyof HostServices)[];

/** The three verbs the inbox uses. Their replies are reduced, see below. */
export const QUEST_INBOX_VERBS = [
	"questsAcceptSuggestion",
	"questsDismissSuggestion",
	"questsList",
] as const satisfies readonly (typeof QUEST_VERBS)[number][];

// What the inbox gets for one quest: the fields its rows show, plus the keys
// its shipped schema requires. That schema wants `completion_condition` as a
// string, so the key stays and is always empty. The captured text, its source,
// the detail, the person's own condition and the judge's evidence stay on the
// host.
const inboxSuggestionSchema = allowlistRecord(
	z.object({
		confidence: z.number(),
		reason: z.string(),
		suggested_at: z.string(),
	})
);
export const questInboxRecordSchema = allowlistRecord(
	z.object({
		created_at: z.string(),
		id: z.string(),
		status: z.string(),
		suggestion: inboxSuggestionSchema.nullish(),
		title: z.string(),
		updated_at: z.string(),
	})
).transform((row) => ({ ...row, completion_condition: "" }));
export const questInboxRecordsSchema = allowlistRows(questInboxRecordSchema);

export type QuestAccess = "board" | "inbox" | "none";

export function questAccessFor(pluginId: string): QuestAccess {
	const id = pluginId.trim().toLowerCase();
	if (QUEST_BOARD_OWNERS.has(id)) {
		return "board";
	}
	return QUEST_INBOX_READERS.has(id) ? "inbox" : "none";
}

function refuseQuests(): never {
	throw new CodedRpcError(
		"denied",
		"Only the Quests app can read or change quests from an app."
	);
}

/**
 * Returns `services` unchanged for the Quests app. For the inbox app, the three
 * inbox verbs stay and answer with reduced rows, and the other twelve are
 * refused. For any other app all fifteen are refused. A refusal never reaches
 * the node.
 */
export function gateQuests(
	pluginId: string,
	services: Partial<HostServices>
): Partial<HostServices> {
	const access = questAccessFor(pluginId);
	if (access === "board") {
		return services;
	}
	const gated: Partial<HostServices> = { ...services };
	for (const verb of QUEST_VERBS) {
		if (gated[verb]) {
			gated[verb] = refuseQuests;
		}
	}
	if (access === "none") {
		return gated;
	}
	const {
		questsAcceptSuggestion: accept,
		questsDismissSuggestion: dismiss,
		questsList: list,
	} = services;
	if (accept) {
		gated.questsAcceptSuggestion = async (input) =>
			questInboxRecordSchema.parse(await accept(input));
	}
	if (dismiss) {
		gated.questsDismissSuggestion = async (input) =>
			questInboxRecordSchema.parse(await dismiss(input));
	}
	if (list) {
		gated.questsList = async (input) =>
			questInboxRecordsSchema.parse(await list(input));
	}
	return gated;
}
