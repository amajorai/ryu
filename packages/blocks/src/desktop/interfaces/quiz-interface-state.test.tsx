import { expect, test } from "bun:test";
import { I18nProvider } from "@ryu/i18n/react";
import {
	INTERFACE_PROTOCOL_VERSION,
	type InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import { renderToStaticMarkup } from "react-dom/server";
import { useQuizBoardState } from "./quiz-interface-state.ts";

const SNAPSHOT: InterfaceSnapshot = {
	agents: [
		{
			avatarUrl: null,
			description: "",
			id: "a1",
			name: "Ada",
			status: "working",
		},
	],
	groups: [],
	threads: [
		{
			agentIds: ["a1"],
			id: "t1",
			lastMessage: "On it",
			lastMessageRole: "assistant",
			messageCount: 2,
			pinned: false,
			projectId: null,
			running: true,
			teamId: null,
			title: "Plan",
			updatedAt: "2026-10-12T12:00:00Z",
		},
	],
	version: INTERFACE_PROTOCOL_VERSION,
};

function Words() {
	const { board } = useQuizBoardState(SNAPSHOT, new Map(), true, "auto");
	const words = board.columns.flatMap((column) =>
		(column?.tiles ?? []).map((tile) => tile.statusWord ?? "")
	);
	return <output>{words.join("|")}</output>;
}

test("clue words follow the provider's language, not a first-mount cache", () => {
	const render = (locale: string) =>
		renderToStaticMarkup(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale={locale}
				manageDocument={false}
				overlays={{ ja: { Working: "作業中" } }}
			>
				<Words />
			</I18nProvider>
		);
	expect(render("ja")).toContain("<output>作業中</output>");
	expect(render("en")).toContain("<output>Working</output>");
});
