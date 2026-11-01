/**
 * Shared fixtures for the Sites client tests: a recording fetch stub, a Site
 * record, the Sites error envelope and an in-memory Sites management server.
 */
import { isRyuError, type RyuError } from "../errors.ts";
import { Ryu } from "../ryu.ts";

export interface Recorded {
	body: string | null;
	headers: Headers;
	method: string;
	url: string;
}

export type Respond = (request: Recorded) => Response | Promise<Response>;

export function stubFetch(respond: Respond) {
	const calls: Recorded[] = [];
	const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const body = init?.body;
		const recorded: Recorded = {
			body: typeof body === "string" ? body : null,
			headers: new Headers(init?.headers),
			method: init?.method ?? "GET",
			url: String(input),
		};
		calls.push(recorded);
		return await respond(recorded);
	};
	return { calls, fetch };
}

export const BASE = "http://127.0.0.1:8021";
export const KEY = "sites-management-token-0123456789abcdef";
export const ENV = { RYU_SITES_API_KEY: KEY, RYU_SITES_URL: BASE };
export const SITE_ID = "site_0123456789";
export const NOW = "2026-10-21T12:00:00.000Z";
export const HTML = "<!doctype html><title>Launch</title><h1>Launch</h1>";

export function version(id: string) {
	return {
		bytes: HTML.length,
		commit: null,
		createdAt: NOW,
		extensions: { mcp: false },
		id,
		message: "first",
	};
}

/** Every setting, as the Sites satellite stores a new Site's (its `siteSettings` defaults). */
export const SETTINGS = {
	mode: "local",
	audience: "private",
	workspaceId: null,
	viewers: [],
	editors: [],
	optionalSignIn: false,
	agentActions: false,
	ai: false,
	aiDailyLimit: 100,
	aiMode: "grounded",
	aiAnonymous: false,
	aiSystemPrompt: "Answer briefly.",
	storage: false,
	uploads: false,
	spaceId: null,
	database: { databaseId: "db_1", spaceId: "space_1" },
	sharedData: { enabled: false, write: "signed-in" },
	extensions: { connections: [], mcp: false },
	allowRemix: false,
};

export function site(
	revision: number,
	versions: string[] = [],
	deploymentId: string | null = null,
	settings: Record<string, unknown> = SETTINGS
) {
	return {
		access: "owner",
		aliases: [],
		createdAt: NOW,
		deploymentId,
		domains: [],
		hasPublished: deploymentId !== null,
		id: SITE_ID,
		name: "Launch",
		ownerId: "node-owner",
		prompt: "",
		revision,
		schemaVersion: 1,
		settings,
		slug: "launch-notes",
		template: "website",
		updatedAt: NOW,
		versions: versions.map(version),
	};
}

export const STATUS = {
	apiVersion: "v1",
	baseDomain: "localhost",
	limits: { projects: 30, versions: 100 },
	mode: "standalone",
	publicEnabled: false,
	visitorPort: 8022,
};

export function sitesError(
	status: number,
	code: string,
	message: string,
	fields?: string[]
): Response {
	return Response.json(
		{ error: { code, message, ...(fields ? { fields } : {}) } },
		{ status }
	);
}

/** A tiny Sites management server holding one Site. */
export function sitesServer(
	options: {
		publicEnabled?: boolean;
		revision?: number;
		settings?: Record<string, unknown>;
	} = {}
) {
	let current = site(options.revision ?? 0, [], null, options.settings);
	return (request: Recorded): Response => {
		const path = new URL(request.url).pathname;
		const route = `${request.method} ${path}`;
		const body = JSON.parse(request.body ?? "{}") as {
			expectedRevision?: number;
			settings?: Record<string, unknown>;
			versionId?: string;
		};
		if (route === "GET /api/sites/status") {
			return Response.json(STATUS);
		}
		if (route === `GET /api/sites/projects/${SITE_ID}`) {
			return Response.json(current);
		}
		if (
			(request.method === "POST" || request.method === "PUT") &&
			body.expectedRevision !== current.revision
		) {
			return sitesError(409, "conflict", "Site changed. Reload before saving.");
		}
		if (route === `POST /api/sites/projects/${SITE_ID}/versions`) {
			current = site(
				current.revision + 1,
				[...current.versions.map((item) => item.id), "ver_1"],
				current.deploymentId
			);
			return Response.json(current, { status: 201 });
		}
		if (route === `POST /api/sites/projects/${SITE_ID}/deploy`) {
			current = site(
				current.revision + 1,
				current.versions.map((item) => item.id),
				body.versionId ?? null
			);
			return Response.json(current);
		}
		if (route === `PUT /api/sites/projects/${SITE_ID}/settings`) {
			// The satellite refuses a changed database or extensions, and the
			// public audience unless the operator allowed it.
			const settings = body.settings ?? {};
			if (
				JSON.stringify(settings.database) !==
					JSON.stringify(current.settings.database) ||
				JSON.stringify(settings.extensions) !==
					JSON.stringify(current.settings.extensions)
			) {
				return sitesError(400, "invalid_input", "Managed separately");
			}
			if (settings.audience === "public" && options.publicEnabled !== true) {
				return sitesError(
					403,
					"policy_denied",
					"Public publishing is disabled by the operator"
				);
			}
			current = site(
				current.revision + 1,
				current.versions.map((item) => item.id),
				current.deploymentId,
				settings
			);
			return Response.json(current);
		}
		if (route === `POST /api/sites/projects/${SITE_ID}/unpublish`) {
			current = site(
				current.revision + 1,
				current.versions.map((item) => item.id),
				null
			);
			return Response.json(current);
		}
		return sitesError(404, "not_found", "Route not found");
	};
}

export function client(respond: Respond, env: Record<string, string> = ENV) {
	const stub = stubFetch(respond);
	const ryu = new Ryu({ env, fetch: stub.fetch, maxRetryDelayMs: 50 });
	return { ...stub, ryu };
}

export async function failure(promise: Promise<unknown>): Promise<RyuError> {
	try {
		await promise;
	} catch (error) {
		if (isRyuError(error)) {
			return error;
		}
		throw error;
	}
	throw new Error("expected the call to fail");
}
