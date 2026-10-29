import { useSyncExternalStore } from "react";

declare global {
	interface Window {
		__settingsProofAuthCalls: Array<{ body?: unknown; method: string }>;
		__settingsProofFailAuth: (method: string) => void;
	}
}

window.__settingsProofAuthCalls = [];
const authFailures = new Map<string, number>();
let twoFactorEnabled = false;
const listeners = new Set<() => void>();
const backupCodes = [
	"A1B2C-D3E4F",
	"G5H6I-J7K8L",
	"M9N0P-Q1R2S",
	"T3U4V-W5X6Y",
];

window.__settingsProofFailAuth = (method) => {
	authFailures.set(method, (authFailures.get(method) ?? 0) + 1);
};

function fail(method: string): boolean {
	const remaining = authFailures.get(method) ?? 0;
	if (remaining <= 0) {
		return false;
	}
	authFailures.set(method, remaining - 1);
	return true;
}

function notify(): void {
	for (const listener of listeners) {
		listener();
	}
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function snapshot(): boolean {
	return twoFactorEnabled;
}

export const BACKEND_URL = "http://localhost:3000";
export const FRONTEND_URL = "http://localhost:5173";
export const TOKEN_KEY = "ryu_session_token";
export const vaultHydrated = Promise.resolve();

export function getActiveUserId(): string {
	return "coverage-user";
}

export function getActiveToken(): string {
	return "fixture-token";
}

/**
 * The shipping vault adopts the bearer Better Auth rotates in when 2FA is
 * turned on or off. The proof session is held in memory rather than keyed by
 * a bearer, and its two-factor mocks never report a rotated token.
 */
export async function storeSessionToken(_token: string): Promise<void> {
	// Nothing to adopt: the proof session is not token based.
}

export function listAccounts() {
	return [
		{
			email: "security@example.test",
			image: null,
			name: "Coverage Account",
			token: "fixture-token",
			userId: "coverage-user",
		},
	];
}

export function useSession() {
	const enabled = useSyncExternalStore(subscribe, snapshot, snapshot);
	const emailUnverified =
		localStorage.getItem("settings-proof-email-unverified") === "true" ||
		new URLSearchParams(location.search).get("email-unverified") === "true";
	return {
		data: {
			user: {
				email: "security@example.test",
				emailVerified: !emailUnverified,
				id: "coverage-user",
				name: "Coverage Account",
				twoFactorEnabled: enabled,
			},
		},
		isPending: false,
	};
}

function authResult<T, Body>(method: string, body: Body, data: T) {
	window.__settingsProofAuthCalls.push({ body, method });
	if (fail(method)) {
		return Promise.resolve({
			data: null,
			error: { message: `Fixture ${method} failure` },
		});
	}
	return Promise.resolve({ data, error: null });
}

export const authClient = {
	sendVerificationEmail: async (body: {
		callbackURL: string;
		email: string;
	}) => {
		window.__settingsProofAuthCalls.push({
			body,
			method: "sendVerificationEmail",
		});
		if (fail("sendVerificationEmail")) {
			throw new Error("Fixture verification email failure");
		}
		return { data: { status: true }, error: null };
	},
	twoFactor: {
		disable: (body: { password: string }) =>
			authResult("disable", body, { success: true }).then((result) => {
				if (!result.error) {
					twoFactorEnabled = false;
					notify();
				}
				return result;
			}),
		enable: (body: { password: string }) =>
			authResult("enable", body, {
				method: "totp" as const,
				totpURI:
					"otpauth://totp/Ryu:security%40example.test?secret=JBSWY3DPEHPK3PXP&issuer=Ryu",
			}),
		generateBackupCodes: (body: { password: string }) =>
			authResult("generateBackupCodes", body, { backupCodes }).then(
				(result) => result
			),
		verifyTotp: (body: { code: string }) => {
			window.__settingsProofAuthCalls.push({ body, method: "verifyTotp" });
			if (fail("verifyTotp") || body.code !== "123456") {
				return Promise.resolve({
					data: null,
					error: { message: "Invalid authenticator code" },
				});
			}
			twoFactorEnabled = true;
			notify();
			return Promise.resolve({ data: { backupCodes }, error: null });
		},
	},
};

export const signIn = async () => ({ data: null, error: null });
export const signOut = async () => ({ data: null, error: null });
export const signUp = async () => ({ data: null, error: null });
