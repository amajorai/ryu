import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { LiteralMessage } from "@ryu/i18n/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import en from "../../../i18n/locales/en.json" with { type: "json" };
import { CHANNEL_TYPES, type ChannelType } from "./channels-constants.ts";
import type { ChannelConfigView } from "./channels-model.ts";
import { channelSetup } from "./channels-setup.ts";

// Channel setup notes, credential help and warnings are explicit `tl()`
// messages: every one must reach the shared catalog, and the credentials card
// must render the active locale's text instead of the English source.

const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { ChannelsView, defaultBehaviorSettings } = await import(
	"./channels.tsx"
);

/** Longest literal the extractor keeps (`MAX_LENGTH` in filters.mjs). */
const MAX_LENGTH = 600;

interface RecordedMessage {
	source: string;
	values: Record<string, unknown>;
}

function recordedMessages(channelType: ChannelType): RecordedMessage[] {
	const recorded: RecordedMessage[] = [];
	const tl: LiteralMessage = (source, values) => {
		recorded.push({ source, values: { ...(values ?? {}) } });
		return source;
	};
	channelSetup(tl, channelType);
	return recorded;
}

const catalog = new Set<string>(en as string[]);

for (const channelType of CHANNEL_TYPES) {
	test(`every ${channelType} setup message is a catalog key`, () => {
		const messages = recordedMessages(channelType);
		expect(messages.length).toBeGreaterThan(1);
		const missing = messages
			.map(({ source }) => source)
			.filter((source) => !catalog.has(source));
		expect(missing).toEqual([]);
	});

	test(`${channelType} setup messages keep URLs and token prefixes in values`, () => {
		for (const { source } of recordedMessages(channelType)) {
			expect(source.length).toBeLessThanOrEqual(MAX_LENGTH);
			expect(source).not.toMatch(/https?:\/\/|\bxapp-|\bxoxb-|0\.0\.0\.0/u);
		}
	});
}

/** English rendering: fills `{name}` placeholders, translates nothing. */
const englishText: LiteralMessage = (source, values) => {
	let text = source;
	for (const [name, value] of Object.entries(values ?? {})) {
		text = text.replaceAll(`{${name}}`, String(value));
	}
	return text;
};

test("the Slack note and token help format their technical values", () => {
	const setup = channelSetup(englishText, "slack");
	expect(setup.note).toStartWith("Slack runs over Socket Mode");
	expect(setup.note).toContain("(1) Socket Mode is ON; (2) Event");
	expect(setup.secretHelp.app_token).toContain("(starts with xapp-)");
	expect(setup.secretHelp.bot_token).toContain("(starts with xoxb-)");
	const whatsapp = channelSetup(englishText, "whatsapp");
	expect(whatsapp.warning).toContain(
		"on 0.0.0.0:8443/webhooks/whatsapp by default"
	);
	expect(whatsapp.warning).toContain(
		"register https://<your-domain>/webhooks/whatsapp —"
	);
});

const SLACK_NOTE_JA =
	"Slack は Socket Mode で動作するため、公開 URL は不要です。ゲートウェイが外向きの WebSocket を開きます。";
const APP_TOKEN_JA = "アプリレベルトークン（{prefix} で始まる）";

afterEach(() => {
	registerLiteralCatalogLoader(null);
});
afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

function slackChannel(): ChannelConfigView {
	return {
		...defaultBehaviorSettings(),
		agentId: null,
		channelType: "slack",
		enabled: true,
		groupReplyMode: "mentions",
		id: "bot-slack",
		model: null,
		name: "Slack bot",
		secrets: {},
		systemPrompt: null,
		teamId: null,
	};
}

test("a Japanese render of the Slack credentials card shows the translated note", async () => {
	const [slackFirst, , , , , , appToken] = recordedMessages("slack");
	registerLiteralCatalogLoader((locale) =>
		locale.startsWith("ja")
			? {
					[slackFirst?.source ?? ""]: SLACK_NOTE_JA,
					[appToken?.source ?? ""]: APP_TOKEN_JA,
				}
			: {}
	);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	try {
		await act(async () => {
			root.render(
				<I18nProvider initialLocale="ja" initialPackId={null}>
					<ChannelsView
						agents={[]}
						channels={[slackChannel()]}
						initialSelectedId="bot-slack"
						loading={false}
						onSave={() => Promise.resolve(true)}
					/>
				</I18nProvider>
			);
		});
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
		});
		const text = container.textContent ?? "";
		expect(text).toContain(SLACK_NOTE_JA);
		expect(text).not.toContain("Slack runs over Socket Mode");
		expect(text).toContain("アプリレベルトークン（xapp- で始まる）");
	} finally {
		await act(async () => root.unmount());
		container.remove();
	}
});
