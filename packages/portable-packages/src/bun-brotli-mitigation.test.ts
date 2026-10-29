import { describe, expect, test } from "bun:test";
import {
	fetchInitWithoutBrotliAccept,
	installBunBrotliFetchGuard,
	requestUsesBrotliContentEncoding,
	responseUsesBrotliContentEncoding,
} from "./bun-brotli-mitigation.ts";

describe("requestUsesBrotliContentEncoding", () => {
	test("detects br and combined encodings", () => {
		expect(
			requestUsesBrotliContentEncoding(
				new Request("http://example.test", {
					headers: { "content-encoding": "br" },
				})
			)
		).toBe(true);
		expect(
			requestUsesBrotliContentEncoding(
				new Request("http://example.test", {
					headers: { "content-encoding": "gzip, br" },
				})
			)
		).toBe(true);
	});

	test("ignores gzip-only and missing headers", () => {
		expect(
			requestUsesBrotliContentEncoding(
				new Request("http://example.test", {
					headers: { "content-encoding": "gzip" },
				})
			)
		).toBe(false);
		expect(
			requestUsesBrotliContentEncoding(new Request("http://example.test"))
		).toBe(false);
	});
});

describe("fetchInitWithoutBrotliAccept", () => {
	test("removes br while keeping other encodings", () => {
		const init = fetchInitWithoutBrotliAccept({
			headers: { "accept-encoding": "gzip, br, deflate" },
		});
		expect(new Headers(init?.headers).get("accept-encoding")).toBe(
			"gzip, deflate"
		);
	});
});

describe("responseUsesBrotliContentEncoding", () => {
	test("detects br on responses", () => {
		expect(
			responseUsesBrotliContentEncoding(
				new Response("x", { headers: { "content-encoding": "deflate, br" } })
			)
		).toBe(true);
	});
});

describe("installBunBrotliFetchGuard", () => {
	// The guard installs once per fetch function, so each test swaps in a fresh
	// recording fetch, installs over it, and restores the original.
	async function withGuardedFetch(
		respond: () => Response,
		run: (seen: { encoding: string | null }) => Promise<void>
	): Promise<void> {
		const previous = globalThis.fetch;
		const seen: { encoding: string | null } = { encoding: null };
		globalThis.fetch = Object.assign(
			(input: string | URL | Request, init?: RequestInit) => {
				const headers =
					init?.headers === undefined && input instanceof Request
						? input.headers
						: new Headers(init?.headers);
				seen.encoding = headers.get("accept-encoding");
				return Promise.resolve(respond());
			},
			{ preconnect: previous.preconnect }
		);
		try {
			installBunBrotliFetchGuard();
			await run(seen);
		} finally {
			globalThis.fetch = previous;
		}
	}

	test("strips br from outbound Accept-Encoding", async () => {
		await withGuardedFetch(
			() => new Response("ok"),
			async (seen) => {
				await globalThis.fetch("http://example.test", {
					headers: { "accept-encoding": "gzip, br" },
				});
				expect(seen.encoding).toBe("gzip");
			}
		);
	});

	test("sets a br-free Accept-Encoding when the caller sent none", async () => {
		await withGuardedFetch(
			() => new Response("ok"),
			async (seen) => {
				await globalThis.fetch("http://example.test");
				expect(seen.encoding).toBe("gzip, deflate");
				await globalThis.fetch("http://example.test", {
					signal: new AbortController().signal,
				});
				expect(seen.encoding).toBe("gzip, deflate");
				await globalThis.fetch(new Request("http://example.test"));
				expect(seen.encoding).toBe("gzip, deflate");
				await globalThis.fetch("http://example.test", {
					headers: { "accept-encoding": "br" },
				});
				expect(seen.encoding).toBe("gzip, deflate");
			}
		);
	});

	test("refuses a response that arrives Brotli-encoded", async () => {
		await withGuardedFetch(
			() => new Response("x", { headers: { "content-encoding": "br" } }),
			async () => {
				await expect(globalThis.fetch("http://example.test")).rejects.toThrow(
					/Content-Encoding: br/
				);
			}
		);
	});
	test("lets a bodyless br-labelled reply through", async () => {
		const brHeaders = { "content-encoding": "br" };
		await withGuardedFetch(
			() => new Response(null, { status: 204, headers: brHeaders }),
			async () => {
				const response = await globalThis.fetch("http://example.test");
				expect(response.status).toBe(204);
			}
		);
		await withGuardedFetch(
			() => new Response(null, { status: 304, headers: brHeaders }),
			async () => {
				const response = await globalThis.fetch("http://example.test");
				expect(response.status).toBe(304);
			}
		);
		await withGuardedFetch(
			() => new Response(null, { headers: brHeaders }),
			async () => {
				const response = await globalThis.fetch("http://example.test", {
					method: "HEAD",
				});
				expect(response.status).toBe(200);
				await expect(
					globalThis.fetch(
						new Request("http://example.test", { method: "HEAD" })
					)
				).resolves.toBeInstanceOf(Response);
			}
		);
	});
});
