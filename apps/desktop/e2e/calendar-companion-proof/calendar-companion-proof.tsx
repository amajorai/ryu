import type { RyuCatalogSnapshot } from "@ryu/app-host/app-bridge";
import { ExtensionHost } from "@ryu/app-host/ExtensionHost";
import {
	calendarJobRecordSchema,
	calendarWorkflowRecordSchema,
	capabilitiesFromGrants,
	type HostServices,
	validatePluginRoute,
} from "@ryu/app-host/rpc";
import { htmlCompanionSrcdoc } from "@ryu/app-host/third-party-plugin";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fetchJobs } from "@/src/lib/api/schedules.ts";
import { fetchWorkflows } from "@/src/lib/api/workflows.ts";
import { createScheduledAgentWorkflow } from "@/src/lib/automations.ts";

const PLUGIN_ID = "@ryu/calendar";
const GRANTS = ["calendar:crud", "core:list_agents"];
const catalog: RyuCatalogSnapshot = {
	agents: [
		{
			enabled: true,
			engine: "Ryu agent",
			id: "agent-analyst",
			installed: true,
			name: "Analyst",
			recommended: true,
		},
		{
			enabled: true,
			engine: "ACP agent",
			id: "agent-scheduler",
			installed: true,
			name: "Scheduler Two",
		},
	],
	apiTypes: [],
	current: { provider: "", providerRouting: {}, routing: "" },
	hookEvents: [],
	hooks: [],
	plugins: [],
	providers: [],
	thinkingLevels: [],
	version: 1,
};

export interface CalendarProofApi {
	connected: () => boolean;
	mount: (appHtml: string) => void;
	srcdoc: () => string;
}

declare global {
	interface Window {
		__calendarProof: CalendarProofApi;
	}
}

let connected = false;
let lastSrcdoc = "";
let root: Root | null = null;

function nodeTarget() {
	return {
		token: "calendar-proof-node-token",
		url: window.location.origin,
		userJwt: "calendar-proof-user-jwt",
	};
}

function mount(appHtml: string): void {
	connected = false;
	const nonce = crypto.randomUUID();
	lastSrcdoc = htmlCompanionSrcdoc(nonce, appHtml, PLUGIN_ID);

	const services: HostServices = {
		calendarAgents: async () => [],
		calendarCreateAutomation: (input) =>
			createScheduledAgentWorkflow(nodeTarget(), input),
		calendarJobs: async () =>
			calendarJobRecordSchema.array().parse(await fetchJobs(nodeTarget())),
		calendarWorkflows: async () =>
			calendarWorkflowRecordSchema
				.array()
				.parse(await fetchWorkflows(nodeTarget())),
		catalogSnapshot: async () => catalog,
		listAgents: async () =>
			catalog.agents.map(({ id, name }) => ({ id, name })),
		registerRoute: (claim) =>
			validatePluginRoute(PLUGIN_ID, claim)
				? Promise.resolve({ path: claim.path })
				: Promise.reject(
						new Error(`Route '${claim.path}' is not this app's surface.`)
					),
	};
	const granted = capabilitiesFromGrants(GRANTS);
	const container = document.getElementById("host-root");
	if (!container) {
		throw new Error("Calendar proof #host-root is missing");
	}
	root?.unmount();
	root = createRoot(container);
	root.render(
		createElement(ExtensionHost, {
			srcdoc: lastSrcdoc,
			nonce,
			granted,
			services,
			onConnected: () => {
				connected = true;
			},
			title: "Calendar",
		})
	);
}

window.__calendarProof = {
	connected: () => connected,
	mount,
	srcdoc: () => lastSrcdoc,
};
document.body.setAttribute("data-calendar-proof-ready", "1");
