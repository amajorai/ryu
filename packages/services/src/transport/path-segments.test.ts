import { describe, expect, test } from "bun:test";
// The shim delegates to this export; the table below guards the base-URL stripping.
import { isSafeRequestPath } from "@ryuhq/client";
import {
	isRyuError,
	RyuInvalidRequestError,
	type RyuService,
} from "../errors.ts";
import { Ryu } from "../ryu.ts";
import { hasUnsafePathSegment } from "./fetch-shim.ts";

function recordingFetch() {
	const calls: string[] = [];
	const fetch = (input: RequestInfo | URL) => {
		calls.push(String(input));
		return Promise.resolve(Response.json({}, { status: 500 }));
	};
	return { calls, fetch };
}

const BOX_ENV = {
	RYU_BOX_API_KEY: "box-tenant-secret",
	RYU_BOX_URL: "http://127.0.0.1:8090",
};
const NOTIFY_ENV = {
	RYU_NOTIFY_API_KEY: "notify_tenant_secret",
	RYU_NOTIFY_URL: "http://127.0.0.1:8092",
};
const CONTROL_PLANE_ENV = {
	RYU_API_KEY: "ryu_test_key",
	RYU_ORGANIZATION_ID: "org_1",
};

async function refusal(call: () => unknown): Promise<unknown> {
	try {
		await call();
	} catch (error) {
		return error;
	}
	throw new Error("expected the call to throw");
}

/** The fields an `invalid_id` refusal is checked on, or null for anything else. */
function refusalShape(error: unknown) {
	if (!(error instanceof RyuInvalidRequestError && isRyuError(error))) {
		return null;
	}
	const { code, retryable, service, status } = error;
	return { code, retryable, service, status };
}

function invalidId(service: RyuService) {
	return { code: "invalid_id", retryable: false, service, status: 0 };
}

describe("hasUnsafePathSegment", () => {
	const base = "http://127.0.0.1:8090";

	test("refuses dot, %2e and empty segments after the base URL", () => {
		for (const path of [
			"/v1/boxes/b/previews/..",
			"/v1/boxes/b/previews/.",
			"/v1/boxes/%2E%2e/fork",
			"/v1/boxes/.%2e",
			"/v1/boxes//previews",
			"/v1/boxes/",
			"/v1/boxes/b/previews/?x=1",
		]) {
			expect(hasUnsafePathSegment(base, `${base}${path}`)).toBe(true);
		}
	});

	test("passes ordinary paths, queries with dots and the base itself", () => {
		for (const url of [
			`${base}/v1/boxes/b`,
			`${base}/v1/boxes/b.c/files?path=../x`,
			`${base}/v1/boxes/...`,
			`${base}/`,
			base,
			"http://other.example.com/a/../b",
		]) {
			expect(hasUnsafePathSegment(base, url)).toBe(false);
		}
	});

	test("reads segments like the URL parser: backslash separates, tab/CR/LF vanish", () => {
		for (const path of [
			"/v1/projects/..\\x",
			"/v1/projects\\..",
			"\\v1\\..",
			"/v1/projects/.\t.",
			"/v1/projects/%2e\n%2E/x",
			"/v1/projects/\r",
			"/v1/projects/. ",
		]) {
			expect({
				path,
				unsafe: hasUnsafePathSegment(base, `${base}${path}`),
			}).toEqual({ path, unsafe: true });
			// What fetch would actually send: the parsed path is not the raw one.
			expect(new URL(`${base}${path}`).pathname).not.toBe(path);
		}
		expect(hasUnsafePathSegment(base, `${base}/v1/projects/a\tb`)).toBe(false);
	});

	test("answers like @ryuhq/client's isSafeRequestPath on the same paths", () => {
		// The shim delegates the segment scan to @ryuhq/client's exported
		// isSafeRequestPath and only strips the base URL; this table guards
		// that the wrapper adds no divergence of its own.
		for (const path of [
			"/v1/boxes/b",
			"/v1/boxes/b.c/files?path=../x",
			"/v1/boxes/...",
			"/v1/projects/a\tb",
			"/v1/projects/a b",
			"/v1/boxes/b/previews/..",
			"/v1/boxes/b/previews/.",
			"/v1/boxes/%2E%2e/fork",
			"/v1/boxes/.%2e",
			"/v1/boxes//previews",
			"/v1/boxes/",
			"/v1/boxes/b/previews/?x=1",
			"/v1/boxes/b#..",
			"/v1/projects/..\\x",
			"/v1/projects\\..",
			"\\v1\\..",
			"/v1/projects/.\t.",
			"/v1/projects/%2e\n%2E/x",
			"/v1/projects/\r",
			"/v1/projects/. ",
			"/v1/projects/ .. /x",
			"/v1/projects/\u0000../x",
		]) {
			expect({
				path,
				unsafe: hasUnsafePathSegment(base, `${base}${path}`),
			}).toEqual({ path, unsafe: !isSafeRequestPath(path) });
		}
	});

	test("only reads the path after a base URL that has its own path", () => {
		expect(
			hasUnsafePathSegment(
				"https://api.example.com/prefix/",
				"https://api.example.com/prefix/api/v1/x/.."
			)
		).toBe(true);
		expect(
			hasUnsafePathSegment(
				"https://api.example.com/prefix",
				"https://api.example.com/prefix/api/v1/x"
			)
		).toBe(false);
	});
});

