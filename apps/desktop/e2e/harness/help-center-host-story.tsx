// Help Center browser-proof host. This keeps the real ExtensionHost and
// htmlCompanionSrcdoc path while supplying an in-memory Core-shaped bridge.

import { ExtensionHost } from "@ryu/app-host/ExtensionHost";
import {
	type Capability,
	capabilitiesFromGrants,
	type HostServices,
	validatePluginRoute,
} from "@ryu/app-host/rpc";
import { htmlCompanionSrcdoc } from "@ryu/app-host/third-party-plugin";
import { createElement, type Root } from "react";
import { createRoot } from "react-dom/client";

const PLUGIN_ID = "@ryu/help-center";
const SPACE_ID = "help-center-proof-space";
const DOCUMENT_KIND = "app:@ryu/help-center";

interface ProofSource {
	createdAt: string;
	id: string;
	schemaVersion: 1;
	subject?: string;
	title?: string;
	type: "help-center/ticket" | "help-center/article";
	updatedAt: string;
	[key: string]: unknown;
}

interface ProofRecord {
	id: string;
	kind: string;
	source: string;
	title: string;
	updated_at: number;
}

const SEEDED_SOURCES: ProofSource[] = [
	{
		schemaVersion: 1,
		type: "help-center/ticket",
		id: "demo-ticket-export",
		subject: "Cannot export a report",
		status: "open",
		priority: "urgent",
		channel: "in-app",
		requester: {
			id: "demo-user-maya",
			name: "Maya Chen",
			email: "maya@example.com",
			company: "Northstar Labs",
			avatarSeed: "maya",
		},
		assigneeId: null,
		tags: ["reports", "export"],
		createdAt: "2026-08-24T08:00:00.000Z",
		updatedAt: "2026-08-24T08:12:00.000Z",
		snoozedUntil: null,
		aiState: "suggested",
		topic: "Reports",
		sentiment: "negative",
		aiConfidence: 0.84,
		messages: [
			{
				id: "demo-message-export-1",
				author: "customer",
				authorName: "Maya Chen",
				body: "The export button spins but no report downloads.",
				createdAt: "2026-08-24T08:00:00.000Z",
				internal: false,
			},
		],
		linkedArticleIds: ["demo-article-export"],
	},
	{
		schemaVersion: 1,
		type: "help-center/ticket",
		id: "demo-ticket-access",
		subject: "Please add a teammate to our workspace",
		status: "waiting",
		priority: "normal",
		channel: "chat",
		requester: {
			id: "demo-user-jon",
			name: "Jon Bell",
			email: "jon@example.com",
			company: "Rookery Studio",
			avatarSeed: "jon",
		},
		assigneeId: "ryu-operator",
		tags: ["access", "workspace"],
		createdAt: "2026-08-23T16:20:00.000Z",
		updatedAt: "2026-08-24T07:55:00.000Z",
		snoozedUntil: null,
		aiState: "human-reviewed",
		topic: "Workspace access",
		sentiment: "neutral",
		aiConfidence: 0.62,
		messages: [
			{
				id: "demo-message-access-1",
				author: "customer",
				authorName: "Jon Bell",
				body: "Can you help me invite one teammate with editor access?",
				createdAt: "2026-08-23T16:20:00.000Z",
				internal: false,
			},
			{
				id: "demo-message-access-2",
				author: "agent",
				authorName: "Ryu operator",
				body: "I am checking the workspace role before I reply.",
				createdAt: "2026-08-24T07:55:00.000Z",
				internal: true,
			},
		],
		linkedArticleIds: ["demo-article-access"],
	},
	{
		schemaVersion: 1,
		type: "help-center/ticket",
		id: "demo-ticket-model",
		subject: "Which model should run this task?",
		status: "waiting",
		priority: "low",
		channel: "email",
		requester: {
			id: "demo-user-priya",
			name: "Priya Nair",
			email: "priya@example.com",
			company: null,
			avatarSeed: "priya",
		},
		assigneeId: "ryu-operator",
		tags: ["models", "tasks"],
		createdAt: "2026-08-23T10:00:00.000Z",
		updatedAt: "2026-08-23T10:45:00.000Z",
		snoozedUntil: null,
		aiState: "human-reviewed",
		topic: "Model selection",
		sentiment: "positive",
		aiConfidence: 0.91,
		messages: [
			{
				id: "demo-message-model-1",
				author: "customer",
				authorName: "Priya Nair",
				body: "The model recommendation worked well. Thank you!",
				createdAt: "2026-08-23T10:00:00.000Z",
				internal: false,
			},
		],
		linkedArticleIds: ["demo-article-models"],
	},
	{
		schemaVersion: 1,
		type: "help-center/article",
		id: "demo-article-export",
		title: "Exporting a report from Ryu",
		body: "Ryu reports can be exported from the Reports view. Choose a date range, select Export, and keep the tab open until the download is ready.",
		status: "published",
		tags: ["reports", "exports"],
		sourceTicketIds: ["demo-ticket-export"],
		createdAt: "2026-08-24T07:10:00.000Z",
		updatedAt: "2026-08-24T07:20:00.000Z",
		usageCount: 12,
	},
	{
		schemaVersion: 1,
		type: "help-center/article",
		id: "demo-article-access",
		title: "Managing workspace access in Ryu",
		body: "Workspace owners can manage access from Settings. Invite a teammate, choose their role, and review the Space permissions before saving.",
		status: "published",
		tags: ["access", "workspace"],
		sourceTicketIds: ["demo-ticket-access"],
		createdAt: "2026-08-24T07:30:00.000Z",
		updatedAt: "2026-08-24T07:40:00.000Z",
		usageCount: 8,
	},
	{
		schemaVersion: 1,
		type: "help-center/article",
		id: "demo-article-models",
		title: "Choosing a model for a Ryu task",
		body: "Start with the model recommended by Ryu for the task. You can review the selected provider, effort, and expected usage before running it.",
		status: "draft",
		tags: ["models", "tasks"],
		sourceTicketIds: ["demo-ticket-model"],
		createdAt: "2026-08-24T07:50:00.000Z",
		updatedAt: "2026-08-24T08:00:00.000Z",
		usageCount: 3,
	},
];

