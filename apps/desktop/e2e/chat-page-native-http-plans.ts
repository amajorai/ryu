// Finite Artifacts Space service. Identity includes the delegated user JWT;
// a document belonging to another account is absent and cannot be overwritten.
export const PLAN_TITLE = "Plan — Account-scoped launch plan · 73b94db5";
export const PLAN_MARKDOWN =
	"# Account-scoped launch plan\n\nKeep the saved page private to this account.\n\n<!-- ryu-plan-key: saved-plan-message:1:saved-plan-call -->\n";
export const PLAN_MESSAGES = [
	{
		id: "saved-plan-message",
		role: "assistant",
		content: "A completed launch plan is ready.",
		created_at: 1724000010000,
		parts: [
			{ type: "text", text: "A completed launch plan is ready." },
			{
				type: "tool-PlanWrite",
				state: "output-available",
				toolCallId: "saved-plan-call",
				output: { ok: true },
				input: {
					plan: {
						title: "Account-scoped launch plan",
						summary: "Keep the saved page private to this account.",
					},
				},
			},
		],
	},
];
export function createPlanDocumentsFixture() {
	const documents = new Map<
		string,
		{ id: string; title: string; source: string }
	>();
	const key = (node: string, jwt: string | null) => JSON.stringify([node, jwt]);
	return {
		reset: () => documents.clear(),
		snapshot: () => Object.fromEntries(documents),
		matches: (method: string, path: string) =>
			(method === "GET" && path === "/api/spaces") ||
			(["GET", "POST"].includes(method) &&
				path === "/api/spaces/artifacts-owned/documents") ||
			(method === "GET" &&
				/^\/api\/spaces\/artifacts-owned\/documents\/owned-plan-[12]$/.test(
					path
				)),
		handle(
			node: string,
			jwt: string | null,
			method: string,
			path: string,
			body: unknown
		): { body: unknown; status: number } {
			const identity = key(node, jwt),
				document = documents.get(identity);
			if (path === "/api/spaces")
				return {
					body: {
						spaces: [
							{
								id: "artifacts-owned",
								name: "Artifacts",
								created_at: 1,
								updated_at: 1,
								document_count: document ? 1 : 0,
								system: true,
								retrieval_mode: "vector",
								visibility: "private",
							},
						],
					},
					status: 200,
				};
			if (method === "POST") {
				if (
					JSON.stringify(body) !==
					JSON.stringify({ title: PLAN_TITLE, content: PLAN_MARKDOWN })
				)
					return {
						body: { error: "Unexpected exact plan document payload" },
						status: 400,
					};
				if (document)
					return { body: { error: "Duplicate plan ingest" }, status: 409 };
				const id = jwt === "plan-user-b" ? "owned-plan-2" : "owned-plan-1";
				documents.set(identity, {
					id,
					title: PLAN_TITLE,
					source: PLAN_MARKDOWN,
				});
				return { body: { document_id: id }, status: 200 };
			}
			const wire = document
				? {
						...document,
						space_id: "artifacts-owned",
						kind: "page",
						chunk_count: 1,
						created_at: 1,
						updated_at: 1,
					}
				: null;
			if (path.endsWith("/documents"))
				return { body: { documents: wire ? [wire] : [] }, status: 200 };
			return wire && path.endsWith("/" + wire.id)
				? { body: wire, status: 200 }
				: {
						body: { error: "Document not visible to this account" },
						status: 404,
					};
		},
	};
}
