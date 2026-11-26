import { describe, expect, test } from "bun:test";
import {
	createOpenExternalAsk,
	describeExternalDestination,
	type ExternalDestination,
	gateOpenExternal,
	OPEN_EXTERNAL_APP_NAME_LIMIT,
	OPEN_EXTERNAL_MAX_PROMPTS,
	OPEN_EXTERNAL_REST_LIMIT,
	OPEN_EXTERNAL_WINDOW_MS,
	type OpenExternalAsk,
	type OpenExternalPromptLock,
	promptAppName,
} from "./open-external-gate.ts";
import { CodedRpcError } from "./rpc-errors.ts";

const LOOKALIKE_HOST =
	"accounts.google.com.signin.session-check.security-update.example-login.net";

/** A confirm the test answers by hand, recording what it was shown. */
function manualConfirm() {
	const shown: ExternalDestination[] = [];
	const answers: Array<(accepted: boolean) => void> = [];
	return {
		answers,
		confirm: (destination: ExternalDestination) => {
			shown.push(destination);
			return new Promise<boolean>((resolve) => {
				answers.push(resolve);
			});
		},
		shown,
	};
}

async function codeOf(work: Promise<unknown>): Promise<string> {
	try {
		await work;
	} catch (error) {
		return error instanceof CodedRpcError ? error.code : "not coded";
	}
	return "resolved";
}

describe("describeExternalDestination", () => {
	test("keeps a lookalike host with a long subdomain whole", () => {
		const destination = describeExternalDestination(
			`https://${LOOKALIKE_HOST}/login?next=%2Fhome`
		);
		expect(destination?.host).toBe(LOOKALIKE_HOST);
		expect(destination?.scheme).toBe("https");
		expect(destination?.display).toBe(
			`https://${LOOKALIKE_HOST}/login?next=%2Fhome`
		);
	});

	test("shows an internationalized host in its xn-- form", () => {
		// The first letter is the Cyrillic a (U+0430), not the Latin one.
		const destination = describeExternalDestination("https://\u0430pple.com/");
		expect(destination?.host).toBe("xn--pple-43d.com");
		expect(destination?.display).toBe("https://xn--pple-43d.com");
	});

	test("cuts a long path at the end only, never the host", () => {
		const path = `/c?d=${"a".repeat(400)}`;
		const destination = describeExternalDestination(
			`http://${LOOKALIKE_HOST}:8443${path}`
		);
		expect(destination?.host).toBe(`${LOOKALIKE_HOST}:8443`);
		expect(destination?.rest).toBe(
			`${path.slice(0, OPEN_EXTERNAL_REST_LIMIT)}…`
		);
		expect(
			destination?.display.startsWith(`http://${LOOKALIKE_HOST}:8443/c?d=`)
		).toBe(true);
		expect(destination?.href).toBe(`http://${LOOKALIKE_HOST}:8443${path}`);
	});

	test("refuses credentials in the address and every other scheme", () => {
		for (const href of [
			"https://bank.example@evil.example/",
			"https://user:secret@evil.example/",
			"mailto:someone@example.com",
			"file:///C:/Windows/system32",
			"javascript:alert(1)",
			"not a url",
		]) {
			expect(describeExternalDestination(href)).toBeNull();
		}
	});
});

describe("promptAppName", () => {
	test("drops control and direction characters and cuts a long name", () => {
		expect(promptAppName("Notes\u202E\n  app")).toBe("Notes app");
		const long = promptAppName("x".repeat(200));
		expect(long).toBe(`${"x".repeat(OPEN_EXTERNAL_APP_NAME_LIMIT)}…`);
	});
});

