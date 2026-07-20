// apps/desktop/src/lib/api/channels.ts
//
// Typed client for channel-bot configuration (Telegram/Slack/WhatsApp/Discord).
//
// Unlike every other desktop client module, this targets the identity/control
// plane server (:3000, BACKEND_URL) rather than a Core node — channel configs are
// a "what is allowed/configured" concern and live in the control plane
// (packages/api `/api/channels`, MongoDB), authenticated with the Better-Auth
// session bearer token. The gateway reads enabled configs at startup and runs the
// platform listeners (apps/gateway/src/channels/*), forwarding inbound messages
// to Core's POST /api/channels/run.
//
// Secrets are write-only: list/get responses mask them as "***". On edit we send
// only the secret fields the user actually changed (the server merges them).

import { BACKEND_URL, TOKEN_KEY } from "@/lib/auth-client.ts";

export const CHANNEL_TYPES = [
	"telegram",
	"slack",
	"whatsapp",
	"discord",
] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

/** When the bot replies inside a group chat (DMs always reply). */
export const GROUP_REPLY_MODES = ["mentions", "all"] as const;
export type GroupReplyMode = (typeof GROUP_REPLY_MODES)[number];

// The per-channel required-credential map and its field labels deliberately do
// NOT live here. This module once carried its own copy, which silently drifted
// from the gateway's real contract (it still demanded only 2 of WhatsApp's 4
// keys) while having zero consumers. The form's copy — the one that renders —
// is REQUIRED_SECRETS/SECRET_LABELS/CHANNEL_SETUP in
// packages/blocks/src/desktop/channels.tsx, and the enforcing copy is
// REQUIRED_SECRETS in packages/api/src/routers/channels.ts (the server guard,
// mirroring apps/gateway/src/channels/*.rs). Don't add a third.

export const CHANNEL_LABELS: Record<ChannelType, string> = {
	telegram: "Telegram",
	slack: "Slack",
	whatsapp: "WhatsApp",
	discord: "Discord",
};

/** A channel config as returned by the server (secrets masked to "***"). */
export interface ChannelConfig {
	agentId: string | null;
	channelType: ChannelType;
	createdAt: string;
	createdBy: string;
	enabled: boolean;
	/** When the bot replies in a group chat (mentions-only vs every message). */
	groupReplyMode: GroupReplyMode;
	id: string;
	model: string | null;
	name: string;
	organizationId: string | null;
	secrets: Record<string, string>;
	systemPrompt: string | null;
	/** Team this bot routes to instead of a single agent. Mutually exclusive
	 * with agentId — when set, the team's lead orchestrates its members. */
	teamId: string | null;
	updatedAt: string;
}

export interface ChannelInput {
	agentId?: string | null;
	channelType: ChannelType;
	enabled?: boolean;
	groupReplyMode?: GroupReplyMode;
	model?: string | null;
	name: string;
	/** Only the secret keys being set/changed; the server merges on update. */
	secrets?: Record<string, string>;
	systemPrompt?: string | null;
	teamId?: string | null;
}

/** True when the user has a session token; channel CRUD requires sign-in. */
export function hasChannelAuth(): boolean {
	try {
		return Boolean(localStorage.getItem(TOKEN_KEY));
	} catch {
		return false;
	}
}

function authHeaders(): Record<string, string> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	try {
		const token = localStorage.getItem(TOKEN_KEY);
		if (token) {
			headers.Authorization = `Bearer ${token}`;
		}
	} catch {
		// No storage — request will 401 and the UI prompts to sign in.
	}
	return headers;
}

const BASE = `${BACKEND_URL.replace(/\/$/, "")}/api/channels`;

async function parseError(resp: Response): Promise<Error> {
	if (resp.status === 401) {
		return new Error("Sign in to manage channels.");
	}
	try {
		const body = (await resp.json()) as { message?: string; error?: string };
		const msg = body.message ?? body.error;
		if (msg) {
			return new Error(msg);
		}
	} catch {
		// Non-JSON body.
	}
	return new Error(`Request failed: ${resp.status}`);
}

export async function listChannels(): Promise<ChannelConfig[]> {
	const resp = await fetch(BASE, { headers: authHeaders() });
	if (!resp.ok) {
		throw await parseError(resp);
	}
	const body = (await resp.json()) as { channels?: ChannelConfig[] };
	return body.channels ?? [];
}

export async function createChannel(
	input: ChannelInput
): Promise<ChannelConfig> {
	const resp = await fetch(BASE, {
		method: "POST",
		headers: authHeaders(),
		body: JSON.stringify(input),
	});
	if (!resp.ok) {
		throw await parseError(resp);
	}
	return (await resp.json()) as ChannelConfig;
}

export async function updateChannel(
	id: string,
	input: Partial<ChannelInput>
): Promise<ChannelConfig> {
	const resp = await fetch(`${BASE}/${id}`, {
		method: "PATCH",
		headers: authHeaders(),
		body: JSON.stringify(input),
	});
	if (!resp.ok) {
		throw await parseError(resp);
	}
	return (await resp.json()) as ChannelConfig;
}

export async function deleteChannel(id: string): Promise<void> {
	const resp = await fetch(`${BASE}/${id}`, {
		method: "DELETE",
		headers: authHeaders(),
	});
	if (!resp.ok) {
		throw await parseError(resp);
	}
}
