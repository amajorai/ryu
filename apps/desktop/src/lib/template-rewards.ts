// Template Rewards pilot reporter (flag `marketplace.template_rewards_pilot`).
//
// When a signed-in user chats with an agent they installed from the
// Marketplace, report "used <listing> today" to the control plane at most once
// per listing per day. The control plane stamps the day, drops non-template and
// non-enrolled listings, and excludes the publisher's own members, staff, and
// free-trial usage — this side only has to name the listing.
//
// Core assigns an installed agent a fresh local id, so the listing id is
// remembered here at install time. Nothing is reported while the flag is off,
// while signed out, or from a temporary chat.

import { TEMPLATE_REWARDS_PILOT_FLAG } from "@ryu/auth/lib/feature-flags";
import { z } from "zod";
import { BACKEND_URL, getActiveToken } from "@/lib/auth-client.ts";
import { readFeatureFlag } from "@/src/lib/feature-flags.ts";

const INSTALLS_KEY = "ryu.templateRewards.installs";
const REPORTED_KEY = "ryu.templateRewards.reported";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_REMEMBERED = 500;

const stringMapSchema = z.record(z.string(), z.string()).catch({});

function readMap(key: string): Record<string, string> {
	try {
		const raw = localStorage.getItem(key);
		return raw ? stringMapSchema.parse(JSON.parse(raw)) : {};
	} catch {
		return {};
	}
}

function writeMap(key: string, map: Record<string, string>): void {
	try {
		const entries = Object.entries(map);
		const bounded =
			entries.length > MAX_REMEMBERED
				? Object.fromEntries(entries.slice(-MAX_REMEMBERED))
				: map;
		localStorage.setItem(key, JSON.stringify(bounded));
	} catch {
		// Best-effort: losing this only means a usage report is skipped or repeated.
	}
}

/** Remember which Marketplace agent listing a local agent was installed from. */
export function rememberInstalledTemplate(
	localAgentId: string,
	listingId: string
): void {
	if (!(localAgentId && listingId)) {
		return;
	}
	const installs = readMap(INSTALLS_KEY);
	installs[localAgentId] = listingId;
	writeMap(INSTALLS_KEY, installs);
}

/**
 * Fire-and-forget usage report for a chat turn with `localAgentId`. Never
 * throws and never blocks the chat.
 */
export function reportTemplateUse(
	localAgentId: string | null | undefined
): void {
	if (!localAgentId || readFeatureFlag(TEMPLATE_REWARDS_PILOT_FLAG) !== true) {
		return;
	}
	const listingId = readMap(INSTALLS_KEY)[localAgentId];
	if (!listingId) {
		return;
	}
	const today = new Date().toISOString().slice(0, 10);
	const reported = readMap(REPORTED_KEY);
	if (reported[listingId] === today) {
		return;
	}
	let token: string | null = null;
	try {
		token = getActiveToken();
	} catch {
		token = null;
	}
	if (!token) {
		return;
	}
	void fetch(`${BACKEND_URL.replace(/\/$/, "")}/api/template-rewards/usage`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ items: [{ kind: "agent", itemId: listingId }] }),
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	})
		.then((response) => {
			// 404 means the pilot is off for this account today; don't retry it
			// on every turn either.
			if (response.ok || response.status === 404) {
				reported[listingId] = today;
				writeMap(REPORTED_KEY, reported);
			}
		})
		.catch(() => {
			// Usage reporting is best-effort and must never surface in chat.
		});
}
