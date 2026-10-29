// Explicit idle dependency contracts for the unchanged shipping Layout.
// These routes do not claim execution of their background features.
export interface BackgroundContract {
	allowNoBody?: boolean;
	body: unknown;
	headers?: Record<string, string>;
	status?: number;
	stream?: boolean;
}
export function canonicalPath(url: URL): string {
	const query = new URLSearchParams(url.search);
	query.sort();
	return url.pathname + (query.size ? `?${query}` : "");
}
export function createBackgroundContracts(
	conversationId: string,
	ownerId: string
) {
	const core = new Map<string, BackgroundContract>();
	const backend = new Map<string, BackgroundContract>();
	const get = (path: string, body: unknown) =>
		core.set(`GET ${canonicalPath(new URL(path, "http://owned.test"))}`, {
			body,
		});
	get("/api/health", {
		status: "ok",
		version: "0.0.0",
		gatewayVersion: null,
		requiredRuntimeReady: false,
		updateRuntimeNonce: null,
		channel: "stable",
		capabilities: [
			"chat",
			"agents",
			"teams",
			"threads",
			"workflows",
			"spaces",
			"memory",
			"auto-recall",
			"monitors",
			"meetings",
			"quests",
			"approvals",
			"tools-exec",
			"mcp",
			"mesh",
			"webhook-ingress",
			"recipes",
			"predict",
			"skills",
			"models-catalog",
			"voice",
			"images",
		],
	});
	get("/api/quests", { quests: [] });
	get("/api/plugins/catalog", { entries: [] });
	get("/api/models/updates", { updates: [] });
	get("/api/skills/updates", { updates: [] });
	get("/api/mcp/updates", { updates: [] });
	get(`/api/notifications?user_id=${ownerId}&limit=50`, { notifications: [] });
	get("/api/routing/advice?agent_id=&model=auto&at_conversation_start=false", {
		original: { agent_id: "", model: "auto" },
		effective: { agent_id: "", model: "auto" },
		severity: "continue",
	});
	core.set("POST /api/chat/suggestions", { body: { suggestions: [] } });
	// Core's `chat_prediction` answers `{ prediction: null }` while no enabled
	// plugin contributes the composer-predictions toggle, as in this fixture.
	core.set("POST /api/chat/prediction", { body: { prediction: null } });
	get("/api/catalog", { sidecars: [] });
	get("/api/sidecar/status", { sidecars: [] });
	get("/api/system/status", {
		engine: { active: null, running: false },
		gateway: { reachable: false },
		mesh: null,
		sidecars: [],
	});
	get("/api/plugins", { apps: [] });
	get("/api/identities", { profiles: [] });
	get("/api/mcp/servers", { servers: [] });
	get("/api/mcp/tools", { tools: [] });
	get("/api/sandbox/backend", { active: "wasmtime", available: [] });
	get("/api/composio/status", { configured: false, base_url: "" });
	get("/api/skills", { skills: [] });
	get("/api/safe-mode", {
		enabled: false,
		preference_enabled: false,
		source: "off",
		user_clearable: true,
		suppressed: { kernel_plugins: 0, mcp_servers: 0, plugins: 0, skills: 0 },
	});
	get("/workflows", { workflows: [] });
	get("/api/output-styles", { styles: [], selected: null, forced: null });
	get("/api/catalog/sources?kind=skill", { active: "", sources: [] });
	get("/api/skills/catalog?limit=120&source=all", {
		skills: [],
		next_cursor: null,
		total: 0,
	});
	get("/api/drafts/list", { drafts: [] });
	get("/api/teams", { teams: [] });
	get("/api/agents/catalog", { agents: [] });
	get("/api/models/installed", { models: [] });
	get("/api/models/active", {
		active: "",
		engine: null,
		format: "gguf",
		ref: null,
		repo_id: null,
		default: "",
	});
	get("/api/approvals", { approvals: [] });
	// The shipping inbox opts in to app-job approvals (`approvalsListPath`);
	// Core's `list_approvals` answers the same `{ approvals }` list.
	get("/api/approvals?include=app_jobs", { approvals: [] });
	// Core's `list_inference_presets`: `builtin_presets()` (crates/core/engines
	// presets.rs) followed by the node's saved presets, of which there are none.
	const builtinPreset = (
		id: string,
		name: string,
		description: string,
		sampling: { temperature: number; top_p: number }
	) => ({
		id: `builtin.${id}`,
		name,
		description,
		target: "any",
		sampling,
		builtin: true,
		created_at: 0,
		updated_at: 0,
	});
	get("/api/inference/presets", {
		presets: [
			builtinPreset(
				"precise",
				"Precise",
				"Low randomness for code, extraction, and factual answers.",
				{ temperature: 0.2, top_p: 0.9 }
			),
			builtinPreset(
				"balanced",
				"Balanced",
				"General chat with moderate variety.",
				{ temperature: 0.7, top_p: 0.95 }
			),
			builtinPreset(
				"creative",
				"Creative",
				"Higher variety for brainstorming and writing.",
				{ temperature: 1.0, top_p: 0.98 }
			),
		],
	});
	// The composer's model is neither a local engine nor a named cloud provider,
	// so it asks with no query; Core's `inference_sampling_fields` then answers
	// `remote_sampling_fields("")`, the OpenAI-compatible standard + output set.
	get("/api/inference/sampling-fields", {
		local: false,
		fields: [
			"temperature",
			"top_p",
			"max_tokens",
			"frequency_penalty",
			"presence_penalty",
			"seed",
			"stop",
			"prefill",
			"extra",
			"response_format",
			"logit_bias",
		],
	});
	get("/api/projects/projects", { projects: [] });
	get("/api/spaces", { spaces: [] });
	get("/api/language-packs/installed", { packs: [] });
	get("/api/connections", {
		data: [],
		client_count: 0,
		user_count: 0,
		ttl_secs: 90,
	});
	get("/api/agent-sync/profiles", { profiles: [] });
	get("/api/version", {
		components: [],
		platform: "linux-x86_64",
		ryu_version: "0.0.0",
	});
	get("/api/update/check?channel=stable", {
		current: "0.0.0",
		latest: "0.0.0",
		channel: "stable",
		update_available: false,
		asset: null,
		notes: null,
		html_url: null,
		published_at: null,
	});
	get("/api/webhook-ingress/status", {
		kind: "ryu-relay",
		public_url: null,
		up: false,
	});
	for (const userId of [ownerId, "share-toolbar-fixture-token"]) {
		get(`/api/notifications?user_id=${userId}&limit=50&archived=false`, {
			notifications: [],
		});
		core.set(
			`GET ${canonicalPath(new URL(`/api/notifications/stream?user_id=${userId}`, "http://owned.test"))}`,
			{ body: null, stream: true }
		);
	}
	for (const path of ["/api/events/all", "/api/runs/stream"]) {
		core.set(`GET ${path}`, { body: null, stream: true });
	}
	// The fixture has no realtime collaborator. Explicitly refuse ticket issuance
	// instead of manufacturing a working socket or silently accepting other rooms.
	core.set("POST /api/ws/ticket", {
		body: { error: "Owned fixture has no realtime peer" },
		status: 503,
	});

	get(`/api/conversations/${conversationId}/goal`, { turns: 0 });
	get(`/api/conversations/${conversationId}/participants`, {
		participants: [],
	});
	get(`/api/conversations/${conversationId}/read-receipts`, {
		receipts: [],
		users: [],
	});
	get(`/api/conversations/${conversationId}/feedback`, { feedback: {} });
	get(`/api/chat/forms?conversationId=${conversationId}`, { forms: [] });
	get(`/api/learn/exclude/${conversationId}`, {
		conversation_id: conversationId,
		excluded: false,
	});
	get("/api/cloud-environments", {
		schemaVersion: 1,
		revision: 0,
		environments: [],
		vault: [],
	});
	get(`/api/cloud-environments/task-binding/${conversationId}`, {
		cloudEnvironmentId: null,
		state: null,
	});
	core.set(`GET /api/worktree/${conversationId}/diff`, {
		body: { error: "no diff found for run", run_id: conversationId },
		status: 404,
	});
	core.set(`GET /api/chat/stream/resume/${conversationId}`, {
		body: { error: "no running turn" },
		status: 404,
	});

	const orgId = "org-share-toolbar-fixture";
	const timestamp = "2026-10-01T00:00:00.000Z";
	const organization = {
		id: orgId,
		name: "Owned ChatPage workspace",
		slug: "owned-chat-page",
		role: "owner",
		createdAt: timestamp,
		logo: null,
		isPersonal: true,
	};
	const backGet = (path: string, body: unknown) =>
		backend.set(`GET ${canonicalPath(new URL(path, "http://owned.test"))}`, {
			body,
		});
	backGet("/api/auth/get-session", {
		session: {
			id: "share-toolbar-session",
			token: "share-toolbar-fixture-token",
			userId: ownerId,
			activeOrganizationId: orgId,
			activeTeamId: null,
			createdAt: timestamp,
			updatedAt: timestamp,
			expiresAt: "2027-10-01T00:00:00.000Z",
		},
		user: {
			id: ownerId,
			name: "Jia Wei Ng",
			email: "jiawei@example.test",
			emailVerified: true,
			image: null,
			createdAt: timestamp,
			updatedAt: timestamp,
		},
	});
	backGet("/api/auth/organization/get-full-organization", {
		...organization,
		members: [
			{
				id: "owned-member",
				userId: ownerId,
				organizationId: orgId,
				role: "owner",
				createdAt: timestamp,
				user: {
					id: ownerId,
					name: "Jia Wei Ng",
					email: "jiawei@example.test",
					image: null,
				},
			},
		],
		invitations: [],
		teams: [],
	});
	backGet("/api/auth/organization/list", [organization]);
	backGet(`/api/auth/organization/list-user-teams?organizationId=${orgId}`, []);
	backGet("/api/control-plane/orgs", { organizations: [organization] });
	backGet("/api/announcements", { announcements: [] });
	backGet("/api/upsell/pitch", { cards: [] });
	backGet("/api/upsell/state", { lastUpsellShownAt: 0 });
	backend.set("GET /api/login-approvals/stream", {
		stream: true,
		body: ": keepalive\n\n",
	});
	backend.set(`GET /api/control-plane/me/permissions?orgId=${orgId}`, {
		body: {
			permissions: [
				"gateway.view",
				"gateway.configure",
				"workflow.view",
				"workflow.run",
				"workflow.edit",
				"workflow.delete",
				"space.read",
				"space.write",
				"space.delete",
				"agent.view",
				"agent.run",
				"agent.edit",
				"agent.delete",
				"channel.manage",
				"channel.delete",
				"tool.exec",
				"notifications.view",
				"notifications.manage",
				"mail.read",
				"mail.manage",
				"teams.manage",
				"projects.manage",
				"registry.manage",
				"nodes.view",
				"nodes.manage",
				"members.manage",
				"roles.manage",
				"features.manage",
				"billing.manage",
				"audit.view",
				"app.install",
				"app.update",
				"app.enable",
				"app.disable",
				"app.uninstall",
				"marketplace.view",
				"marketplace.publish",
				"marketplace.transfer",
			],
		},
		headers: { "cache-control": "private, no-store" },
	});
	backGet("/api/channels", { channels: [] });
	backGet("/api/login-approvals/pending", { requests: [] });
	backGet("/api/campaigns/mine", { claims: [], pools: [], referral: null });
	backGet("/api/billing/subscription-status", {
		zeroDataRetentionEnabled: false,
		subscription: null,
		lifetime: null,
		plan: null,
		seats: 0,
		entitlement: {
			plan: null,
			desktopAccess: false,
			marketplaceApps: false,
			managedInference: false,
			monthlyCreditPoolMicroUsd: 0,
			seats: 0,
		},
		hostedAgents: null,
		scope: "org",
		organizationId: orgId,
		features: {
			"ui.managed_inference_card": false,
			"billing.individual_plans": false,
			"waitlist.managed_nodes_only": false,
		},
		giftSubscription: null,
	});
	backGet("/api/billing/trial", { firstLaunchAt: timestamp });
	backend.set("POST /api/billing/trial", {
		body: { firstLaunchAt: timestamp },
		allowNoBody: true,
	});
	const wallet = {
		id: "share-fixture-wallet",
		ownerId: orgId,
		ownerType: "org",
		balanceMicroUsd: 0,
		grantBalanceMicroUsd: 0,
		subscriptionBalanceMicroUsd: 0,
		topupBalanceMicroUsd: 0,
		giftBalanceMicroUsd: 0,
		currency: "usd",
		updatedAt: timestamp,
	};
	backGet("/api/credits/wallet", { wallet, ledger: [] });
	backend.set("GET /api/credits/wallet/stream", {
		stream: true,
		body: `event: wallet\ndata: ${JSON.stringify({ id: wallet.id, ownerId: wallet.ownerId, balanceMicroUsd: wallet.balanceMicroUsd, currency: wallet.currency, updatedAt: wallet.updatedAt })}\n\n`,
	});
	backend.set("GET /api/credits/alert/stream", { stream: true, body: null });

	get("/api/engine/active", {
		active: null,
		running: false,
		available: ["codex"],
		llamacpp_variant: null,
	});
	get("/api/pi-config", {
		config: {
			configDir: "/tmp/owned-chat-pi",
			model: null,
			provider: "gateway",
			routing: "gateway",
			thinkingLevel: null,
		},
	});
	get("/api/pi-config/catalog", {
		apiTypes: ["openai-completions"],
		providers: [],
		thinkingLevels: [],
	});
	get("/api/agents/agent-fixture/threads", {
		engine: "codex",
		supported: true,
		threads: [],
	});
	for (const model of ["auto", "model-proof-a", "model-proof-b"]) {
		get(`/api/models/${model}/launch-config`, {});
		get(`/api/models/context-window?model=${model}`, { contextLength: null });
		get(`/api/agents/agent-fixture/capabilities?model=${model}`, {
			detected: { reasoning: false, tools: false, vision: false },
			overrides: { reasoning: null, tools: null, vision: null },
			reasoning: false,
			tools: false,
			vision: false,
			source: "default",
		});
		for (const atStart of ["true", "false"]) {
			get(
				`/api/routing/advice?agent_id=agent-fixture&model=${model}&at_conversation_start=${atStart}`,
				{
					original: { agent_id: "agent-fixture", model },
					effective: { agent_id: "agent-fixture", model },
					severity: "continue",
				}
			);
		}
	}
	// A thread pinned to the fixture agent before any model is chosen (the
	// merged agent view): the shipping composer reads the agent's capabilities
	// without a model and asks for routing advice with an empty model.
	get("/api/agents/agent-fixture/capabilities", {
		detected: { reasoning: false, tools: false, vision: false },
		overrides: { reasoning: null, tools: null, vision: null },
		reasoning: false,
		tools: false,
		vision: false,
		source: "default",
	});
	for (const atStart of ["true", "false"]) {
		get(
			`/api/routing/advice?agent_id=agent-fixture&model=&at_conversation_start=${atStart}`,
			{
				original: { agent_id: "agent-fixture", model: "" },
				effective: { agent_id: "agent-fixture", model: "" },
				severity: "continue",
			}
		);
	}
	// Exact model-default requests observed from the shipping expert-mode caller.
	const model = "gpt-5.1-codex-max";
	get(`/api/models/${model}/launch-config`, {});
	get(`/api/agents/agent-fixture/capabilities?model=${model}`, {
		detected: { reasoning: false, tools: false, vision: false },
		overrides: { reasoning: null, tools: null, vision: null },
		reasoning: false,
		tools: false,
		vision: false,
		source: "default",
	});
	get(
		`/api/routing/advice?agent_id=agent-fixture&model=${model}&at_conversation_start=true`,
		{
			original: { agent_id: "agent-fixture", model },
			effective: { agent_id: "agent-fixture", model },
			severity: "continue",
		}
	);
	return { core, backend };
}
