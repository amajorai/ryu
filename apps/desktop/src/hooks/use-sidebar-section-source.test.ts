import { describe, expect, it } from "bun:test";
import type { PluginSidebarSection } from "@/src/lib/api/plugins.ts";
import { sectionSourceRequest } from "./useSidebarSectionSource.ts";

function section(
	approvedGrants: string[],
	path: string,
	method = "GET"
): PluginSidebarSection {
	const http = { method: "GET", path };
	Reflect.set(http, "method", method);
	return {
		approved_grants: approvedGrants,
		http_policy: "core",
		id: "records",
		plugin: "com.example.records",
		spec: {
			source: {
				http,
			},
		},
		title: "Records",
	};
}

describe("contributed sidebar source requests", () => {
	it("requires approved declarative HTTP access", () => {
		expect(sectionSourceRequest(section([], "/api/records"))).toBeNull();
		expect(
			sectionSourceRequest(section(["ui:declarative-http"], "/api/records"))
		).toEqual({ method: "GET", path: "/api/records" });
	});

	it("allows only hardened same-origin GET paths", () => {
		const grants = ["ui:declarative-http"];
		expect(sectionSourceRequest(section(grants, "/workflows"))).toEqual({
			method: "GET",
			path: "/workflows",
		});
		expect(
			sectionSourceRequest(section(grants, "/api/records", "POST"))
		).toBeNull();
		expect(
			sectionSourceRequest(section(grants, "/api/%2e%2e/admin"))
		).toBeNull();
	});
});
