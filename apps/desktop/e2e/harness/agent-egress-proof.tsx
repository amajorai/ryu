declare const window: Window;

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { AgentEgressSection } from "../../src/components/gateway/AgentEgressSection.tsx";
import {
	type AgentEgressCapturedRequest,
	type AgentEgressJson,
	type AgentEgressSnapshot,
	agentEgressBodyStringSchema,
	agentEgressPreferenceWriteSchema,
	agentEgressSnapshotSchema,
} from "../agent-egress-proof.contracts.ts";
import { parseProofJson } from "../fixture-json.ts";
import "../../src/index.css";
import styles from "./agent-egress-proof.module.css";

const STORAGE_KEY = "ryu-agent-egress-proof-fixture";
const RESEARCH_ID = "research-agent";
const INITIAL_PREFERENCES: AgentEgressSnapshot["preferences"] = {
	"agent-gateway-routing": JSON.stringify({ [RESEARCH_ID]: false }),
	"agent-tool-bridge": JSON.stringify({
		"acp:claude": false,
		[RESEARCH_ID]: false,
		openclaw: false,
	}),
	"claude-gateway-routing": "false",
	"codex-gateway-routing": "true",
};

const initialSnapshot: AgentEgressSnapshot = {
	preferences: INITIAL_PREFERENCES,
	requests: [],
};

localStorage.setItem(
	STORAGE_KEY,
	localStorage.getItem(STORAGE_KEY) ?? JSON.stringify(initialSnapshot)
);

function getSnapshot(): AgentEgressSnapshot {
	return agentEgressSnapshotSchema.parse(
		JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}")
	);
}

function persistSnapshot(snapshot: AgentEgressSnapshot): void {
	localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
}

function jsonResponse<FixturePayload>(
	body: FixturePayload,
	status = 200
): Response {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status,
	});
}

function parseBody(body: BodyInit | null | undefined): AgentEgressJson {
	const bodyString = agentEgressBodyStringSchema.safeParse(body);
	if (!bodyString.success) {
		return null;
	}
	try {
		return parseProofJson(bodyString.data);
	} catch {
		return null;
	}
}

let failReads = new URLSearchParams(window.location.search).has("readFailure");
const failedWrites = new Map<string, number>();
let holdNextWritePath: string | null = null;
let releaseHeldWrite: ((failed: boolean) => void) | null = null;

window.__agentEgressProof = {
	failNextWrite: (path) => {
		failedWrites.set(path, (failedWrites.get(path) ?? 0) + 1);
	},
	holdNextWrite: (path) => {
		holdNextWritePath = path;
	},
	releaseHeldWrite: (failed) => {
		if (!releaseHeldWrite) {
			throw new Error("no preference write is being held");
		}
		const resolve = releaseHeldWrite;
		releaseHeldWrite = null;
		resolve(failed);
	},
	setReadFailure: (failed) => {
		failReads = failed;
	},
	snapshot: () => structuredClone(getSnapshot()),
};

