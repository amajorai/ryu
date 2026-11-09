import { afterEach, describe, expect, test } from "bun:test";
import type { ApiTarget } from "./client.ts";
import {
	deleteRecap,
	exportRecaps,
	finalizeRecap,
	getDailyRecap,
	listRecaps,
	markRecapChunkSilent,
	RECAPS_BASE,
	recapErrorCode,
	searchRecaps,
	setRecapsAvailability,
	startRecap,
	uploadRecapChunk,
	withdrawRecapConsent,
} from "./recaps.ts";
import { recapSchema } from "./recaps-schemas.ts";
import { createFetchFixture } from "./test-support/http-fixture.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

const target: ApiTarget = {
	token: "t",
	url: "http://127.0.0.1:7980/",
	userJwt: null,
};

const RECAP = {
	created_at: "2026-11-08T10:00:00Z",
	id: "rcp_1",
	kind: "recap",
	recap: {
		client_session_id: "6f1f0d55-6c1f-4d5c-9b84-3c7a1f0e2a11",
		local_day: "2026-11-08",
		owner_user_id: "u1",
		tz: "UTC",
	},
	source: "phone",
	started_at: "2026-11-08T10:00:00Z",
	status: "recording",
	title: "Recap",
	updated_at: "2026-11-08T10:00:00Z",
};

interface Seen {
	body?: BodyInit | null;
	headers: Record<string, string>;
	method: string;
	url: string;
}

function serve(status: number, body: unknown, seen: Seen[] = []): Seen[] {
	globalThis.fetch = createFetchFixture(async (url, init) => {
		seen.push({
			body: init.body,
			headers: { ...(init.headers as Record<string, string>) },
			method: init.method ?? "GET",
			url,
		});
		const text = typeof body === "string" ? body : JSON.stringify(body);
		return new Response(text, { status });
	});
	return seen;
}

