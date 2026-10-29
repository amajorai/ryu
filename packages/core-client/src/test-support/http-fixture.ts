import { z } from "zod";

/** Concrete JSON payloads produced by local HTTP response fixtures. */
export type HttpFixtureBody =
	| null
	| boolean
	| number
	| string
	| readonly HttpFixtureBody[]
	| { readonly [key: string]: HttpFixtureBody | undefined };

/** Preserve the Fetch call contract and captured request details without assertions. */
export function createFetchFixture(
	handle: (url: string, init: RequestInit) => Promise<Response>
): typeof globalThis.fetch {
	const fetchFixture = (input: RequestInfo | URL, init?: RequestInit) =>
		handle(input instanceof Request ? input.url : String(input), init ?? {});
	return Object.assign(fetchFixture, { preconnect: () => undefined });
}

/** Check that the captured request really carries a JSON string before inspecting it. */
const jsonRequestBodySchema = z
	.string()
	.transform((body) => JSON.parse(body))
	.pipe(z.json());
export const parseJsonRequestBody = jsonRequestBodySchema.parse;
