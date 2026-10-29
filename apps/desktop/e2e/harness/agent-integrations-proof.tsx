import { mockIPC } from "@tauri-apps/api/mocks";
import { createRoot } from "react-dom/client";
import { IntegrationsPanel } from "../../src/pages/AgentEditPage.tsx";
import "../../src/index.css";

export interface AgentIntegrationProofState {
	calls: { command: string; args: unknown; outcome: string }[];
	requests: { url: string; method: string; authorization: string | null }[];
	unexpected: unknown[];
	refuseDocsOnce: boolean;
}
declare global {
	interface Window {
		__agentIntegrationProof: AgentIntegrationProofState;
	}
}
const proof = (window.__agentIntegrationProof = {
	calls: [],
	requests: [],
	unexpected: [],
	refuseDocsOnce: false,
} as AgentIntegrationProofState);
const expectedDocs =
	"https://app.ryuhq.com/docs/extend/develop/agent-integration-guide";
mockIPC(async (command, args) => {
	const call = { command, args, outcome: "accepted" };
	proof.calls.push(call);
	if (
		command === "open_external" &&
		JSON.stringify(args) === JSON.stringify({ url: expectedDocs })
	) {
		if (proof.refuseDocsOnce) {
			proof.refuseDocsOnce = false;
			call.outcome = "refused";
			throw new Error("Native opener refused documentation URL");
		}
		return null;
	}
	if (
		command === "plugin:store|load" &&
		JSON.stringify(args) === JSON.stringify({ path: "auth.bin" })
	)
		return 4218;
	if (
		command === "plugin:store|get" &&
		args &&
		typeof args === "object" &&
		Object.keys(args).sort().join(",") === "key,rid" &&
		args.rid === 4218 &&
		["accounts", "activeUserId", "token"].includes(String(args.key))
	)
		return [null, false];
	if (
		command === "plugin:store|save" &&
		JSON.stringify(args) === JSON.stringify({ rid: 4218 })
	)
		return null;
	call.outcome = "unexpected";
	proof.unexpected.push({ command, args });
	throw new Error("Unexpected integration native command");
});
const actualFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
	const request = new Request(input, init);
	if (new URL(request.url).pathname.startsWith("/api/")) {
		const call = {
			url: request.url,
			method: request.method,
			authorization: request.headers.get("authorization"),
		};
		proof.requests.push(call);
		if (
			request.url === `${location.origin}/api/gateway/config` &&
			request.method === "GET" &&
			request.headers.get("authorization") === "Bearer integration-proof-token"
		)
			return Response.json({
				auth: {
					api_keys: [
						{
							name: "byoa:review-agent",
							key: "owned-fixture-key",
							trusted_forwarder: true,
						},
					],
				},
			});
		proof.unexpected.push(call);
		return Response.json(
			{ error: "Unexpected integration HTTP request" },
			{ status: 500 }
		);
	}
	return actualFetch(input, init);
};
const root = document.getElementById("root");
if (!root) throw new Error("Missing integration proof root");
createRoot(root).render(
	<main className="mx-auto max-w-5xl p-8">
		<IntegrationsPanel
			agentId="review-agent"
			target={{ url: `${location.origin}/`, token: "integration-proof-token" }}
		/>
	</main>
);
