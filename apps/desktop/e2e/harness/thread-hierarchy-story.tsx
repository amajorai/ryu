// Standalone browser story for the REAL `ThreadHierarchyBar`, the strip above a
// thread that says where it sits in Projects › Bots/Groups › Sessions.
//
// The fixture is a deep nest: a project, a bot inside it, and a chain of
// sessions that each spawned the next. That is the case the breadcrumb has to
// survive: a chain longer than four crumbs folds its middle into a menu, every
// crumb carries the run status of its thread, and a crumb with threads beside
// it opens a menu of them.
//
// Query parameters:
//   theme=light|dark   the app theme (dark by default)
//   locale=ar          the Arabic pack, which also turns the page right to left
//   depth=N            how many nested sessions the chain has (5 by default)
//   current=ID         the thread to open first (the deepest session by default)
//   tree=missing       answer the tree route with 404, as a Core that predates
//                      it does, so the Sessions list falls back to one level
//
// The node is faked at `fetch`: the story answers the hierarchy routes (the
// sessions a thread spawned, and the whole tree it sits in) from the same
// fixture the breadcrumb reads, so the bar's own client code runs unchanged
// and no Core is needed.

import { I18nProvider } from "@ryu/i18n/react";
import { I18nDirectionProvider } from "@ryu/ui/components/direction.tsx";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ThreadHierarchyBar } from "../../src/components/chat/ThreadHierarchyBar.tsx";
import type { Conversation, ThreadHierarchy } from "../../types/chat.ts";
import "../../src/index.css";

const params = new URLSearchParams(window.location.search);
const theme = params.get("theme") === "light" ? "light" : "dark";
const arabic = params.get("locale") === "ar";
const depth = Math.min(Math.max(Number(params.get("depth") ?? "5") || 5, 1), 7);
const treeMissing = params.get("tree") === "missing";

const MINUTE = 60_000;
const loadedAt = Date.now();

const SESSION_TITLES = arabic
	? [
			"مراجعة طلبات السحب المفتوحة",
			"إعادة إنتاج اختبار الرفع المتقلب",
			"تحديد سبب تراجع الرفع",
			"إصلاح حلقة إعادة المحاولة في أداة الرفع",
			"التحقق من الإصلاح على ويندوز",
			"قياس زمن الرفع بعد الإصلاح",
			"كتابة ملخص النتائج",
		]
	: [
			"Audit the open pull requests",
			"Reproduce the flaky upload test",
			"Bisect the upload regression",
			"Patch the retry loop in the uploader",
			"Verify the fix on Windows",
			"Measure upload time after the fix",
			"Write up the findings",
		];
const SESSION_STATUSES = [
	"completed",
	"completed",
	"failed",
	"running",
	"running",
	"running",
	"running",
];

function thread(
	id: string,
	title: string,
	hierarchy: Partial<ThreadHierarchy>,
	extra: Partial<Conversation> = {}
): Conversation {
	return {
		createdAt: loadedAt - 90 * MINUTE,
		hierarchy: { role: "session", ...hierarchy },
		id,
		messages: [],
		title,
		updatedAt: loadedAt - 5 * MINUTE,
		...extra,
	};
}

function fixture(): Conversation[] {
	const conversations: Conversation[] = [
		thread(
			"project",
			"Atlas",
			{
				ownerId: "atlas",
				ownerKind: "project",
				projectId: "atlas",
				role: "main",
			},
			{ runStatus: "completed" }
		),
		thread(
			"scout",
			"Scout · Atlas",
			{
				ownerId: "scout",
				ownerKind: "agent",
				projectId: "atlas",
				role: "main",
			},
			{ agentId: "scout", runStatus: "running" }
		),
		thread(
			"quill",
			"Quill · Atlas",
			{
				ownerId: "quill",
				ownerKind: "agent",
				projectId: "atlas",
				role: "main",
			},
			{ agentId: "quill" }
		),
		thread(
			"triage",
			arabic ? "فرز البلاغات الجديدة" : "Triage new issues",
			{ projectId: "atlas", spawnedByConversationId: "scout" },
			{ agentId: "scout", runStatus: "interrupted" }
		),
	];
	let parent = "scout";
	for (let index = 0; index < depth; index += 1) {
		const id = `session-${index + 1}`;
		conversations.push(
			thread(
				id,
				SESSION_TITLES[index] ?? id,
				{ projectId: "atlas", spawnedByConversationId: parent },
				{
					agentId: "scout",
					createdAt: loadedAt - (80 - index * 10) * MINUTE,
					runStatus: SESSION_STATUSES[index],
					updatedAt: loadedAt - (6 - index) * MINUTE,
				}
			)
		);
		parent = id;
	}
	// Three threads beside the deepest session, so its crumb has a menu.
	const deepestParent =
		conversations.at(-1)?.hierarchy?.spawnedByConversationId ?? "scout";
	const beside: [string, string, string, number][] = arabic
		? [
				["changelog", "كتابة سجل التغييرات", "completed", 30],
				["docs", "تحديث صفحة توثيق الرفع", "awaiting_input", 20],
				["macos", "فحص نسخة ماك", "failed", 10],
			]
		: [
				["changelog", "Write the changelog entry", "completed", 30],
				["docs", "Update the upload docs page", "awaiting_input", 20],
				["macos", "Check the macOS build", "failed", 10],
			];
	for (const [id, title, runStatus, age] of beside) {
		conversations.push(
			thread(
				id,
				title,
				{ projectId: "atlas", spawnedByConversationId: deepestParent },
				{
					agentId: "quill",
					createdAt: loadedAt - (age + 25) * MINUTE,
					runStatus,
					updatedAt: loadedAt - age * MINUTE,
				}
			)
		);
	}
	return conversations;
}

