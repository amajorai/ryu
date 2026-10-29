import { I18nProvider } from "@ryu/i18n/react";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import { NodePermissionsSettings } from "@/src/components/settings/NodePermissionsSettings.tsx";
import { EntitlementProvider } from "@/src/contexts/entitlement-context.tsx";
import { TabsProvider } from "@/src/contexts/TabsContext.tsx";
import { useNodeStore } from "@/src/store/useNodeStore.ts";
import { parseProofJson } from "../fixture-json.ts";
import "../../src/index.css";

const NODE = {
	name: "permissions-proof",
	token: "permissions-proof-token",
	url: "http://127.0.0.1:7986",
};
const OVERWRITES_KEY = "node-permissions-proof-overwrites";

const OverwriteSchema = z.object({
	allow: z.array(z.string()),
	deny: z.array(z.string()),
	target_id: z.string(),
	target_type: z.string(),
});
type Overwrite = z.infer<typeof OverwriteSchema>;

interface CapturedRequest {
	body: unknown;
	method: string;
	path: string;
}

interface PermissionsProofState {
	failNextResourceList: boolean;
	failNextVocabularyRead: boolean;
	failNextWrite: boolean;
	requests: CapturedRequest[];
	snapshot: () => { overwrites: Overwrite[]; requests: CapturedRequest[] };
}

declare global {
	interface Window {
		__nodePermissionsProof: PermissionsProofState;
	}
}

const initialOverwrites: Overwrite[] = [
	{
		allow: ["space.edit"],
		deny: ["space.view"],
		target_id: "role-operators",
		target_type: "role",
	},
];

function readOverwrites(): Overwrite[] {
	const stored = localStorage.getItem(OVERWRITES_KEY);
	return stored
		? OverwriteSchema.array().parse(JSON.parse(stored))
		: structuredClone(initialOverwrites);
}

function jsonResponse<FixturePayload>(
	body: FixturePayload,
	status = 200
): Response {
	return new Response(JSON.stringify(body), {
		headers: { "Content-Type": "application/json" },
		status,
	});
}

function installMocks(): void {
	const params = new URLSearchParams(window.location.search);
	const state: PermissionsProofState = {
		failNextResourceList: params.get("resourceFailure") === "true",
		failNextWrite: params.get("failWrite") === "true",
		failNextVocabularyRead: params.get("vocabularyFailure") === "true",
		requests: [],
		snapshot: () => ({
			overwrites: structuredClone(readOverwrites()),
			requests: structuredClone(state.requests),
		}),
	};
	window.__nodePermissionsProof = state;
	window.fetch = async (input, init) => {
		const rawUrl = input instanceof Request ? input.url : String(input);
		const url = new URL(rawUrl, window.location.href);
		const method = (init?.method ?? "GET").toUpperCase();
		const body = isNativeText(init?.body) ? parseProofJson(init.body) : null;
		state.requests.push({ body, method, path: url.pathname });

		if (url.pathname === "/api/acl/resources" && method === "GET") {
			if (state.failNextResourceList) {
				state.failNextResourceList = false;
				return jsonResponse(
					{ error: "fixture resource list unavailable" },
					503
				);
			}
			const overwrites = readOverwrites();
			return jsonResponse({
				resources: overwrites.length ? [{ id: "agent-07", kind: "agent" }] : [],
			});
		}
		if (url.pathname === "/api/acl/principals") {
			if (params.get("principalFailure") === "true") {
				return jsonResponse({ error: "fixture directory unavailable" }, 503);
			}
			return jsonResponse({
				kinds: ["space", "agent", "workflow"],
				members: [{ email: "kai@example.test", id: "member-kai", name: "Kai" }],
				org_id: params.get("personalNode") === "true" ? null : "org-ryu",
				roles: [
					{ id: "role-operators", label: "Operators" },
					{ id: "role-auditors", label: "Auditors" },
				],
				teams: [{ id: "team-content-writers", name: "Content writers" }],
			});
		}
		if (url.pathname === "/api/acl/vocabulary") {
			if (state.failNextVocabularyRead) {
				state.failNextVocabularyRead = false;
				return jsonResponse({ error: "fixture vocabulary unavailable" }, 503);
			}
			return jsonResponse({
				collisions: [],
				declared: [
					{
						description: "View content on this resource.",
						id: "space.view",
						implies: [],
						label: "View items",
						plugin_id: "",
					},
					{
						description: "Change content on this resource.",
						id: "space.edit",
						implies: [],
						label: "Edit items",
						plugin_id: "",
					},
					{
						description: "Execute an installed workflow.",
						id: "workflow.run",
						implies: ["space.view"],
						label: "Run workflows",
						plugin_id: "com.ryu.workflows",
					},
				],
				kernel: ["space.edit", "space.view"],
			});
		}
		if (url.pathname === "/api/acl/resources/agent/agent-07") {
			if (method === "PUT") {
				if (state.failNextWrite) {
					state.failNextWrite = false;
					return jsonResponse({ error: "fixture write failed" }, 503);
				}
				const payload = z
					.object({ overwrites: OverwriteSchema.array() })
					.parse(body);
				localStorage.setItem(
					OVERWRITES_KEY,
					JSON.stringify(payload.overwrites)
				);
				return jsonResponse({ overwrites: payload.overwrites });
			}
			return jsonResponse({ overwrites: readOverwrites() });
		}
		if (
			method === "GET" &&
			/^\/api\/acl\/resources\/[^/]+\/[^/]+$/.test(url.pathname)
		) {
			return jsonResponse({ overwrites: [] });
		}
		return jsonResponse({ error: "unexpected proof request" }, 404);
	};
}

useNodeStore.setState({
	cloudNodes: [],
	defaultNode: NODE.name,
	localNodes: [NODE],
	nodes: [NODE],
});
installMocks();

function ProofSurface() {
	return (
		<main className="min-h-screen bg-background p-8 text-foreground">
			<div className="mx-auto max-w-4xl space-y-6">
				<header>
					<p className="font-medium text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
						Ryu · Gateway permissions
					</p>
					<h1 className="mt-2 font-semibold text-3xl tracking-tight">
						Node permissions
					</h1>
					<p className="mt-2 text-muted-foreground text-sm">
						Edit resource exceptions against the node's real principal directory
						and permission vocabulary.
					</p>
				</header>
				<NodePermissionsSettings />
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (!root) {
	throw new Error("Proof root not found");
}

document.documentElement.classList.add("dark");
createRoot(root).render(
	<I18nProvider>
		<EntitlementProvider>
			<TabsProvider>
				<ProofSurface />
			</TabsProvider>
		</EntitlementProvider>
	</I18nProvider>
);
