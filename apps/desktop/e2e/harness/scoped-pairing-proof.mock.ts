import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";

interface PairingConstraints {
	org_id?: string;
	plugin_id?: string;
	team_id?: string;
	tool_name?: string;
}

interface PendingRequest {
	client_name: string;
	created_at: number;
	requested_constraints: PairingConstraints;
	requested_expires_at: number;
	requested_scopes: string[];
	user_code: string;
}

interface PairedClient {
	active?: boolean;
	constraints?: PairingConstraints;
	created_at: number;
	expires_at?: number | null;
	granted_scopes: string[];
	id: string;
	last_seen: number;
	name: string;
	revoked_at?: number | null;
	schema_version: number;
}

interface ProofApproval {
	granted_scopes: string[];
	user_code: string;
}

interface RequestOptions {
	body?: unknown;
	method?: string;
}

interface RequestTarget {
	token: string | null;
	url: string;
	userJwt: string | null;
}

export type ApiTarget = RequestTarget;

interface CapturedRequest {
	body: unknown;
	method: string;
	path: string;
	status: number | null;
	target: RequestTarget;
}

const NOW_SECONDS = Math.floor(Date.now() / 1000);
const OWNER_TOKEN = "owner-proof-token";
const ROTATED_OWNER_TOKEN = "rotated-owner-proof-token";
const BROWSER_TOKEN = "browser-paired-proof-token";
const REQUEST_CODE = "J7K-PQM";
const BROWSER_PAIR_CODE = "N4H-RQX";
const requestFailures = new Map<string, number>();
let currentOwnerToken = OWNER_TOKEN;
const tokenSource =
	new URLSearchParams(window.location.search).get("source") === "env"
		? "env"
		: "file";
let resolveBrowserPair: ((approved: boolean) => void) | null = null;
let nextHeldRequestKey: string | null = null;
let resolveHeldRequest: ((failed: boolean) => void) | null = null;

if (
	new URLSearchParams(window.location.search).get("failPendingRead") === "1"
) {
	requestFailures.set("GET /api/pair/requests", 1);
}

let pending: PendingRequest[] = [
	{
		client_name: "Research browser",
		created_at: NOW_SECONDS - 60,
		requested_constraints: {
			org_id: "org-proof",
			plugin_id: "com.ryu.search",
			team_id: "team-proof",
			tool_name: "search",
		},
		requested_expires_at: NOW_SECONDS + 86_400,
		requested_scopes: ["chat:read", "chat:write", "tools:read"],
		user_code: REQUEST_CODE,
	},
];

let clients: PairedClient[] = [
	{
		constraints: { org_id: "org-proof", plugin_id: "com.ryu.vscode" },
		created_at: NOW_SECONDS - 7200,
		expires_at: NOW_SECONDS + 172_800,
		granted_scopes: ["tools:read", "gateway:route"],
		id: "client-vscode",
		last_seen: NOW_SECONDS - 15,
		name: "VS Code MCP",
		revoked_at: null,
		schema_version: 2,
	},
	{
		constraints: { org_id: "org-proof" },
		created_at: NOW_SECONDS - 172_800,
		expires_at: NOW_SECONDS - 30,
		granted_scopes: ["chat:read"],
		id: "client-ci",
		last_seen: NOW_SECONDS - 7200,
		name: "Expired CI runner",
		revoked_at: null,
		schema_version: 2,
	},
	{
		active: false,
		constraints: { team_id: "team-proof" },
		created_at: NOW_SECONDS - 3600,
		expires_at: NOW_SECONDS + 172_800,
		granted_scopes: ["chat:read"],
		id: "client-idle",
		last_seen: NOW_SECONDS - 1800,
		name: "Inactive tablet",
		revoked_at: null,
		schema_version: 2,
	},
	{
		constraints: { org_id: "org-proof" },
		created_at: NOW_SECONDS - 200_000,
		expires_at: null,
		granted_scopes: ["files:read"],
		id: "client-old",
		last_seen: NOW_SECONDS - 190_000,
		name: "Revoked browser",
		revoked_at: NOW_SECONDS - 180_000,
		schema_version: 2,
	},
];

function clone<T>(value: T): T {
	return structuredClone(value);
}

function assertOwner(target: RequestTarget): void {
	if (
		target.url !== "http://proof.local" ||
		(target.token !== OWNER_TOKEN && target.token !== BROWSER_TOKEN)
	) {
		throw new Error("pairing proof did not use the active owner target");
	}
}

