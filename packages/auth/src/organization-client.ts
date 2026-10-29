import { organizationClient } from "better-auth/client/plugins";
import {
	ryuOrganizationAccessControl,
	ryuOrganizationRoles,
} from "./organization-access.ts";

/**
 * The browser, desktop, native, and extension clients all speak to the same
 * Better Auth organization server. Keep their client plugin contract in one
 * place so a new organization field, role, or team capability cannot be added
 * to only one surface.
 */
export const ryuOrganizationClient = organizationClient({
	ac: ryuOrganizationAccessControl,
	roles: ryuOrganizationRoles,
	teams: {
		enabled: true,
	},
	schema: {
		organization: {
			additionalFields: {
				primaryOwnerUserId: {
					type: "string",
					required: false,
				},
				// Server-owned and authoritative; read by `organizationKindOf`.
				organizationKind: {
					type: "string",
					input: false,
					required: false,
				},
			},
		},
		invitation: {
			additionalFields: {
				referralTag: {
					type: "string",
					required: false,
				},
			},
		},
	},
});
