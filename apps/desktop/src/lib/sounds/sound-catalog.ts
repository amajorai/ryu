// The UI sound catalog: every cue the desktop shell can play, how loud and
// how often it may play, and which Settings row switches it on or off.
//
// One Settings row can cover several ids ("Join and leave" covers the call
// join, leave and connect-failure cues), so the list a user sees stays short
// while the engine still tells the events apart.

export const SOUND_EVENT_IDS = [
	"message",
	"message-sent",
	"run-complete",
	"run-failed",
	"approval-needed",
	"alert",
	"credit-alert",
	"quest-suggest",
	"quest-complete",
	"achievement",
	"call-ring",
	"call-join",
	"call-leave",
	"call-error",
	"mute",
	"unmute",
	"meeting-detected",
] as const;

export type SoundEventId = (typeof SOUND_EVENT_IDS)[number];

/**
 * - `notification`: something happened elsewhere (quieted in Do Not Disturb,
 *   ducked during a call).
 * - `feedback`: confirms the user's own action.
 * - `reward`: celebrates progress (quieted in Do Not Disturb).
 * - `call`: voice-call lifecycle.
 */
export type SoundClass = "notification" | "feedback" | "reward" | "call";

export type SoundGroup = "Activity" | "Agents" | "Calls" | "Rewards";

/** Higher wins when cues overlap. */
export type SoundPriority = 1 | 2 | 3;

export const SOUND_SETTING_ROW_IDS = [
	"message",
	"message-sent",
	"alerts",
	"credit-alert",
	"meeting-detected",
	"run-complete",
	"run-failed",
	"approval-needed",
	"calling",
	"join-leave",
	"mute-unmute",
	"quest-suggest",
	"quest-complete",
	"achievement",
] as const;

export type SoundSettingRowId = (typeof SOUND_SETTING_ROW_IDS)[number];

export interface SoundSettingRow {
	defaultEnabled: boolean;
	description: string;
	group: SoundGroup;
	id: SoundSettingRowId;
	/** The cues this switch controls; the first is the one Preview plays. */
	ids: readonly [SoundEventId, ...SoundEventId[]];
	label: string;
}

export interface SoundEventDef {
	class: SoundClass;
	/** Minimum gap between two plays of this cue. */
	cooldownMs: number;
	id: SoundEventId;
	label: string;
	priority: SoundPriority;
	settingRow: SoundSettingRowId;
}

export const DEFAULT_SOUND_COOLDOWN_MS = 250;

export const SOUND_SETTING_ROWS: readonly SoundSettingRow[] = [
	{
		id: "message",
		label: "Message received",
		description: "A new message or notification arrives.",
		group: "Activity",
		ids: ["message"],
		defaultEnabled: true,
	},
	{
		id: "message-sent",
		label: "Message sent",
		description: "You send a message to an agent.",
		group: "Activity",
		ids: ["message-sent"],
		defaultEnabled: false,
	},
	{
		id: "alerts",
		label: "Alerts",
		description: "Monitor alerts, warnings and errors.",
		group: "Activity",
		ids: ["alert"],
		defaultEnabled: true,
	},
	{
		id: "credit-alert",
		label: "Credit alert",
		description: "Your credit balance crosses a threshold.",
		group: "Activity",
		ids: ["credit-alert"],
		defaultEnabled: true,
	},
	{
		id: "meeting-detected",
		label: "Meeting detected",
		description: "Ryu notices a meeting has started.",
		group: "Activity",
		ids: ["meeting-detected"],
		defaultEnabled: true,
	},
	{
		id: "run-complete",
		label: "Run complete",
		description: "An agent finishes a run.",
		group: "Agents",
		ids: ["run-complete"],
		defaultEnabled: true,
	},
	{
		id: "run-failed",
		label: "Run failed",
		description: "An agent run stops with an error.",
		group: "Agents",
		ids: ["run-failed"],
		defaultEnabled: true,
	},
	{
		id: "approval-needed",
		label: "Approval needed",
		description: "An agent is waiting for your permission.",
		group: "Agents",
		ids: ["approval-needed"],
		defaultEnabled: true,
	},
	{
		id: "calling",
		label: "Calling",
		description: "Rings while a voice call connects.",
		group: "Calls",
		ids: ["call-ring"],
		defaultEnabled: true,
	},
	{
		id: "join-leave",
		label: "Join and leave",
		description: "A voice call connects, ends or fails to connect.",
		group: "Calls",
		ids: ["call-join", "call-leave", "call-error"],
		defaultEnabled: true,
	},
	{
		id: "mute-unmute",
		label: "Mute and unmute",
		description: "You mute or unmute your microphone in a call.",
		group: "Calls",
		ids: ["mute", "unmute"],
		defaultEnabled: true,
	},
	{
		id: "quest-suggest",
		label: "Quest suggestions",
		description: "Ryu suggests a new quest.",
		group: "Rewards",
		ids: ["quest-suggest"],
		defaultEnabled: true,
	},
	{
		id: "quest-complete",
		label: "Quest completed",
		description: "You complete a quest.",
		group: "Rewards",
		ids: ["quest-complete"],
		defaultEnabled: true,
	},
	{
		id: "achievement",
		label: "Achievement unlocked",
		description: "You unlock a feature or level up.",
		group: "Rewards",
		ids: ["achievement"],
		defaultEnabled: true,
	},
];

