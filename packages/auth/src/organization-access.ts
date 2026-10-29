import { createAccessControl } from "better-auth/plugins/access";
import {
	defaultAc,
	defaultRoles,
} from "better-auth/plugins/organization/access";

// This access-control vocabulary governs Better Auth organization-management
// records only. `apiKey` actions authorize creating/listing/revoking an org key
// record; they do not grant any Ryu capability scope. Ryu's server-side
// permission model remains the authority for `resource:action` scopes carried
// by the resulting key.
export const ryuOrganizationAccessControl = createAccessControl({
	...defaultAc.statements,
	apiKey: ["create", "read", "update", "delete"],
});

export const ryuOrganizationRoles = {
	admin: ryuOrganizationAccessControl.newRole({
		...defaultRoles.admin.statements,
		apiKey: ["create", "read", "update", "delete"],
	}),
	owner: ryuOrganizationAccessControl.newRole({
		...defaultRoles.owner.statements,
		apiKey: ["create", "read", "update", "delete"],
	}),
	// Members and viewers carry no API-key record authority. Listing org keys is
	// Ryu's `gateway.configure` capability (enforced by the control plane, which
	// reads the key store itself), so the native `/api-key/list` and `/get`
	// endpoints must not hand them the org's key inventory.
	member: ryuOrganizationAccessControl.newRole({
		...defaultRoles.member.statements,
		apiKey: [],
	}),
	viewer: ryuOrganizationAccessControl.newRole({
		...defaultRoles.member.statements,
		apiKey: [],
	}),
	// Billing contacts manage payment and read usage. Ryu's control plane grants
	// `billing.manage` on top of the viewer floor for this role; it carries no
	// organization-management or API-key record authority here.
	billing: ryuOrganizationAccessControl.newRole({
		...defaultRoles.member.statements,
		apiKey: [],
	}),
};
