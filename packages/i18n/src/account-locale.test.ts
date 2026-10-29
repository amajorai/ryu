import { describe, expect, it } from "bun:test";
import {
	type AccountLocaleSyncDeps,
	accountLocaleFor,
	createAccountLocaleSync,
} from "./account-locale.ts";

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

function harness(overrides: Partial<AccountLocaleSyncDeps> = {}) {
	const cookies: string[] = [];
	const saved: string[] = [];
	const errors: unknown[] = [];
	const save = createAccountLocaleSync({
		delayMs: 0,
		isSignedIn: async () => true,
		onError: (error) => errors.push(error),
		saveLocale: async (locale) => {
			saved.push(locale);
			return {};
		},
		writeCookie: (locale) => cookies.push(locale),
		...overrides,
	});
	return { cookies, errors, save, saved };
}

describe("accountLocaleFor", () => {
	it("maps English and no pack to en", () => {
		expect(accountLocaleFor("en")).toBe("en");
		expect(accountLocaleFor("en-GB")).toBe("en");
		expect(accountLocaleFor(null)).toBe("en");
	});

	it("canonicalizes official catalog locales", () => {
		expect(accountLocaleFor("de")).toBe("de");
		expect(accountLocaleFor("pt_br")).toBe("pt-BR");
		expect(accountLocaleFor("pt-PT")).toBe("pt-BR");
	});

	it("rejects languages email cannot render and malformed tags", () => {
		expect(accountLocaleFor("nl")).toBeNull();
		expect(accountLocaleFor("not a tag")).toBeNull();
		expect(accountLocaleFor("x".repeat(40))).toBeNull();
	});
});

describe("createAccountLocaleSync", () => {
	it("writes the cookie at once and saves only the last debounced choice", async () => {
		const { cookies, save, saved } = harness();
		save("de");
		save("fr");
		save("en");
		expect(cookies).toEqual(["de", "fr", "en"]);
		await settle();
		expect(saved).toEqual(["en"]);
	});

	it("skips the account write when signed out", async () => {
		const { cookies, save, saved } = harness({ isSignedIn: async () => false });
		save("ja");
		await settle();
		expect(cookies).toEqual(["ja"]);
		expect(saved).toEqual([]);
	});

	it("does not resave the locale it already saved", async () => {
		const { save, saved } = harness();
		save("ko");
		await settle();
		save("ko");
		await settle();
		expect(saved).toEqual(["ko"]);
	});

	it("ignores unsupported languages entirely", async () => {
		const { cookies, save, saved } = harness();
		save("nl");
		await settle();
		expect(cookies).toEqual([]);
		expect(saved).toEqual([]);
	});

	it("reports failures without throwing and retries later", async () => {
		const failure = new Error("offline");
		let attempts = 0;
		const { errors, save } = harness({
			saveLocale: async () => {
				attempts += 1;
				if (attempts === 1) {
					throw failure;
				}
				return { error: { status: 400 } };
			},
		});
		save("es");
		await settle();
		save("es");
		await settle();
		expect(errors).toEqual([failure, { status: 400 }]);
		expect(attempts).toBe(2);
	});

	it("reports a cookie failure and still saves", async () => {
		const { errors, save, saved } = harness({
			writeCookie: () => {
				throw new Error("blocked");
			},
		});
		save("it");
		await settle();
		expect(errors).toHaveLength(1);
		expect(saved).toEqual(["it"]);
	});

	it("saves without a cookie writer (Desktop)", async () => {
		const saved: string[] = [];
		const save = createAccountLocaleSync({
			delayMs: 0,
			isSignedIn: async () => true,
			saveLocale: async (locale) => {
				saved.push(locale);
				return {};
			},
		});
		save("zh-CN");
		await settle();
		expect(saved).toEqual(["zh-CN"]);
	});
});
