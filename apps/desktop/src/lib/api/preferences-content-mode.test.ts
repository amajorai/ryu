// apps/desktop/src/lib/api/preferences-content-mode.test.ts
//
// `getDiagnosticsContentMode` / `setDiagnosticsContentMode` round trip against a
// real loopback server that keeps preferences the way Core's
// `/api/preferences/:key` route does (a missing key is a 404, a PUT stores the
// raw string). The pure parse table and the Rust anchors live in
// `preferences.test.ts`; this file pins what the two calls put on and take off
// the wire, so the Privacy page cannot write a value Core would not read back.
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import {
	DIAGNOSTICS_OTLP_CONTENT_MODE_PREF_KEY,
	getDiagnosticsContentMode,
	setDiagnosticsContentMode,
	subscribePreferenceChanges,
} from "./preferences.ts";

const TOKEN = "content-mode-token";
let stored = new Map<string, string>();
let refuseWrites = 0;
let calls: Array<{ body: unknown; method: string; path: string }> = [];

const core = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		const key = decodeURIComponent(
			url.pathname.replace("/api/preferences/", "")
		);
		const body = request.method === "GET" ? null : await request.json();
		calls.push({ body, method: request.method, path: url.pathname });
		if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) {
			return Response.json({ error: "Unauthorized" }, { status: 401 });
		}
		if (request.method === "PUT") {
			if (refuseWrites > 0) {
				refuseWrites -= 1;
				return Response.json({ error: "Refused" }, { status: 503 });
			}
			stored.set(key, (body as { value: string }).value);
			return Response.json({ ok: true });
		}
		const value = stored.get(key);
		if (value === undefined) {
			return Response.json({ error: "Not found" }, { status: 404 });
		}
		return Response.json({ key, value });
	},
});
const target = { token: TOKEN, url: core.url.origin, userJwt: null };
const KEY_PATH = `/api/preferences/${DIAGNOSTICS_OTLP_CONTENT_MODE_PREF_KEY}`;
const changes: [string, string][] = [];
let unsubscribe: () => void = () => undefined;

beforeEach(() => {
	stored = new Map();
	refuseWrites = 0;
	calls = [];
	changes.length = 0;
	unsubscribe = subscribePreferenceChanges((key, value) => {
		changes.push([key, value]);
	});
});
afterEach(() => {
	unsubscribe();
});
afterAll(() => {
	core.stop(true);
});

describe("diagnostics content mode over the wire", () => {
	it("reads metadata only when Core never stored the key (a 404)", async () => {
		expect(await getDiagnosticsContentMode(target)).toBe("metadata_only");
		expect(calls).toEqual([{ body: null, method: "GET", path: KEY_PATH }]);
	});

	it("round trips content and back through Core, writing the canonical values", async () => {
		expect(await setDiagnosticsContentMode(target, "content")).toBe(true);
		expect(stored.get(DIAGNOSTICS_OTLP_CONTENT_MODE_PREF_KEY)).toBe("content");
		expect(await getDiagnosticsContentMode(target)).toBe("content");

		expect(await setDiagnosticsContentMode(target, "metadata_only")).toBe(true);
		expect(stored.get(DIAGNOSTICS_OTLP_CONTENT_MODE_PREF_KEY)).toBe(
			"metadata_only"
		);
		expect(await getDiagnosticsContentMode(target)).toBe("metadata_only");

		expect(calls).toEqual([
			{ body: { value: "content" }, method: "PUT", path: KEY_PATH },
			{ body: null, method: "GET", path: KEY_PATH },
			{ body: { value: "metadata_only" }, method: "PUT", path: KEY_PATH },
			{ body: null, method: "GET", path: KEY_PATH },
		]);
	});

	it("never writes any other preference key", async () => {
		await setDiagnosticsContentMode(target, "content");
		expect(calls.map((call) => call.path)).toEqual([KEY_PATH]);
		expect([...stored.keys()]).toEqual(["diagnostics-otlp-content-mode"]);
	});

	it("reads whatever Core stored by Core's own parse: full and padded content opt in, junk does not", async () => {
		const readStored = async (value: string) => {
			stored.set(DIAGNOSTICS_OTLP_CONTENT_MODE_PREF_KEY, value);
			return await getDiagnosticsContentMode(target);
		};
		expect(await readStored("full")).toBe("content");
		expect(await readStored("  Content  ")).toBe("content");
		expect(await readStored("metadata_only")).toBe("metadata_only");
		expect(await readStored("contents")).toBe("metadata_only");
		expect(await readStored("")).toBe("metadata_only");
	});

	it("announces a successful write to preference observers and a refused one to nobody", async () => {
		await setDiagnosticsContentMode(target, "content");
		expect(changes).toEqual([
			[DIAGNOSTICS_OTLP_CONTENT_MODE_PREF_KEY, "content"],
		]);

		refuseWrites = 1;
		let caught: unknown;
		try {
			await setDiagnosticsContentMode(target, "metadata_only");
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(Error);
		expect(stored.get(DIAGNOSTICS_OTLP_CONTENT_MODE_PREF_KEY)).toBe("content");
		expect(changes).toEqual([
			[DIAGNOSTICS_OTLP_CONTENT_MODE_PREF_KEY, "content"],
		]);
	});

	it("does not mistake an authentication failure for the default", async () => {
		let caught: unknown;
		try {
			await getDiagnosticsContentMode({ ...target, token: "wrong" });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(Error);
	});
});
