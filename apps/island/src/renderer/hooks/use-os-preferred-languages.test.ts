// useOsPreferredLanguages reads the main process's OS language list, re-reads
// it on `languagechange`, and stays null without the bridge. Runs in its own
// Bun process with happy-dom, so the hook's effects run.
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const HOOK = resolve(import.meta.dirname, "use-os-preferred-languages.ts");
/** Resolved here: the runner lives in a temp directory with no node_modules. */
const REACT = Bun.resolveSync("react", import.meta.dirname);
const REACT_DOM = Bun.resolveSync("react-dom/client", import.meta.dirname);
const DOM = resolve(
	import.meta.dirname,
	"../../../../desktop/node_modules/@happy-dom/global-registrator/lib/index.js"
);

function runner(withBridge: boolean): string {
	const bridge = withBridge
		? "window.islandLanguage={select:async()=>true,systemLanguages:async()=>current};"
		: "";
	return `
import {GlobalRegistrator} from ${JSON.stringify(DOM)};
GlobalRegistrator.register();globalThis.IS_REACT_ACT_ENVIRONMENT=true;
let current=["ja-JP","en-US"];${bridge}
const React=await import(${JSON.stringify(REACT)});const {act}=React;const {createRoot}=await import(${JSON.stringify(REACT_DOM)});
const {useOsPreferredLanguages}=await import(${JSON.stringify(HOOK)});
function Probe(){const value=useOsPreferredLanguages();return React.createElement("output",null,value===null?"null":value.join(","));}
const container=document.createElement("div");document.body.append(container);
const root=createRoot(container);const read=()=>container.querySelector("output").textContent;
const settle=()=>act(async()=>{await new Promise((done)=>setTimeout(done,20));});
await act(async()=>root.render(React.createElement(Probe)));await settle();
const first=read();
current=["ar-EG"];await act(async()=>{window.dispatchEvent(new Event("languagechange"));});await settle();
const changed=read();
current="not a list";await act(async()=>{window.dispatchEvent(new Event("languagechange"));});await settle();
const invalid=read();
await act(()=>root.unmount());
process.stdout.write(JSON.stringify({first,changed,invalid}));process.exit(0);
`;
}

async function run(withBridge: boolean): Promise<Record<string, string>> {
	const dir = await mkdtemp(join(tmpdir(), "ryu-island-os-languages-"));
	try {
		const script = join(dir, "run.ts");
		await writeFile(script, runner(withBridge));
		const child = Bun.spawn([process.execPath, script], {
			stderr: "pipe",
			stdout: "pipe",
		});
		const out = await new Response(child.stdout).text();
		await child.exited;
		return JSON.parse(out);
	} finally {
		await rm(dir, { force: true, recursive: true });
	}
}

test("reads the OS list, follows languagechange and ignores an invalid reply", async () => {
	expect(await run(true)).toEqual({
		changed: "ar-EG",
		first: "ja-JP,en-US",
		invalid: "ar-EG",
	});
});

test("stays null in a window without the language bridge", async () => {
	const result = await run(false);
	expect(result.first).toBe("null");
	expect(result.changed).toBe("null");
});
