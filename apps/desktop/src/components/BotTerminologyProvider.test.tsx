import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { LanguagePack } from "@ryu/i18n";
import { messageIdForLiteral } from "@ryu/i18n/core";
import { I18nProvider } from "@ryu/i18n/react";
import {
	readBotTerminology,
	setBotTerminology,
} from "@ryu/ui/hooks/use-bot-terminology.ts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { setInterfaceLevel } from "@/src/lib/interface-level.ts";
import { BotTerminologyProvider } from "./BotTerminologyProvider.tsx";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}

// SAFETY: The actual installed ReactDOM act environment reads this optional
// global flag. This test writes the authored boolean true to that native hook;
// the declaration gap concerns only this flag, without asserting other globals
// or replacing the registered DOM/native React test environment.
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("BotTerminologyProvider", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		localStorage.clear();
		setInterfaceLevel("expert", { applyPrefs: false });
		setBotTerminology(true);
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(async () => {
		await act(async () => {
			root.unmount();
		});
		container.remove();
	});

	it("rewrites UI text and accessible labels without touching authored content", async () => {
		await act(async () => {
			root.render(
				createElement(
					BotTerminologyProvider,
					null,
					createElement(
						"div",
						null,
						createElement("button", { title: "Agent agents" }, "Agent Agents"),
						createElement("input", {
							"aria-label": "Agents",
							placeholder: "agent",
						}),
						createElement(
							"div",
							{ "data-slot": "message-content" },
							"Agent agents"
						),
						createElement("pre", null, "Agent agents")
					)
				)
			);
		});

		expect(container.querySelector("button")?.textContent).toBe("Bot Bots");
		expect(container.querySelector("button")?.title).toBe("Bot bots");
		expect(container.querySelector("input")?.getAttribute("aria-label")).toBe(
			"Bots"
		);
		expect(container.querySelector("input")?.placeholder).toBe("bot");
		expect(
			container.querySelector('[data-slot="message-content"]')?.textContent
		).toBe("Agent agents");
		expect(container.querySelector("pre")?.textContent).toBe("Agent agents");
	});

	it("restores the original UI when the setting is turned off", async () => {
		await act(async () => {
			root.render(
				createElement(
					BotTerminologyProvider,
					null,
					createElement("button", { title: "Agent" }, "Agents")
				)
			);
		});

		expect(container.textContent).toBe("Bots");
		await act(async () => {
			setBotTerminology(false);
			await Promise.resolve();
		});

		expect(readBotTerminology()).toBe(false);
		expect(container.textContent).toBe("Agents");
		expect(container.querySelector("button")?.title).toBe("Agent");
	});

	it("leaves data-ryu-i18n=off user data alone under an English pack", async () => {
		const pack: LanguagePack = {
			baseLocale: "en",
			direction: "ltr",
			id: "en-flavor",
			locale: "en",
			messages: { [messageIdForLiteral("Inbox")]: "Mailroom" },
			name: "English flavor",
			schemaVersion: 1,
			version: "1.0.0",
		};
		await act(async () => {
			root.render(
				<I18nProvider
					autoLocalizeDom={false}
					initialPackId={pack.id}
					manageDocument={false}
					packs={[pack]}
				>
					<BotTerminologyProvider>
						<span id="ui">Inbox</span>
						<span data-ryu-i18n="off" id="data" title="Inbox">
							Inbox
						</span>
						<span data-ryu-i18n="off" id="name">
							Sales Agent
						</span>
					</BotTerminologyProvider>
				</I18nProvider>
			);
		});

		expect(container.querySelector("#ui")?.textContent).toBe("Mailroom");
		expect(container.querySelector("#data")?.textContent).toBe("Inbox");
		expect(container.querySelector("#data")?.getAttribute("title")).toBe(
			"Inbox"
		);
		expect(container.querySelector("#name")?.textContent).toBe("Sales Agent");
	});
});
