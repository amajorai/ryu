// An in-memory local Core for tests of the loopback identity challenge.
//
// `useFakeLoopbackCore` replaces how clients open loopback connections
// (`setLoopbackConnectorForTests`) with a fake Core that answers the identity
// challenge the way Core does: with the node-token proof, or, for a
// `broker_session` lookup id, with the proof keyed by that session's stored
// hash (only for sessions it holds). Every other request gets a small broker
// reply. Each request is recorded with the connection it arrived on.

import {
	coreIdentityProof,
	setLoopbackConnectorForTests,
} from "../core-identity.ts";
import {
	brokerSessionIdentityProof,
	brokerSessionKey,
	brokerSessionLookupId,
} from "../core-identity-broker.ts";
import type {
	LoopbackConnection,
	LoopbackConnector,
} from "../loopback-connection.ts";

export interface FakeCoreRequest {
	authorization: string | null;
	body: string;
	connection: number;
	method: string;
	path: string;
	query: URLSearchParams;
	search: string;
	vaultToken: string | null;
}

export interface FakeCoreOptions {
	/** The node token this Core proves; none when omitted. */
	nodeToken?: string;
	seen: FakeCoreRequest[];
	/** Broker sessions this Core holds. */
	sessions?: string[];
}

const PROPOSAL = {
	id: "bp_1",
	environment: "dev",
	status: "pending",
	message: "need linear",
	services: [],
	credentials: [],
	requestedBy: "broker_session:bvs_1",
	createdAt: 1,
	expiresAt: 2,
};

const DISCOVERY = {
	environment: "dev",
	unmatchedHostPolicy: "deny",
	proposalsEndpoint: "/api/vault/agent/broker/proposals",
	skills: [],
	services: [],
	proxy: {
		listening: true,
		port: 9000,
		caUrl: "/api/vault/broker/ca.pem",
		portEnv: "RYU_VAULT_BROKER_PORT",
	},
};

function identityAnswer(
	options: FakeCoreOptions,
	query: URLSearchParams,
	address: string,
	port: number
): Response {
	const nonce = query.get("nonce") ?? "";
	const lookup = query.get("broker_session");
	if (lookup !== null) {
		const session = (options.sessions ?? []).find(
			(candidate) => brokerSessionLookupId(candidate) === lookup
		);
		return session
			? Response.json({
					version: 2,
					proof: brokerSessionIdentityProof(
						brokerSessionKey(session),
						address,
						port,
						nonce
					),
				})
			: new Response(null, { status: 404 });
	}
	return options.nodeToken
		? Response.json({
				version: 2,
				proof: coreIdentityProof(options.nodeToken, address, port, nonce),
			})
		: new Response(null, { status: 404 });
}

/** Install the fake Core; returns the restore function. */
export function useFakeLoopbackCore(options: FakeCoreOptions): () => void {
	let nextId = 0;
	const connector: LoopbackConnector = (address, port) => {
		nextId += 1;
		const id = nextId;
		let open = true;
		const connection: LoopbackConnection = {
			address,
			close: () => {
				open = false;
			},
			get open() {
				return open;
			},
			port,
			send: async (request, sendOptions) => {
				if (!open) {
					throw new TypeError("connection closed");
				}
				const url = new URL(request.url);
				options.seen.push({
					authorization: request.headers.get("authorization"),
					body: request.body === null ? "" : await request.text(),
					connection: id,
					method: request.method,
					path: url.pathname,
					query: url.searchParams,
					search: url.search,
					vaultToken: request.headers.get("x-ryu-vault-token"),
				});
				if (sendOptions.close) {
					open = false;
				}
				if (url.pathname === "/api/health/identity") {
					return identityAnswer(options, url.searchParams, address, port);
				}
				return Response.json(
					url.pathname.endsWith("/discover")
						? DISCOVERY
						: { proposal: PROPOSAL }
				);
			},
		};
		return Promise.resolve(connection);
	};
	setLoopbackConnectorForTests(connector);
	return () => setLoopbackConnectorForTests(null);
}
