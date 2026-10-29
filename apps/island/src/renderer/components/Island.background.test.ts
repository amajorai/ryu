import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { runIsolatedIslandScenario } from "../../main/island-isolated-runtime.ts";

// Mounts the shipping `Island` in happy-dom, in its own Bun runtime, with the
// Island Background preference Desktop Settings writes. Real: `Island.tsx`, the
// appearance, notch, command-summon, material-mask and window-drag hooks, the
// Island state store and the GlassCN scrim card. The preload bridge is a
// recording `window.island`: its appearance read answers with the stored value
// once the case releases it, the case drives pointer enter/leave on the Island
// wrapper and the main process's polled cursor, and \`forwardsMouseMoves\` is
// what the preload reports for the platform (false on Linux). Data-driven hooks (context, suggestions, voice, dictation,
// theme) and the panel content are inert fixtures; happy-dom has no layout, so
// every element reports a 40px box at the window origin.
const COMPONENTS = import.meta.dirname;
const RENDERER = resolve(COMPONENTS, "..");
const REACT = Bun.resolveSync("react", RENDERER);
const REACT_DOM_CLIENT = Bun.resolveSync("react-dom/client", RENDERER);
const DOM = resolve(
	COMPONENTS,
	"../../../../desktop/node_modules/@happy-dom/global-registrator/lib/index.js"
);
const INERT: Record<string, string> = {
	"hooks/use-active-context.ts":
		"useActiveContext:()=>({live:false,appName:null})",
	"hooks/use-composer-shortcut-bindings.ts":
		"useComposerShortcutBindings:()=>({})",
	"hooks/use-dev-state-switcher.ts": "useDevStateSwitcher(){}",
	"hooks/use-dictation.ts": "useDictation(){}",
	"hooks/use-eye-cursor.ts": "useEyeCursor(){}",
	"hooks/use-island-theme.ts": "useIslandTheme(){}",
	"hooks/use-meeting-detect.ts":
		"useMeetingDetect:()=>({suggestion:null,accept(){},dismiss(){}})",
	"hooks/use-quest-detect.ts":
		"useQuestDetect:()=>({suggestion:null,accept(){},dismiss(){}})",
	"hooks/use-suggestion-queue.ts":
		"useSuggestionQueue:()=>({active:null,accept(){},dismiss(){},snooze(){}})",
	"hooks/use-voice-agent.ts":
		"useVoiceAgent:()=>({agentName:null,canCycle:false})",
	"hooks/use-voice-input.ts": "useVoiceInput:()=>({levels:[],error:null})",
	"hooks/use-voice-mode.ts": "useVoiceMode:()=>({active:false,stop(){}})",
	"hooks/use-voice-mode-shortcuts.ts": "useVoiceModeShortcuts(){}",
	"components/IslandContent.tsx": "IslandContent:()=>null",
	"context/island-composer-context.tsx":
		"IslandComposerProvider:({children})=>children,useIslandComposerContext:()=>({agentId:'',leftActions:null,sections:[]})",
};

interface SurfaceView {
	blurred: boolean;
	shadowed: boolean;
}
interface IslandView {
	nativeBackdrops: number;
	padded: boolean;
	surfaces: SurfaceView[];
}
interface IslandRun {
	sent: Record<string, unknown[][]>;
	stderr: string;
	views: Record<string, IslandView>;
}

/**
 * Mount the Island with `stored` as Core's `island-appearance` value. The case
 * records what the renderer sends after each step: `beforeRead` (mounted, the
 * appearance read still pending), `rest` (read answered), `hoverIn`/`hoverOut`
 * (pointer enters/leaves the Island wrapper at rest), `split` (the idle pill
 * splits out), `summoned` (command bar), `expandedHover` (enter then leave while
 * it is open), `dismissed` (the bar loses focus), then `panel` and
 * `panelClosed` (the chat panel opens from the pill and closes). The polled
 * cursor (window coordinates; the wrapper is the 40px box at the origin) moves
 * in (`cursorIn`) at rest; then the DOM pointer leaves (`domLeave`), the cursor
 * returns (`cursorReturn`) and stays inside (`cursorStay`); then it moves out
 * (`cursorOut`); in, out and in again while the bar is open (`expandedCursor`);
 * and back in after it closes (`cursorBack`). With `appearanceFails` the
 * appearance read rejects instead of answering. With `summonBeforeRead` the
 * command bar opens (`earlySummon`) and closes (`earlyDismiss`) while the read
 * is still pending.
 */
