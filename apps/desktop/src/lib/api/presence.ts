import { AGENT_AVAILABILITY_OPTIONS } from "@ryu/blocks/desktop/agent-availability.tsx";
import { z } from "zod";
import { gatewayJsonValueSchema } from "@/src/lib/api/gateway-json-contracts.ts";
// Core presence API: the desktop's availability heartbeat and gaming mode.

import type { AgentAvailabilityStatus } from "@ryu/blocks/desktop/agent-availability.tsx";
import { type ApiTarget, request } from "./client.ts";

export interface GamingSettings {
	/** Detect running games from this node's process table. Off by default. */
	detectionEnabled: boolean;
	/** Extra executable names (no extension) to treat as games. */
	extraProcesses: string[];
	/** Stop local model sidecars while gaming mode is active. */
	freeLocalModels: boolean;
	/** Executable names (no extension) that must never count as games. */
	ignoredProcesses: string[];
}

export interface StreamingSettings {
	/** Exact process names (with or without `.exe`) that activate Streaming. */
	apps: string[];
	/** Detect a configured streaming app from this node's process table. */
	detectionEnabled: boolean;
	/** Persisted settings schema version. */
	schemaVersion: number;
}

export interface PresenceSnapshot {
	gaming: {
		active: boolean;
		detectedGame: { name: string; sinceMs: number } | null;
		modelsPaused: boolean;
		settings: GamingSettings;
	};
	questionsDeferred: boolean;
	source: "default" | "reported" | "stale" | "game" | "stream";
	status: AgentAvailabilityStatus;
	streaming?: {
		active: boolean;
		detectedApp: { name: string; sinceMs: number } | null;
		settings: StreamingSettings;
	};
}

/** Heartbeat the desktop's resolved availability; returns Core's effective view. */
export async function reportPresence(
	target: ApiTarget,
	status: AgentAvailabilityStatus,
	clientId: string
): Promise<PresenceSnapshot> {
	return await request<PresenceSnapshot>(
		target,
		"/api/presence",
		{
			method: "PUT",
			body: { clientId, status },
		},
		presenceSnapshotResponseCodec
	);
}

/** Read Core's effective presence, question policy, and gaming state. */
export async function getPresence(
	target: ApiTarget
): Promise<PresenceSnapshot> {
	return await request<PresenceSnapshot>(
		target,
		"/api/presence",
		undefined,
		presenceSnapshotResponseCodec
	);
}

/** Read the persisted gaming-mode preferences. */
export async function getGamingSettings(
	target: ApiTarget
): Promise<GamingSettings> {
	return await request<GamingSettings>(
		target,
		"/api/presence/gaming",
		undefined,
		gamingSettingsResponseCodec
	);
}

/** Save gaming-mode preferences; Core re-evaluates the model pause at once. */
export async function saveGamingSettings(
	target: ApiTarget,
	settings: GamingSettings
): Promise<GamingSettings> {
	return await request<GamingSettings>(
		target,
		"/api/presence/gaming",
		{
			method: "PUT",
			body: settings,
		},
		gamingSettingsResponseCodec
	);
}

/** Read the persisted Streaming detection preferences. */
export async function getStreamingSettings(
	target: ApiTarget
): Promise<StreamingSettings> {
	return await request<StreamingSettings>(
		target,
		"/api/presence/streaming",
		undefined,
		streamingSettingsResponseCodec
	);
}

/** Save Streaming detection preferences on the selected node. */
export async function saveStreamingSettings(
	target: ApiTarget,
	settings: StreamingSettings
): Promise<StreamingSettings> {
	return await request<StreamingSettings>(
		target,
		"/api/presence/streaming",
		{
			method: "PUT",
			body: settings,
		},
		streamingSettingsResponseCodec
	);
}

// Response codecs validate the consumed native DTO fields and retain JSON extension fields.
const gamingSettingsResponseCodec = z
	.object({
		detectionEnabled: z.boolean(),
		extraProcesses: z.array(z.string()),
		freeLocalModels: z.boolean(),
		ignoredProcesses: z.array(z.string()),
	})
	.catchall(gatewayJsonValueSchema);
const streamingSettingsResponseCodec = z
	.object({
		apps: z.array(z.string()),
		detectionEnabled: z.boolean(),
		schemaVersion: z.number(),
	})
	.catchall(gatewayJsonValueSchema);

const presenceSnapshotResponseCodec = z
	.object({
		gaming: z
			.object({
				active: z.boolean(),
				detectedGame: z
					.object({ name: z.string(), sinceMs: z.number() })
					.catchall(gatewayJsonValueSchema)
					.nullable(),
				modelsPaused: z.boolean(),
				settings: gamingSettingsResponseCodec,
			})
			.catchall(gatewayJsonValueSchema),
		questionsDeferred: z.boolean(),
		source: z.enum(["default", "reported", "stale", "game", "stream"]),
		status: z.enum(AGENT_AVAILABILITY_OPTIONS.map((option) => option.value)),
		streaming: z
			.object({
				active: z.boolean(),
				detectedApp: z
					.object({ name: z.string(), sinceMs: z.number() })
					.catchall(gatewayJsonValueSchema)
					.nullable(),
				settings: streamingSettingsResponseCodec,
			})
			.catchall(gatewayJsonValueSchema)
			.optional(),
	})
	.catchall(gatewayJsonValueSchema);