describe("path ids the wrapped clients would collapse are refused before any request", () => {
	test("Box: previews.delete with '..' never sends DELETE /v1/boxes/b/", async () => {
		const { calls, fetch } = recordingFetch();
		const ryu = new Ryu({ env: BOX_ENV, fetch });
		expect(
			refusalShape(await refusal(() => ryu.box.previews.delete("b", "..")))
		).toEqual(invalidId("box"));
		expect(refusalShape(await refusal(() => ryu.box.delete("")))).toEqual(
			invalidId("box")
		);
		expect(refusalShape(await refusal(() => ryu.box.get(".")))).toEqual(
			invalidId("box")
		);
		expect(calls).toEqual([]);
	});

	test("Box object mode returns the refusal as a result", async () => {
		const { calls, fetch } = recordingFetch();
		const ryu = new Ryu({ env: BOX_ENV, fetch, result: "object" });
		const result = await ryu.box.snapshots.delete("..");
		expect(refusalShape(result.error)).toEqual(invalidId("box"));
		expect(calls).toEqual([]);
	});

	test("Notify: events.get with '.' or '' sends nothing", async () => {
		const { calls, fetch } = recordingFetch();
		const ryu = new Ryu({ env: NOTIFY_ENV, fetch });
		expect(
			refusalShape(await refusal(() => ryu.notify.events.get(".")))
		).toEqual(invalidId("notify"));
		expect(
			refusalShape(await refusal(() => ryu.notify.events.get("")))
		).toEqual(invalidId("notify"));
		expect(calls).toEqual([]);
	});

	test("Messaging: messages.get with '..' sends nothing", async () => {
		const { calls, fetch } = recordingFetch();
		const ryu = new Ryu({ env: CONTROL_PLANE_ENV, fetch });
		expect(
			refusalShape(await refusal(() => ryu.messaging.messages.get("..")))
		).toEqual(invalidId("messaging"));
		expect(calls).toEqual([]);
	});

	test("Managed Agents: sessions.get and sessions.stream refuse '..' without reconnecting", async () => {
		const { calls, fetch } = recordingFetch();
		const ryu = new Ryu({ env: CONTROL_PLANE_ENV, fetch });
		expect(
			refusalShape(await refusal(() => ryu.managedAgents.sessions.get("..")))
		).toEqual(invalidId("managedAgents"));
		const streamed = await refusal(async () => {
			for await (const _event of ryu.managedAgents.sessions.stream("..")) {
				// unreachable
			}
		});
		expect(refusalShape(streamed)).toEqual(invalidId("managedAgents"));
		const followed = await refusal(async () => {
			for await (const _event of ryu.managedAgents.sessions.follow("")) {
				// unreachable
			}
		});
		expect(refusalShape(followed)).toEqual(invalidId("managedAgents"));
		expect(calls).toEqual([]);
	});

	test("an ordinary id still reaches the service", async () => {
		const { calls, fetch } = recordingFetch();
		const ryu = new Ryu({
			env: BOX_ENV,
			fetch,
			maxRetries: 0,
		});
		await refusal(() => ryu.box.previews.delete("b", "tok.en"));
		expect(calls).toEqual(["http://127.0.0.1:8090/v1/boxes/b/previews/tok.en"]);
	});
});
