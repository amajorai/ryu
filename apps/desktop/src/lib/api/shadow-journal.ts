// apps/desktop/src/lib/api/shadow-journal.ts

import { z } from "zod";
import { shadowFetch } from "./shadow-fetch.ts";
import {
	journalSnapshotSchema,
	timelineEventSchema,
	weeklyReviewSchema,
} from "./shadow-schemas.ts";
import type {
	JournalSnapshot,
	TimelineEvent,
	WeeklyReview,
} from "./shadow-types.ts";

interface JournalOptions {
	narrate?: boolean;
	signal?: AbortSignal;
}

/**
 * Fetch timeline events in the window [now - rangeMinutes, now]. Returns `null`
 * when Shadow is unreachable so callers degrade gracefully.
 */
export async function getTimeline(
	rangeMinutes: number,
	signal?: AbortSignal
): Promise<TimelineEvent[] | null> {
	const now = Date.now() * 1000; // ms → µs
	const start = now - rangeMinutes * 60 * 1_000_000;
	try {
		const resp = await shadowFetch(`/timeline?start=${start}&end=${now}`, {
			signal,
			headers: { Accept: "application/json" },
		});
		if (!resp.ok) {
			return null;
		}
		const data = z
			.object({ entries: z.array(timelineEventSchema).nullish() })
			.parse(await resp.json());
		return data.entries ?? [];
	} catch {
		return null;
	}
}

/**
 * Fetch derived activity cards, category/app stats, and standup bullets for the
 * same live range as the raw timeline. Returns `null` when Shadow is unreachable.
 */
export async function getJournal(
	rangeMinutes: number,
	options?: JournalOptions
): Promise<JournalSnapshot | null> {
	const now = Date.now() * 1000;
	const start = now - rangeMinutes * 60 * 1_000_000;
	const narrate = options?.narrate ? "&narrate=true" : "";
	try {
		const resp = await shadowFetch(
			`/journal?start=${start}&end=${now}${narrate}`,
			{
				signal: options?.signal,
				headers: { Accept: "application/json" },
			}
		);
		if (!resp.ok) {
			return null;
		}
		const data = z
			.object({ journal: journalSnapshotSchema.nullish() })
			.parse(await resp.json());
		return data.journal ?? null;
	} catch {
		return null;
	}
}

/**
 * Fetch the weekly retrospective: the trailing `days` calendar days folded into
 * focus analytics, per-day rollups, and category/app allocation. Returns `null`
 * when Shadow is unreachable so the Review page can render an empty state.
 */
export async function getWeeklyReview(
	days = 7,
	signal?: AbortSignal
): Promise<WeeklyReview | null> {
	const now = Date.now() * 1000;
	try {
		const resp = await shadowFetch(`/journal/weekly?end=${now}&days=${days}`, {
			signal,
			headers: { Accept: "application/json" },
		});
		if (!resp.ok) {
			return null;
		}
		const data = z
			.object({ review: weeklyReviewSchema.nullish() })
			.parse(await resp.json());
		return data.review ?? null;
	} catch {
		return null;
	}
}
