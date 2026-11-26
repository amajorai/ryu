// packages/core-client/src/spaces-path-id.test.ts
//
// Spaces are Core's own routes, not a mount: the space and document ids are
// encoded with encodePathId and stay inside one path segment, and "." and ".."
// are refused. Before, ten builders put the id into the path as it came. Every
// builder that puts a space or document id into a path is in the table, by
// name and by id position.

import { describe, expect, test } from "bun:test";
import type { ApiTarget } from "./client.ts";
import {
	cancelSpaceRetrievalModeChange,
	createPage,
	deleteDocument,
	deleteSpace,
	fetchDocument,
	fetchDocuments,
	fetchSpaceRetrievalModeStatus,
	ingestDocument,
	searchSpace,
	setDocumentIcon,
	setSpaceIcon,
	updateDocument,
} from "./spaces.ts";

const BASE = "http://core.test";
const HOSTILE_ID = "S/import?x#y";
const ENCODED_ID = "S%2Fimport%3Fx%23y";
const PLAIN_ID = "0b6d2f5e-3c1a-4e8b-9f7d-2a6c5e4b3d21";
const DOT_IDS = [".", ".."];

/** A target whose stub fetch records every request and answers with an empty object. */
function recordingTarget(): { requests: string[]; target: ApiTarget } {
	const requests: string[] = [];
	const target: ApiTarget = {
		url: BASE,
		token: "node-token",
		fetch: (input, init) => {
			requests.push(`${init?.method ?? "GET"} ${String(input)}`);
			return Promise.resolve(Response.json({}));
		},
	};
	return { requests, target };
}

/** Run a builder and keep only what it asked the node for; the reply shape is not under test. */
async function requestsOf(
	call: (target: ApiTarget) => Promise<unknown>
): Promise<string[]> {
	const { requests, target } = recordingTarget();
	await Promise.resolve()
		.then(() => call(target))
		.catch(() => undefined);
	return requests;
}

interface PathBuilder {
	call: (target: ApiTarget, id: string) => Promise<unknown>;
	name: string;
	/** The one request the builder makes, with the id position as given. */
	request: (segment: string) => string;
}

const SPACE = `${BASE}/api/spaces`;

