/**
 * The Ryu-side ceiling for a connected account. Provider OAuth scopes and
 * Gateway grants remain separate; this is the choice the account owner makes
 * about what a connected MCP or Composio account may do through Ryu.
 */
export type ConnectionAccessLevel =
	| "risk_based"
	| "read_only"
	| "write"
	| "full";

export const DEFAULT_CONNECTION_ACCESS_LEVEL: ConnectionAccessLevel =
	"risk_based";

export interface ConnectionAccessOption {
	description: string;
	id: ConnectionAccessLevel;
	label: string;
	shortLabel: string;
}

export const CONNECTION_ACCESS_OPTIONS: readonly ConnectionAccessOption[] = [
	{
		id: "risk_based",
		label: "Risk-based (recommended)",
		shortLabel: "Risk-based",
		description:
			"Safe reads flow normally. Ryu asks for approval before risky writes or deletes.",
	},
	{
		id: "read_only",
		label: "Read only",
		shortLabel: "Read only",
		description:
			"View and search people, messages, files, and records. No creating, changing, sending, or deleting.",
	},
	{
		id: "write",
		label: "Write access",
		shortLabel: "Write access",
		description: "View, create, update, and send. Delete actions stay blocked.",
	},
	{
		id: "full",
		label: "Full access, including delete",
		shortLabel: "Full access",
		description:
			"View, create, update, send, and delete. Ryu still keeps its usual destructive-action confirmation.",
	},
];

const ACCESS_LEVELS = new Set<ConnectionAccessLevel>(
	CONNECTION_ACCESS_OPTIONS.map((option) => option.id)
);

/** Normalize a wire or persisted value without ever widening unknown input. */
export function normalizeConnectionAccessLevel(
	value: unknown
): ConnectionAccessLevel {
	return typeof value === "string" &&
		ACCESS_LEVELS.has(value as ConnectionAccessLevel)
		? (value as ConnectionAccessLevel)
		: DEFAULT_CONNECTION_ACCESS_LEVEL;
}

export function connectionAccessOption(
	level: ConnectionAccessLevel | null | undefined
): ConnectionAccessOption {
	const normalized = normalizeConnectionAccessLevel(level);
	return (
		CONNECTION_ACCESS_OPTIONS.find((option) => option.id === normalized) ??
		CONNECTION_ACCESS_OPTIONS[0]
	);
}

export function connectionAccessLabel(
	level: ConnectionAccessLevel | null | undefined
): string {
	return connectionAccessOption(level).shortLabel;
}