function titleForSource(source: ProofSource): string {
	return source.type === "help-center/ticket"
		? (source.subject ?? "Help Center ticket")
		: (source.title ?? "Help Center article");
}

function createRecord(source: ProofSource): ProofRecord {
	return {
		id: source.id,
		kind: DOCUMENT_KIND,
		source: JSON.stringify(source),
		title: titleForSource(source),
		updated_at: Date.parse(source.updatedAt),
	};
}

function createProofServices(): HostServices {
	const records = new Map(
		SEEDED_SOURCES.map((source) => [source.id, createRecord(source)])
	);
	const storage = new Map<string, string>();
	let nextDocumentNumber = 1;

	return {
		listAgents: () => Promise.resolve([]),
		modelComplete: async () =>
			JSON.stringify({
				reply:
					"Thanks for flagging this. I’m checking the report export path now and will keep this ticket open while we confirm the download is ready.",
				citedArticleIds: ["demo-article-export"],
				shouldEscalate: false,
				uncertainty: null,
			}),
		registerRoute: (claim) =>
			validatePluginRoute(PLUGIN_ID, claim)
				? Promise.resolve({ path: claim.path })
				: Promise.reject(
						new Error(`route '${claim.path}' is not this plugin's own surface`)
					),
		spacesEnsureSpace: async () => SPACE_ID,
		spacesSearch: async ({ space_id, query, limit }) => {
			if (space_id !== SPACE_ID) {
				throw new Error("Unknown Help Center proof Space");
			}
			const normalizedQuery = query.trim().toLocaleLowerCase();
			return [...records.values()]
				.filter((record) =>
					`${record.title} ${record.source}`
						.toLocaleLowerCase()
						.includes(normalizedQuery)
				)
				.slice(0, limit ?? 12)
				.map((record, index) => ({
					chunk_id: `${record.id}-chunk-${index + 1}`,
					content: `${record.title}\n${record.source}`,
					distance: 0.1 + index / 100,
					document_id: record.id,
				}));
		},
		spacesCreateDoc: async ({ space_id, title }) => {
			if (space_id !== SPACE_ID) {
				throw new Error("Unknown Help Center proof Space");
			}
			const id = `help-center-proof-doc-${nextDocumentNumber}`;
			nextDocumentNumber += 1;
			records.set(id, {
				id,
				kind: DOCUMENT_KIND,
				source: "{}",
				title,
				updated_at: Date.now(),
			});
			return id;
		},
		spacesDeleteDoc: async ({ doc_id }) => {
			records.delete(doc_id);
		},
		spacesGetDoc: async ({ doc_id }) => records.get(doc_id) ?? null,
		spacesListDocs: async ({ space_id }) => {
			if (space_id !== SPACE_ID) {
				throw new Error("Unknown Help Center proof Space");
			}
			return [...records.values()].map(({ id, title, updated_at }) => ({
				id,
				title,
				updated_at,
			}));
		},
		spacesUpdateDoc: async ({ doc_id, source, title }) => {
			const current = records.get(doc_id);
			if (!current) {
				throw new Error(`Unknown Help Center proof document '${doc_id}'`);
			}
			records.set(doc_id, {
				...current,
				source,
				title: title ?? current.title,
				updated_at: Date.now(),
			});
		},
		storageGet: async ({ key }) => storage.get(key) ?? null,
		storageSet: async ({ key, value }) => {
			storage.set(key, value);
		},
	};
}

interface HelpCenterCompanionApi {
	connected: () => boolean;
	mount: (appHtml: string, view?: AppView) => void;
}

type AppView =
	| "overview"
	| "inbox"
	| "tickets"
	| "knowledge"
	| "agent"
	| "insights";

declare global {
	interface Window {
		__ryuHelpCenterCompanion: HelpCenterCompanionApi;
	}
}

let connected = false;
let root: Root | null = null;
let services: HostServices | null = null;

function mount(appHtml: string, view: AppView = "inbox"): void {
	connected = false;
	const nonce = globalThis.crypto.randomUUID();
	const granted: ReadonlySet<Capability> = capabilitiesFromGrants([
		"hook:side-model",
		"spaces:docs",
		"storage:kv",
	]);
	const srcdoc = htmlCompanionSrcdoc(nonce, appHtml, PLUGIN_ID, { view });
	const container = document.getElementById("host-root");
	if (!container) {
		throw new Error("harness #host-root missing");
	}
	root?.unmount();
	root = createRoot(container);
	const resolvedServices = services ?? createProofServices();
	services = resolvedServices;
	root.render(
		createElement(ExtensionHost, {
			granted,
			nonce,
			onConnected: () => {
				connected = true;
			},
			services: resolvedServices,
			srcdoc,
			title: "Help Center browser proof",
		})
	);
}

window.__ryuHelpCenterCompanion = {
	connected: () => connected,
	mount,
};
