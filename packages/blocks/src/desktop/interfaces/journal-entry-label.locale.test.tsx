// The journal's open-entry region is one journal entry and reads through the
// keyed `journal.entry` (de Eintrag, ja エントリー). The bare catalog "Entry"
// is admission (de Einlass, ja 入場).
import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { I18nRuntime } from "@ryu/i18n/core";
import type {
	InterfacePort,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import { renderToStaticMarkup } from "react-dom/server";
// The provider registers its runtime here; a test registers its own.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../../i18n/src/active-locale.ts";

const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
const { JournalInterface } = await import("./journal-interface.tsx");

afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

const port: InterfacePort = {
	closeThread: () => undefined,
	openThread: () => undefined,
	startThread: () => undefined,
};

const snapshot: InterfaceSnapshot = {
	agents: [],
	groups: [],
	threads: [
		{
			agentIds: [],
			id: "thread-notes",
			lastMessage: "Draft ready.",
			lastMessageRole: "assistant",
			messageCount: 2,
			pinned: false,
			projectId: null,
			running: false,
			teamId: null,
			title: "Release notes",
			updatedAt: new Date().toISOString(),
		},
	],
	version: 1,
};

function openEntry(): string {
	return renderToStaticMarkup(
		<JournalInterface
			activeThreadId="thread-notes"
			loading={false}
			params={{}}
			port={port}
			snapshot={snapshot}
			threadView={<div>chat</div>}
		/>
	);
}

test("the German journal labels the open entry Eintrag, not Einlass", () => {
	const runtime = new I18nRuntime([], { initialPackId: "official/de" });
	registerActiveI18nRuntime(runtime);
	try {
		expect(openEntry()).toContain('<main aria-label="Eintrag"');
	} finally {
		unregisterActiveI18nRuntime(runtime);
	}
});

test("English keeps Entry", () => {
	expect(openEntry()).toContain('<main aria-label="Entry"');
});
