import { expect, test } from "bun:test";
import {
	HOME_PROVIDERS,
	providerHomePath,
} from "./AgentSyncSections-providers.ts";

function homeProvider(value: string) {
	const provider = HOME_PROVIDERS.find((entry) => entry.value === value);
	if (!provider) {
		throw new Error(`no home provider ${value}`);
	}
	return provider;
}

test("one-click scans point at the Hermes home of the node's platform", () => {
	const hermes = homeProvider("hermes");
	expect(providerHomePath("C:\\Users\\ada", hermes)).toBe(
		"C:\\Users\\ada\\AppData\\Local\\hermes"
	);
	expect(providerHomePath("/Users/ada", hermes)).toBe("/Users/ada/.hermes");
	expect(providerHomePath("/home/ada", hermes)).toBe("/home/ada/.hermes");
});

test("other providers keep their dot folder on every platform", () => {
	expect(providerHomePath("C:\\Users\\ada", homeProvider("claude"))).toBe(
		"C:\\Users\\ada\\.claude"
	);
	expect(providerHomePath("/home/ada", homeProvider("openclaw"))).toBe(
		"/home/ada/.openclaw"
	);
});