async function mountIsland(
	stored: string | null,
	{
		forwardsMouseMoves = true,
		appearanceFails = false,
		summonBeforeRead = false,
	}: {
		appearanceFails?: boolean;
		forwardsMouseMoves?: boolean;
		summonBeforeRead?: boolean;
	} = {}
): Promise<IslandRun> {
	const { result, stderr } = await runIsolatedIslandScenario(
		() => `
import {mock} from "bun:test";
import {GlobalRegistrator} from ${JSON.stringify(DOM)};
GlobalRegistrator.register();globalThis.IS_REACT_ACT_ENVIRONMENT=true;
HTMLElement.prototype.getBoundingClientRect=function(){return {x:0,y:0,left:0,top:0,right:40,bottom:40,width:40,height:40,toJSON(){}};};
let sent=[];let openCommand=()=>{};let blurCommand=()=>{};let releaseAppearance=()=>{};let cursorMoved=()=>{};
const appearanceRead=new Promise((resolve)=>{releaseAppearance=resolve;});
window.island={
 appearance:{get:async()=>{await appearanceRead;if(${appearanceFails}){throw new Error("appearance read failed");}return ${JSON.stringify(stored)};},notch:async()=>null},
 win:{
  setMouseCapture:(capture)=>sent.push(["setMouseCapture",capture]),
  setContentSize:(width,height,expanded)=>sent.push(["setContentSize",width,height,expanded]),
  setMaterialShapes:(contours)=>sent.push(["setMaterialShapes",contours.length]),
  dragStart(){},moveBy(){},dragEnd(){},
  forwardsMouseMoves:${forwardsMouseMoves},
  initialPlacement:{h:"center",v:"start"},
  onPlacement:()=>()=>{},
  placementApplied(){},
 },
 window:{onCursorMove:(handler)=>{cursorMoved=handler;return()=>{cursorMoved=()=>{};};}},
 command:{onOpen:(handler)=>{openCommand=handler;return()=>{};},onBlur:(handler)=>{blurCommand=handler;return()=>{};}},
};
${Object.entries(INERT)
	.map(
		([file, members]) =>
			`mock.module(${JSON.stringify(join(RENDERER, file))},()=>({${members}}));`
	)
	.join("\n")}
const {act,createElement}=await import(${JSON.stringify(REACT)});
const {createRoot}=await import(${JSON.stringify(REACT_DOM_CLIENT)});
const {Island}=await import(${JSON.stringify(join(COMPONENTS, "Island.tsx"))});
const {useIslandState}=await import(${JSON.stringify(join(RENDERER, "store/island-state.ts"))});
const container=document.createElement("div");document.body.append(container);
const root=createRoot(container);
const settle=()=>act(async()=>{await Bun.sleep(60);});
const views={};const sentBy={};
function view(name){
 const outer=container.firstElementChild;
 views[name]={
  padded:(outer instanceof HTMLElement)&&outer.style.paddingTop!=="",
  surfaces:[...container.querySelectorAll("[data-island-material-shape]")].map((surface)=>({blurred:surface.classList.contains("backdrop-blur-2xl"),shadowed:surface.classList.contains("shadow-2xl")})),
  nativeBackdrops:container.querySelectorAll(".glass-native-backdrop").length,
 };
}
// The element carrying the Island's pointer enter/leave handlers.
const wrapper=()=>container.firstElementChild?.firstElementChild;
const pointer=(type)=>wrapper()?.dispatchEvent(new PointerEvent(type,{bubbles:true,relatedTarget:null}));
const step=async(name,action)=>{sent=[];await act(async()=>action());await settle();sentBy[name]=sent;view(name);};
await act(async()=>root.render(createElement(Island)));
await settle();view("beforeRead");sentBy.beforeRead=sent;
if(${summonBeforeRead}){
 await step("earlySummon",()=>openCommand());
 await step("earlyDismiss",()=>blurCommand());
}
await step("rest",()=>releaseAppearance());
await step("hoverIn",()=>pointer("pointerover"));
await step("hoverOut",()=>pointer("pointerout"));
await step("cursorIn",()=>cursorMoved({x:20,y:20}));
await step("domLeave",()=>pointer("pointerout"));
await step("cursorReturn",()=>cursorMoved({x:22,y:22}));
await step("cursorStay",()=>cursorMoved({x:23,y:23}));
await step("cursorOut",()=>cursorMoved({x:300,y:300}));
await step("split",()=>useIslandState.getState().setState("idle"));
await step("summoned",()=>openCommand());
await step("expandedHover",()=>{pointer("pointerover");pointer("pointerout");});
await step("expandedCursor",()=>{cursorMoved({x:20,y:20});cursorMoved({x:300,y:300});cursorMoved({x:20,y:20});});
await step("dismissed",()=>blurCommand());
await step("cursorBack",()=>cursorMoved({x:21,y:21}));
await step("panel",()=>useIslandState.getState().openPanel());
await step("panelClosed",()=>useIslandState.getState().setState("idle"));
await act(async()=>root.unmount());
process.stdout.write(JSON.stringify({views,sent:sentBy}));
process.exit(0);
`,
		20_000
	);
	return { ...(result as Omit<IslandRun, "stderr">), stderr };
}

