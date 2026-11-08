import { expect, test } from "bun:test";
import { orgProjectOptions } from "./vault-org-projects.ts";

test("offers each mapped project once, sorted, without blank ids", () => {
	expect(
		orgProjectOptions({
			mappings: [
				{ organizationId: "org-1", projectId: "proj-b" },
				{ organizationId: "org-1", projectId: "proj-a" },
				{ organizationId: "org-1", projectId: "proj-b" },
				{ organizationId: "org-1", projectId: "  " },
			],
		})
	).toEqual(["proj-a", "proj-b"]);
	expect(orgProjectOptions({ mappings: [] })).toEqual([]);
});
