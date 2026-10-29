import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { Tab } from "@/src/contexts/TabsContext.tsx";

interface OpenTabWindowArgs {
	conversationId: string | null;
	dragOut: boolean;
	entityKey: string | null;
	node: string | null;
	path: string;
	title: string;
	transfer: { artifact?: unknown; node: string; tab: Tab; version: number };
}

const invocations: { args: OpenTabWindowArgs; command: string }[] = [];
let nativeAnswer = true;
let duringOpen: (() => void) | null = null;

const realTauri = await import("@/src/lib/tauri-ready.ts");
mock.module("@/src/lib/tauri-ready.ts", () => ({
	...realTauri,
	invokeWhenReady: async (command: string, args: OpenTabWindowArgs) => {
		invocations.push({ command, args });
		duringOpen?.();
		return nativeAnswer;
	},
}));

const { moveTabToWindow } = await import("./move-tab-window.ts");
const { registerTabSnapshot, TabTransferBlockedError } = await import(
	"./tab-transfer.ts"
);
const { useArtifactStore } = await import("@/src/store/useArtifactStore.ts");
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");

const originalNodes = useNodeStore.getState();
const studio = { name: "studio", url: "https://studio.test", token: null };
const artifact = {
	id: "art-1",
	sourceMessageId: "msg",
	kind: "html" as const,
	title: "Report",
	content: "<h1>Report</h1>",
};

beforeEach(() => {
	invocations.length = 0;
	nativeAnswer = true;
	duringOpen = null;
	useNodeStore.setState({
		nodes: [...originalNodes.nodes, studio],
		tabOverrides: { "pane-chat": "studio" },
	});
	useArtifactStore.setState({ artifacts: { [artifact.id]: artifact } });
});
afterEach(() => {
	useNodeStore.setState(originalNodes, true);
});

test("a chat tab opens with its conversation entity key, active node and drag flag", async () => {
	const tab: Tab = {
		id: "pane-chat",
		path: "/chat",
		title: "Research",
		conversationId: "conv/1",
	};
	expect(await moveTabToWindow(tab, true)).toBe(true);
	expect(invocations).toHaveLength(1);
	const [{ command, args }] = invocations;
	expect(command).toBe("open_tab_window");
	expect(args).toMatchObject({
		path: "/chat",
		conversationId: "conv/1",
		entityKey: "conversation:conv%2F1",
		node: "studio",
		title: "Research",
		dragOut: true,
	});
	expect(args.transfer).toMatchObject({ version: 1, node: "studio" });
	expect(args.transfer.tab.id).toBe("pane-chat");
	expect(args.transfer.artifact).toBeUndefined();
});

test("a non-chat tab has no conversation id or entity key and dragOut defaults to false", async () => {
	await moveTabToWindow({ id: "pane-x", path: "/settings", title: "Settings" });
	expect(invocations[0]?.args).toMatchObject({
		conversationId: null,
		entityKey: null,
		dragOut: false,
	});
});

test("only an /artifact/ tab carries its artifact from the store", async () => {
	await moveTabToWindow({
		id: "pane-art",
		path: "/artifact/art-1",
		title: "Report",
	});
	expect(invocations[0]?.args.transfer.artifact).toBe(artifact);

	// Same-length prefix, so a prefix-blind slice would resolve "art-1" too.
	await moveTabToWindow({
		id: "pane-other",
		path: "/notebook/art-1",
		title: "L",
	});
	expect(invocations[1]?.args.transfer.artifact).toBeUndefined();
});

test("a tab edited while its window was opening blocks the move instead of losing the edit", async () => {
	let draft = "first";
	const release = registerTabSnapshot("pane-draft", () => ({
		initialPrompt: draft,
	}));
	try {
		duringOpen = () => {
			draft = "typed while opening";
		};
		const tab: Tab = { id: "pane-draft", path: "/chat", title: "Draft" };
		await expect(moveTabToWindow(tab)).rejects.toBeInstanceOf(
			TabTransferBlockedError
		);
		expect(invocations[0]?.args.transfer.tab.initialPrompt).toBe("first");
	} finally {
		release();
	}
});

test("a declined native move resolves false without throwing, even if the tab changed", async () => {
	let draft = "first";
	const release = registerTabSnapshot("pane-declined", () => ({
		initialPrompt: draft,
	}));
	try {
		nativeAnswer = false;
		duringOpen = () => {
			draft = "changed";
		};
		expect(
			await moveTabToWindow({ id: "pane-declined", path: "/chat", title: "D" })
		).toBe(false);
	} finally {
		release();
	}
});

test("an unchanged tab moves successfully", async () => {
	const release = registerTabSnapshot("pane-same", () => ({
		initialPrompt: "steady",
	}));
	try {
		expect(
			await moveTabToWindow({ id: "pane-same", path: "/chat", title: "S" })
		).toBe(true);
	} finally {
		release();
	}
});
