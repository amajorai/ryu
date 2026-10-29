// This gate is shared by the mounted browser fixture and its guard regressions.
// Register only requests whose actual responses the proof implements.
export interface ChatProofHttpScope {
	backendUrl: string;
	conversationIds: readonly string[];
	coreUrl: string;
	sharingConversationId: string;
}

export interface UnexpectedChatProofRequest {
	body: string | null;
	method: string;
	url: string;
}

export function prepareChatProofRequest(
	input: RequestInfo | URL,
	init: RequestInit | undefined,
	baseUrl: string
): Request {
	return new Request(
		input instanceof Request
			? input.clone()
			: new URL(String(input), baseUrl).href,
		init
	);
}

export async function rejectUnexpectedChatProofRequest(
	request: Request,
	scope: ChatProofHttpScope,
	ledger: UnexpectedChatProofRequest[]
): Promise<Response | null> {
	const url = new URL(request.url);
	const coreOrigin = new URL(scope.coreUrl).origin;
	const backendOrigin = new URL(scope.backendUrl).origin;
	const coreReads = new Set([
		"/api/conversations",
		"/api/plugins/contributions",
		"/api/ext/com.ryu.test-tools/current-run",
		"/api/agents/agent-fixture",
		"/api/acl/principals",
		"/api/workspace/list",
		`/api/conversations/${encodeURIComponent(scope.sharingConversationId)}/access`,
		`/api/conversations/${encodeURIComponent(scope.sharingConversationId)}/history-preview`,
		...scope.conversationIds.map(
			(id) => `/api/conversations/${encodeURIComponent(id)}`
		),
		...["@ryu/drawesome", "com.ryu.test-tools"].map(
			(id) => `/api/plugins/${encodeURIComponent(id)}/ui-bundle`
		),
	]);
	const coreWrites = new Map([
		["/api/plugins/com.ryu.test-tools/host", "POST"],
		["/api/uploads", "POST"],
		["/api/chat/stream", "POST"],
		[
			`/api/conversations/${encodeURIComponent(scope.sharingConversationId)}/fork`,
			"POST",
		],
		[
			`/api/conversations/${encodeURIComponent(scope.sharingConversationId)}/access`,
			"PUT",
		],
	]);
	const coreAllowed =
		url.origin === coreOrigin &&
		((request.method === "GET" && coreReads.has(url.pathname)) ||
			coreWrites.get(url.pathname) === request.method);
	const sharePath = `/api/conversation-shares/conversation/${encodeURIComponent(scope.sharingConversationId)}`;
	// A signed-in owner's sharing dialog reads the public share link and, on
	// saving access that is not public, revokes it (`revokePublicShare`).
	const backendAllowed =
		url.origin === backendOrigin &&
		((request.method === "GET" &&
			(url.pathname === "/api/auth/token" || url.pathname === sharePath)) ||
			(request.method === "DELETE" && url.pathname === sharePath));
	if (coreAllowed || backendAllowed) {
		return null;
	}
	ledger.push({
		body: request.body === null ? null : await request.clone().text(),
		method: request.method,
		url: request.url,
	});
	return Response.json(
		{ error: "Share toolbar proof fixture: request is not implemented" },
		{ status: 503 }
	);
}