describe("createOpenExternalAsk", () => {
	test("shows the person the destination and returns it after a yes", async () => {
		const prompt = manualConfirm();
		const ask = createOpenExternalAsk({
			confirm: prompt.confirm,
			lock: { open: false },
		});
		const first = ask({ href: `https://${LOOKALIKE_HOST}/a` });
		expect(prompt.shown.map((destination) => destination.host)).toEqual([
			LOOKALIKE_HOST,
		]);
		prompt.answers[0]?.(true);
		// The very object the prompt was given, so its href is the one shown.
		expect(await first).toBe(prompt.shown[0] ?? false);
		const second = ask({ href: "https://example.com/" });
		prompt.answers[1]?.(false);
		expect(await second).toBe(false);
	});

	test("raises no second prompt while one is open, in any frame of the lock", async () => {
		const prompt = manualConfirm();
		const lock: OpenExternalPromptLock = { open: false };
		const frameA = createOpenExternalAsk({ confirm: prompt.confirm, lock });
		const frameB = createOpenExternalAsk({ confirm: prompt.confirm, lock });
		const open = frameA({ href: "https://example.com/1" });
		expect(await codeOf(frameA({ href: "https://example.com/2" }))).toBe(
			"over_budget"
		);
		expect(await codeOf(frameB({ href: "https://example.com/3" }))).toBe(
			"over_budget"
		);
		expect(prompt.shown).toHaveLength(1);
		prompt.answers[0]?.(false);
		expect(await open).toBe(false);
		// The lock is free again once the person answered.
		const next = frameB({ href: "https://example.com/4" });
		expect(prompt.shown).toHaveLength(2);
		prompt.answers[1]?.(true);
		expect(await next).not.toBe(false);
	});

	test("limits the prompts of one frame per window, whatever the answers", async () => {
		let clock = 1000;
		let asked = 0;
		const ask = createOpenExternalAsk({
			confirm: () => {
				asked += 1;
				return Promise.resolve(asked % 2 === 0);
			},
			lock: { open: false },
			now: () => clock,
		});
		for (let index = 0; index < OPEN_EXTERNAL_MAX_PROMPTS; index += 1) {
			await ask({ href: `https://example.com/${index}` });
			clock += 10;
		}
		expect(asked).toBe(OPEN_EXTERNAL_MAX_PROMPTS);
		expect(await codeOf(ask({ href: "https://example.com/more" }))).toBe(
			"over_budget"
		);
		expect(asked).toBe(OPEN_EXTERNAL_MAX_PROMPTS);
		// The oldest prompt leaves the window, so exactly one more may be raised.
		clock = 1000 + OPEN_EXTERNAL_WINDOW_MS;
		await ask({ href: "https://example.com/later" });
		expect(asked).toBe(OPEN_EXTERNAL_MAX_PROMPTS + 1);
		expect(await codeOf(ask({ href: "https://example.com/again" }))).toBe(
			"over_budget"
		);
	});

	test("frees the lock when the prompt itself fails, and refuses bad addresses unasked", async () => {
		const lock: OpenExternalPromptLock = { open: false };
		let asked = 0;
		const ask = createOpenExternalAsk({
			confirm: () => {
				asked += 1;
				return Promise.reject(new Error("prompt unmounted"));
			},
			lock,
		});
		expect(await codeOf(ask({ href: "https://example.com/" }))).toBe(
			"not coded"
		);
		expect(lock.open).toBe(false);
		expect(
			await codeOf(ask({ href: "https://bank.example@evil.example/" }))
		).toBe("invalid_args");
		expect(asked).toBe(1);
	});
});

describe("gateOpenExternal", () => {
	test("opens only after a yes", async () => {
		const prompt = manualConfirm();
		const opened: string[] = [];
		const open = gateOpenExternal(
			createOpenExternalAsk({ confirm: prompt.confirm, lock: { open: false } }),
			({ href }) => {
				opened.push(href);
			}
		);
		const call = open({ href: "https://example.com/x" });
		await Promise.resolve();
		expect(prompt.shown).toHaveLength(1);
		expect(opened).toEqual([]);
		prompt.answers[0]?.(true);
		await call;
		expect(opened).toEqual(["https://example.com/x"]);
	});

	test("a no opens nothing and is reported as denied", async () => {
		const opened: string[] = [];
		const open = gateOpenExternal(
			() => Promise.resolve<false>(false),
			({ href }) => {
				opened.push(href);
			}
		);
		expect(await codeOf(open({ href: "https://example.com/x" }))).toBe(
			"denied"
		);
		expect(opened).toEqual([]);
	});

	test("the opener receives the address the prompt showed, not the string the gate was given", async () => {
		// The URL parser drops a leading space and a tab, and reads a backslash
		// as a slash. An opener that parsed the raw string by other rules could
		// read `example.com\` as a user name and open evil.example.
		const normalized: [raw: string, shown: string][] = [
			[" https://example.com/x", "https://example.com/x"],
			["https://exa\tmple.com/x", "https://example.com/x"],
			[
				"https://example.com\\@evil.example/x",
				"https://example.com/@evil.example/x",
			],
		];
		for (const [raw, shown] of normalized) {
			const prompt = manualConfirm();
			const opened: string[] = [];
			const open = gateOpenExternal(
				createOpenExternalAsk({
					confirm: prompt.confirm,
					lock: { open: false },
				}),
				({ href }) => {
					opened.push(href);
				}
			);
			const call = open({ href: raw });
			await Promise.resolve();
			expect(prompt.shown.map((destination) => destination.host)).toEqual([
				"example.com",
			]);
			expect(prompt.shown.map((destination) => destination.href)).toEqual([
				shown,
			]);
			prompt.answers[0]?.(true);
			await call;
			expect(opened).toEqual([shown]);
		}
	});

	test("a yes that does not carry the address it showed opens nothing", async () => {
		const opened: string[] = [];
		// A host still wired to the earlier contract, where ask answered true.
		const bareYes = (() => Promise.resolve(true)) as unknown as OpenExternalAsk;
		const open = gateOpenExternal(bareYes, ({ href }) => {
			opened.push(href);
		});
		expect(await codeOf(open({ href: "https://example.com/x" }))).toBe(
			"denied"
		);
		expect(opened).toEqual([]);
	});

	test("without a prompt wired, nothing opens", async () => {
		const opened: string[] = [];
		const open = gateOpenExternal(undefined, ({ href }) => {
			opened.push(href);
		});
		expect(await codeOf(open({ href: "https://example.com/x" }))).toBe(
			"server_error"
		);
		expect(opened).toEqual([]);
	});
});
