import { expect, test } from "bun:test";
import { join } from "node:path";
import { runIsolatedIslandScenario } from "../main/island-isolated-runtime.ts";

// Loads the shipping preload in its own Bun runtime as each platform, with
// Electron's `contextBridge` replaced by a recorder, and reads the
// `forwardsMouseMoves` flag it exposes to the renderer. Electron forwards mouse
// moves to a click-through window on macOS and Windows only, so the renderer
// hit-tests the polled cursor where this flag is false.
const PRELOAD = join(import.meta.dirname, "index.ts");
const ELECTRON = Bun.resolveSync("electron", import.meta.dirname);

async function exposedFlag(
	platform: string
): Promise<{ flag: unknown; stderr: string }> {
	const { result, stderr } = await runIsolatedIslandScenario(
		() => `
import {mock} from "bun:test";
Object.defineProperty(process,"platform",{value:${JSON.stringify(platform)},configurable:true});
const exposed={};
mock.module(${JSON.stringify(ELECTRON)},()=>({
 contextBridge:{exposeInMainWorld:(name,api)=>{exposed[name]=api;}},
 ipcRenderer:{on(){},removeListener(){},send(){},invoke:async()=>null},
}));
await import(${JSON.stringify(PRELOAD)});
process.stdout.write(JSON.stringify({flag:exposed.island?.win?.forwardsMouseMoves??null}));
process.exit(0);
`
	);
	return { flag: (result as { flag: unknown }).flag, stderr };
}

test("the preload tells the renderer that only Linux withholds mouse moves from a click-through window", async () => {
	for (const [platform, forwards] of [
		["darwin", true],
		["win32", true],
		["linux", false],
	] as const) {
		expect(await exposedFlag(platform)).toEqual({
			flag: forwards,
			stderr: "",
		});
	}
}, 30_000);
