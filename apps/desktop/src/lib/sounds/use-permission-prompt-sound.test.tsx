import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, StrictMode } from "react";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { createRoot } = await import("react-dom/client");
type Root = import("react-dom/client").Root;
const { __setSoundSinkForTests } = await import("./play-sound.ts");
const { usePermissionPromptSound } = await import(
	"./use-permission-prompt-sound.ts"
);

const played: string[] = [];
let root: Root | null = null;

function Prompt({ requestId }: { requestId: string | undefined }) {
	usePermissionPromptSound(requestId);
	return null;
}

function render(requestId: string | undefined) {
	if (!root) {
		const host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
	}
	const current: Root = root;
	act(() => {
		current.render(
			<StrictMode>
				<Prompt requestId={requestId} />
			</StrictMode>
		);
	});
}

beforeEach(() => {
	played.length = 0;
	__setSoundSinkForTests((id, options) => {
		played.push(`${id}@${options.key ?? ""}`);
	});
});

afterEach(() => {
	act(() => root?.unmount());
	root = null;
	__setSoundSinkForTests(null);
});

describe("usePermissionPromptSound", () => {
	it("knocks once per request id", () => {
		render(undefined);
		expect(played).toEqual([]);
		render("req-1");
		render("req-1");
		expect(played).toEqual(["approval-needed@approval:req-1"]);
		render(undefined);
		render("req-2");
		expect(played).toEqual([
			"approval-needed@approval:req-1",
			"approval-needed@approval:req-2",
		]);
	});
});
