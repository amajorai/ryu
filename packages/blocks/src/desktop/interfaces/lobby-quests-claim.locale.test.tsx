// A finished quest's button takes the reward (de "Abholen", ja "受け取る") and
// reads through the keyed `lobby.claimReward`. The bare catalog "Claim" is
// reserving an email alias (de "Beanspruchen", ar "حجز").
import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { I18nRuntime } from "@ryu/i18n/core";
import type { InterfaceSnapshot } from "@ryuhq/protocol/interfaces";
import { renderToStaticMarkup } from "react-dom/server";
// The provider registers its runtime here; a test registers its own.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../../i18n/src/active-locale.ts";
import type { LobbyQuest } from "./lobby-model-quests.ts";

const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}

const { LobbyQuests } = await import("./lobby-quests.tsx");

afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

const SNAPSHOT: InterfaceSnapshot = {
	agents: [],
	groups: [],
	threads: [],
	version: 1,
};

const DONE: LobbyQuest = {
	action: { kind: "start" },
	agentId: null,
	complete: true,
	detail: "Send fifty messages",
	goal: 50,
	groupId: null,
	id: "quest-messages",
	kind: "milestone",
	metric: "50 / 50 messages",
	progress: 50,
	title: "Chatterbox",
	updatedAt: null,
	xp: 100,
};

function questList(): string {
	return renderToStaticMarkup(
		<LobbyQuests
			activeThreadId={null}
			board={{ daily: [], milestone: [DONE], weekly: [] }}
			kind="milestone"
			loading={false}
			now={0}
			onAction={() => undefined}
			onKind={() => undefined}
			snapshot={SNAPSHOT}
		/>
	);
}

function inLocale(packId: string): string {
	const runtime = new I18nRuntime([], { initialPackId: packId });
	registerActiveI18nRuntime(runtime);
	try {
		return questList();
	} finally {
		unregisterActiveI18nRuntime(runtime);
	}
}

test("the German finished quest picks up its reward", () => {
	const html = inLocale("official/de");
	expect(html).toContain(">Abholen<");
	expect(html).not.toContain("Beanspruchen");
});

test("the Japanese finished quest receives its reward", () => {
	expect(inLocale("official/ja")).toContain(">受け取る<");
});

test("English keeps Claim", () => {
	expect(questList()).toContain(">Claim<");
});
