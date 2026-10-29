import { describe, expect, test } from "bun:test";
import {
	managedDiscordInstallUrl,
	managedTelegramBotUrl,
} from "./channels.tsx";

describe("managed channel action URLs", () => {
	test("builds a Telegram bot deeplink from a display username", () => {
		expect(managedTelegramBotUrl("@ryu_node_a")).toBe(
			"https://t.me/ryu_node_a"
		);
	});

	test("rejects an invalid Telegram username", () => {
		expect(managedTelegramBotUrl("not a username")).toBeNull();
	});

	test("builds a Discord install link from an application id", () => {
		expect(managedDiscordInstallUrl("123456789012345678")).toBe(
			"https://discord.com/oauth2/authorize?client_id=123456789012345678"
		);
	});

	test("does not build a Discord link from a bot label", () => {
		expect(managedDiscordInstallUrl("Ryu Node A")).toBeNull();
	});
});