type EventSpec = Omit<SoundEventDef, "id" | "cooldownMs"> & {
	cooldownMs?: number;
};

const EVENT_SPECS: Record<SoundEventId, EventSpec> = {
	message: {
		label: "Message received",
		class: "notification",
		priority: 2,
		settingRow: "message",
		cooldownMs: 600,
	},
	"message-sent": {
		label: "Message sent",
		class: "feedback",
		priority: 1,
		settingRow: "message-sent",
	},
	"run-complete": {
		label: "Run complete",
		class: "notification",
		priority: 2,
		settingRow: "run-complete",
	},
	"run-failed": {
		label: "Run failed",
		class: "notification",
		priority: 3,
		settingRow: "run-failed",
	},
	"approval-needed": {
		label: "Approval needed",
		class: "notification",
		priority: 3,
		settingRow: "approval-needed",
	},
	alert: {
		label: "Alert",
		class: "notification",
		priority: 3,
		settingRow: "alerts",
	},
	"credit-alert": {
		label: "Credit alert",
		class: "notification",
		priority: 3,
		settingRow: "credit-alert",
	},
	"quest-suggest": {
		label: "Quest suggestion",
		class: "notification",
		priority: 1,
		settingRow: "quest-suggest",
	},
	"quest-complete": {
		label: "Quest completed",
		class: "reward",
		priority: 2,
		settingRow: "quest-complete",
	},
	achievement: {
		label: "Achievement unlocked",
		class: "reward",
		priority: 3,
		settingRow: "achievement",
	},
	"call-ring": {
		label: "Calling",
		class: "call",
		priority: 2,
		settingRow: "calling",
	},
	"call-join": {
		label: "Call joined",
		class: "call",
		priority: 2,
		settingRow: "join-leave",
	},
	"call-leave": {
		label: "Call ended",
		class: "call",
		priority: 2,
		settingRow: "join-leave",
	},
	"call-error": {
		label: "Call failed",
		class: "call",
		priority: 2,
		settingRow: "join-leave",
	},
	mute: {
		label: "Muted",
		class: "feedback",
		priority: 1,
		settingRow: "mute-unmute",
		cooldownMs: 0,
	},
	unmute: {
		label: "Unmuted",
		class: "feedback",
		priority: 1,
		settingRow: "mute-unmute",
		cooldownMs: 0,
	},
	"meeting-detected": {
		label: "Meeting detected",
		class: "notification",
		priority: 1,
		settingRow: "meeting-detected",
	},
};

function buildEvents(): Record<SoundEventId, SoundEventDef> {
	const events = {} as Record<SoundEventId, SoundEventDef>;
	for (const id of SOUND_EVENT_IDS) {
		const spec = EVENT_SPECS[id];
		events[id] = {
			...spec,
			id,
			cooldownMs: spec.cooldownMs ?? DEFAULT_SOUND_COOLDOWN_MS,
		};
	}
	return events;
}

export const SOUND_EVENTS: Readonly<Record<SoundEventId, SoundEventDef>> =
	buildEvents();

const ROWS_BY_ID = new Map<SoundSettingRowId, SoundSettingRow>(
	SOUND_SETTING_ROWS.map((row) => [row.id, row])
);

export function soundSettingRow(id: SoundSettingRowId): SoundSettingRow {
	const row = ROWS_BY_ID.get(id);
	if (!row) {
		throw new Error(`Unknown sound setting row: ${id}`);
	}
	return row;
}

/** Whether a cue plays when the user has not touched its Settings row. */
export function soundEventDefaultEnabled(id: SoundEventId): boolean {
	return soundSettingRow(SOUND_EVENTS[id].settingRow).defaultEnabled;
}

export function isSoundEventId(value: unknown): value is SoundEventId {
	return (
		typeof value === "string" &&
		(SOUND_EVENT_IDS as readonly string[]).includes(value)
	);
}

export function isSoundSettingRowId(
	value: unknown
): value is SoundSettingRowId {
	return (
		typeof value === "string" &&
		(SOUND_SETTING_ROW_IDS as readonly string[]).includes(value)
	);
}
