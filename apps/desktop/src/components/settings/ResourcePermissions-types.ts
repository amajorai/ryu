export type TargetType = "org" | "team" | "role" | "member";

export interface Overwrite {
	allow: string[];
	deny: string[];
	target_id: string;
	target_type: TargetType;
}

export interface DeclaredLevel {
	description: string;
	id: string;
	implies: string[];
	label: string;
	plugin_id: string;
}

export interface Vocabulary {
	collisions: string[];
	declared: DeclaredLevel[];
	kernel: string[];
}

/**
 * The node's org directory — everything a rule can be pointed at.
 *
 * A member carries no email when the org never had one for them, so the email is
 * a subtitle here and never the thing a row is identified by.
 */
export interface PrincipalDirectory {
	kinds?: string[];
	members: { email: string | null; id: string; name: string }[];
	/**
	 * The org an `org`-tier overwrite must name. Null on an unbound (personal)
	 * node, where there is no org and that tier is meaningless.
	 */
	org_id?: string | null;
	roles: { id: string; label: string }[];
	teams: { id: string; name: string }[];
}

/** One selectable target, already reduced to what the picker renders. */
export interface Choice {
	hint?: string;
	id: string;
	label: string;
}

/** One permission as it appears on a row, with its knock-on effects resolved. */
export interface PermissionInfo {
	alsoAllows: string[];
	alsoDenies: string[];
	description: string;
	id: string;
	label: string;
}

/** Permissions from one source — an app, or the node itself. */
export interface PermissionGroup {
	key: string;
	permissions: PermissionInfo[];
	title: string;
}

/** Tri-state for one permission on one target. */
export type Setting = "allow" | "deny" | "inherit";
