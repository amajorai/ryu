import { describe, expect, it } from "bun:test";
import {
	STEP_UP_CONFIRM_COPY,
	STEP_UP_METHOD_LABEL,
	stepUpConfirmSentence,
} from "./copy.ts";
import {
	type StepUpMethod,
	type StepUpScope,
	stepUpPromptLine,
} from "./index.ts";

/**
 * The server's English scope labels, copied verbatim from SCOPE_LABELS in
 * packages/auth/src/lib/step-up.ts (not exported, and this package must not
 * depend on @ryu/auth). packages/auth/src/lib/step-up-action-labels.test.ts
 * pins the same eleven phrases against `stepUpActionLabel`, so a server
 * wording change fails there and points here.
 */
const SERVER_ACTION = {
	"account.merge": "merge another account into this one",
	"account.security": "change your account security settings",
	billing: "complete this billing action",
	"node.destroy": "remove or transfer a cloud node, or delete a Box",
	"org.credentials": "change or reveal access keys and shared secrets",
	"org.delete": "delete a workspace",
	"org.features": "change organization feature access",
	"org.members": "change who can access a workspace",
	"org.security": "change organization security policy",
	"platform.admin": "use Ryu staff powers",
	"session.confirm": "confirm this session with two-factor authentication",
} satisfies Record<StepUpScope, string>;

/** The pre-catalogue template, kept here verbatim as the English oracle. */
const WHERE_THE_CODE_WAS = {
	backup: "one of your backup codes",
	"magic-link": "the verification link we emailed you",
	otp: "the code we emailed you",
	password: "your current password",
	totp: "the code from your authenticator app",
} satisfies Record<StepUpMethod, string>;

function legacyLine(input: {
	action: string;
	enrolmentRequired?: boolean;
	method: StepUpMethod;
}): string {
	if (input.enrolmentRequired) {
		return `You're about to ${input.action}. This can't be undone.`;
	}
	return `Enter ${WHERE_THE_CODE_WAS[input.method]} to ${input.action}.`;
}

const SCOPES = Object.keys(SERVER_ACTION) as StepUpScope[];
const METHODS = Object.keys(WHERE_THE_CODE_WAS) as StepUpMethod[];

describe("catalogued step-up sentences", () => {
	it("cover exactly the scopes the server labels", () => {
		expect(Object.keys(STEP_UP_CONFIRM_COPY).sort()).toEqual(
			[...SCOPES].sort()
		);
		expect(Object.keys(STEP_UP_METHOD_LABEL).sort()).toEqual(
			[...METHODS].sort()
		);
	});

	it("are byte-identical to the old template for every scope and method", () => {
		for (const scope of SCOPES) {
			const action = SERVER_ACTION[scope];
			for (const method of METHODS) {
				const expected = legacyLine({ action, method });
				expect(STEP_UP_CONFIRM_COPY[scope][method]).toBe(expected);
				expect(stepUpPromptLine({ action, method, scope })).toBe(expected);
				expect(
					stepUpPromptLine({ action, enrolmentRequired: false, method, scope })
				).toBe(expected);
			}
		}
	});

	it("say the action can't be undone exactly where enrolment is required, for every scope", () => {
		for (const scope of SCOPES) {
			const action = SERVER_ACTION[scope];
			const expected = legacyLine({
				action,
				enrolmentRequired: true,
				method: "totp",
			});
			expect(STEP_UP_CONFIRM_COPY[scope].undo).toBe(expected);
			for (const method of METHODS) {
				expect(
					stepUpPromptLine({ action, enrolmentRequired: true, method, scope })
				).toBe(expected);
				expect(
					stepUpPromptLine({ action, method, scope }).includes(
						"can't be undone"
					)
				).toBe(false);
			}
		}
	});

	it("are distinct whole sentences", () => {
		const sentences = SCOPES.flatMap((scope) =>
			Object.values(STEP_UP_CONFIRM_COPY[scope])
		);
		expect(new Set(sentences).size).toBe(sentences.length);
		for (const sentence of sentences) {
			expect(sentence).toMatch(/^(?:Enter|You're about to) .+\.$/u);
		}
	});

	it("read the table, not the server's English, for a known scope", () => {
		expect(
			stepUpPromptLine({
				action: "ändern, wer Zugriff hat",
				method: "totp",
				scope: "org.members",
			})
		).toBe(
			"Enter the code from your authenticator app to change who can access a workspace."
		);
	});
});

describe("step-up prompt line fallback", () => {
	// A newer server can send a scope this client has no sentence for.
	const unknownScope = "org.future" as StepUpScope;

	it("keeps the server's action in the old template for an unknown scope", () => {
		for (const method of METHODS) {
			const action = "rotate the signing keys";
			expect(stepUpPromptLine({ action, method, scope: unknownScope })).toBe(
				legacyLine({ action, method })
			);
			expect(
				stepUpPromptLine({
					action,
					enrolmentRequired: true,
					method,
					scope: unknownScope,
				})
			).toBe("You're about to rotate the signing keys. This can't be undone.");
		}
		expect(
			stepUpPromptLine({
				action: "rotate the signing keys",
				method: "otp",
				scope: unknownScope,
			})
		).toBe("Enter the code we emailed you to rotate the signing keys.");
	});

	it("keeps the old template when no scope is given", () => {
		expect(
			stepUpPromptLine({
				action: "complete this billing action",
				method: "backup",
			})
		).toBe("Enter one of your backup codes to complete this billing action.");
	});

	it("never matches inherited object keys as scopes", () => {
		for (const scope of ["toString", "constructor", "__proto__", ""]) {
			expect(stepUpConfirmSentence({ method: "otp", scope })).toBeNull();
			expect(
				stepUpPromptLine({
					action: "do the thing",
					method: "otp",
					scope: scope as StepUpScope,
				})
			).toBe("Enter the code we emailed you to do the thing.");
		}
	});
});
