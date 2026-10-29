declare const window: Window;

import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { GitHistoryDialog } from "../../src/components/chat/GitHistoryDialog.tsx";
import { ShareConversationDialog } from "../../src/components/chat/ShareConversationDialog.tsx";
import type {
	ConversationAccess,
	PublicShareStatus,
	PublicSnapshotMessage,
} from "../../src/lib/api/conversation-sharing.ts";
import { type ProofJsonRecord, parseProofJson } from "../fixture-json.ts";
import "../../src/index.css";

const json = <FixturePayload,>(body: FixturePayload, status = 200) =>
	new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status,
	});

const readOnlyStory = new URLSearchParams(globalThis.location.search).has(
	"readonly"
);
const params = new URLSearchParams(globalThis.location.search);
const sensitiveStory = params.has("sensitive");
let failAccessReads = params.get("loadfail") === "once" ? 1 : 0;
let failAccessWrites = params.get("savefail") === "once" ? 1 : 0;
let failPublicWrites = params.get("publishfail") === "once" ? 1 : 0;
let failHistoryPreviewReads = params.get("previewfail") === "once" ? 1 : 0;

interface ApiCall {
	body: unknown;
	method: string;
	path: string;
}

const apiCalls: ApiCall[] = [];
const transcript: PublicSnapshotMessage[] = [
	{
		content: sensitiveStory
			? "Can we share Project Cobalt with ava@example.com? password='hunter2'"
			: "Can we share this rollout plan?",
		created_at: 1_724_000_000_000,
		id: "message-1",
		role: "user",
	},
	{
		content:
			"Yes — I’ve separated the public milestones from the internal notes.",
		created_at: 1_724_000_010_000,
		id: "message-2",
		role: "assistant",
	},
];
const redactedTranscript = transcript.map((message) => ({
	...message,
	content: message.content
		.replace("ava@example.com", "[REDACTED:EMAIL]")
		.replace("password='hunter2'", "[REDACTED:CREDENTIAL]"),
}));
const checkpointId = "a".repeat(64);
const codeCommit = "b".repeat(40);
const restoreCheckpointId = sensitiveStory ? "d".repeat(64) : checkpointId;
let historyFetched = !params.has("restore-empty");
const portableTranscript = {
	format: "ryu-portable-conversation",
	version: 1,
	sourceId: "c".repeat(64),
	title: "Launch readiness and rollout plan",
	agentId: null,
	createdAt: "2024-08-19T00:00:00.000Z",
	updatedAt: "2024-08-19T00:00:00.000Z",
	codeCommit,
	branch: "main",
	messages: redactedTranscript.map((message) => ({
		id: message.id,
		role: message.role,
		content: message.content,
		agentId: null,
		createdAt: new Date(message.created_at).toISOString(),
	})),
	omittedStructuredParts: 0,
	redactionPolicy: "locked-sensitive-v1",
};
const restoredTranscript = {
	...portableTranscript,
	messages: portableTranscript.messages.map((message) => ({
		...message,
		content: sensitiveStory
			? message.content.replace("Project Cobalt", "[REDACTED:CUSTOM]")
			: message.content,
	})),
};

let accessState: ProofJsonRecord = {
	can_manage: !readOnlyStory,
	collaborators: [
		{
			role: "viewer",
			user_id: readOnlyStory ? "user-owner" : "user-noor",
		},
	],
	owner_user_id: readOnlyStory ? "user-mira" : "user-owner",
	team_id: null,
	visibility: "private",
} satisfies ConversationAccess;

let publicShare: PublicShareStatus | null =
	params.get("visibility") === "private" || readOnlyStory
		? null
		: {
				created_at: 1_724_000_020_000,
				updated_at: 1_724_000_030_000,
				url: "https://ryu.test/share/story-token",
			};

function parseBody(init?: RequestInit) {
	if (!isNativeText(init?.body)) {
		return null;
	}
	try {
		return parseProofJson(init.body);
	} catch {
		return init.body;
	}
}

