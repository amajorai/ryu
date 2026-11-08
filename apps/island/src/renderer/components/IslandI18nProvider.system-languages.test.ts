// The Island renderer's automatic language follows the main process's OS list
// (`window.islandLanguage.systemLanguages`), not Chromium's accept-language list.
// Runs in its own Bun process with happy-dom, so the provider's effects run.
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PROVIDER = resolve(import.meta.dirname, "IslandI18nProvider.tsx");
/** Resolved here: the runner lives in a temp directory with no node_modules. */
const REACT = Bun.resolveSync("react", import.meta.dirname);
const REACT_DOM = Bun.resolveSync("react-dom/client", import.meta.dirname);
const I18N_REACT = Bun.resolveSync("@ryu/i18n/react", import.meta.dirname);
const DOM = resolve(
	import.meta.dirname,
	"../../../../desktop/node_modules/@happy-dom/global-registrator/lib/index.js"
);

function runner(systemLanguages: string | null): string {
	const bridge =
		systemLanguages === null
			? "{select:async()=>true}"
			: `{select:async()=>true,systemLanguages:async()=>(${systemLanguages})}`;
	return `
import {GlobalRegistrator} from ${JSON.stringify(DOM)};
GlobalRegistrator.register();globalThis.IS_REACT_ACT_ENVIRONMENT=true;
Object.defineProperty(navigator,"languages",{configurable:true,get:()=>["nl-NL"]});
Object.defineProperty(navigator,"language",{configurable:true,get:()=>"nl-NL"});
window.islandLanguage=${bridge};
const React=await import(${JSON.stringify(REACT)});const {act}=React;const {createRoot}=await import(${JSON.stringify(REACT_DOM)});
const {useI18n}=await import(${JSON.stringify(I18N_REACT)});const {IslandI18nProvider}=await import(${JSON.stringify(PROVIDER)});
const silent={get:()=>new Promise(()=>undefined)};
function Probe(){return React.createElement("output",null,useI18n().locale);}
const container=document.createElement("div");document.body.append(container);
const root=createRoot(container);
await act(async()=>root.render(React.createElement(IslandI18nProvider,{languagePacks:silent},React.createElement(Probe))));
await act(async()=>{await new Promise((done)=>setTimeout(done,20));});
const locale=container.querySelector("output").textContent;await act(()=>root.unmount());
process.stdout.write(JSON.stringify({locale}));process.exit(0);
`;
}

async function shownLocale(systemLanguages: string | null): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "ryu-island-system-languages-"));
	try {
		const script = join(dir, "run.ts");
		await writeFile(script, runner(systemLanguages));
		const child = Bun.spawn([process.execPath, script], {
			cwd: import.meta.dirname,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		if (code !== 0) {
			throw new Error(stderr);
		}
		return (JSON.parse(stdout) as { locale: string }).locale;
	} finally {
		await rm(dir, { force: true, recursive: true });
	}
}

test("automatic mode resolves the main process's OS list (nl-NL, de-DE → de)", async () => {
	expect((await shownLocale('["nl-NL","de-DE"]')).startsWith("de")).toBe(true);
});

test("walks past an unsupported first OS language to ja and ar, and keeps English", async () => {
	expect((await shownLocale('["nl-NL","ja-JP"]')).startsWith("ja")).toBe(true);
	expect((await shownLocale('["nl-NL","ar-EG"]')).startsWith("ar")).toBe(true);
	expect((await shownLocale('["en-US","de-DE"]')).startsWith("en")).toBe(true);
});

test("without the bridge or with a malformed answer it uses navigator.languages", async () => {
	// The renderer's own list holds only nl-NL, which has no Ryu pack.
	expect((await shownLocale(null)).startsWith("de")).toBe(false);
	expect((await shownLocale('[42,"de-DE"]')).startsWith("de")).toBe(false);
});
