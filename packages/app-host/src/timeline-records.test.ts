import { describe, expect, test } from "bun:test";
import {
	timelineJournalAppRecordSchema,
	timelineJournalRecordSchema,
} from "./timeline-records.ts";

const app = { name: "Editor", icon_url: null };
const card = {
	apps: [app],
	category: "work",
	detailed_summary: "Details",
	distraction: false,
	distractions: [{ end_ts: 2, start_ts: 1, summary: "Brief", title: "Detour" }],
	end_ts: 3,
	event_count: 2,
	id: "card",
	primary_app: "Editor",
	start_ts: 0,
	summary: "Summary",
	title: "Focused work",
};
const journal = {
	apps: [{ event_count: 2, minutes: 3, name: "Editor" }],
	cards: [card],
	categories: [],
	end_ts: 3,
	focus: {
		communication_minutes: 0,
		deep_work_minutes: 2,
		distraction_minutes: 1,
		focus_minutes: 2,
		focus_ratio: 2 / 3,
		longest_focus_streak_minutes: 2,
		total_minutes: 3,
	},
	standup: { blockers: [], highlights: ["Done"], tasks: [] },
	start_ts: 0,
	future: { nested: [null, true] },
};

describe("sanitized Shadow journal records", () => {
	test("retains complete normalized records and optional legacy app lists", () => {
		expect(timelineJournalRecordSchema.parse(journal)).toBe(journal);
		expect(timelineJournalRecordSchema.parse(journal).cards[0]).toBe(card);
		expect(timelineJournalRecordSchema.parse(journal).cards[0]?.apps?.[0]).toBe(
			app
		);
		const { apps: _apps, ...legacyCard } = card;
		expect(
			timelineJournalRecordSchema.safeParse({ ...journal, cards: [legacyCard] })
				.success
		).toBe(true);
	});
	test("rejects malformed nested statistics, cards, and non-JSON metadata", () => {
		expect(
			timelineJournalRecordSchema.safeParse({
				...journal,
				focus: { ...journal.focus, focus_ratio: "two-thirds" },
			}).success
		).toBe(false);
		expect(
			timelineJournalRecordSchema.safeParse({
				...journal,
				cards: [{ ...card, distractions: [{}] }],
			}).success
		).toBe(false);
		expect(
			timelineJournalRecordSchema.safeParse({
				...journal,
				future: { callback: () => null },
			}).success
		).toBe(false);
	});
	test("refuses app locators even when all presentation fields are valid", () => {
		expect(
			timelineJournalAppRecordSchema.safeParse({
				...app,
				app_path: "/Applications/Editor.app",
			}).success
		).toBe(false);
		expect(
			timelineJournalAppRecordSchema.safeParse({
				...app,
				bundle_id: "app.editor",
			}).success
		).toBe(false);
		expect(
			timelineJournalRecordSchema.safeParse({
				...journal,
				cards: [{ ...card, apps: [{ ...app, bundle_id: "app.editor" }] }],
			}).success
		).toBe(false);
	});
});
