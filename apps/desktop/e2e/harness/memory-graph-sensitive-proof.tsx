import { createRoot } from "react-dom/client";
import { MemoryLibrary } from "../../src/components/memory/MemoryLibrary.tsx";
import { MemoryTab } from "../../src/components/settings/MemoryTab.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import type { Memory } from "../../src/lib/api/memory.ts";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import "../../src/index.css";

const memories: Memory[] = [
	{
		authorAgentId: "planner",
		category: "preference",
		content: "Alice prefers graph retrieval for project planning",
		createdAt: 1,
		id: "memory-alice-preference",
		importance: 4,
		scope: "user",
		scopeId: null,
		sensitiveTopics: [],
		tags: ["planning"],
		updatedAt: 2,
		whenToUse: "When planning work",
	},
	{
		authorAgentId: "planner",
		category: "user_fact",
		content: "Alice has a health condition and follows a religious faith",
		createdAt: 3,
		id: "memory-alice-sensitive",
		importance: 3,
		scope: "user",
		scopeId: null,
		sensitiveTopics: ["health_condition", "religious_belief"],
		tags: ["consent"],
		updatedAt: 4,
		whenToUse: "Only with sensitive-memory consent",
	},
	{
		authorAgentId: "planner",
		category: "project_context",
		content: "Planner agent collaborates with Alice on graph retrieval",
		createdAt: 5,
		id: "memory-planner-agent",
		importance: 3,
		scope: "agent",
		scopeId: "planner",
		sensitiveTopics: [],
		tags: ["agents"],
		updatedAt: 6,
		whenToUse: "When the planner agent is active",
	},
	{
		authorAgentId: "default",
		category: "project_context",
		content: "Project Apollo uses graph retrieval with Alice",
		createdAt: 7,
		id: "memory-apollo-project",
		importance: 3,
		scope: "project",
		scopeId: "apollo",
		sensitiveTopics: [],
		tags: ["apollo"],
		updatedAt: 8,
		whenToUse: "Inside Project Apollo",
	},
	{
		authorAgentId: "default",
		category: "directive",
		content: "This node shares graph retrieval conventions with Alice",
		createdAt: 9,
		id: "memory-node-conventions",
		importance: 3,
		scope: "node",
		scopeId: null,
		sensitiveTopics: [],
		tags: ["graph"],
		updatedAt: 10,
		whenToUse: "When this device needs shared conventions",
	},
];

const graph = {
	nodes: [
		{
			id: "memory:memory-alice-preference",
			kind: "memory",
			label: "Alice prefers graph retrieval for project planning",
			normalized: "aliceprefersgraphretrievalforprojectplanning",
			memory_id: "memory-alice-preference",
			scope: "user",
			agent_id: "planner",
			sensitive: false,
		},
		{
			id: "memory:memory-alice-sensitive",
			kind: "memory",
			label: "Alice has a health condition and follows a religious faith",
			normalized: "alicehashealthconditionandfollowsareligiousfaith",
			memory_id: "memory-alice-sensitive",
			scope: "user",
			agent_id: "planner",
			sensitive: true,
		},
		{
			id: "memory:memory-planner-agent",
			kind: "memory",
			label: "Planner agent collaborates with Alice on graph retrieval",
			normalized: "planneragentcollaborateswithaliceongraphretrieval",
			memory_id: "memory-planner-agent",
			scope: "agent",
			scope_id: "planner",
			agent_id: "planner",
			sensitive: false,
		},
		{
			id: "memory:memory-apollo-project",
			kind: "memory",
			label: "Project Apollo uses graph retrieval with Alice",
			normalized: "projectapollousesgraphretrievalwithalice",
			memory_id: "memory-apollo-project",
			scope: "project",
			scope_id: "apollo",
			agent_id: "default",
			sensitive: false,
		},
		{
			id: "memory:memory-node-conventions",
			kind: "memory",
			label: "This node shares graph retrieval conventions with Alice",
			normalized: "thisnodesharesgraphretrievalconventionswithalice",
			memory_id: "memory-node-conventions",
			scope: "node",
			agent_id: "default",
			sensitive: false,
		},
		{
			id: "person:alice",
			kind: "person",
			label: "Alice",
			normalized: "alice",
			sensitive: false,
		},
		{
			id: "topic:graph-retrieval",
			kind: "topic",
			label: "Graph retrieval",
			normalized: "graphretrieval",
			sensitive: false,
		},
		{
			id: "topic:planning",
			kind: "topic",
			label: "Planning",
			normalized: "planning",
			sensitive: false,
		},
		{
			id: "topic:health-condition",
			kind: "topic",
			label: "Health conditions",
			normalized: "healthcondition",
			sensitive: true,
		},
		{
			id: "topic:religious-belief",
			kind: "topic",
			label: "Religious beliefs",
			normalized: "religiousbelief",
			sensitive: true,
		},
		{
			id: "category:preference",
			kind: "category",
			label: "Preference",
			normalized: "preference",
			sensitive: false,
		},
		{
			id: "category:project-context",
			kind: "category",
			label: "Project context",
			normalized: "projectcontext",
			sensitive: false,
		},
		{
			id: "category:user-fact",
			kind: "category",
			label: "User fact",
			normalized: "userfact",
			sensitive: false,
		},
		{
			id: "category:directive",
			kind: "category",
			label: "Directive",
			normalized: "directive",
			sensitive: false,
		},
		{
			id: "scope:agent",
			kind: "scope",
			label: "Agent scope",
			normalized: "agent",
			scope: "agent",
			sensitive: false,
		},
		{
			id: "scope:user",
			kind: "scope",
			label: "User scope",
			normalized: "user",
			scope: "user",
			sensitive: false,
		},
		{
			id: "scope:project",
			kind: "scope",
			label: "Project scope",
			normalized: "project",
			scope: "project",
			scope_id: "apollo",
			sensitive: false,
		},
		{
			id: "scope:node",
			kind: "scope",
			label: "Node scope",
			normalized: "node",
			scope: "node",
			sensitive: false,
		},
		{
			id: "agent:planner",
			kind: "agent",
			label: "Agent · planner",
			normalized: "planner",
			agent_id: "planner",
			sensitive: false,
		},
	],
	edges: [
		["memory:memory-alice-preference", "person:alice", "mentions_person"],
		["memory:memory-alice-preference", "topic:graph-retrieval", "has_topic"],
		["memory:memory-alice-preference", "topic:planning", "has_topic"],
		["memory:memory-alice-preference", "category:preference", "has_category"],
		["memory:memory-alice-preference", "scope:user", "applies_to_scope"],
		["memory:memory-alice-preference", "agent:planner", "authored_by_agent"],
		["memory:memory-alice-sensitive", "person:alice", "mentions_person"],
		["memory:memory-alice-sensitive", "topic:health-condition", "has_topic"],
		["memory:memory-alice-sensitive", "topic:religious-belief", "has_topic"],
		["memory:memory-alice-sensitive", "category:user-fact", "has_category"],
		["memory:memory-alice-sensitive", "scope:user", "applies_to_scope"],
		["memory:memory-alice-sensitive", "agent:planner", "authored_by_agent"],
		["memory:memory-planner-agent", "person:alice", "mentions_person"],
		["memory:memory-planner-agent", "topic:graph-retrieval", "has_topic"],
		["memory:memory-planner-agent", "category:project-context", "has_category"],
		["memory:memory-planner-agent", "scope:agent", "applies_to_scope"],
		["memory:memory-planner-agent", "agent:planner", "authored_by_agent"],
		["memory:memory-apollo-project", "person:alice", "mentions_person"],
		["memory:memory-apollo-project", "topic:graph-retrieval", "has_topic"],
		[
			"memory:memory-apollo-project",
			"category:project-context",
			"has_category",
		],
		["memory:memory-apollo-project", "scope:project", "applies_to_scope"],
		["memory:memory-node-conventions", "person:alice", "mentions_person"],
		["memory:memory-node-conventions", "topic:graph-retrieval", "has_topic"],
		["memory:memory-node-conventions", "category:directive", "has_category"],
		["memory:memory-node-conventions", "scope:node", "applies_to_scope"],
	],
	memory_count: 5,
	truncated: false,
};