interface ScopedPairingCapturedState {
	browserPairName: string | null;
	failNextRequest(method: string, path: string): void;
	holdNextRequest(method: string, path: string): void;
	lastApproval: ProofApproval | null;
	lastDeniedUserCode: string | null;
	lastRevokedClientId: string | null;
	requests: CapturedRequest[];
	resolveBrowserPairing(approved: boolean): void;
	resolveHeldRequest(failed: boolean): void;
	rotationCount: number;
}

const proofState: ScopedPairingCapturedState = {
	browserPairName: null,
	failNextRequest(method: string, path: string) {
		const key = `${method.toUpperCase()} ${path}`;
		requestFailures.set(key, (requestFailures.get(key) ?? 0) + 1);
	},
	holdNextRequest(method: string, path: string) {
		nextHeldRequestKey = `${method.toUpperCase()} ${path}`;
	},
	lastApproval: null,
	lastDeniedUserCode: null,
	lastRevokedClientId: null,
	requests: [],
	rotationCount: 0,
	resolveBrowserPairing(approved: boolean) {
		if (!resolveBrowserPair) {
			throw new Error("no browser pairing request is pending");
		}
		const resolve = resolveBrowserPair;
		resolveBrowserPair = null;
		resolve(approved);
	},
	resolveHeldRequest(failed: boolean) {
		if (!resolveHeldRequest) {
			throw new Error("no local API request is being held");
		}
		const resolve = resolveHeldRequest;
		resolveHeldRequest = null;
		resolve(failed);
	},
};

export type ScopedPairingProofPublisher = typeof proofState;

Object.defineProperty(window, "__SCOPED_PAIRING_PROOF__", {
	configurable: true,
	value: proofState,
});

export function useActiveNode() {
	return {
		id: "proof-node",
		name: "Secure workstation",
		token:
			window.localStorage.getItem("scoped-pairing-proof-browser-token") ??
			OWNER_TOKEN,
		url: "http://proof.local",
		// A local workstation carries no managed-node delegation, the same as
		// the real store's Node for a non-managed node.
		userJwt: null as string | null,
	};
}

export async function invoke(
	command: string,
	args?: { name?: string; onCode?: (code: string) => void }
): Promise<{ source: "env" | "file"; token: string } | boolean> {
	if (command === "local_node_token") {
		// SAFETY: The scoped Vite alias supplies NodeAccessSettings local_node_token, whose actual invocation requests source and nullable token; both fields are authored here. This fixture bridge retains the SDK generic ABI, not a decoder for arbitrary T.
		return { source: tokenSource, token: currentOwnerToken };
	}
	if (command === "pair_local_node") {
		const name = args?.name;
		proofState.browserPairName = isNativeText(name) ? name : null;
		args?.onCode?.(BROWSER_PAIR_CODE);
		// SAFETY: NodeAccessSettings invokes pair_local_node<boolean>; this actual native Promise resolves only the approved boolean. The cast bridges the preserved generic invoke ABI for that controlled command.
		return await new Promise<boolean>((resolve) => {
			resolveBrowserPair = (approved) => {
				if (approved) {
					window.localStorage.setItem(
						"scoped-pairing-proof-browser-token",
						BROWSER_TOKEN
					);
				}
				resolve(approved);
			};
		});
	}
	throw new Error(`unexpected Tauri command: ${command}`);
}