const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
	const request = input instanceof Request ? input : null;
	const url = new URL(request?.url ?? String(input), window.location.href);
	if (!url.pathname.startsWith("/api/")) {
		return nativeFetch(input, init);
	}

	const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
	const headers = new Headers(init?.headers ?? request?.headers);
	const body = parseBody(
		init?.body ?? (request ? await request.clone().text() : null)
	);
	const snapshot = getSnapshot();
	const captured: AgentEgressCapturedRequest = {
		authorization: headers.get("authorization"),
		body,
		method,
		path: url.pathname,
		status: null,
	};
	snapshot.requests.push(captured);
	persistSnapshot(snapshot);

	if (failReads && method === "GET") {
		captured.status = 503;
		persistSnapshot(snapshot);
		return jsonResponse(
			{ message: "Local agent settings fixture is unavailable." },
			503
		);
	}

	if (method === "PUT" && holdNextWritePath === url.pathname) {
		holdNextWritePath = null;
		await new Promise<void>((resolve, reject) => {
			releaseHeldWrite = (failed) => {
				if (failed) {
					captured.status = 503;
					persistSnapshot(snapshot);
					reject(new Error("Local preference fixture rejected the write."));
					return;
				}
				resolve();
			};
		});
	}

	if (method === "PUT" && (failedWrites.get(url.pathname) ?? 0) > 0) {
		failedWrites.set(url.pathname, (failedWrites.get(url.pathname) ?? 1) - 1);
		captured.status = 503;
		persistSnapshot(snapshot);
		return jsonResponse(
			{ message: "Local preference fixture rejected the write." },
			503
		);
	}

	let response: Response;
	if (method === "GET" && url.pathname === "/api/agents") {
		response = jsonResponse({
			agents: [
				{
					engine: "ryu",
					id: "ryu",
					name: "Ryu",
					recommended: true,
					transport: "acp",
				},
				{
					engine: "acp:claude",
					id: "acp:claude",
					name: "Claude Code",
					transport: "acp",
				},
				{
					id: RESEARCH_ID,
					name: "Research Agent",
				},
				{
					engine: "acp:pi",
					id: "acp:pi",
					name: "Pi",
					transport: "acp",
				},
				{
					engine: "openclaw",
					id: "openclaw",
					name: "OpenClaw",
					transport: "acp",
				},
				{
					id: "local-agent",
					name: "Local Model",
				},
			],
		});
	} else if (method === "GET" && url.pathname === "/api/agents/catalog") {
		response = jsonResponse({
			agents: [
				{ engine: "acp:claude", id: "acp:claude", name: "Claude Code" },
				{
					engine: "acp:pi",
					id: "acp:pi",
					name: "Pi",
					registry_id: "pi-acp",
				},
				{
					engine: "openclaw",
					gateway_bypass: true,
					id: "openclaw",
					name: "OpenClaw",
				},
			],
		});
	} else if (
		method === "GET" &&
		url.pathname === `/api/agents/${RESEARCH_ID}`
	) {
		response = jsonResponse({
			agent: {
				engine: "acp-exec:research --acp",
				id: RESEARCH_ID,
				name: "Research Agent",
			},
		});
	} else if (method === "GET" && url.pathname === "/api/agents/local-agent") {
		response = jsonResponse({
			agent: { engine: "ollama", id: "local-agent", name: "Local Model" },
		});
	} else if (method === "GET" && url.pathname === "/api/pi-config") {
		response = jsonResponse({
			config: {
				configDir: "/fixture/pi",
				model: "fixture-model",
				provider: "gateway",
				routing: "gateway",
				thinkingLevel: null,
			},
		});
	} else if (url.pathname.startsWith("/api/preferences/")) {
		const key = decodeURIComponent(
			url.pathname.slice("/api/preferences/".length)
		);
		if (method === "GET") {
			const value = snapshot.preferences[key];
			response =
				value === undefined
					? jsonResponse({ message: "Preference is unset." }, 404)
					: jsonResponse({ key, value });
		} else if (method === "PUT") {
			const input = agentEgressPreferenceWriteSchema.safeParse(body);
			if (input.success) {
				const value = input.data.value;
				snapshot.preferences[key] = value;
				persistSnapshot(snapshot);
				response = jsonResponse({ key, value });
			} else {
				response = jsonResponse(
					{ message: "Preference value must be a string." },
					400
				);
			}
		} else {
			response = jsonResponse(
				{ message: "Unsupported local preference method." },
				405
			);
		}
	} else {
		response = jsonResponse(
			{ message: `No local fixture for ${method} ${url.pathname}.` },
			404
		);
	}

	captured.status = response.status;
	persistSnapshot(snapshot);
	return response;
};

function ProofArtifact() {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: {
				refetchOnWindowFocus: false,
				retry: 1,
			},
		},
	});
	return (
		<QueryClientProvider client={queryClient}>
			<main className={`${styles.surface} dark min-h-screen px-8 py-8`}>
				<div className="mx-auto max-w-6xl">
					<header className="mb-6">
						<p className={`${styles.eyebrow} text-xs`}>
							RYU · LOCAL AGENT CONTROL PROOF
						</p>
						<h1 className="mt-2 font-semibold text-3xl">
							Agent tools and model traffic
						</h1>
						<p className={`${styles.subtitle} mt-2 max-w-3xl text-sm`}>
							Production AgentEgressSection. API writes and reads are captured
							in this page's local-only fixture.
						</p>
					</header>
					<section
						aria-label="Agent egress settings proof"
						className="rounded-2xl border border-white/10 bg-white/[0.03] p-5"
					>
						<AgentEgressSection
							target={{
								token: "agent-egress-proof-token",
								url: "http://proof.local",
								userJwt: null,
							}}
						/>
					</section>
				</div>
			</main>
			<div className="sr-only" data-testid="fixture-ready">
				local agent policy fixture ready
			</div>
		</QueryClientProvider>
	);
}

const root = document.getElementById("root");
if (!root) {
	throw new Error("agent egress proof root is missing");
}
createRoot(root).render(<ProofArtifact />);
document.body.dataset.harnessReady = "1";
