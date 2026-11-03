/* @jsxImportSource @opentui/react */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { officialCliLiteralCatalog } from "@ryu/i18n/official-catalog/cli";
import type { ApiTarget } from "@ryuhq/core-client/client";
import { act } from "react";
import { createCliTranslator } from "./translate.ts";

// Pin the whole CLI (JSX runtime, tf, tr and errorText) to Japanese before any
// screen module loads, the way LANG=ja_JP.UTF-8 does at startup.
const japanese = createCliTranslator("ja", officialCliLiteralCatalog("ja"));
mock.module("./translate.ts", () => ({
	CLI_FORMAT_LOCALE: "ja",
	CLI_LOCALE: "ja",
	createCliTranslator,
	tf: japanese.tf,
	tr: japanese.tr,
	translateProps: japanese.translateProps,
}));
const { caughtMessage, createErrorText, errorText } = await import(
	"./error-text.ts"
);
const { AccountSecurity } = await import(
	"../overlays/settings/account-security.tsx"
);
const { testRender } = await import("../__tests__/cli-test-render.ts");

const UNAVAILABLE = "Identity verification is unavailable for this account.";
const SERVER_REASON = "upstream refused: quota_exceeded (req 7f3a)";
// How the shared request client reports the refused step-up read.
const REFUSED_READ = "/api/step-up/status?scope=account.security failed: 400";
const realFetch = globalThis.fetch;
type Setup = Awaited<ReturnType<typeof testRender>>;
let setup: Setup | null = null;

afterEach(async () => {
	globalThis.fetch = realFetch;
	await act(async () => {
		setup?.renderer.destroy();
		await Promise.resolve();
	});
	setup = null;
});

describe("errorText", () => {
	test("translates a catalogued reason and keeps unknown text verbatim", () => {
		const reason = officialCliLiteralCatalog("ja")?.[UNAVAILABLE];
		expect(reason).toBeString();
		expect(reason).not.toBe(UNAVAILABLE);
		expect(errorText(new Error(UNAVAILABLE))).toBe(reason ?? "");
		expect(errorText(UNAVAILABLE)).toBe(reason ?? "");
		expect(errorText(new Error(SERVER_REASON))).toBe(SERVER_REASON);
		expect(errorText(404)).toBe("404");
	});

	test.each([
		"ja",
		"ar",
		"de",
	])("translates the overlays' thrown reasons under %s", (locale) => {
		const catalog = officialCliLiteralCatalog(locale);
		const localized = createErrorText(createCliTranslator(locale, catalog).tr);
		// One literal throw from each wrapping screen.
		for (const reason of [
			"Identity verification was not confirmed.",
			"Provide the complete evaluator array.",
			"Saved context did not match readback.",
			"Choose an image smaller than 5 MB.",
			"Application remains authorized after revocation.",
		]) {
			const translated = catalog?.[reason];
			expect(translated).toBeString();
			expect(translated).not.toBe(reason);
			expect(localized(new Error(reason))).toBe(translated ?? "");
		}
		expect(localized(new Error(SERVER_REASON))).toBe(SERVER_REASON);
	});

	test("stays English without a catalog", () => {
		const english = createErrorText(createCliTranslator(null, null).tr);
		expect(english(new Error(UNAVAILABLE))).toBe(UNAVAILABLE);
		expect(caughtMessage(new TypeError("bad"))).toBe("bad");
	});
});

/** An account service whose step-up gate has no enrolled method. */
function installAccountService(stepUpReason: "unenrolled" | "server") {
	const provide = (...args: Parameters<typeof realFetch>) => {
		const url = new URL(String(args[0]));
		if (url.pathname === "/api/auth/get-session") {
			return Promise.resolve(Response.json(null));
		}
		if (url.pathname === "/api/user/email-change-status") {
			return Promise.resolve(Response.json({ hasActive: false, message: "" }));
		}
		if (url.pathname === "/api/step-up/status" && stepUpReason === "server") {
			return Promise.resolve(
				Response.json(
					{ error: SERVER_REASON, message: SERVER_REASON },
					{
						status: 400,
					}
				)
			);
		}
		if (url.pathname === "/api/step-up/status") {
			return Promise.resolve(
				Response.json({
					action: "account.security",
					enrolmentRequired: true,
					methods: [],
					passwordAvailable: false,
					satisfied: false,
					scope: "account.security",
					twoFactorEnabled: false,
					windowMs: 300_000,
				})
			);
		}
		return Promise.resolve(new Response("unexpected", { status: 404 }));
	};
	globalThis.fetch = Object.assign(provide, {
		preconnect: realFetch.preconnect,
	});
}

async function renderSecurity(): Promise<Setup> {
	const target: ApiTarget = { url: "http://127.0.0.1:3000", token: "t" };
	const rendered = await testRender(
		<AccountSecurity
			active
			authTarget={target}
			onEditingChange={() => undefined}
			onRefresh={() => undefined}
		/>,
		{ height: 30, width: 160 }
	);
	setup = rendered;
	return rendered;
}

/** The frame with OpenTUI's wide-glyph padding removed, so CJK text matches. */
function compact(frame: string): string {
	return frame.replace(/\s+/gu, "");
}

describe("account security errors under Japanese", () => {
	test("the catch path shows the thrown reason in Japanese", async () => {
		installAccountService("unenrolled");
		const rendered = await renderSecurity();
		await rendered.mockInput.pressKeys(["w"]);
		const prefix = japanese.tf("Could not complete action: {error}", {
			error: "",
		});
		const reason = japanese.tr(UNAVAILABLE);
		const frame = await rendered.waitForFrame((text) =>
			compact(text).includes(compact(reason))
		);
		expect(compact(frame)).toContain(compact(`${prefix}${reason}`));
		expect(frame).not.toContain(UNAVAILABLE);
	});

	test("an uncatalogued server reason passes through unchanged", async () => {
		installAccountService("server");
		const rendered = await renderSecurity();
		await rendered.mockInput.pressKeys(["w"]);
		const frame = await rendered.waitForFrame((text) =>
			text.includes(REFUSED_READ)
		);
		const prefix = japanese.tf("Could not complete action: {error}", {
			error: "",
		});
		expect(compact(frame)).toContain(compact(`${prefix}${REFUSED_READ}`));
	});
});