const BUILDERS: PathBuilder[] = [
	{
		name: "deleteSpace",
		request: (s) => `DELETE ${SPACE}/${s}`,
		call: (target, id) => deleteSpace(target, id),
	},
	{
		name: "setSpaceIcon",
		request: (s) => `POST ${SPACE}/${s}/icon`,
		call: (target, id) => setSpaceIcon(target, id, null),
	},
	{
		name: "fetchSpaceRetrievalModeStatus",
		request: (s) =>
			`GET ${SPACE}/${s}/retrieval-mode/status?job_id=${PLAIN_ID}`,
		call: (target, id) => fetchSpaceRetrievalModeStatus(target, id, PLAIN_ID),
	},
	{
		name: "cancelSpaceRetrievalModeChange",
		request: (s) => `POST ${SPACE}/${s}/retrieval-mode/cancel`,
		call: (target, id) => cancelSpaceRetrievalModeChange(target, id, PLAIN_ID),
	},
	{
		name: "setDocumentIcon (space id)",
		request: (s) => `POST ${SPACE}/${s}/documents/${PLAIN_ID}/icon`,
		call: (target, id) => setDocumentIcon(target, id, PLAIN_ID, null),
	},
	{
		name: "setDocumentIcon (document id)",
		request: (s) => `POST ${SPACE}/${PLAIN_ID}/documents/${s}/icon`,
		call: (target, id) => setDocumentIcon(target, PLAIN_ID, id, null),
	},
	{
		name: "fetchDocuments",
		request: (s) => `GET ${SPACE}/${s}/documents`,
		call: (target, id) => fetchDocuments(target, id),
	},
	{
		name: "ingestDocument",
		request: (s) => `POST ${SPACE}/${s}/documents`,
		call: (target, id) => ingestDocument(target, id, "t", "c"),
	},
	{
		name: "createPage",
		request: (s) => `POST ${SPACE}/${s}/pages`,
		call: (target, id) => createPage(target, id, "t"),
	},
	{
		name: "fetchDocument (space id)",
		request: (s) => `GET ${SPACE}/${s}/documents/${PLAIN_ID}`,
		call: (target, id) => fetchDocument(target, id, PLAIN_ID),
	},
	{
		name: "fetchDocument (document id)",
		request: (s) => `GET ${SPACE}/${PLAIN_ID}/documents/${s}`,
		call: (target, id) => fetchDocument(target, PLAIN_ID, id),
	},
	{
		name: "updateDocument (space id)",
		request: (s) => `PUT ${SPACE}/${s}/documents/${PLAIN_ID}`,
		call: (target, id) => updateDocument(target, id, PLAIN_ID, "t", "s"),
	},
	{
		name: "updateDocument (document id)",
		request: (s) => `PUT ${SPACE}/${PLAIN_ID}/documents/${s}`,
		call: (target, id) => updateDocument(target, PLAIN_ID, id, "t", "s"),
	},
	{
		name: "deleteDocument (space id)",
		request: (s) => `DELETE ${SPACE}/${s}/documents/${PLAIN_ID}`,
		call: (target, id) => deleteDocument(target, id, PLAIN_ID),
	},
	{
		name: "deleteDocument (document id)",
		request: (s) => `DELETE ${SPACE}/${PLAIN_ID}/documents/${s}`,
		call: (target, id) => deleteDocument(target, PLAIN_ID, id),
	},
	{
		name: "searchSpace",
		request: (s) => `POST ${SPACE}/${s}/search`,
		call: (target, id) => searchSpace(target, id, "q"),
	},
];

describe("the spaces client keeps every id inside one path segment", () => {
	for (const builder of BUILDERS) {
		test(`${builder.name} encodes the id ${HOSTILE_ID}`, async () => {
			expect(
				await requestsOf((target) => builder.call(target, HOSTILE_ID))
			).toEqual([builder.request(ENCODED_ID)]);
		});

		for (const id of DOT_IDS) {
			test(`${builder.name} builds no request for the id ${id}`, async () => {
				expect(await requestsOf((target) => builder.call(target, id))).toEqual(
					[]
				);
			});
		}

		test(`${builder.name} builds its request unchanged for a plain id`, async () => {
			expect(
				await requestsOf((target) => builder.call(target, PLAIN_ID))
			).toEqual([builder.request(PLAIN_ID)]);
		});
	}
});

describe("the split of spaces.ts", () => {
	test("spaces.ts re-exports the schemas and requests of its three parts", async () => {
		const entry = await import("./spaces.ts");
		const types = await import("./spaces-types.ts");
		const documents = await import("./spaces-documents.ts");
		const search = await import("./spaces-search.ts");
		const pairs: [unknown, unknown][] = [
			[entry.spaceRowFields, types.spaceRowFields],
			[entry.spaceSearchResponse, types.spaceSearchResponse],
			[entry.createPage, documents.createPage],
			[entry.deleteDocument, documents.deleteDocument],
			[entry.fetchDocument, documents.fetchDocument],
			[entry.fetchDocuments, documents.fetchDocuments],
			[entry.ingestDocument, documents.ingestDocument],
			[entry.setDocumentIcon, documents.setDocumentIcon],
			[entry.updateDocument, documents.updateDocument],
			[entry.fetchEmbeddingModel, search.fetchEmbeddingModel],
			[entry.fetchReindexStatus, search.fetchReindexStatus],
			[entry.searchSpace, search.searchSpace],
			[entry.setEmbeddingModel, search.setEmbeddingModel],
			[entry.triggerReindex, search.triggerReindex],
		];
		for (const [exported, moved] of pairs) {
			expect(exported).toBe(moved);
		}
	});
});