function trackCall(path: string, init?: RequestInit) {
	apiCalls.push({
		body: parseBody(init),
		method: init?.method ?? "GET",
		path,
	});
	const calls = document.getElementById("share-calls");
	if (calls) {
		calls.textContent = JSON.stringify(apiCalls);
	}
}

function record(value: string) {
	const output = document.getElementById("share-result");
	if (output) {
		output.textContent = value;
	}
}

window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = input instanceof Request ? input.url : String(input);
	if (url.endsWith("/api/auth/token")) {
		return json({}, 401);
	}
	const requestUrl = new URL(url, "http://core.test");
	const { pathname } = requestUrl;
	const method = init?.method ?? "GET";
	trackCall(pathname, init);
	if (pathname.endsWith("/api/conversations/conversation-1/access")) {
		if (method === "GET" && failAccessReads > 0) {
			failAccessReads -= 1;
			return json({ message: "Fixture access read failed." }, 503);
		}
		if (init?.method === "PUT") {
			if (failAccessWrites > 0) {
				failAccessWrites -= 1;
				return json({ message: "Fixture access save failed." }, 503);
			}
			const body = parseBody(init);
			// SAFETY: This immediate native object-spread operand retains JavaScript
			// boxing/nullish handling and own-key traversal of the captured JSON or
			// raw-text fallback. It claims no business fields or stable object value.
			accessState = { ...accessState, ...(body as object) };
			record(`saved:${JSON.stringify(body)}`);
			return json({ ok: true, ...accessState });
		}
		return json(accessState);
	}
	if (pathname.endsWith("/api/acl/principals")) {
		return json({
			members: [
				{ email: "jiawei@example.com", id: "user-owner", name: "Jia Wei Ng" },
				{ email: "noor@example.com", id: "user-noor", name: "Noor Aziz" },
				{ email: "mira@example.com", id: "user-mira", name: "Mira Chen" },
			],
			org_id: "org-ryu",
			teams: [
				{ id: "team-product", name: "Product" },
				{ id: "team-research", name: "Research" },
			],
		});
	}
	if (pathname.endsWith("/api/conversations/conversation-1/history-preview")) {
		if (failHistoryPreviewReads > 0) {
			failHistoryPreviewReads -= 1;
			return json({ message: "Fixture privacy preview failed." }, 503);
		}
		// SAFETY: The mounted privacy preview publishes its native input split/trimmed string terms through getHistoryPreview {extraRedactions}; this controlled POST decodes that actual serializer, not arbitrary JSON arrays.
		const extraRedactions =
			(method === "POST"
				? (parseBody(init) as { extraRedactions?: string[] })?.extraRedactions
				: undefined) ?? [];
		const customTranscript = {
			...portableTranscript,
			messages: portableTranscript.messages.map((message) => ({
				...message,
				content: extraRedactions.reduce(
					(content, term) => content.replaceAll(term, "[REDACTED:CUSTOM]"),
					message.content
				),
			})),
		};
		return json({
			checkpointId: extraRedactions.length ? "d".repeat(64) : checkpointId,
			redactions: {
				pii: sensitiveStory ? 1 : 0,
				secrets: sensitiveStory ? 1 : 0,
				custom: extraRedactions.length,
			},
			repoAvailable: true,
			repoError: null,
			repoRoot: "/tmp/ryu-history-project",
			transcript: customTranscript,
		});
	}
	if (
		pathname.endsWith("/api/conversations/conversation-1/git-history") &&
		method === "POST"
	) {
		// SAFETY: Native saveGitHistory copies checkpointId from the historyPreviewSchema-parsed preview into expectedCheckpointId; the mounted save action serializes that checked string to this controlled route.
		const body = parseBody(init) as { expectedCheckpointId: string };
		record("git-saved");
		return json({
			checkpoint: {
				checkpointId: body.expectedCheckpointId,
				checkpointRef: `refs/ryu/checkpoints/${body.expectedCheckpointId}`,
				codeCommit,
				alreadySaved: false,
			},
			redactions: {
				pii: sensitiveStory ? 1 : 0,
				secrets: sensitiveStory ? 1 : 0,
				custom: 0,
			},
		});
	}
	if (pathname.endsWith("/api/git/history/sync")) {
		// SAFETY: Native GitHistoryDialog calls syncGitHistory with literal fetch and ShareConversationDialog with literal push; the actual API serializer forwards that action to this controlled sync route.
		const action = (parseBody(init) as { action: "fetch" | "push" }).action;
		if (action === "fetch") {
			historyFetched = true;
			record("history-fetched");
		} else {
			record("history-pushed");
		}
		return json({ ok: true, action });
	}
	if (pathname.endsWith("/api/git/history") && method === "GET") {
		return json({
			entries: historyFetched
				? [
						{
							format: "ryu-portable-conversation",
							version: 1,
							checkpointId: restoreCheckpointId,
							sourceId: portableTranscript.sourceId,
							title: portableTranscript.title,
							codeCommit,
							branch: "main",
							messageCount: restoredTranscript.messages.length,
							redactions: {
								pii: sensitiveStory ? 1 : 0,
								secrets: sensitiveStory ? 1 : 0,
							},
							updatedAt: portableTranscript.updatedAt,
						},
					]
				: [],
			skipped: 0,
		});
	}
	if (pathname.endsWith(`/api/git/history/${restoreCheckpointId}`)) {
		return json({ transcript: restoredTranscript });
	}
	if (pathname.endsWith("/api/git/history/import") && method === "POST") {
		record("history-imported");
		return json({
			conversationId: "git-restored-conversation",
			messagesAdded: restoredTranscript.messages.length,
			checkpointId: restoreCheckpointId,
		});
	}
	if (pathname.endsWith("/api/conversations/conversation-1")) {
		return json({
			messages: transcript,
		});
	}
	if (
		pathname.endsWith("/api/conversation-shares/conversation/conversation-1")
	) {
		if (method === "PUT") {
			if (failPublicWrites > 0) {
				failPublicWrites -= 1;
				return json({ message: "Fixture public copy update failed." }, 503);
			}
			parseBody(init);
			publicShare = {
				created_at: publicShare?.created_at ?? 1_724_000_020_000,
				updated_at: (publicShare?.updated_at ?? 1_724_000_020_000) + 1,
				url: "https://ryu.test/share/story-token",
			};
			record("published");
		}
		if (method === "DELETE") {
			publicShare = null;
			record("revoked");
			return json({ ok: true });
		}
		return json({ share: publicShare });
	}
	return json({ error: `Unhandled story request: ${url}` }, 404);
};

