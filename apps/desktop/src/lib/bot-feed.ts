import { z } from "zod";
import type { ActivityItem } from "./api/activity.ts";
import {
	pluginDocumentSchema,
	pluginValueSchema,
} from "./api/plugin-wire-values.ts";
import { sealedLocalStorage } from "./content-seal.ts";

export const BOT_FEED_PREFERENCES_KEY = "ryu:bot-feed-preferences:v1";
export const BOT_FEED_ENGAGEMENT_KEY = "ryu:bot-feed-engagement:v1";

export const BOT_FEED_SOURCES = [
	"runs",
	"approvals",
	"goals",
	"watch",
	"notes",
] as const;

export type BotFeedSource = (typeof BOT_FEED_SOURCES)[number];

export interface BotFeedPreferences {
	sources: BotFeedSource[];
}

export interface BotFeedEngagement {
	comments: Record<string, string[]>;
	liked: string[];
}

export const DEFAULT_BOT_FEED_PREFERENCES: BotFeedPreferences = {
	sources: [...BOT_FEED_SOURCES],
};

export const DEFAULT_BOT_FEED_ENGAGEMENT: BotFeedEngagement = {
	comments: {},
	liked: [],
};

const botFeedSourceSchema = z.enum(BOT_FEED_SOURCES);
const botFeedArraySchema = z.array(z.unknown());
const botFeedEnvelopeSchema = z.union([
	z.object({
		sources: z.unknown().optional(),
		liked: z.unknown().optional(),
		comments: z.unknown().optional(),
	}),
	// Legacy JSON arrays counted as objects and produced empty stored selections.
	botFeedArraySchema.transform(() => ({
		sources: undefined,
		liked: undefined,
		comments: undefined,
	})),
]);
const botFeedCommentsSchema = z.union([
	pluginDocumentSchema,
	z.array(pluginValueSchema),
]);
type BotFeedStoredInput = Parameters<typeof botFeedSourceSchema.parse>[0];

function storage(): Storage | null {
	try {
		return globalThis.localStorage ?? null;
	} catch {
		return null;
	}
}

function isSource(value: BotFeedStoredInput): value is BotFeedSource {
	return botFeedSourceSchema.safeParse(value).success;
}

export function feedSourceForActivity(
	item: Pick<ActivityItem, "source" | "kind">
): BotFeedSource {
	switch (item.source) {
		case "approvals":
			return "approvals";
		case "monitors":
			return "watch";
		case "quests":
			return "goals";
		case "manual":
			return "notes";
		case "runs":
			return "runs";
		default:
			return item.kind === "approval" ? "approvals" : "runs";
	}
}

export function loadBotFeedPreferences(): BotFeedPreferences {
	try {
		const raw = storage()?.getItem(BOT_FEED_PREFERENCES_KEY);
		if (!raw) {
			return { sources: [...DEFAULT_BOT_FEED_PREFERENCES.sources] };
		}
		const parsed = botFeedEnvelopeSchema.safeParse(JSON.parse(raw));
		if (!parsed.success) {
			return { sources: [...DEFAULT_BOT_FEED_PREFERENCES.sources] };
		}
		const entries = botFeedArraySchema.safeParse(parsed.data.sources);
		const sources = entries.success ? entries.data.filter(isSource) : [];

		return { sources: [...new Set(sources)] };
	} catch {
		return { sources: [...DEFAULT_BOT_FEED_PREFERENCES.sources] };
	}
}

export function saveBotFeedPreferences(preferences: BotFeedPreferences): void {
	try {
		storage()?.setItem(
			BOT_FEED_PREFERENCES_KEY,
			JSON.stringify({
				sources: [...new Set(preferences.sources.filter(isSource))],
			})
		);
	} catch {
		// Local presentation preferences are best-effort.
	}
}

export function loadBotFeedEngagement(): BotFeedEngagement {
	try {
		const raw = sealedLocalStorage.getItem(BOT_FEED_ENGAGEMENT_KEY);
		if (!raw) {
			return { comments: {}, liked: [] };
		}
		const parsed = botFeedEnvelopeSchema.safeParse(JSON.parse(raw));
		if (!parsed.success) {
			return { comments: {}, liked: [] };
		}
		const storedLikes = botFeedArraySchema.safeParse(parsed.data.liked);
		const liked: string[] = [];
		if (storedLikes.success) {
			for (const entry of storedLikes.data) {
				const text = z.string().safeParse(entry);
				if (text.success) {
					liked.push(text.data);
				}
			}
		}
		const comments: Record<string, string[]> = {};
		const storedComments = botFeedCommentsSchema.safeParse(
			parsed.data.comments
		);
		if (storedComments.success) {
			for (const [id, entries] of Object.entries(storedComments.data)) {
				const storedEntries = botFeedArraySchema.safeParse(entries);
				if (!storedEntries.success) {
					continue;
				}
				const strings: string[] = [];
				for (const entry of storedEntries.data) {
					const text = z.string().safeParse(entry);
					if (text.success && text.data.trim().length > 0) {
						strings.push(text.data);
					}
				}
				if (strings.length > 0) {
					comments[id] = strings;
				}
			}
		}

		return { comments, liked: [...new Set(liked)] };
	} catch {
		return { comments: {}, liked: [] };
	}
}

export function saveBotFeedEngagement(engagement: BotFeedEngagement): void {
	try {
		sealedLocalStorage.setItem(
			BOT_FEED_ENGAGEMENT_KEY,
			JSON.stringify(engagement)
		);
	} catch {
		// Local presentation preferences are best-effort.
	}
}

export function filterBotFeed(
	items: readonly ActivityItem[],
	preferences: BotFeedPreferences
): ActivityItem[] {
	const allowed = new Set(preferences.sources);
	return items.filter((item) => allowed.has(feedSourceForActivity(item)));
}
