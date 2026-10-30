import { tf } from "../../i18n/translate.ts";
import {
	displayBudget,
	type MemoryPreferences,
	RESERVE_MAX,
	RESERVE_MIN,
	type RowId,
	TOP_K_MAX,
	TOP_K_MIN,
} from "./memory-preferences.ts";

/** Label, current value, and help text for each Memory settings row. */
export function memoryRowLabels(preferences: MemoryPreferences) {
	return {
		autoRecall: {
			label: "Automatically recall context",
			value: preferences.autoRecall ? "ON" : "OFF",
			description:
				"Core adds relevant saved memories and earlier chats before a reply.",
		},
		topK: {
			label: "Snippets per reply",
			value: String(preferences.topK),
			description: preferences.autoRecall
				? tf("Choose {min}–{max} recalled snippets.", {
						min: String(TOP_K_MIN),
						max: String(TOP_K_MAX),
					})
				: "Auto-recall is off; turn it on before changing this limit.",
		},
		contextBudget: {
			label: "Conversation context budget",
			value: displayBudget(preferences.contextBudget),
			description:
				"Off sends the full conversation; Auto needs a local model context size.",
		},
		contextReserve: {
			label: "Reply token reserve",
			value: String(preferences.contextReserve),
			description: tf(
				"Applies with a context budget; editable range {min}–{max}.",
				{
					min: String(RESERVE_MIN),
					max: String(RESERVE_MAX),
				}
			),
		},
		autoCompact: {
			label: "Summarize older turns",
			value: preferences.autoCompact ? "ON" : "OFF",
			description:
				"Uses a summarizer model when turns fall outside a context budget.",
		},
		skills: {
			label: "Load skills on demand",
			value: preferences.skills
				? "ON · progressive"
				: "OFF · full instructions",
			description:
				"Controls whether agents load complete skill instructions only when relevant.",
		},
		ranker: {
			label: "Tool and skill search ranking",
			value: preferences.ranker,
			description:
				"Needle 2, keyword BM25, or embeddings-based semantic search.",
		},
	} satisfies Record<
		RowId,
		{ label: string; value: string; description: string }
	>;
}
