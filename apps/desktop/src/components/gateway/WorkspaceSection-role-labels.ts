import type { OrgRole } from "@/src/lib/api/org.ts";

/** A `tl()`-shaped translator. */
type Translate = (source: string) => string;

/**
 * A built-in workspace role as a badge. "Administrator", not "Admin": the bare
 * catalog "Admin" is the administration area (ja 管理), not a person's role.
 * A missing role is a member.
 */
export function workspaceRoleLabel(tl: Translate, role: OrgRole): string {
	switch (role) {
		case "owner":
			return tl("Owner");
		case "admin":
			return tl("Administrator");
		case "viewer":
			return tl("Viewer");
		default:
			return tl("Member");
	}
}

/**
 * The caller's place in the workspace as one whole sentence per role, so no
 * English role word is inserted into a translated sentence.
 */
export function workspaceRoleSentence(tl: Translate, role: OrgRole): string {
	switch (role) {
		case "owner":
			return tl("You are an owner of this workspace.");
		case "admin":
			return tl("You are an administrator of this workspace.");
		case "viewer":
			return tl("You are a viewer of this workspace.");
		default:
			return tl("You are a member of this workspace.");
	}
}
