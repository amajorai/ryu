import { z } from "zod";

/** Shared resource visibility vocabulary for the desktop shell. */
export type ResourceVisibility = "org" | "private" | "team";
export type ResourceVisibilityGroup = "private" | "team";
export type VisibilityResourceType = "chat" | "space";

/** Native drag payload used only for moving a resource between visibility groups. */
export const RESOURCE_VISIBILITY_DND_MIME =
	"application/x-ryu-resource-visibility";

/** A type-only marker remains readable during protected native dragover events. */
export function resourceVisibilityDndMime(
	resourceType: VisibilityResourceType
): string {
	return `${RESOURCE_VISIBILITY_DND_MIME}-${resourceType}`;
}

export interface VisibilityDragPayload {
	from: ResourceVisibilityGroup;
	id: string;
	name: string;
	resourceType: VisibilityResourceType;
}

export interface VisibilityChangeRequest extends VisibilityDragPayload {
	to: ResourceVisibilityGroup;
}

/** Tolerant read-side parsing keeps an older Core from blanking the sidebar. */
export function toResourceVisibility(
	value: string | null | undefined
): ResourceVisibility {
	return value === "org" || value === "team" ? value : "private";
}

/** The product calls both organization-wide and named-team scopes “Team”. */
export function resourceVisibilityLabel(
	visibility: ResourceVisibility | undefined,
	system = false
): string {
	return (visibility ?? "private") === "private" && !system
		? "Private"
		: "Team";
}

export function resourceVisibilityGroup(
	visibility: ResourceVisibility | undefined,
	system = false
): ResourceVisibilityGroup {
	return (visibility ?? "private") === "private" && !system
		? "private"
		: "team";
}

export function isSharedResource(
	visibility: ResourceVisibility | undefined,
	system = false
): boolean {
	return resourceVisibilityGroup(visibility, system) === "team";
}

/** The public HTTP scope represented by the product's two group labels. */
export function resourceVisibilityForGroup(
	group: ResourceVisibilityGroup
): ResourceVisibility {
	return group === "team" ? "org" : "private";
}

/** Organization owners inherit admin authority for visibility changes. */
export function isOrganizationAdminRole(
	role: string | null | undefined
): boolean {
	return role === "admin" || role === "owner";
}

export function serializeVisibilityDragPayload(
	payload: VisibilityDragPayload
): string {
	return JSON.stringify(payload);
}

const visibilityDragPayloadSchema = z.object({
	from: z.enum(["private", "team"]),
	id: z.string(),
	name: z.string(),
	resourceType: z.enum(["chat", "space"]),
});

/** Parse untrusted DataTransfer text at the browser boundary. */
export function parseVisibilityDragPayload(
	value: string | null | undefined
): VisibilityDragPayload | null {
	if (!value) {
		return null;
	}
	try {
		const parsed = visibilityDragPayloadSchema.safeParse(JSON.parse(value));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}
