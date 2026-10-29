import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import { coreDataCountsResponseSchema } from "../../core/settings-response-codecs.ts";
// Read-only data loaders for the Settings overlay panels that Core already
// serves. Each maps a Core read endpoint (via the typed @ryuhq/core-client
// readers where one exists, otherwise the core-client `request` primitive) to
// ListRow[] for the shared ListTab. Writes (toggles, deletes, relocations) stay
// in the desktop app; these panels only surface state.

import { type ApiTarget, request } from "@ryuhq/core-client/client";
import { listMeetings } from "@ryuhq/core-client/meetings";
import { fetchApps } from "@ryuhq/core-client/plugins";
import { listQuests } from "@ryuhq/core-client/quests";
import { z } from "zod";
import type { ListRow } from "../../core/featureList.ts";

const TITLE_MAX = 72;
const KIB = 1024;
const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** Collapse whitespace and cap a free-text field for a single list row. */
export function oneLine(text: string, max = TITLE_MAX): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Human-readable byte count (binary units, one decimal above KB). */
export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) {
		return "unknown";
	}
	let value = bytes;
	let unit = 0;
	while (value >= KIB && unit < BYTE_UNITS.length - 1) {
		value /= KIB;
		unit += 1;
	}
	return unit === 0
		? `${value} ${BYTE_UNITS[unit]}`
		: `${value.toFixed(1)} ${BYTE_UNITS[unit]}`;
}

/** The date part of an ISO timestamp, or the raw value when it is not one. */
function isoDate(value: string | null | undefined): string {
	if (!value) {
		return "";
	}
	return value.length >= 10 ? value.slice(0, 10) : value;
}

// ── Memory (GET /api/memory) ────────────────────────────────────────────────

const memoryEntrySchema = z.object({
	category: z.string().optional().catch(undefined),
	content: z.string().optional().catch(undefined),
	id: z.string().optional().catch(undefined),
	importance: z.number().optional().catch(undefined),
	scope: z.string().optional().catch(undefined),
	scope_id: z.string().nullable().optional().catch(undefined),
});
const memoriesResponseSchema = z.object({
	memories: z.array(memoryEntrySchema).optional(),
});

export async function loadMemory(target: ApiTarget): Promise<ListRow[]> {
	const json = memoriesResponseSchema.parse(
		await request(target, "/api/memory?limit=200", {}, appResponseValueSchema)
	);
	return (json.memories ?? []).map((entry, index) => {
		const scope = entry.scope_id
			? `${entry.scope ?? "user"}:${entry.scope_id}`
			: (entry.scope ?? "user");
		const importance =
			entry.importance === undefined ? "" : ` · importance ${entry.importance}`;
		return {
			id: entry.id ?? String(index),
			title: oneLine(entry.content ?? "") || "—",
			subtitle: `${scope}${importance}`,
			badge: entry.category,
		};
	});
}

// ── Meetings (GET /api/meetings) ────────────────────────────────────────────

export async function loadMeetings(target: ApiTarget): Promise<ListRow[]> {
	const meetings = await listMeetings(target);
	return meetings.map((meeting) => {
		const people = meeting.participants?.length ?? 0;
		const parts = [isoDate(meeting.started_at || meeting.created_at)];
		if (people > 0) {
			parts.push(`${people} participant${people === 1 ? "" : "s"}`);
		}
		if (meeting.app) {
			parts.push(meeting.app);
		}
		return {
			id: meeting.id,
			title: oneLine(meeting.title) || meeting.id,
			subtitle: parts.filter(Boolean).join(" · ") || undefined,
			badge: meeting.status,
		};
	});
}

// ── Tasks / quests (GET /api/quests) ────────────────────────────────────────

export async function loadQuests(target: ApiTarget): Promise<ListRow[]> {
	const quests = await listQuests(target);
	return quests.map((quest) => {
		const kind = quest.kind ?? "task";
		const detail = quest.completion_condition || quest.detail || "";
		return {
			id: quest.id,
			title: oneLine(quest.title) || quest.id,
			subtitle: detail ? `${kind} · ${oneLine(detail)}` : kind,
			badge: quest.pinned ? `${quest.status} · pinned` : quest.status,
		};
	});
}

// ── Features / apps (GET /api/plugins) ──────────────────────────────────────

