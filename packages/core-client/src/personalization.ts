import { z } from "zod";
/** Core preference contract consumed by Desktop and CLI profile settings. */
export const USER_PERSONALIZATION_PREF_KEY = "user-personalization";
export interface UserPersonalization {
	aboutOrganization: string;
	aboutYou: string;
	nickname: string;
	occupation: string;
}
export const DEFAULT_USER_PERSONALIZATION: UserPersonalization = {
	aboutOrganization: "",
	aboutYou: "",
	nickname: "",
	occupation: "",
};
const personalizationSchema = z
	.object({
		aboutOrganization: z.string().catch(""),
		aboutYou: z.string().catch(""),
		nickname: z.string().catch(""),
		occupation: z.string().catch(""),
	})
	.catch(() => ({ ...DEFAULT_USER_PERSONALIZATION }));

export function parseUserPersonalization(
	raw: string | null
): UserPersonalization {
	if (!raw) {
		return { ...DEFAULT_USER_PERSONALIZATION };
	}
	try {
		return personalizationSchema.parse(JSON.parse(raw));
	} catch {
		return { ...DEFAULT_USER_PERSONALIZATION };
	}
}