function Story() {
	const [open, setOpen] = useState(true);
	return (
		<div className="min-h-screen bg-muted/40 p-8">
			<button
				className="mb-5 rounded-md border bg-background px-3 py-2 text-sm"
				onClick={() => setOpen(true)}
				type="button"
			>
				Open sharing
			</button>
			<div className="mx-auto max-w-3xl rounded-2xl border bg-background p-8 shadow-sm">
				<p className="text-muted-foreground text-xs">Ryu · Release planning</p>
				<h1 className="mt-2 font-semibold text-xl">
					Launch readiness and rollout plan
				</h1>
				<div className="mt-8 space-y-4 opacity-45">
					<div className="ml-auto h-16 w-2/3 rounded-2xl bg-muted" />
					<div className="h-28 w-4/5 rounded-2xl border" />
				</div>
			</div>
			<pre className="sr-only" data-testid="share-result" id="share-result" />
			<pre className="sr-only" data-testid="share-calls" id="share-calls">
				[]
			</pre>
			{params.has("restore") || params.has("restore-empty") ? (
				<GitHistoryDialog
					cwd="/tmp/ryu-history-project"
					onImported={(conversationId) => record(`restored:${conversationId}`)}
					onOpenChange={setOpen}
					open={open}
					target={{ token: "node-token", url: "http://core.test" }}
				/>
			) : (
				<ShareConversationDialog
					conversationId="conversation-1"
					onOpenChange={setOpen}
					open={open}
					target={{ token: "node-token", url: "http://core.test" }}
					title="Launch readiness and rollout plan"
				/>
			)}
			<Toaster position="bottom-right" theme="dark" />
		</div>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