export async function loadFeatures(target: ApiTarget): Promise<ListRow[]> {
	const apps = await fetchApps(target);
	return apps.map((app) => {
		let badge = "not installed";
		if (app.installed) {
			badge = app.enabled ? "enabled" : "disabled";
		}
		const version = app.installedVersion ?? app.version;
		return {
			id: app.id,
			title: app.name || app.id,
			subtitle: version ? `${app.id} · v${version}` : app.id,
			badge,
		};
	});
}

// ── Storage (GET /api/data-path) ────────────────────────────────────────────

const dataPathSchema = z.object({
	current: z.string().optional().catch(undefined),
	default: z.string().optional().catch(undefined),
	free_space_bytes: z.number().optional().catch(undefined),
	is_custom: z.boolean().optional().catch(undefined),
	size_bytes: z.number().optional().catch(undefined),
});

export async function loadStorage(target: ApiTarget): Promise<ListRow[]> {
	const info = dataPathSchema.parse(
		await request(target, "/api/data-path", {}, appResponseValueSchema)
	);
	const rows: ListRow[] = [
		{
			id: "current",
			title: "Data folder",
			subtitle: info.current,
			badge: info.is_custom ? "custom" : "default",
		},
	];
	if (info.size_bytes !== undefined) {
		rows.push({
			id: "size",
			title: "Used",
			badge: formatBytes(info.size_bytes),
		});
	}
	if (info.free_space_bytes !== undefined) {
		rows.push({
			id: "free",
			title: "Free on disk",
			badge: formatBytes(info.free_space_bytes),
		});
	}
	if (info.is_custom && info.default) {
		rows.push({
			id: "default",
			title: "Default folder",
			subtitle: info.default,
		});
	}
	return rows;
}

export async function loadDataCounts(target: ApiTarget): Promise<ListRow[]> {
	const json = await request(
		target,
		"/api/data/counts",
		{},
		coreDataCountsResponseSchema
	);
	return (json.categories ?? []).map((category, index) => {
		const count = category.count ?? 0;
		return {
			id: category.id ?? String(index),
			title: category.title ?? category.id ?? "—",
			subtitle: category.detail ? oneLine(category.detail) : undefined,
			badge: category.noun ? `${count} ${category.noun}` : String(count),
		};
	});
}

// ── Privacy (GET /api/preferences/:key) ─────────────────────────────────────

interface PrivacyPref {
	/** What an unset preference means (Core's canonical default). */
	defaultLabel: string;
	key: string;
	label: string;
}

// Canonical keys and defaults from apps/core/src/privacy.rs.
export const PRIVACY_PREFS: readonly PrivacyPref[] = [
	{
		key: "product-analytics-enabled",
		label: "Product analytics",
		defaultLabel: "on",
	},
	{ key: "crash-reports-enabled", label: "Crash reports", defaultLabel: "on" },
	{
		key: "community-stats-enabled",
		label: "Community savings stats",
		defaultLabel: "on",
	},
	{
		key: "profile-activity-enabled",
		label: "Profile activity",
		defaultLabel: "on",
	},
	{
		key: "diagnostics-export-enabled",
		label: "Diagnostics export (OTLP)",
		defaultLabel: "off",
	},
	{
		key: "support-access-local-enabled",
		label: "Local support access",
		defaultLabel: "off",
	},
];

const preferenceResponseSchema = z.object({ value: z.json().optional() });
type SettingsPreferenceValue = z.infer<
	typeof preferenceResponseSchema
>["value"];

function prefLabel(
	value: SettingsPreferenceValue,
	defaultLabel: string
): string {
	if (value === null || value === undefined || value === "") {
		return `${defaultLabel} (default)`;
	}
	if (value === "true" || value === true) {
		return "on";
	}
	if (value === "false" || value === false) {
		return "off";
	}
	return String(value);
}

export async function loadPrivacy(target: ApiTarget): Promise<ListRow[]> {
	return await Promise.all(
		PRIVACY_PREFS.map(async (pref) => {
			// One unreadable key must not blank the whole panel.
			const badge = await request(
				target,
				`/api/preferences/${encodeURIComponent(pref.key)}`,
				{},
				appResponseValueSchema
			)
				.then((raw) => {
					const json = preferenceResponseSchema.parse(raw);
					return prefLabel(json.value, pref.defaultLabel);
				})
				.catch(() => "unavailable");
			return { id: pref.key, title: pref.label, subtitle: pref.key, badge };
		})
	);
}
