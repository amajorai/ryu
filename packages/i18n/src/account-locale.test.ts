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

	it("saves a choice made while signed out once the person signs in", async () => {
		let signedIn = false;
		const { save, saved } = harness({ isSignedIn: async () => signedIn });
		save("de");
		await settle();
		await save.flushPending();
		expect(saved).toEqual([]);

		signedIn = true;
		await save.flushPending();
		await save.flushPending();
		expect(saved).toEqual(["de"]);
	});

	it("saves the same choice again for the next account after a sign-out", async () => {
		let signedIn = true;
		const { save, saved } = harness({ isSignedIn: async () => signedIn });
		save("fr");
		await settle();
		signedIn = false;
		save("fr");
		await settle();
		signedIn = true;
		await save.flushPending();
		expect(saved).toEqual(["fr", "fr"]);
	});

	it("drops a pending choice that a newer signed-in choice replaced", async () => {
		let signedIn = false;
		const { save, saved } = harness({ isSignedIn: async () => signedIn });
		save("ja");
		await settle();
		signedIn = true;
		save("ko");
		await save.flushPending();
		await settle();
		await save.flushPending();
		expect(saved).toEqual(["ko"]);
	});

	it("keeps a pending choice whose save failed for the next sign-in", async () => {
		let signedIn = false;
		let fail = true;
		const saved: string[] = [];
		const { errors, save } = harness({
			isSignedIn: async () => signedIn,
			saveLocale: async (locale) => {
				if (fail) {
					return { error: { status: 500 } };
				}
				saved.push(locale);
				return {};
			},
		});
		save("es");
		await settle();
		signedIn = true;
		await save.flushPending();
		fail = false;
		await save.flushPending();
		expect(errors).toEqual([{ status: 500 }]);
		expect(saved).toEqual(["es"]);
	});

	it("saves once when two sign-in retries overlap (StrictMode remount)", async () => {
		let signedIn = false;
		const { save, saved } = harness({ isSignedIn: async () => signedIn });
		save("ja");
		await settle();
		signedIn = true;
		await Promise.all([save.flushPending(), save.flushPending()]);
		expect(saved).toEqual(["ja"]);
	});

	it("saves a choice whose sign-out check was still running at sign-in", async () => {
		let answer: (signedIn: boolean) => void = () => undefined;
		let checks = 0;
		const { save, saved } = harness({
			isSignedIn: () => {
				checks += 1;
				if (checks === 1) {
					return new Promise<boolean>((resolve) => {
						answer = resolve;
					});
				}
				return Promise.resolve(true);
			},
		});
		save("ar");
		await settle();
		const retry = save.flushPending();
		answer(false);
		await retry;
		expect(saved).toEqual(["ar"]);
	});

	it("has nothing to flush when no choice is pending", async () => {
		const { save, saved } = harness();
		await save.flushPending();
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
