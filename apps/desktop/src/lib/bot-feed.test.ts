import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ActivityItem } from "./api/activity.ts";
import {
	BOT_FEED_ENGAGEMENT_KEY,
	BOT_FEED_PREFERENCES_KEY,
	type BotFeedPreferences,
	DEFAULT_BOT_FEED_PREFERENCES,
	feedSourceForActivity,
	filterBotFeed,
	loadBotFeedEngagement,
	loadBotFeedPreferences,
	saveBotFeedPreferences,
} from "./bot-feed.ts";

const originalStorage = Object.getOwnPropertyDescriptor(
	globalThis,
	"localStorage"
);
const stored = new Map<string, string>();
beforeEach(() => {
	stored.clear();
	const storage: Storage = {
		getItem: (key) => stored.get(key) ?? null,
		setItem: (key, value) => {
			stored.set(key, value);
		},
		removeItem: (key) => {
			stored.delete(key);
		},
		clear: () => {
			stored.clear();
		},
		key: (index) => [...stored.keys()][index] ?? null,
		get length() {
			return stored.size;
		},
	};
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: storage,
	});
});
afterEach(() => {
	if (originalStorage) {
		Object.defineProperty(globalThis, "localStorage", originalStorage);
	} else {
		Reflect.deleteProperty(globalThis, "localStorage");
	}
});

function activity(source: string, kind = "run"): ActivityItem {
	return {
		agent_id: null,
		body: null,
		created_at: 1,
		id: `${source}-${kind}`,
		kind,
		level: "info",
		metadata: {},
		session_id: null,
		source,
		title: source,
	};
}

describe("Bot feed projection", () => {
	test("maps existing activity producers to user-facing feed groups", () => {
		expect(feedSourceForActivity(activity("runs"))).toBe("runs");
		expect(feedSourceForActivity(activity("approvals"))).toBe("approvals");
		expect(feedSourceForActivity(activity("quests"))).toBe("goals");
		expect(feedSourceForActivity(activity("monitors"))).toBe("watch");
		expect(feedSourceForActivity(activity("manual"))).toBe("notes");
		expect(feedSourceForActivity(activity("new-module", "approval"))).toBe(
			"approvals"
		);
	});

	test("filters the real activity stream without rewriting its records", () => {
		const items = [activity("runs"), activity("approvals"), activity("quests")];
		const preferences: BotFeedPreferences = { sources: ["approvals"] };
		expect(filterBotFeed(items, preferences)).toEqual([items[1]]);
		expect(filterBotFeed(items, DEFAULT_BOT_FEED_PREFERENCES)).toEqual(items);
	});
});

test("saved feed preferences retain legacy root arrays and discard future source entries", () => {
	expect(loadBotFeedPreferences()).toEqual(DEFAULT_BOT_FEED_PREFERENCES);
	stored.set(BOT_FEED_PREFERENCES_KEY, "null");
	expect(loadBotFeedPreferences()).toEqual(DEFAULT_BOT_FEED_PREFERENCES);
	for (const value of [[], {}, { sources: false }]) {
		stored.set(BOT_FEED_PREFERENCES_KEY, JSON.stringify(value));
		expect(loadBotFeedPreferences()).toEqual({ sources: [] });
	}
	stored.set(
		BOT_FEED_PREFERENCES_KEY,
		JSON.stringify({ sources: ["runs", "future", "notes", "runs", null, 4] })
	);
	expect(loadBotFeedPreferences()).toEqual({ sources: ["runs", "notes"] });
	saveBotFeedPreferences({ sources: ["notes", "runs", "notes"] });
	expect(stored.get(BOT_FEED_PREFERENCES_KEY)).toBe(
		'{"sources":["notes","runs"]}'
	);
});

test("saved feed engagement keeps string content and ordering while rejecting malformed entries", () => {
	stored.set(
		BOT_FEED_ENGAGEMENT_KEY,
		JSON.stringify({
			liked: ["", "run", 1, "run", "other", null],
			comments: {
				run: ["  text  ", "", " ", null, 1, "second"],
				empty: [],
				invalid: "text",
			},
		})
	);
	expect(loadBotFeedEngagement()).toEqual({
		liked: ["", "run", "other"],
		comments: { run: ["  text  ", "second"] },
	});
	stored.set(
		BOT_FEED_ENGAGEMENT_KEY,
		JSON.stringify({ comments: [["legacy array"]], liked: [] })
	);
	expect(loadBotFeedEngagement()).toEqual({
		liked: [],
		comments: { 0: ["legacy array"] },
	});
	stored.set(BOT_FEED_ENGAGEMENT_KEY, "not-json");
	expect(loadBotFeedEngagement()).toEqual({ comments: {}, liked: [] });
});
