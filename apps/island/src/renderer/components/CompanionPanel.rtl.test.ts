// The companion tab strip mirrors under dir="rtl", so its arrow keys follow
// the reading direction: ArrowLeft moves to the next tab in RTL.
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ADAPTERS = `
const companions=[{id:"a",pluginId:"alpha",name:"Alpha",label:"Alpha",hasUi:true},{id:"b",pluginId:"beta",name:"Beta",label:"Beta",hasUi:true}];
export const usePluginContributions=()=>({companions,views:[]});const setExpandedTall=()=>{};export const useIslandState=selector=>selector({setExpandedTall});
export const IslandMorphingPage=({children})=><div>{children}</div>;
export const IslandChat=()=> <div>Chat fixture</div>;export const ContributedView=()=>null;
export const IslandPluginHost=({companion})=> <div>{companion.name}</div>;
`;

function runner(dom: string, direction: string, key: string) {
	return `
import {GlobalRegistrator} from ${JSON.stringify(dom)};
GlobalRegistrator.register();globalThis.IS_REACT_ACT_ENVIRONMENT=true;window.island={plugins:{onShortcut:()=>()=>{}}};
const {act}=await import("react");const {createRoot}=await import("react-dom/client");const {CompanionPanel}=await import("./panel.tsx");
const container=document.createElement("div");container.setAttribute("dir",${JSON.stringify(direction)});container.style.direction=${JSON.stringify(direction)};document.body.append(container);
const root=createRoot(container);await act(()=>root.render(<CompanionPanel/>));
const chat=container.querySelector('[role="tab"]');chat.focus();
await act(()=>{chat.dispatchEvent(new KeyboardEvent("keydown",{bubbles:true,key:${JSON.stringify(key)}}));});
const selected=container.querySelector('[role="tab"][aria-selected="true"]').textContent;await act(()=>root.unmount());process.stdout.write(JSON.stringify({selected}));
`;
}

async function selectedAfter(direction: "ltr" | "rtl", key: string) {
	const dir = await mkdtemp(join(tmpdir(), "ryu-island-tab-rtl-"));
	try {
		await symlink(
			resolve(import.meta.dirname, "../../../node_modules"),
			join(dir, "node_modules")
		);
		const source = await readFile(
			join(import.meta.dirname, "CompanionPanel.tsx"),
			"utf8"
		);
		await writeFile(
			join(dir, "panel.tsx"),
			source.replaceAll(
				/from "(?:\.\.\/(?:hooks|host|store)\/[^"]+|\.\/(?:ContributedView|IslandMorphingPage|chat\/IslandChat)\.tsx)"/g,
				'from "./adapters.tsx"'
			)
		);
		await writeFile(join(dir, "adapters.tsx"), ADAPTERS);
		const dom = resolve(
			import.meta.dirname,
			"../../../../desktop/node_modules/@happy-dom/global-registrator/lib/index.js"
		);
		await writeFile(join(dir, "run.tsx"), runner(dom, direction, key));
		const child = Bun.spawn([process.execPath, join(dir, "run.tsx")], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const result = (await new Response(child.stdout).json()) as {
			selected: string;
		};
		if ((await child.exited) !== 0) {
			throw new Error(await new Response(child.stderr).text());
		}
		return result.selected;
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("companion tabs: ArrowRight moves to the next tab in LTR", async () => {
	expect(await selectedAfter("ltr", "ArrowRight")).toBe("Alpha");
});

test("companion tabs: ArrowLeft moves to the next tab in RTL", async () => {
	expect(await selectedAfter("rtl", "ArrowLeft")).toBe("Alpha");
});

test("companion tabs: ArrowRight moves to the previous tab in RTL", async () => {
	expect(await selectedAfter("rtl", "ArrowRight")).toBe("Beta");
});