export async function request<T>(
	target: RequestTarget,
	path: string,
	options: RequestOptions = {}
): Promise<T> {
	assertOwner(target);
	const method = options.method?.toUpperCase() ?? "GET";
	const captured: CapturedRequest = {
		body: options.body === undefined ? null : clone(options.body),
		method,
		path,
		status: null,
		target: clone(target),
	};
	proofState.requests.push(captured);
	const failureKey = `${method} ${path}`;
	const failures = requestFailures.get(failureKey) ?? 0;
	if (failures > 0) {
		requestFailures.set(failureKey, failures - 1);
		captured.status = 503;
		throw new Error(`fixture unavailable for ${failureKey}`);
	}
	if (nextHeldRequestKey === failureKey) {
		nextHeldRequestKey = null;
		await new Promise<void>((resolve, reject) => {
			resolveHeldRequest = (failed) => {
				if (failed) {
					captured.status = 503;
					reject(new Error(`fixture unavailable for ${failureKey}`));
					return;
				}
				resolve();
			};
		});
	}
	if (method === "GET" && path === "/api/pair/requests") {
		captured.status = 200;
		// SAFETY: NodeAccessSettings requests the requests envelope on this exact GET path. The local typed PendingRequest array and native structuredClone author the complete fixture envelope; no external response is decoded.
		return clone({ requests: pending }) as T;
	}
	if (method === "GET" && path === "/api/pair/clients") {
		captured.status = 200;
		// SAFETY: NodeAccessSettings requests the clients envelope on this exact GET path. The local typed PairedClient array and native structuredClone author the complete fixture envelope; no external response is decoded.
		return clone({ clients }) as T;
	}
	if (method === "POST" && path === "/api/pair/approve") {
		// SAFETY: The mounted NodeAccessSettings decide branch authors granted_scopes plus user_code. The fixture immediately requires the complete serialized expected approval before reading these fields; this view does not validate arbitrary external bodies.
		const approval = options.body as ProofApproval;
		const expected: ProofApproval = {
			granted_scopes: ["chat:read", "tools:read"],
			user_code: REQUEST_CODE,
		};
		if (JSON.stringify(approval) !== JSON.stringify(expected)) {
			throw new Error(
				`unexpected narrowed approval: ${JSON.stringify(approval)}`
			);
		}
		const approved = pending.find(
			(item) => item.user_code === approval.user_code
		);
		if (!approved) {
			throw new Error("pending request was already consumed");
		}
		proofState.lastApproval = clone(approval);
		pending = pending.filter((item) => item.user_code !== approval.user_code);
		clients = [
			{
				constraints: clone(approved.requested_constraints),
				created_at: approved.created_at,
				expires_at: approved.requested_expires_at,
				granted_scopes: clone(approval.granted_scopes),
				id: "client-research",
				last_seen: NOW_SECONDS,
				name: approved.client_name,
				revoked_at: null,
				schema_version: 2,
			},
			...clients,
		];
		captured.status = 200;
		// SAFETY: The actual NodeAccessSettings approval caller awaits and ignores the result; this controlled route authors its complete success acknowledgement while preserving request generic ABI.
		return { approved: true } as T;
	}
	if (method === "POST" && path === "/api/pair/deny") {
		// SAFETY: The mounted NodeAccessSettings denial branch authors user_code; the following native key-count, primitive-string observation and pending membership checks admit the field before use. The field remains unknown until those checks.
		const body = options.body as { user_code?: unknown };
		if (
			Object.keys(body ?? {}).length !== 1 ||
			!isNativeText(body?.user_code) ||
			!pending.some((item) => item.user_code === body.user_code)
		) {
			throw new Error(
				`unexpected pairing denial: ${JSON.stringify(options.body)}`
			);
		}
		proofState.lastDeniedUserCode = body.user_code;
		pending = pending.filter((item) => item.user_code !== body.user_code);
		captured.status = 200;
		// SAFETY: The actual NodeAccessSettings denial caller awaits and ignores the result; this controlled route authors its complete success acknowledgement while preserving request generic ABI.
		return { denied: true } as T;
	}
	if (method === "DELETE" && path.startsWith("/api/pair/clients/")) {
		const clientId = decodeURIComponent(
			path.slice("/api/pair/clients/".length)
		);
		const client = clients.find((item) => item.id === clientId);
		if (!client) {
			throw new Error(`unknown client: ${clientId}`);
		}
		client.revoked_at = NOW_SECONDS;
		proofState.lastRevokedClientId = clientId;
		captured.status = 200;
		// SAFETY: The actual NodeAccessSettings revoke caller awaits and ignores the result; this controlled route authors its complete success acknowledgement while preserving request generic ABI.
		return { revoked: true } as T;
	}
	if (method === "POST" && path === "/api/node/token/rotate") {
		currentOwnerToken = ROTATED_OWNER_TOKEN;
		proofState.rotationCount += 1;
		captured.status = 200;
		// SAFETY: NodeAccessSettings rotate requests message and restart_required; this route authors the complete string/boolean result. The cast bridges only the controlled request generic ABI, not arbitrary T.
		return {
			message: "The local node token changed in the fixture.",
			restart_required: true,
		} as T;
	}
	captured.status = 404;
	throw new Error(`unexpected pairing request: ${method} ${path}`);
}
