// apps/desktop/src/lib/api/agent-fill-sets.ts
//
// Fill sets: the user's own vault items attached to one agent's browser
// session, so the agent can sign in with them without ever seeing a value.
// Core owns the sets (`apps/core/src/vault/agent_accounts/fill_sets.rs`, routes
// `/api/vault/fill-sets`): a set is immutable, one is active per agent, and it
// expires after its time to live. Every reply is metadata only.

import { z } from "zod";

import { type ApiTarget, request } from "./client.ts";

/** Most items one set may attach; Core refuses a larger set. */
export const MAX_FILL_SET_ITEMS = 32;

/** The time-to-live choices the editor offers, in seconds (Core caps 24 h). */
export const FILL_SET_TTL_CHOICES = [3600, 4 * 3600, 24 * 3600] as const;

const attachedItemSchema = z.looseObject({
	environment: z.string(),
	fields: z.array(z.string()).catch(() => []),
	handle: z.string(),
	host: z.string(),
	key: z.string(),
	kind: z.string(),
	path: z.string(),
	site: z.string(),
	// Box fill (Core 1.21+): where a session Box fill may submit the password,
	// and the user's opt-in for a fill without a login URL.
	submit_urls: z.array(z.string()).catch(() => []),
	box_unbound: z.boolean().catch(false),
	login_url_bound: z.boolean().catch(false),
});

const fillSetSchema = z.looseObject({
	agent_id: z.string(),
	claimed: z.boolean(),
	created_at: z.number(),
	expires_at: z.number(),
	id: z.string(),
	items: z.array(attachedItemSchema),
});

export type FillSet = z.output<typeof fillSetSchema>;
export type AttachedItem = z.output<typeof attachedItemSchema>;

const listSchema = z.looseObject({ fillSets: z.array(fillSetSchema) });
const createSchema = z.looseObject({ fillSet: fillSetSchema });
const revokeSchema = z.looseObject({ revoked: z.boolean() });

/** One item to attach, as Core's `POST /api/vault/fill-sets` takes it. */
export interface FillSetItemInput {
	/** The user's opt-in for a session Box fill without a login URL. */
	box_unbound?: boolean;
	environment?: string;
	key: string;
	path?: string;
	site?: string;
	/** Login URLs a session Box fill may submit the password to. */
	submit_urls?: string[];
}

/** The Box fill choices the editor keeps for one item. */
export interface BoxFillChoice {
	loginUrl: string;
	unbound: boolean;
}

/** A stable reference for one parsed item: `environment|path|key`. */
export function fillSetItemRef(item: FillSetItemInput): string {
	return `${item.environment ?? ""}|${item.path ?? ""}|${item.key}`;
}

/**
 * The login URL the editor suggests for an item: the URL the user wrote for
 * it, when that URL is https and names a page (a non-root path) without a
 * query or fragment. Core validates whatever is sent.
 */
export function loginUrlPrefill(site: string | undefined): string {
	if (!site) {
		return "";
	}
	let url: URL;
	try {
		url = new URL(site);
	} catch {
		return "";
	}
	if (
		url.protocol !== "https:" ||
		url.pathname === "/" ||
		url.search !== "" ||
		url.hash !== "" ||
		url.username !== "" ||
		url.password !== "" ||
		url.port !== ""
	) {
		return "";
	}
	return `${url.origin}${url.pathname}`;
}

/** The default choice for an item: its prefilled login URL, no opt-in. */
export function defaultBoxFillChoice(item: FillSetItemInput): BoxFillChoice {
	return { loginUrl: loginUrlPrefill(item.site), unbound: false };
}

/**
 * The items as Core takes them, with each item's login URL and Box opt-in.
 * An item without a stored choice gets its default (the prefill).
 */
export function withBoxFillChoices(
	items: readonly FillSetItemInput[],
	choices: ReadonlyMap<string, BoxFillChoice>
): FillSetItemInput[] {
	return items.map((item) => {
		const choice =
			choices.get(fillSetItemRef(item)) ?? defaultBoxFillChoice(item);
		const loginUrl = choice.loginUrl.trim();
		return {
			...item,
			submit_urls: loginUrl ? [loginUrl] : [],
			box_unbound: choice.unbound,
		};
	});
}

export interface ParsedFillSetText {
	/** One-based line numbers that are not `folder/key [site]`. */
	invalidLines: number[];
	items: FillSetItemInput[];
}

const ITEM_KEY = /^[A-Za-z0-9._-]{1,255}$/;
const WHITESPACE = /\s+/;

/**
 * Parse the editor text: one item per line, `folder/key` (or a bare `key` at
 * the root), optionally followed by the site it fills on. Blank lines are
 * skipped; anything else that does not parse is reported by line number.
 */
export function parseFillSetText(
	text: string,
	environment: string
): ParsedFillSetText {
	const items: FillSetItemInput[] = [];
	const invalidLines: number[] = [];
	const env = environment.trim();
	for (const [index, raw] of text.split("\n").entries()) {
		const line = raw.trim();
		if (line === "") {
			continue;
		}
		const parts = line.split(WHITESPACE);
		const reference = parts[0] ?? "";
		const slash = reference.lastIndexOf("/");
		const key = reference.slice(slash + 1);
		const folder = slash > 0 ? reference.slice(0, slash) : "";
		if (parts.length > 2 || !ITEM_KEY.test(key)) {
			invalidLines.push(index + 1);
			continue;
		}
		items.push({
			key,
			...(env ? { environment: env } : {}),
			...(folder ? { path: `/${folder.replace(/^\/+/, "")}` } : {}),
			...(parts[1] ? { site: parts[1] } : {}),
		});
	}
	return { invalidLines, items };
}

/** The agent's active sets (Core lists only sets whose items the caller may use). */
export async function fetchAgentFillSets(
	target: ApiTarget,
	agentId: string
): Promise<FillSet[]> {
	const body = await request(
		target,
		`/api/vault/fill-sets?agent_id=${encodeURIComponent(agentId)}`,
		{},
		listSchema
	);
	return body.fillSets;
}

/** Attach `items` to the agent's browser session for `ttlSecs` seconds. */
export async function attachAgentFillSet(
	target: ApiTarget,
	agentId: string,
	items: readonly FillSetItemInput[],
	ttlSecs: number
): Promise<FillSet> {
	const body = await request(
		target,
		"/api/vault/fill-sets",
		{
			method: "POST",
			body: { agent_id: agentId, items, ttl_secs: ttlSecs },
		},
		createSchema
	);
	return body.fillSet;
}

/** Revoke a set: the agent can no longer fill any of its items. */
export async function revokeAgentFillSet(
	target: ApiTarget,
	setId: string
): Promise<boolean> {
	const body = await request(
		target,
		`/api/vault/fill-sets/${encodeURIComponent(setId)}`,
		{ method: "DELETE" },
		revokeSchema
	);
	return body.revoked;
}
