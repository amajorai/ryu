// Open-ended grant families render one whole sentence with the manifest's
// segment inserted verbatim, so a translator sees the full message and a
// program, host or server name is never mangled.

import { describe, expect, test } from "bun:test";
import { grantFamilyCopy } from "./grant-label-families.ts";

describe("grantFamilyCopy", () => {
	test("command tools name the program they start", () => {
		expect(grantFamilyCopy("tool:command:rg")).toEqual({
			label: "Run the rg command",
			description:
				"Start the rg program on this device, with the arguments its tools pass, when one of its tools is used.",
		});
		expect(grantFamilyCopy("tool:command:*")?.label).toBe(
			"Run any allowed command"
		);
	});

	test("egress grants name the host", () => {
		expect(grantFamilyCopy("tool:http-egress:api.tavily.com")?.label).toBe(
			"Connect to api.tavily.com"
		);
		expect(grantFamilyCopy("tool:http-egress:*")?.label).toBe(
			"Connect to any website"
		);
	});

	test("MCP, cross-app and Core grants name their target", () => {
		expect(grantFamilyCopy("mcp:zvec_grep")?.label).toBe(
			"Use the zvec_grep MCP server"
		);
		expect(grantFamilyCopy("app:http:@ryu/mail")?.label).toBe(
			"Call the @ryu/mail app"
		);
		expect(grantFamilyCopy("core:list_agents")?.label).toBe(
			"Use the Ryu list_agents capability"
		);
	});

	test("the prefix matches case-insensitively and keeps the segment's spelling", () => {
		expect(grantFamilyCopy("MCP:Places")?.label).toBe(
			"Use the Places MCP server"
		);
	});

	test("an empty segment or another namespace is not a family", () => {
		expect(grantFamilyCopy("mcp:")).toBeNull();
		expect(grantFamilyCopy("tool:command: ")).toBeNull();
		expect(grantFamilyCopy("tool:execute")).toBeNull();
		expect(grantFamilyCopy("storage:kv")).toBeNull();
	});
});