const conversations = fixture();
const AGENT_NAMES: Record<string, string> = { quill: "Quill", scout: "Scout" };
const agentName = (id: string) => AGENT_NAMES[id];

/** The wire shape Core's hierarchy routes use for one conversation row. */
function wireRow(conversation: Conversation) {
	return {
		agent_id: conversation.agentId ?? null,
		created_at: conversation.createdAt,
		id: conversation.id,
		message_count: 4,
		project_id: conversation.hierarchy?.projectId,
		run_status: conversation.runStatus ?? null,
		spawned_by_conversation_id: conversation.hierarchy?.spawnedByConversationId,
		thread_role: conversation.hierarchy?.role ?? "session",
		title: conversation.title,
		updated_at: conversation.updatedAt,
	};
}

/** The sessions a thread spawned, newest activity first, as Core lists them. */
function spawnedBy(id: string): Conversation[] {
	return conversations
		.filter((item) => item.hierarchy?.spawnedByConversationId === id)
		.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** What Core's tree route answers: the top of the chain and all below it. */
function treeOf(id: string) {
	const byId = new Map(conversations.map((item) => [item.id, item]));
	let root = byId.get(id);
	for (let hops = 0; root && hops < conversations.length; hops += 1) {
		const parent = byId.get(root.hierarchy?.spawnedByConversationId ?? "");
		if (!parent) {
			break;
		}
		root = parent;
	}
	if (!root) {
		return { nodes: [], truncated: false };
	}
	const nodes: {
		conversation: ReturnType<typeof wireRow>;
		parent_id: string | null;
	}[] = [{ conversation: wireRow(root), parent_id: null }];
	// The list grows while it is read, so every level is visited in turn.
	for (const node of nodes) {
		for (const child of spawnedBy(node.conversation.id)) {
			nodes.push({
				conversation: wireRow(child),
				parent_id: node.conversation.id,
			});
		}
	}
	return { nodes, truncated: false };
}

const HIERARCHY_ROUTE = /^\/api\/hierarchy\/threads\/([^/]+)\/(sessions|tree)$/;
const nodeFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
	let href: string;
	if (typeof input === "string") {
		href = input;
	} else if (input instanceof URL) {
		href = input.href;
	} else {
		href = input.url;
	}
	const match = HIERARCHY_ROUTE.exec(
		new URL(href, window.location.href).pathname
	);
	if (!match) {
		return nodeFetch(input, init);
	}
	const id = decodeURIComponent(match[1] ?? "");
	if (match[2] === "tree") {
		return Promise.resolve(
			treeMissing
				? Response.json({ error: "not found" }, { status: 404 })
				: Response.json(treeOf(id))
		);
	}
	return Promise.resolve(
		Response.json({ sessions: spawnedBy(id).map(wireRow) })
	);
};

function Story() {
	const [currentId, setCurrentId] = useState(
		params.get("current") ?? `session-${depth}`
	);
	const current =
		conversations.find((item) => item.id === currentId) ?? conversations[0];
	if (!current) {
		return null;
	}
	return (
		<main className="min-h-screen bg-background text-foreground">
			<div className="border-border border-b">
				<ThreadHierarchyBar
					agentName={agentName}
					conversation={current}
					conversations={conversations}
					onOpenConversation={setCurrentId}
					target={{ token: null, url: window.location.origin }}
				/>
			</div>
			<p className="px-6 py-4 text-muted-foreground text-sm">
				Open thread:{" "}
				<span data-ryu-i18n="off" data-testid="current-thread">
					{current.id}
				</span>
			</p>
		</main>
	);
}

document.documentElement.classList.toggle("dark", theme === "dark");
const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<I18nProvider initialPackId={arabic ? "official/ar" : undefined}>
			{/* As in the app (LanguagePackBridge), popovers take their reading
			    direction from the language pack. */}
			<I18nDirectionProvider>
				<Story />
			</I18nDirectionProvider>
		</I18nProvider>
	);
}
