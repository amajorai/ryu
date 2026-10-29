import { ExtensionHost } from "@ryu/app-host/ExtensionHost";
import { capabilitiesFromGrants, type HostServices } from "@ryu/app-host/rpc";
import { htmlCompanionSrcdoc } from "@ryu/app-host/third-party-plugin";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PlanDetail } from "../../../../apps-store/blueprint/ui/src/types.ts";
import type {
	BlueprintReadApi,
	BlueprintReadCall,
} from "./blueprint-read-regression.types.ts";
const planId = "plan-read-regression";
const calls: BlueprintReadCall[] = [];
let root: Root | null = null;
let connected = false;
let detailFailures = 0;
let revisionFailures = 0;
let revision = 3;
let hold = false;
let release: (() => void) | null = null;
function detail(): PlanDetail {
	return {
		plan: {
			id: planId,
			title: "Recover reviewed plan reads",
			status: "in_review",
			current_revision: revision,
			created_at: 1_790_000_000,
			updated_at: 1_790_000_100,
		},
		revision: {
			plan_id: planId,
			revision,
			created_at: 1_790_000_100,
			markdown: `Confirmed revision ${revision}: preserve rollback before import.`,
			blocks: [
				{
					id: "reviewed-block",
					kind: "paragraph",
					ordinal: 0,
					text: `Confirmed revision ${revision}: preserve rollback before import.`,
				},
			],
			steps: [],
		},
		annotations: [],
	};
}
const api: BlueprintReadApi = {
	mount(input) {
		if (release) {
			throw new Error("Release the held read before replacing the fixture.");
		}
		root?.unmount();
		calls.length = 0;
		connected = false;
		detailFailures = input.detailFailures ?? 0;
		revisionFailures = input.revisionFailures ?? 0;
		revision = 3;
		hold = false;
		const services: HostServices = {
			listAgents: async () => [],
			registerRoute: async () => {
				throw new Error("No route registration belongs to this read fixture.");
			},
			blueprintRequest: async (request) => {
				const method = request.method ?? "GET";
				const call: BlueprintReadCall = {
					method,
					path: request.path,
					...(request.body === undefined
						? {}
						: { body: structuredClone(request.body) }),
					status: "pending",
				};
				calls.push(call);
				if (
					method !== "GET" ||
					request.body !== undefined ||
					![
						"/plans",
						`/plans/${planId}`,
						`/plans/${planId}/revisions`,
					].includes(request.path)
				) {
					call.status = "refused";
					throw new Error(
						"Unexpected Blueprint request authority or mutation."
					);
				}
				if (request.path === `/plans/${planId}`) {
					if (hold) {
						hold = false;
						await new Promise<void>((resolve) => {
							release = resolve;
						});
						release = null;
					}
					if (detailFailures > 0) {
						detailFailures -= 1;
						call.status = "refused";
						throw new Error("Selected plan detail read was refused.");
					}
					call.status = "accepted";
					return detail();
				}
				if (request.path === `/plans/${planId}/revisions`) {
					if (revisionFailures > 0) {
						revisionFailures -= 1;
						call.status = "refused";
						throw new Error("Selected plan revision list read was refused.");
					}
					call.status = "accepted";
					return {
						revisions: [
							{
								revision,
								created_at: 1_790_000_100,
								block_count: 1,
								step_count: 0,
							},
						],
					};
				}
				call.status = "accepted";
				return { plans: [detail().plan] };
			},
		};
		const container = document.getElementById("host-root");
		if (!container) {
			throw new Error("Missing Blueprint read host.");
		}
		const nonce = crypto.randomUUID();
		root = createRoot(container);
		root.render(
			createElement(ExtensionHost, {
				granted: capabilitiesFromGrants(["blueprint:review"]),
				nonce,
				onConnected: () => {
					connected = true;
				},
				services,
				srcdoc: htmlCompanionSrcdoc(nonce, input.appHtml, "@ryu/blueprint", {
					planId,
				}),
				title: "Blueprint read regression",
			})
		);
	},
	calls: () => structuredClone(calls),
	connected: () => connected,
	setPersistedRevision: (next) => {
		if (![3, 4].includes(next)) {
			throw new Error("Unsupported finite revision.");
		}
		revision = next;
	},
	holdNextDetail: () => {
		if (hold || release) {
			throw new Error("A detail read is already held.");
		}
		hold = true;
	},
	releaseDetail: () => {
		if (!release) {
			throw new Error("No held detail read.");
		}
		release();
	},
};
Reflect.set(window, "__blueprintRead", api);
document.body.dataset.harnessReady = "1";
