import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { z } from "zod";
import type {
	Draft,
	DraftBody,
	MediaAsset,
	ScheduledPost,
	SocialAccount,
} from "../../../apps-store/social/ui/src/types.ts";
import { proofEvidencePath } from "./proof-evidence-path.ts";

// Fixtures and helpers for social-compose-children-proof.spec.ts, kept apart so each file stays under the token limit.

export const evidenceDirectory = proofEvidencePath(
	"test-coverage-sweep-20260924/evidence"
);
export const openingText = "Alpha beta launches.";
export const imageDescription = "A lighthouse above the shoreline.";
export const variantText = "A LinkedIn-first launch message.";
export const tailText = "Tail follow-up.";

export interface SocialBridgeCall {
	body?: unknown;
	method: string;
	path: string;
}

export interface SocialProofResponse {
	method: string;
	path: string;
	value: unknown;
}

export interface SocialProofWindow {
	__socialComposeChildrenProof?: {
		calls: SocialBridgeCall[];
		modelCalls: Array<{ prompt: string; system?: string }>;
		responses: SocialProofResponse[];
	};
}

export interface AccountListResponse {
	accounts: SocialAccount[];
}

export interface DraftListResponse {
	drafts: Draft[];
}

export interface MediaListResponse {
	media: MediaAsset[];
}

export interface PostListResponse {
	posts: ScheduledPost[];
}

export const seedFixtureSchema = z.object({
	accounts: z.array(z.object({ id: z.string() })),
	media: z.object({
		attachPath: z.string(),
		enterPath: z.string(),
		libraryPath: z.string(),
		libraryAsset: z.object({
			created_at: z.number(),
			id: z.string(),
			kind: z.enum(["image", "video"]),
			mime_type: z.string().nullable(),
			name: z.string(),
			path: z.string(),
			workspace_id: z.string(),
		}),
	}),
});
export const timingResponseSchema = z.object({
	best_times: z.object({
		basis: z.enum(["defaults", "hour_of_day", "weekday_hour"]),
		sample_size: z.number(),
		timezone: z.string(),
		slots: z.array(
			z.object({
				day_of_week: z.number().nullable(),
				hour: z.number(),
				lift_pct: z.number().nullable(),
				next_occurrence: z.number(),
				sample_size: z.number(),
			})
		),
	}),
});

declare global {
	interface Window extends SocialProofWindow {}
}

export async function proofState(page: Page) {
	return page.evaluate(() => {
		const proof = window.__socialComposeChildrenProof;
		return {
			calls: proof?.calls ?? [],
			modelCalls: proof?.modelCalls ?? [],
			responses: proof?.responses ?? [],
		};
	});
}

export function writeCalls(calls: SocialBridgeCall[]) {
	return calls.filter(
		(call) =>
			["POST", "PATCH", "DELETE"].includes(call.method) &&
			["/accounts", "/media", "/drafts", "/posts"].some(
				(pathname) =>
					call.path === pathname || call.path.startsWith(`${pathname}/`)
			)
	);
}

export async function readAccounts(page: Page) {
	const response = await page.request.get(
		"/__social/accounts?workspace_id=default"
	);
	expect(response.ok()).toBe(true);
	// SAFETY: This helper first requires a successful response from the private host, which forwards /__social/accounts unchanged to the rebuilt native ryu-social list handler. That handler serializes concrete Rust SocialAccount records under the accounts key; the imported UI wire type mirrors those actual serde fields/enums/nulls. This is the controlled native endpoint contract, not arbitrary JSON validation.
	return (await response.json()) as AccountListResponse;
}

export async function readDrafts(page: Page) {
	const response = await page.request.get(
		"/__social/drafts?workspace_id=default"
	);
	expect(response.ok()).toBe(true);
	// SAFETY: This helper first requires a successful response from the private host, which forwards /__social/drafts unchanged to the rebuilt native ryu-social list handler. That handler serializes concrete Rust Draft records under the drafts key; the imported UI wire type mirrors those actual serde fields/enums/nulls. This is the controlled native endpoint contract, not arbitrary JSON validation.
	return (await response.json()) as DraftListResponse;
}

export async function readMedia(page: Page) {
	const response = await page.request.get(
		"/__social/media?workspace_id=default"
	);
	expect(response.ok()).toBe(true);
	// SAFETY: This helper first requires a successful response from the private host, which forwards /__social/media unchanged to the rebuilt native ryu-social list handler. That handler serializes concrete Rust MediaAsset records under the media key; the imported UI wire type mirrors those actual serde fields/enums/nulls. This is the controlled native endpoint contract, not arbitrary JSON validation.
	return (await response.json()) as MediaListResponse;
}

export async function readPosts(page: Page) {
	const response = await page.request.get(
		"/__social/posts?workspace_id=default"
	);
	expect(response.ok()).toBe(true);
	// SAFETY: This helper first requires a successful response from the private host, which forwards /__social/posts unchanged to the rebuilt native ryu-social list handler. That handler serializes concrete Rust ScheduledPost records under the posts key; the imported UI wire type mirrors those actual serde fields/enums/nulls. This is the controlled native endpoint contract, not arbitrary JSON validation.
	return (await response.json()) as PostListResponse;
}

export function draftBody(
	segments: Array<{ media: DraftBody["media"]; text: string }>,
	accountIds: string[]
): DraftBody {
	const primary = segments[0] ?? { media: [], text: "" };
	return {
		account_ids: accountIds,
		media: primary.media,
		schema_version: 2,
		segments,
		text: primary.text,
	};
}

export async function localDateTimeValue(page: Page, timestamp: number) {
	return page.evaluate((at) => {
		const date = new Date(at);
		const pad = (value: number) => String(value).padStart(2, "0");
		return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
	}, timestamp);
}

export async function saveScreenshot(page: Page, filename: string) {
	await mkdir(evidenceDirectory, { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(evidenceDirectory, filename),
	});
}

export async function waitForTransientAlerts(page: Page) {
	await expect(page.getByRole("alert")).toHaveCount(0, { timeout: 10_000 });
}
