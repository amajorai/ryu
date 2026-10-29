import { afterEach, describe, expect, it, mock } from "bun:test";
import { fetchTimeline } from "./shadow.ts";
import { createFetchFixture } from "./test-support/http-fixture.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("shadow timeline client", () => {
	it("requests the trailing window through Core and returns entries", async () => {
		const fetchMock = mock(async (input: RequestInfo | URL) => {
			expect(String(input)).toMatch(
				/\/api\/shadow\/timeline\?start=\d+&end=\d+/
			);
			return new Response(
				JSON.stringify({
					entries: [
						{
							app_name: "Editor",
							bundle_id: null,
							app_path: null,
							display_id: null,
							segment_file: "native-segment",
							event_type: "app_switch",
							track: 3,
							ts: 1,
							url: null,
							window_title: "Notes",
						},
					],
				}),
				{ status: 200 }
			);
		});
		globalThis.fetch = createFetchFixture(fetchMock);

		await expect(
			fetchTimeline(
				{ token: "node-token", url: "http://node", userJwt: null },
				15
			)
		).resolves.toHaveLength(1);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