/** Before the appearance read answers, nothing is drawn and nothing is sent. */
const NOTHING_YET = { padded: false, surfaces: [], nativeBackdrops: 0 };

const count = (calls: unknown[][], name: string) =>
	calls.filter((call) => call[0] === name).length;
const captures = (calls: unknown[][]) =>
	calls.filter((call) => call[0] === "setMouseCapture");

test("a Translucent preference renders the floating split shapes with CSS glass and click-through at rest", async () => {
	const run = await mountIsland(JSON.stringify({ background: "translucent" }));
	expect(run.stderr).toBe("");
	expect(run.views.beforeRead).toEqual(NOTHING_YET);
	expect(run.sent.beforeRead).toEqual([]);
	const glass = { blurred: true, shadowed: true };
	// Resting logo, then the split: logo and pill as two blurred, shadowed shapes
	// inside the oversized window, inset from its edges (TRANSLUCENT_WINDOW_INSET).
	expect(run.views.rest).toEqual({
		padded: true,
		surfaces: [glass],
		nativeBackdrops: 0,
	});
	expect(run.views.split).toEqual({
		padded: true,
		surfaces: [glass, glass],
		nativeBackdrops: 0,
	});
	// The footprint is still reported, but no native material mask is requested.
	expect(count(run.sent.split, "setContentSize")).toBeGreaterThan(0);
	expect(count(run.sent.split, "setMaterialShapes")).toBe(0);
	// At rest the pointer entering the Island takes the mouse and leaving hands
	// clicks back to the apps underneath.
	expect(run.sent.hoverIn).toEqual([["setMouseCapture", true]]);
	expect(run.sent.hoverOut).toEqual([["setMouseCapture", false]]);
	// A summoned command bar captures the mouse and keeps it while the pointer
	// leaves; dismissing it hands clicks back.
	expect(captures(run.sent.summoned)).toEqual([["setMouseCapture", true]]);
	expect(captures(run.sent.expandedHover)).toEqual([["setMouseCapture", true]]);
	expect(captures(run.sent.dismissed)).toEqual([["setMouseCapture", false]]);
	// The chat panel holds the pointer the same way.
	expect(captures(run.sent.panel)).toEqual([["setMouseCapture", true]]);
	expect(captures(run.sent.panelClosed)).toEqual([["setMouseCapture", false]]);
	// Where the OS forwards pointer moves (macOS, Windows), the polled cursor
	// changes nothing.
	for (const name of [
		"cursorIn",
		"cursorReturn",
		"cursorStay",
		"cursorOut",
		"expandedCursor",
		"cursorBack",
	]) {
		expect(run.sent[name]).toEqual([]);
	}
}, 30_000);