const node = {
	name: "proof",
	url: window.location.origin,
	token: null,
};

useNodeStore.setState({
	activeNodeOnline: true,
	autoSelect: false,
	autoSelectedNode: null,
	cloudNodes: [],
	defaultNode: node.name,
	dismissedCloudUrls: [],
	localNodes: [node],
	nodes: [node],
	suggestedCloudNodes: [],
	tabOverrides: {},
});

window.localStorage.setItem("ryu_long_term_memory", "true");
document.documentElement.classList.add("dark");

const response = (payload: unknown, status = 200) =>
	new Response(JSON.stringify(payload), {
		headers: { "Content-Type": "application/json" },
		status,
	});

window.fetch = async (input, init) => {
	const url = new URL(String(input), window.location.origin);
	if (
		url.pathname === "/api/memory" &&
		(!init?.method || init.method === "GET")
	) {
		return response({ memories });
	}
	if (url.pathname === "/api/memory/graph") {
		return response(graph);
	}
	if (url.pathname === "/api/memory/settings") {
		if (init?.method === "PUT") {
			const body = JSON.parse(String(init.body)) as {
				include_sensitive_topics?: boolean;
			};
			return response({
				include_sensitive_topics: body.include_sensitive_topics === true,
			});
		}
		return response({ include_sensitive_topics: true });
	}
	if (url.pathname.startsWith("/api/preferences/")) {
		return response({
			key: url.pathname.slice("/api/preferences/".length),
			value: null,
		});
	}
	if (url.pathname === "/api/spaces") {
		return response({ spaces: [] });
	}
	return response({});
};

function Story() {
	return (
		<div className="min-h-screen bg-background px-6 py-6 text-foreground">
			<div className="mx-auto max-w-7xl">
				<div className="mb-5">
					<p className="font-medium text-muted-foreground text-xs uppercase tracking-[0.18em]">
						Memory system
					</p>
					<h1 className="mt-1 font-semibold text-2xl">Typed memory graph</h1>
					<p className="mt-1 max-w-2xl text-muted-foreground text-sm">
						Separate facets for people, topics, categories, scopes, and agents,
						with sensitive topics visible only after explicit consent.
					</p>
				</div>
				<div className="grid items-start gap-5 lg:grid-cols-[minmax(300px,0.7fr)_minmax(560px,1.3fr)]">
					<section
						aria-label="Memory settings"
						className="h-[430px] overflow-hidden rounded-xl border border-border/60 bg-card/60 p-5"
					>
						<MemoryTab />
					</section>
					<section
						aria-label="Memory graph"
						className="h-[700px] overflow-hidden rounded-xl border border-border/60 bg-card/30"
					>
						<AppSurfaceProvider surface="desktop">
							<MemoryLibrary initialView="graph" />
						</AppSurfaceProvider>
					</section>
				</div>
			</div>
		</div>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
