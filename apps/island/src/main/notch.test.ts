import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { runIsolatedIslandScenario } from "./island-isolated-runtime.ts";

// Each case runs the shipping `notch.ts` in its own Bun runtime: only Electron's
// `screen` and the Koffi FFI boundary (AppKit/libobjc) are replaced, and those
// replacements never leak into the rest of `bun test src`. Cases force
// `process.platform` to "darwin" so the native NSScreen mapping executes on any
// host; the first case also keeps the host-platform observation.
const NOTCH = join(import.meta.dirname, "notch.ts");
const ELECTRON = Bun.resolveSync("electron", import.meta.dirname);
const KOFFI = Bun.resolveSync("koffi", import.meta.dirname);
const CUTOUT = { displayId: 7, width: 200, height: 32, x: -700, y: -900 };

interface NotchRun {
	/** Every `koffi.load` call the module made (AppKit, then libobjc). */
	loads: string[];
	platform: string;
	/** One `getNotchGeometry()` reading per `observe(label)` in the scenario. */
	seen: Record<string, unknown>;
	stderr: string;
}

/** `platform` null keeps the host's real platform. */
async function notchScenario(
	platform: "darwin" | null,
	body: string
): Promise<NotchRun> {
	const { result, stderr } = await runIsolatedIslandScenario(
		() => `
import {mock} from "bun:test";
const native={safeTop:32,nativeId:7,detectedWidth:200};
const loads=[];
mock.module(${JSON.stringify(ELECTRON)},()=>({screen:{getAllDisplays:()=>[{id:7,bounds:{x:-1200,y:-900,width:1200,height:900}}]}}));
mock.module(${JSON.stringify(KOFFI)},()=>({
 struct:()=>({}),
 load:(library)=>{loads.push(library);return {func:(...signature)=>{
  if(signature.length>1){return (_target,selector)=>selector==="safeAreaInsets"?{top:native.safeTop}:{width:(1200-native.detectedWidth)/2};}
  const declaration=String(signature[0]);
  if(declaration.includes("objc_getClass")||declaration.includes("sel_registerName")){return (value)=>value;}
  return (_target,selector)=>{
   if(selector==="respondsToSelector:"){return true;}
   if(selector==="count"){return 1;}
   if(selector==="unsignedIntValue"){return native.nativeId;}
   return {};
  };
 }};},
}));
${platform ? `Object.defineProperty(process,"platform",{value:${JSON.stringify(platform)}});` : ""}
const {getNotchGeometry,setNotchMode}=await import(${JSON.stringify(NOTCH)});
const seen={};
const observe=(label)=>{seen[label]=getNotchGeometry();};
${body}
process.stdout.write(JSON.stringify({platform:process.platform,loads,seen}));
`
	);
	return { ...(result as Omit<NotchRun, "stderr">), stderr };
}

describe("native notch detection", () => {
	it("maps NSScreen cutout geometry to Electron display coordinates", async () => {
		const mac = await notchScenario(
			"darwin",
			`setNotchMode(true);observe("enabled");`
		);
		expect(mac.stderr).toBe("");
		expect(mac.seen.enabled).toEqual(CUTOUT);
		expect(mac.loads).toEqual([
			"/System/Library/Frameworks/AppKit.framework/AppKit",
			"/usr/lib/libobjc.A.dylib",
		]);
		// The host's own platform keeps the original contract: geometry only on
		// macOS, and no other platform ever loads AppKit.
		const host = await notchScenario(
			null,
			`setNotchMode(true);observe("enabled");`
		);
		expect(host.stderr).toBe("");
		expect(host.platform).toBe(process.platform);
		expect(host.seen.enabled).toEqual(
			process.platform === "darwin" ? CUTOUT : null
		);
		if (process.platform !== "darwin") {
			expect(host.loads).toEqual([]);
		}
	});
	it("does not mistake a regular menu bar for a camera cutout", async () => {
		const { seen, stderr } = await notchScenario(
			"darwin",
			`native.safeTop=0;setNotchMode(true);observe("menuBar");`
		);
		expect(stderr).toBe("");
		expect(seen.menuBar).toBeNull();
	});
	it("falls back when the display disappeared or native measurements are invalid", async () => {
		const { seen, stderr } = await notchScenario(
			"darwin",
			`
setNotchMode(true);observe("baseline");
native.nativeId=8;setNotchMode(true);observe("displayGone");
native.nativeId=7;native.detectedWidth=Number.NaN;setNotchMode(true);observe("invalidWidth");
`
		);
		expect(stderr).toBe("");
		// The same runtime measured a real cutout first, so each null below is a
		// fallback rather than a mapping that never worked.
		expect(seen.baseline).toEqual(CUTOUT);
		expect(seen.displayGone).toBeNull();
		expect(seen.invalidWidth).toBeNull();
	});
	it("clears attached geometry when the setting is disabled", async () => {
		const { seen, stderr } = await notchScenario(
			"darwin",
			`setNotchMode(true);observe("enabled");setNotchMode(false);observe("disabled");`
		);
		expect(stderr).toBe("");
		expect(seen.enabled).toEqual(CUTOUT);
		expect(seen.disabled).toBeNull();
	});
});
