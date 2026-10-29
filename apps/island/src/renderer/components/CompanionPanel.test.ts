import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("switching companion owners remounts host state instead of reusing another app's bundle", async () => {
	const dir = await mkdtemp(join(tmpdir(), "ryu-island-tab-owner-"));
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
		await writeFile(
			join(dir, "adapters.tsx"),
			`
import {useState,useEffect} from "react";
export const mounts=[];export const unmounts=[];
const companions=[{id:"a",pluginId:"alpha",name:"Alpha",label:"Alpha",hasUi:true},{id:"b",pluginId:"beta",name:"Beta",label:"Beta",hasUi:true}];
export const usePluginContributions=()=>({companions,views:[]});const setExpandedTall=()=>{};export const useIslandState=selector=>selector({setExpandedTall});
export const IslandMorphingPage=({children})=><div data-testid="morphing-page">{children}</div>;
export const IslandChat=()=> <div>Chat fixture</div>;export const ContributedView=()=>null;
export function IslandPluginHost({companion}){const [owner]=useState(companion.id);useEffect(()=>{mounts.push(companion.id);return()=>unmounts.push(companion.id);},[]);return <div data-testid="owner" data-owner={owner}>{companion.name}</div>;}
`
		);
		const dom = resolve(
			import.meta.dirname,
			"../../../../desktop/node_modules/@happy-dom/global-registrator/lib/index.js"
		);
		await writeFile(
			join(dir, "run.tsx"),
			`
import {GlobalRegistrator} from ${JSON.stringify(dom)};
GlobalRegistrator.register();globalThis.IS_REACT_ACT_ENVIRONMENT=true;window.island={plugins:{onShortcut:()=>()=>{}}};
const {act}=await import("react");const {createRoot}=await import("react-dom/client");const {CompanionPanel}=await import("./panel.tsx");const {mounts,unmounts}=await import("./adapters.tsx");
const container=document.createElement("div");document.body.append(container);const root=createRoot(container);await act(()=>root.render(<CompanionPanel/>));
for(const name of ["Alpha","Beta"]){await act(()=>Array.from(container.querySelectorAll("button")).find(button=>button.textContent===name).click());}
const owner=container.querySelector('[data-testid="owner"]').dataset.owner;const result={owner,mounts:[...mounts],unmounts:[...unmounts]};await act(()=>root.unmount());process.stdout.write(JSON.stringify(result));
`
		);
		const child = Bun.spawn([process.execPath, join(dir, "run.tsx")], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const result = await new Response(child.stdout).json();
		expect(await child.exited).toBe(0);
		expect(result).toEqual({ owner: "b", mounts: ["a", "b"], unmounts: ["a"] });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
