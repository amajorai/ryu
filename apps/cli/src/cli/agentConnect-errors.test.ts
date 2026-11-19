import { describe, expect, test } from "bun:test";
import { createCliTranslator } from "../i18n/translate.ts";
import {
	notJsonObject,
	serversAtRoot,
	UnsupportedConfigError,
} from "./agentConnect-errors.ts";
import { localizedTextOf, renderLocalized } from "./localizedText.ts";

const german = createCliTranslator("de", {
	"{label} must be a JSON object.": "{label} muss ein JSON-Objekt sein.",
	"{label} defines mcp_servers with a root key, which a [mcp_servers.{server}] table cannot extend.":
		"{label} definiert mcp_servers mit einem Stammschlüssel, den eine [mcp_servers.{server}]-Tabelle nicht erweitern kann.",
});

describe("agent config refusals", () => {
	test("keep English in .message and render whole sentences in the locale", () => {
		const error = notJsonObject("~/.cursor/mcp.json");
		expect(error).toBeInstanceOf(UnsupportedConfigError);
		expect(error.message).toBe("~/.cursor/mcp.json must be a JSON object.");
		const localized = localizedTextOf(error);
		expect(localized && renderLocalized(localized, german.tf)).toBe(
			"~/.cursor/mcp.json muss ein JSON-Objekt sein."
		);
	});

	test("a catalogued refusal also matches through trMessage", () => {
		const error = serversAtRoot("config.toml", "ryu");
		expect(german.trMessage(error.message)).toBe(
			"config.toml definiert mcp_servers mit einem Stammschlüssel, den eine [mcp_servers.ryu]-Tabelle nicht erweitern kann."
		);
	});
});
