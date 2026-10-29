import type { ApiKey } from "@better-auth/api-key";
import type { Account, Session, User, Verification } from "better-auth";
import type { Jwk } from "better-auth/plugins/jwt";
import type {
	Invitation,
	Member,
	Organization,
} from "better-auth/plugins/organization";
import type { TwoFactorTable } from "better-auth/plugins/two-factor";
/** Rows written by real Better Auth adapters during integration tests. */
export interface AuthFixtureDatabase {
	account: Account[];
	apikey: ApiKey[];
	invitation: Invitation[];
	jwks: Jwk[];
	member: Member[];
	organization: Organization[];
	session: (Session & { impersonatedBy?: string })[];
	twoFactor: TwoFactorTable[];
	user: (User & {
		role?: string;
		twoFactorEnabled?: boolean;
		banned?: boolean | null;
		banReason?: string | null;
		banExpires?: Date | null;
	})[];
	verification: Verification[];
}
