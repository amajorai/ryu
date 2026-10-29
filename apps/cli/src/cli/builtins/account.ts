// Account commands: whoami, plan, account, login, logout and setup.

import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import { request } from "@ryuhq/core-client/client";
import { AUTH_BACKEND_URL } from "../../core/authBackend.ts";
import { tf, tr } from "../../i18n/translate.ts";
import { LocalizedError, localize } from "../localizedText.ts";
import { type Command, UsageError } from "../types.ts";
import {
	authBackendTarget,
	authUserLines,
	formatAuthUser,
	loadAuthSessions,
	loadAuthUser,
	twoFactorLine,
} from "./auth.ts";
import {
	asRecord,
	callCore,
	isCommandString,
	outputCommandResult,
	rawCommand,
} from "./shared.ts";

export const whoamiCommand: Command = {
	name: "whoami",
	summary: "Show the signed-in account",
	usage: "ryu-cli whoami",
	run: async (ctx) => {
		if (ctx.args.length > 0) {
			throw new UsageError("Usage: ryu-cli whoami");
		}
		const user = await loadAuthUser(await authBackendTarget(ctx));
		outputCommandResult(ctx, user, formatAuthUser(user));
		return 0;
	},
};

export const planCommand: Command = {
	name: "plan",
	summary: "Show subscription status",
	usage: "ryu-cli plan",
	run: async (ctx) => {
		if (ctx.args.length > 0) {
			throw new UsageError("Usage: ryu-cli plan");
		}
		const target = await authBackendTarget(ctx);
		const subscription = await request(
			target,
			"/api/billing/subscription-status",
			undefined,
			appResponseValueSchema
		);
		outputCommandResult(
			ctx,
			subscription,
			`${tr("Subscription status:")}\n${JSON.stringify(subscription, null, 2)}`
		);
		return 0;
	},
};

export const accountCommand: Command = {
	name: "account",
	summary: "Show account details",
	usage: "ryu-cli account",
	run: async (ctx) => {
		if (ctx.args.length > 0) {
			throw new UsageError("Usage: ryu-cli account");
		}
		const target = await authBackendTarget(ctx);
		const user = await loadAuthUser(target);
		const [password, subscription, sessions] = await Promise.all([
			request(
				target,
				"/api/user/password-status",
				undefined,
				appResponseValueSchema
			).catch(() => null),
			request(
				target,
				"/api/billing/subscription-status",
				undefined,
				appResponseValueSchema
			).catch(() => null),
			loadAuthSessions(target).catch(() => []),
		]);
		const passwordStatus = asRecord(password);
		const account = {
			activeSessions: sessions.length,
			authMethod: isCommandString(passwordStatus?.authMethod)
				? passwordStatus.authMethod
				: "unknown",
			email: user.email,
			emailVerified: user.emailVerified,
			hasPassword: passwordStatus?.hasPassword === true,
			name: user.name,
			subscription,
			twoFactorEnabled: user.twoFactorEnabled,
			userId: user.id,
		};
		const human = [
			...authUserLines({
				email: account.email,
				emailVerified: account.emailVerified,
				id: account.userId,
				name: account.name,
			}),
			account.hasPassword
				? tr("Password: set")
				: tf("Password: not set ({method})", { method: account.authMethod }),
			twoFactorLine(account.twoFactorEnabled),
			tf("Active sessions: {count}", { count: account.activeSessions }),
			tf("Subscription: {subscription}", {
				subscription: JSON.stringify(account.subscription),
			}),
		].join("\n");
		outputCommandResult(ctx, account, human);
		return 0;
	},
};

export const loginCommand: Command = {
	name: "login",
	summary: "Open the account device-login flow",
	usage: "ryu-cli login",
	run: async (ctx) => {
		if (ctx.args.length > 0) {
			throw new UsageError("Usage: ryu-cli login");
		}
		if (ctx.flags.dryRun) {
			outputCommandResult(
				ctx,
				{ dryRun: true },
				tr("Would start account sign-in.")
			);
			return 0;
		}
		const result = asRecord(
			await callCore(ctx, "/api/auth/login", {
				method: "POST",
				body: { backendUrl: AUTH_BACKEND_URL },
			})
		);
		if (isCommandString(result?.error)) {
			throw new LocalizedError(
				localize("Sign-in failed: {error}", { error: result.error })
			);
		}
		const login = {
			userCode: isCommandString(result?.userCode) ? result.userCode : null,
			verificationUri: isCommandString(result?.verificationUriComplete)
				? result.verificationUriComplete
				: isCommandString(result?.verificationUri)
					? result.verificationUri
					: null,
		};
		if (!(login.userCode || login.verificationUri)) {
			throw new Error("Core did not return a device code or verification URL.");
		}
		outputCommandResult(
			ctx,
			login,
			[
				tr("Account sign-in started."),
				login.userCode
					? tf("Device code: {code}", { code: login.userCode })
					: null,
				login.verificationUri
					? tf("Open: {url}", { url: login.verificationUri })
					: null,
			]
				.filter((line): line is string => line !== null)
				.join("\n")
		);
		return 0;
	},
};

export const logoutCommand: Command = {
	name: "logout",
	summary: "Sign out of the active account",
	usage: "ryu-cli logout",
	run: async (ctx) => {
		if (ctx.args.length > 0) {
			throw new UsageError("Usage: ryu-cli logout");
		}
		if (ctx.flags.dryRun) {
			outputCommandResult(
				ctx,
				{ dryRun: true },
				tr("Would sign out of the active account.")
			);
			return 0;
		}
		const result = asRecord(
			await callCore(ctx, "/api/auth/logout", { method: "POST" })
		);
		if (result?.success !== true) {
			throw new Error(
				isCommandString(result?.error)
					? result.error
					: "Core did not confirm sign-out."
			);
		}
		outputCommandResult(
			ctx,
			result ?? { success: true },
			tr("Signed out of the active account.")
		);
		return 0;
	},
};
export const setupCommand = rawCommand(
	"setup",
	"ryu-cli setup",
	"Inspect dependency setup",
	"/api/setup/status",
	"GET"
);
