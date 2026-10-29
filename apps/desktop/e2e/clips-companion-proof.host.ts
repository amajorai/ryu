import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";

interface BridgeRequest {
	body?: unknown;
	method?: string;
	path: string;
}

interface FixtureState {
	calls: BridgeRequest[];
	failures: Record<string, number>;
}

const appHtml = await readFile(
	path.join(tmpdir(), "ryu-clips-companion-ui-build/index.html"),
	"utf8"
);
const bridgeScript = `<script>
window.ryu = {
  context: { view: new URLSearchParams(window.location.search).get("view") ?? "editor" },
  app: {
    request: async (input) => {
      const response = await fetch("/__fixture/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      return await response.json();
    },
  },
};
</script>`;
const html = appHtml.replace("<head>", `<head>${bridgeScript}`);
if (html === appHtml) {
	throw new Error("The production Clips bundle has no document head.");
}

function emptyState(): FixtureState {
	return { calls: [], failures: {} };
}

function json<FixturePayload>(value: FixturePayload, status = 200): Response {
	return Response.json(value, { status });
}

const BridgeRequestSchema = z.object({
	body: z.json().optional(),
	method: z.string().optional(),
	path: z.string(),
}) satisfies z.ZodType<BridgeRequest>;
const ResetSchema = z.object({
	failures: z.record(z.string(), z.number()).optional(),
});

let state = emptyState();

const ingestedClip = {
	createdAt: "2026-10-05T03:00:00Z",
	durationMs: 70_000,
	framesEndpoint: "/api/clips/fixture-ingest-1/frames",
	id: "fixture-ingest-1",
	recommendedMoments: [
		{ atMs: 18_000, reason: "opening insight" },
		{ atMs: 38_000, reason: "closing insight" },
	],
	title: "Desktop ingest proof",
	transcript: {
		segments: [
			{ startMs: 18_000, text: "The node returned this opening transcript." },
			{ startMs: 38_000, text: "The node returned this second transcript." },
		],
	},
};

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 5588,
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/__ready") {
			return new Response("ok");
		}
		if (url.pathname === "/__fixture/reset" && request.method === "POST") {
			const input = ResetSchema.parse(await request.json());
			state = {
				calls: [],
				failures: structuredClone(input.failures ?? {}),
			};
			return json({ ok: true });
		}
		if (url.pathname === "/__fixture/state") {
			return json(state);
		}
		if (url.pathname === "/__fixture/request" && request.method === "POST") {
			const input = BridgeRequestSchema.parse(await request.json());
			state.calls.push(structuredClone(input));
			const remaining = state.failures[input.path] ?? 0;
			if (remaining > 0) {
				state.failures[input.path] = remaining - 1;
				return json({ available: false, reason: "fixture unavailable" });
			}
			if (input.path === "/") {
				return json({
					available: true,
					capabilities: { spaceFiling: false, urlIngest: true },
					clips: [],
				});
			}
			if (input.path === "/ingest") {
				// The node answers an ingest with the saved clip bundle.
				return json(ingestedClip);
			}
			if (input.path === "/start") {
				return json({ available: true, clipId: "fixture-capture-1" });
			}
			return json({ available: false, reason: "fixture path not found" }, 404);
		}
		if (url.pathname === "/favicon.ico") {
			return new Response(null, { status: 204 });
		}
		return new Response(html, {
			headers: { "content-type": "text/html; charset=utf-8" },
		});
	},
});

const stop = () => server.stop();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
