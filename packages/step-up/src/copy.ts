// The step-up prompt's English copy, one whole sentence per scope and factor.
//
// Every line is a complete literal, never assembled from fragments, so the
// i18n extractor catalogues each as one key and every surface translates it
// by exact match: the DOM localizer on the website, desktop and extension
// pages, and the native literal lookup on mobile. The extractor reads this
// file into the shared, native and extension catalogs (SURFACE_ROOTS in
// tools/i18n-extract/files.mjs, SURFACE_SHARED_EXTRAS in
// tools/i18n-extract/shared-imports.mjs).
//
// Each English sentence is byte-identical to what the old template built from
// the server's scope label (SCOPE_LABELS in packages/auth/src/lib/step-up.ts):
// `Enter <where the code is> to <action>.`, or `You're about to <action>.
// This can't be undone.` when the scope needs 2FA the account lacks. A
// scope this table does not know keeps that template (see stepUpPromptLine in index.ts).

import type { StepUpMethod, StepUpScope } from "./index.ts";

type ConfirmLines = Record<StepUpMethod, string> & {
	/** The line shown when the scope needs 2FA the account has not enrolled. */
	undo: string;
};

/** The prompt's instruction line for each scope, by factor. */
export const STEP_UP_CONFIRM_COPY = {
	"account.merge": {
		backup:
			"Enter one of your backup codes to merge another account into this one.",
		"magic-link":
			"Enter the verification link we emailed you to merge another account into this one.",
		otp: "Enter the code we emailed you to merge another account into this one.",
		password:
			"Enter your current password to merge another account into this one.",
		totp: "Enter the code from your authenticator app to merge another account into this one.",
		undo: "You're about to merge another account into this one. This can't be undone.",
	},
	"account.security": {
		backup:
			"Enter one of your backup codes to change your account security settings.",
		"magic-link":
			"Enter the verification link we emailed you to change your account security settings.",
		otp: "Enter the code we emailed you to change your account security settings.",
		password:
			"Enter your current password to change your account security settings.",
		totp: "Enter the code from your authenticator app to change your account security settings.",
		undo: "You're about to change your account security settings. This can't be undone.",
	},
	billing: {
		backup: "Enter one of your backup codes to complete this billing action.",
		"magic-link":
			"Enter the verification link we emailed you to complete this billing action.",
		otp: "Enter the code we emailed you to complete this billing action.",
		password: "Enter your current password to complete this billing action.",
		totp: "Enter the code from your authenticator app to complete this billing action.",
		undo: "You're about to complete this billing action. This can't be undone.",
	},
	"node.destroy": {
		backup:
			"Enter one of your backup codes to remove or transfer a cloud node, or delete a Box.",
		"magic-link":
			"Enter the verification link we emailed you to remove or transfer a cloud node, or delete a Box.",
		otp: "Enter the code we emailed you to remove or transfer a cloud node, or delete a Box.",
		password:
			"Enter your current password to remove or transfer a cloud node, or delete a Box.",
		totp: "Enter the code from your authenticator app to remove or transfer a cloud node, or delete a Box.",
		undo: "You're about to remove or transfer a cloud node, or delete a Box. This can't be undone.",
	},
	"org.credentials": {
		backup:
			"Enter one of your backup codes to change or reveal access keys and shared secrets.",
		"magic-link":
			"Enter the verification link we emailed you to change or reveal access keys and shared secrets.",
		otp: "Enter the code we emailed you to change or reveal access keys and shared secrets.",
		password:
			"Enter your current password to change or reveal access keys and shared secrets.",
		totp: "Enter the code from your authenticator app to change or reveal access keys and shared secrets.",
		undo: "You're about to change or reveal access keys and shared secrets. This can't be undone.",
	},
	"org.delete": {
		backup: "Enter one of your backup codes to delete a workspace.",
		"magic-link":
			"Enter the verification link we emailed you to delete a workspace.",
		otp: "Enter the code we emailed you to delete a workspace.",
		password: "Enter your current password to delete a workspace.",
		totp: "Enter the code from your authenticator app to delete a workspace.",
		undo: "You're about to delete a workspace. This can't be undone.",
	},
	"org.features": {
		backup:
			"Enter one of your backup codes to change organization feature access.",
		"magic-link":
			"Enter the verification link we emailed you to change organization feature access.",
		otp: "Enter the code we emailed you to change organization feature access.",
		password:
			"Enter your current password to change organization feature access.",
		totp: "Enter the code from your authenticator app to change organization feature access.",
		undo: "You're about to change organization feature access. This can't be undone.",
	},
	"org.members": {
		backup:
			"Enter one of your backup codes to change who can access a workspace.",
		"magic-link":
			"Enter the verification link we emailed you to change who can access a workspace.",
		otp: "Enter the code we emailed you to change who can access a workspace.",
		password:
			"Enter your current password to change who can access a workspace.",
		totp: "Enter the code from your authenticator app to change who can access a workspace.",
		undo: "You're about to change who can access a workspace. This can't be undone.",
	},
	"org.security": {
		backup:
			"Enter one of your backup codes to change organization security policy.",
		"magic-link":
			"Enter the verification link we emailed you to change organization security policy.",
		otp: "Enter the code we emailed you to change organization security policy.",
		password:
			"Enter your current password to change organization security policy.",
		totp: "Enter the code from your authenticator app to change organization security policy.",
		undo: "You're about to change organization security policy. This can't be undone.",
	},
	"platform.admin": {
		backup: "Enter one of your backup codes to use Ryu staff powers.",
		"magic-link":
			"Enter the verification link we emailed you to use Ryu staff powers.",
		otp: "Enter the code we emailed you to use Ryu staff powers.",
		password: "Enter your current password to use Ryu staff powers.",
		totp: "Enter the code from your authenticator app to use Ryu staff powers.",
		undo: "You're about to use Ryu staff powers. This can't be undone.",
	},
	"session.confirm": {
		backup:
			"Enter one of your backup codes to confirm this session with two-factor authentication.",
		"magic-link":
			"Enter the verification link we emailed you to confirm this session with two-factor authentication.",
		otp: "Enter the code we emailed you to confirm this session with two-factor authentication.",
		password:
			"Enter your current password to confirm this session with two-factor authentication.",
		totp: "Enter the code from your authenticator app to confirm this session with two-factor authentication.",
		undo: "You're about to confirm this session with two-factor authentication. This can't be undone.",
	},
} satisfies Record<StepUpScope, ConfirmLines>;

/** Label for the button that switches to a given factor. */
export const STEP_UP_METHOD_LABEL = {
	backup: "Use a backup code",
	"magic-link": "Email me a verification link",
	otp: "Email me a code",
	password: "Use your password",
	totp: "Use my authenticator app",
} satisfies Record<StepUpMethod, string>;

function isCataloguedScope(
	scope: string | undefined
): scope is keyof typeof STEP_UP_CONFIRM_COPY {
	return scope !== undefined && Object.hasOwn(STEP_UP_CONFIRM_COPY, scope);
}

/**
 * The catalogued sentence for `scope` and `method`, or null for a scope this
 * table does not know (a server newer than this client), so the caller can
 * fall back to the server's own description.
 */
export function stepUpConfirmSentence(input: {
	enrolmentRequired?: boolean;
	method: StepUpMethod;
	scope?: string;
}): string | null {
	if (!isCataloguedScope(input.scope)) {
		return null;
	}
	const lines: ConfirmLines = STEP_UP_CONFIRM_COPY[input.scope];
	if (input.enrolmentRequired) {
		return lines.undo;
	}
	return Object.hasOwn(lines, input.method) ? lines[input.method] : null;
}