for (const background of ["translucent", "acrylic"]) {
	test(`on Linux the polled cursor takes and releases the pointer over the ${background} Island`, async () => {
		const run = await mountIsland(JSON.stringify({ background }), {
			forwardsMouseMoves: false,
		});
		expect(run.stderr).toBe("");
		// At rest: over the Island takes the pointer, away hands it back.
		expect(captures(run.sent.cursorIn)).toEqual([["setMouseCapture", true]]);
		// A DOM pointerleave releases it; when the cursor is next sampled inside,
		// the pointer is taken again (once).
		expect(captures(run.sent.domLeave)).toEqual([["setMouseCapture", false]]);
		expect(captures(run.sent.cursorReturn)).toEqual([
			["setMouseCapture", true],
		]);
		expect(captures(run.sent.cursorStay)).toEqual([]);
		expect(captures(run.sent.cursorOut)).toEqual([["setMouseCapture", false]]);
		// While the command bar is open, moving away never releases it.
		expect(captures(run.sent.expandedCursor)).toEqual([
			["setMouseCapture", true],
			["setMouseCapture", true],
		]);
		// After it closes with the cursor still over the Island, the next sample
		// takes the pointer again.
		expect(captures(run.sent.cursorBack)).toEqual([["setMouseCapture", true]]);
	}, 30_000);
}

for (const [label, stored] of [
	["Native glass", JSON.stringify({ background: "acrylic" })],
	["Mica", JSON.stringify({ background: "mica" })],
	["an unknown value", JSON.stringify({ background: "hologram" })],
	["no saved value", null],
] as const) {
	test(`${label} keeps the native-material surfaces and an interactive window`, async () => {
		const run = await mountIsland(stored);
		expect(run.stderr).toBe("");
		expect(run.views.beforeRead).toEqual(NOTHING_YET);
		expect(run.sent.beforeRead).toEqual([]);
		const native = { blurred: false, shadowed: false };
		expect(run.views.split).toEqual({
			padded: false,
			surfaces: [native, native],
			nativeBackdrops: 2,
		});
		expect(count(run.sent.split, "setMaterialShapes")).toBeGreaterThan(0);
		expect(captures(run.sent.dismissed)).toEqual([["setMouseCapture", true]]);
	}, 30_000);
}

test("a failed appearance read still shows the Island, in the default Native glass style", async () => {
	const run = await mountIsland(JSON.stringify({ background: "translucent" }), {
		appearanceFails: true,
	});
	// No unhandled rejection, and the Island is drawn instead of staying blank.
	expect(run.stderr).toBe("");
	expect(run.views.beforeRead).toEqual(NOTHING_YET);
	expect(run.views.rest).toEqual({
		padded: false,
		surfaces: [{ blurred: false, shadowed: false }],
		nativeBackdrops: 1,
	});
	expect(count(run.sent.rest, "setContentSize")).toBeGreaterThan(0);
}, 30_000);

for (const [background, resting] of [
	["acrylic", true],
	["translucent", false],
] as const) {
	test(`a command bar opened and closed before the appearance read leaves the ${background} window ${resting ? "interactive" : "click-through"}`, async () => {
		const run = await mountIsland(JSON.stringify({ background }), {
			summonBeforeRead: true,
		});
		expect(run.stderr).toBe("");
		expect(captures(run.sent.earlySummon)).toEqual([["setMouseCapture", true]]);
		// While the window's mode is unknown, closing the bar changes nothing;
		// once main answers, the mode's resting capture is applied.
		expect(captures(run.sent.earlyDismiss)).toEqual([]);
		expect(captures(run.sent.rest)).toEqual([["setMouseCapture", resting]]);
	}, 30_000);
}
