/* @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { ThemeProvider } from "../../components/ui/theme-provider.tsx";
import { CoreProvider } from "../core/CoreContext.tsx";
import type { ListRow } from "../core/featureList.ts";
import { ListTab } from "../ui/ListTab.tsx";

test("list rows remove terminal commands while actions retain the original resource id", async () => {
	const command = "\u001b]52;c;dGVzdA==\u0007";
	const id = `memory-${command}`;
	let activated: string | undefined;
	let releaseLoad!: (rows: ListRow[]) => void;
	const loaded = new Promise<ListRow[]>((resolve) => {
		releaseLoad = resolve;
	});
	const setup = await testRender(
		<ThemeProvider>
			<CoreProvider initial={{ url: "http://127.0.0.1:7980", token: null }}>
				<ListTab
					active
					load={() => loaded}
					onActivate={(row) => {
						activated = row.id;
						return `done${command}safe`;
					}}
				/>
			</CoreProvider>
		</ThemeProvider>,
		{ width: 80, height: 12 }
	);
	try {
		await act(async () => {
			releaseLoad([
				{
					id,
					title: `before${command}after`,
					subtitle: "detail\u001b[2Jsafe",
					badge: `category${command}safe`,
				},
			]);
		});
		await setup.renderOnce();
		const frame = setup.captureCharFrame();
		expect(frame).toContain("beforeafter");
		expect(frame).toContain("detailsafe");
		expect(frame).toContain("categorysafe");
		expect(frame).not.toContain(command);
		expect(frame).not.toContain("\u001b");
		await act(async () => {
			setup.mockInput.pressEnter();
		});
		await setup.renderOnce();
		expect(activated).toBe(id);
		expect(setup.captureCharFrame()).toContain("donesafe");
		expect(setup.captureCharFrame()).not.toContain(command);
	} finally {
		await act(async () => {
			setup.renderer.destroy();
		});
	}
});
