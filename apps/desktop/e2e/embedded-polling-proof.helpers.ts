import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import { proofEvidencePath } from "./proof-evidence-path.ts";

// Fixtures and helpers for embedded-polling-proof.spec.ts and its part<N>- siblings, kept apart so each file stays under the token limit.

export const proofDir = proofEvidencePath("performance-sweep");
export function readCompanionHtml(build: string): Promise<string> {
	const app =
		build === "broadcast"
			? "chat-broadcast"
			: build === "video"
				? "video-studio"
				: build;
	const fixture = path.resolve(
		import.meta.dirname,
		"../../../apps/core/src/plugin_manifest/fixtures",
		`${app}.ui.html`
	);
	const html =
		process.env.RYU_PERF_USE_CORE_FIXTURES === "1" && existsSync(fixture)
			? fixture
			: `/tmp/ryu-${build}-performance-build/index.html`;
	return readFile(html, "utf8");
}

/**
 * Switches to "Another tab" and resolves once the companion frame has observed
 * itself hidden. The probe observer is created after the app's own shared
 * visibility observer, so Chromium delivers the hidden entry to the app first in
 * the same intersection-observer task; read baselines taken afterwards cannot
 * race a late pause signal.
 */
export async function hideCompanion(page: Page): Promise<void> {
	const companion = await page
		.locator('iframe[title="Companion workspace"]')
		.elementHandle();
	const frame = await companion?.contentFrame();
	if (!frame) {
		throw new Error("companion frame is not attached");
	}
	await frame.evaluate(() => {
		const hidden = new Promise<void>((resolve) => {
			const observer = new IntersectionObserver((entries) => {
				if (entries.at(-1)?.isIntersecting === false) {
					observer.disconnect();
					resolve();
				}
			});
			observer.observe(document.documentElement);
		});
		Reflect.set(globalThis, "__ryuProofCompanionHidden", hidden);
	});
	await page.getByRole("button", { name: "Another tab", exact: true }).click();
	await frame.evaluate(() =>
		Reflect.get(globalThis, "__ryuProofCompanionHidden")
	);
}

export const workflowBridge = `<script>let reads=0,stops=0,runReads=0;let workflow={id:"workflow-a",name:"Review workflow",nodes:[{id:"input",type:"input",key:null},{id:"approval",type:"notify_user",prompt:"Review the draft"},{id:"output",type:"output",key:null}],edges:[{from:"input",to:"approval"},{from:"approval",to:"output"}],triggers:[]};const waitFor=message=>new Promise(resolve=>{const done=e=>{if(e.data!==message)return;removeEventListener("message",done);resolve()};addEventListener("message",done)});const run={runId:"run-a",workflowId:workflow.id,status:"awaiting_input",awaitingNode:"approval",createdAt:"2026-09-12T00:00:00Z",updatedAt:"2026-09-12T00:00:00Z",dryRun:false,input:{},output:{},nodes:{input:{status:"completed"},approval:{status:"running"},output:{status:"pending"}}};window.ryu={context:{workflowId:workflow.id},catalog:{snapshot:async()=>null},ghost:{recipes:async()=>[],recordStart:async()=>({recording:true,status:{event_count:0,elapsed_secs:0}}),recordStatus:async()=>{document.body.dataset.recordReads=String(++reads);await waitFor("release-record-status");return {recording:true,status:{event_count:9,elapsed_secs:12}}},recordStop:async()=>{document.body.dataset.recordStops=String(++stops);return {recording:false,task:"Review task",events:[],event_count:0,started_at:"2026-09-12T00:00:00Z"}}},workflows:{list:async()=>[workflow],schedules:async()=>[],apps:async()=>[],mcp:async()=>({servers:[],tools:[]}),notifyTargets:async()=>[],skills:async()=>[],hookEvents:async()=>[],composio:async()=>({configured:false}),versionsList:async()=>[],templatesList:async()=>[],save:async(definition)=>{workflow={...definition,id:"recorded-workflow"};return workflow},run:async()=>run,runGet:async()=>{document.body.dataset.runReads=String(++runReads);if(runReads===1){await waitFor("release-workflow-run");return run}return {...run,status:"completed",nodes:{input:{status:"completed"},approval:{status:"completed"},output:{status:"completed"}}}}}};</script>`;
