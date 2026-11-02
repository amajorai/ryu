import { describe, expect, test } from "bun:test";
import { ApiError } from "@/src/lib/api/client.ts";
import {
	nativeAccountErrorText,
	nativeAccountsUnsupported,
	nativeOperationErrorText,
} from "./NativeProviderAccounts-error-text.ts";

const german: Record<string, string> = {
	"Disconnect this native account before signing in again.":
		"Trenne dieses native Konto, bevor du dich erneut anmeldest.",
	"Native sign-in timed out. Try signing in again.":
		"Die native Anmeldung hat zu lange gedauert. Melde dich erneut an.",
};
const tl = (source: string, values: Record<string, string | number>) =>
	(german[source] ?? source).replace(/\{(\w+)\}/g, (_match, name: string) =>
		String(values[name] ?? "")
	);

const refusal = (body: Record<string, unknown>) =>
	new ApiError(
		"/api/agents/kiro/native-accounts",
		400,
		typeof body.error === "string" ? body.error : undefined,
		typeof body.code === "string" ? body.code : undefined,
		body
	);

describe("native account error text", () => {
	test("renders Core's coded sentence in the reader's language", () => {
		const cause = refusal({
			code: "native_account_disconnect_first",
			error: "Disconnect this native account before signing in again.",
			i18n: {
				args: {},
				message: "Disconnect this native account before signing in again.",
			},
		});
		expect(nativeAccountErrorText(cause, tl, "fallback")).toBe(
			"Trenne dieses native Konto, bevor du dich erneut anmeldest."
		);
	});

	test("shows an older Core's text as sent and falls back for unknown causes", () => {
		const cause = refusal({ error: "Account vault not initialized" });
		expect(nativeAccountErrorText(cause, tl, "fallback")).toBe(
			"Account vault not initialized"
		);
		expect(nativeAccountErrorText("boom", tl, "fallback")).toBe("fallback");
	});

	test("renders a failed login operation's coded sentence", () => {
		const operation = {
			accountId: "work",
			error: "Native sign-in timed out. Try signing in again.",
			errorCode: "native_account_login_timed_out",
			errorI18n: {
				args: {},
				message: "Native sign-in timed out. Try signing in again.",
			},
			instructions: "",
			operationId: "op",
			state: "failed" as const,
		};
		expect(nativeOperationErrorText(operation, tl)).toBe(
			"Die native Anmeldung hat zu lange gedauert. Melde dich erneut an."
		);
		expect(
			nativeOperationErrorText({ ...operation, error: null }, tl)
		).toBeNull();
	});

	test("recognizes an unsupported agent by code or legacy text", () => {
		expect(
			nativeAccountsUnsupported(
				refusal({
					code: "native_account_unsupported",
					error: "translated elsewhere",
				})
			)
		).toBe(true);
		expect(
			nativeAccountsUnsupported(refusal({ error: "Not a native ACP agent" }))
		).toBe(true);
		expect(
			nativeAccountsUnsupported(refusal({ error: "Something else" }))
		).toBe(false);
	});
});
