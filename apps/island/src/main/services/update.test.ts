import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { runIsolatedIslandScenario } from "../island-isolated-runtime.ts";

// Each case runs the shipping `update.ts` with the real `config.ts` in its own
// Bun runtime. Only the OS/installer boundary is replaced (Electron's `app` and
// `electron-updater`'s `autoUpdater`, recording every call), and that
// replacement never leaks into the rest of `bun test src`. The shared
// `auto-updates` preference is served by an owned native HTTP Core fixture.
const UPDATE = join(import.meta.dirname, "update.ts");
const ELECTRON = Bun.resolveSync("electron", import.meta.dirname);
const UPDATER = Bun.resolveSync("electron-updater", import.meta.dirname);
const TOKEN = "island-update-token";

interface PreferenceRead {
	authorization: string | null;
	method: string;
	path: string;
}
interface UpdaterRun {
	/** Updater calls recorded before the positive control, if one ran. */
	beforeControl: unknown[][];
	calls: unknown[][];
	reads: PreferenceRead[];
	sent: unknown[][];
	settled: boolean;
	stderr: string;
}

/**
 * `enabled` is the saved preference Core answers with. The scenario emits
 * `update-downloaded` straight after `initAutoUpdater`, as electron-updater
 * would once a download finishes. With `control`, the preference is then turned
 * on and a second download is emitted, proving the same runtime still installs.
 */
async function updaterScenario({
	enabled,
	control,
}: {
	enabled: boolean;
	control: boolean;
}): Promise<UpdaterRun> {
	const { result, stderr } = await runIsolatedIslandScenario(
		(root) => `
import {mock} from "bun:test";
import {writeFileSync} from "node:fs";
let enabled=${JSON.stringify(enabled)};
const reads=[];
const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch(req){
 reads.push({path:new URL(req.url).pathname,method:req.method,authorization:req.headers.get("authorization")});
 return Response.json({key:"auto-updates",value:JSON.stringify({enabled})});
}});
const base=server.url.toString().replace(/\\/$/,"");
writeFileSync(${JSON.stringify(join(root, "island-services.json"))},JSON.stringify({coreBaseUrl:base,coreToken:${JSON.stringify(TOKEN)}}));
const listeners=new Map();const calls=[];const sent=[];
const autoUpdater={
 autoDownload:false,
 checkForUpdates:async()=>{calls.push(["checkForUpdates",autoUpdater.autoDownload]);},
 checkForUpdatesAndNotify:async()=>{calls.push(["checkForUpdatesAndNotify",autoUpdater.autoDownload]);},
 on:(event,listener)=>{listeners.set(event,listener);return autoUpdater;},
 quitAndInstall:(...args)=>{calls.push(["quitAndInstall",...args]);},
};
mock.module(${JSON.stringify(ELECTRON)},()=>({app:{getPath:()=>${JSON.stringify(root)},getVersion:()=>"0.1.15",isPackaged:true}}));
mock.module(${JSON.stringify(UPDATER)},()=>({default:{autoUpdater}}));
const window={isDestroyed:()=>false,webContents:{send:(channel,state)=>sent.push([channel,state])}};
async function until(predicate,ms){const end=Date.now()+ms;while(!predicate()){if(Date.now()>end){return false;}await Bun.sleep(5);}return true;}
// A same-server round trip issued after Core answered: earlier responses have
// been delivered to the module before this one returns.
const roundTrip=()=>fetch(base+"/sync").then((r)=>r.text());
const installs=()=>calls.filter((call)=>call[0]==="quitAndInstall").length;
const prefReads=()=>reads.filter((read)=>read.path==="/api/preferences/auto-updates").length;
try{
 const {initAutoUpdater}=await import(${JSON.stringify(UPDATE)});
 initAutoUpdater(()=>window);
 listeners.get("update-downloaded")?.({version:${JSON.stringify(enabled ? "0.1.16" : "0.1.17")}});
 let settled=await until(()=>prefReads()>=2&&calls.some((call)=>call[0].startsWith("checkFor"))&&(!enabled||installs()>0),3000);
 await roundTrip();
 const beforeControl=calls.slice();
 if(${JSON.stringify(control)}){
  enabled=true;
  listeners.get("update-downloaded")?.({version:"0.1.18"});
  settled=settled&&await until(()=>installs()>0,3000);
  await roundTrip();
 }
 process.stdout.write(JSON.stringify({beforeControl,calls,reads:reads.filter((read)=>read.path!=="/sync"),sent,settled}));
}finally{server.stop(true);}
`
	);
	return { ...(result as Omit<UpdaterRun, "stderr">), stderr };
}

const authorizedRead = {
	authorization: `Bearer ${TOKEN}`,
	method: "GET",
	path: "/api/preferences/auto-updates",
};

describe("Electron updater install wiring", () => {
	test("silently installs and relaunches after an enabled download", async () => {
		const run = await updaterScenario({ enabled: true, control: false });
		expect(run.stderr).toBe("");
		expect(run.settled).toBe(true);
		const installs = run.calls.filter((call) => call[0] === "quitAndInstall");
		expect(installs).toEqual([["quitAndInstall", true, true]]);
		// The launch check auto-downloads, and the install decision re-read the
		// shared preference from Core with the node credential.
		expect(run.calls).toContainEqual(["checkForUpdatesAndNotify", true]);
		expect(run.reads).toEqual([authorizedRead, authorizedRead]);
		expect(run.sent).toEqual([
			[
				"update:downloaded",
				{ available: true, downloaded: true, version: "0.1.16" },
			],
		]);
	});

	test("keeps the restart under user control when auto-updates are disabled", async () => {
		const run = await updaterScenario({ enabled: false, control: true });
		expect(run.stderr).toBe("");
		expect(run.settled).toBe(true);
		expect(
			run.beforeControl.filter((call) => call[0] === "quitAndInstall")
		).toEqual([]);
		// Disabled: the launch check only surfaces availability.
		expect(run.beforeControl).toContainEqual(["checkForUpdates", false]);
		expect(run.beforeControl).not.toContainEqual([
			"checkForUpdatesAndNotify",
			true,
		]);
		// Positive control in the same runtime: once the preference allows it, the
		// next download installs exactly once (the refused one never fires late).
		expect(run.calls.filter((call) => call[0] === "quitAndInstall")).toEqual([
			["quitAndInstall", true, true],
		]);
		expect(run.reads).toEqual([authorizedRead, authorizedRead, authorizedRead]);
	});
});
