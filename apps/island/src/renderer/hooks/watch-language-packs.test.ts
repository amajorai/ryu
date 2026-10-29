import { expect, test } from "bun:test";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("catalog refresh skips hidden windows, overlaps and late results and removes listeners", async () => {
	const root = await mkdtemp(join(tmpdir(), "ryu-island-language-packs-"));
	try {
		await copyFile(
			join(import.meta.dirname, "watch-language-packs.ts"),
			join(root, "watch.ts")
		);
		await writeFile(
			join(root, "run.ts"),
			`
import {watchLanguagePacks} from "./watch.ts";
class Target extends EventTarget {listeners=new Set();addEventListener(type,callback,options){this.listeners.add(callback);super.addEventListener(type,callback,options);}removeEventListener(type,callback){this.listeners.delete(callback);super.removeEventListener(type,callback);}}
const win=new Target();const doc=new Target();doc.hidden=true;globalThis.window=win;globalThis.document=doc;
let tick;let cleared=false;let calls=0;const replies=[];const received=[];
win.setInterval=callback=>{tick=callback;return 1;};win.clearInterval=()=>{cleared=true;};win.island={languagePacks:{get:()=>{calls++;return new Promise((resolve,reject)=>replies.push({resolve,reject}));}}};
const settle=()=>Bun.sleep(0);const stop=watchLanguagePacks(packs=>received.push(packs));
tick();win.dispatchEvent(new Event("focus"));const hidden=calls;
doc.hidden=false;doc.dispatchEvent(new Event("visibilitychange"));for(let i=0;i<5;i++){tick();win.dispatchEvent(new Event("focus"));}const overlapping=calls;
doc.hidden=true;replies[0].resolve({available:true,packs:[]});await settle();const hiddenDeliveries=received.length;
doc.hidden=false;doc.dispatchEvent(new Event("visibilitychange"));replies[1].resolve({available:true,packs:[]});await settle();const visibleDeliveries=received.length;
tick();replies[2].reject(Error("fixture"));await settle();win.dispatchEvent(new Event("focus"));const beforeStop=calls;stop();replies[3].resolve({available:true,packs:[]});await settle();tick();win.dispatchEvent(new Event("focus"));doc.dispatchEvent(new Event("visibilitychange"));
process.stdout.write(JSON.stringify({hidden,overlapping,hiddenDeliveries,visibleDeliveries,beforeStop,calls,received:received.length,cleared,listeners:win.listeners.size+doc.listeners.size}));
`
		);
		const child = Bun.spawn([process.execPath, join(root, "run.ts")], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const result = await new Response(child.stdout).json();
		expect(await child.exited).toBe(0);
		expect(result).toEqual({
			hidden: 0,
			overlapping: 1,
			hiddenDeliveries: 0,
			visibleDeliveries: 1,
			beforeStop: 4,
			calls: 4,
			received: 1,
			cleared: true,
			listeners: 0,
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("catalog refresh reads from a caller-supplied bridge (the screen window)", async () => {
	const root = await mkdtemp(join(tmpdir(), "ryu-island-language-packs-"));
	try {
		await copyFile(
			join(import.meta.dirname, "watch-language-packs.ts"),
			join(root, "watch.ts")
		);
		await writeFile(
			join(root, "run.ts"),
			`
import {watchLanguagePacks} from "./watch.ts";
const win=new EventTarget();const doc=new EventTarget();doc.hidden=false;globalThis.window=win;globalThis.document=doc;
win.setInterval=()=>1;win.clearInterval=()=>undefined;
let calls=0;const received=[];const pack={id:"official/ar"};
const source={get:async()=>{calls++;return {available:true,packs:[pack]};}};
const stop=watchLanguagePacks(packs=>received.push(packs),source);await Bun.sleep(0);stop();
process.stdout.write(JSON.stringify({calls,received}));
`
		);
		const child = Bun.spawn([process.execPath, join(root, "run.ts")], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const result = await new Response(child.stdout).json();
		expect(await child.exited).toBe(0);
		expect(result).toEqual({ calls: 1, received: [[{ id: "official/ar" }]] });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
