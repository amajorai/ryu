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
	dynamicAccessControl: {
		enabled: true,
	},
	roles: ryuOrganizationRoles,
	teams: {
		enabled: true,
	},
	schema: {
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