describe("recaps client", () => {
	test("start posts snake_case to the ext-proxy mount and parses the upload contract", async () => {
		const seen = serve(201, {
			recap: RECAP,
			upload: {
				accepted: ["audio/mp4"],
				max_chunk_bytes: 2_000_000,
				max_chunk_ms: 60_000,
				max_seq: 1440,
				recommended_chunk_ms: 30_000,
			},
		});
		const started = await startRecap(target, {
			clientSessionId: RECAP.recap.client_session_id,
			consentVersion: 1,
			localDay: "2026-11-08",
			source: "watch",
			tz: "UTC",
		});
		expect(seen[0]?.url).toBe(`http://127.0.0.1:7980${RECAPS_BASE}`);
		expect(JSON.parse(String(seen[0]?.body))).toMatchObject({
			client_session_id: RECAP.recap.client_session_id,
			consent_version: 1,
			source: "watch",
		});
		expect(started.upload.max_seq).toBe(1440);
		expect(started.recap.recap.pinned).toBe(false);
	});

	test("chunk upload sends raw bytes with the metadata headers", async () => {
		const seen = serve(200, {
			duplicate: false,
			segment_id: 4,
			seq: 2,
			status: "transcribed",
		});
		const result = await uploadRecapChunk(target, "rcp_1", {
			body: new Uint8Array([1, 2, 3]),
			contentType: "audio/mp4",
			durationMs: 30_000,
			offsetMs: 60_000,
			seq: 2,
			sha256: "a".repeat(64),
		});
		expect(seen[0]?.method).toBe("PUT");
		expect(seen[0]?.url).toEndWith("/recaps/rcp_1/chunks/2");
		expect(seen[0]?.headers["x-recap-offset-ms"]).toBe("60000");
		expect(seen[0]?.headers["Content-Type"]).toBe("audio/mp4");
		expect(seen[0]?.headers.Authorization).toBe("Bearer t");
		expect(result.status).toBe("transcribed");
		serve(200, { duplicate: false, seq: 3, status: "skipped_client" }, seen);
		await markRecapChunkSilent(target, "rcp_1", {
			durationMs: 30_000,
			offsetMs: 90_000,
			seq: 3,
		});
		expect(seen[1]?.headers["x-recap-silent"]).toBe("1");
	});

	test("finalize returns missing chunks as data and other errors as ApiError codes", async () => {
		serve(409, { error: "missing_chunks", missing: [1, 4] });
		expect(await finalizeRecap(target, "rcp_1", { expectedChunks: 5 })).toEqual(
			{ kind: "missing", missing: [1, 4] }
		);
		serve(202, { recap: { ...RECAP, status: "processing" } });
		const accepted = await finalizeRecap(target, "rcp_1", {
			expectedChunks: 5,
			force: true,
		});
		expect(accepted.kind).toBe("accepted");
		serve(409, { error: "recap_unconfirmed" });
		const failure = await finalizeRecap(target, "rcp_1", {
			expectedChunks: 1,
		}).catch((error: unknown) => error);
		expect(recapErrorCode(failure)).toBe("recap_unconfirmed");
	});

	test("search is a POST body, never a query string", async () => {
		const seen = serve(200, {
			results: [
				{
					local_day: "2026-11-08",
					recap_id: "rcp_1",
					score: 2,
					snippet: "s",
					title: "T",
				},
			],
		});
		const results = await searchRecaps(target, { q: "budget secret" });
		expect(seen[0]?.method).toBe("POST");
		expect(seen[0]?.url).not.toContain("budget");
		expect(JSON.parse(String(seen[0]?.body))).toEqual({ q: "budget secret" });
		expect(results[0]?.recap_id).toBe("rcp_1");
	});

	test("list, digest, delete and export build the documented paths", async () => {
		const seen = serve(200, { next_cursor: null, recaps: [RECAP] });
		const list = await listRecaps(target, { from: "2026-11-01", limit: 10 });
		expect(seen[0]?.url).toEndWith(`${RECAPS_BASE}?from=2026-11-01&limit=10`);
		expect(list.recaps).toHaveLength(1);
		serve(200, { digest: null }, seen);
		expect(
			await getDailyRecap(target, "2026-11-08", "Europe/Berlin")
		).toBeNull();
		expect(seen[1]?.url).toContain(
			"/recaps/daily?date=2026-11-08&tz=Europe%2FBerlin"
		);
		serve(200, { ok: true }, seen);
		await deleteRecap(target, "rcp/1");
		expect(seen[2]?.url).toEndWith("/recaps/rcp%2F1/detail");
		serve(200, "# Ryu recaps export\n", seen);
		expect(await exportRecaps(target, { format: "md" })).toStartWith(
			"# Ryu recaps export"
		);
	});

	test("the recap schema fills defaults for older rows", () => {
		const parsed = recapSchema.parse(RECAP);
		expect(parsed.recap.partial).toBe(false);
		expect(parsed.recap.duration_ms).toBe(0);
	});

	test("withdrawing consent reports the sessions it closed", async () => {
		serve(200, {
			closed_recordings: 2,
			delete_all: { method: "DELETE", path: "/recaps" },
			recap_count: 5,
			withdrawn: true,
		});
		const withdrawn = await withdrawRecapConsent(target);
		expect(withdrawn.closed_recordings).toBe(2);
		serve(200, { recap_count: 0, withdrawn: true });
		expect((await withdrawRecapConsent(target)).closed_recordings).toBe(0);
	});

	test("a member refused the node switch gets the admin_required code", async () => {
		serve(403, { error: "admin_required" });
		const error = await setRecapsAvailability(target, true).catch(
			(caught: unknown) => caught
		);
		expect(recapErrorCode(error)).toBe("admin_required");
	});

	test("a malformed recap is rejected rather than trusted", async () => {
		serve(200, { next_cursor: null, recaps: [{ ...RECAP, kind: "meeting" }] });
		await expect(listRecaps(target)).rejects.toThrow();
	});
});
