// Continues embedded-polling-proof.spec.ts (split under the file token limit); helpers live in embedded-polling-proof.helpers.ts.

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
	newProject,
	newSegment,
} from "../../../apps-store/video-studio/shared/project.ts";
import {
	hideCompanion,
	proofDir,
	readCompanionHtml,
} from "./embedded-polling-proof.helpers.ts";

test("production Fine-tuning coalesces slow job reads and preserves configuration while hidden", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	const html = await readCompanionHtml("finetune");
	const bridge = `<script>let reads=0;const sidecar={"/capability":async()=>({can_train_local:true,gpu:"Local GPU"}),"/adapters":async()=>({adapters:[]}),"/list":async()=>{document.body.dataset.jobReads=String(++reads);if(reads===1)await new Promise(resolve=>{const done=e=>{if(e.data!=="release-jobs")return;removeEventListener("message",done);resolve()};addEventListener("message",done)});return {jobs:[]}},"/start":async()=>{document.body.dataset.started="true";throw Error("No training starts in this proof")}};window.ryu={app:{request:async({path})=>{const route=sidecar[path];if(!route)throw Error("Unexpected finetune sidecar path "+path);return route()}}};</script>`;
	await page.route("**/embedded-polling-child.html", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: html.replace("<head>", `<head>${bridge}`),
		})
	);
	await page.clock.install();
	await page.goto("/embedded-polling-proof.html");
	const frame = page.frameLocator('iframe[title="Companion workspace"]');
	await frame
		.getByRole("textbox", { name: "Base model id", exact: true })
		.fill("unsloth/llama-3-8b-bnb-4bit");
	await frame
		.getByRole("textbox", { name: "Output adapter name", exact: true })
		.fill("My saved draft");
	await page.clock.fastForward(13_000);
	await expect(frame.locator("body")).toHaveAttribute("data-job-reads", "1");
	await page
		.locator("iframe")
		.evaluate((element: HTMLIFrameElement) =>
			element.contentWindow?.postMessage("release-jobs", "*")
		);
	await page.clock.fastForward(1);
	await hideCompanion(page);
	await page.clock.fastForward(21_000);
	await expect(frame.locator("body")).toHaveAttribute("data-job-reads", "1");
	await page.getByRole("button", { name: "Companion", exact: true }).click();
	await expect(frame.locator("body")).toHaveAttribute("data-job-reads", "2");
	await expect(
		frame.getByRole("textbox", { name: "Output adapter name", exact: true })
	).toHaveValue("My saved draft");
	expect(await frame.locator("body").getAttribute("data-started")).toBeNull();
	expect(errors).toEqual([]);
	await mkdir(proofDir, { recursive: true });
	await page.screenshot({
		path: path.join(proofDir, "finetune-completed.png"),
		fullPage: true,
		animations: "disabled",
	});
});

test("production Fine-tuning keeps live progress and refreshes once on repeated terminal frames", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	const html = await readCompanionHtml("finetune");
	const bridge = `<script>let lists=0,adapters=0;const sidecar={"/capability":async()=>({can_train_local:true,gpu:"Local GPU"}),"/adapters":async()=>{document.body.dataset.adapterReads=String(++adapters);return {adapters:[]}},"/list":async()=>{document.body.dataset.jobReads=String(++lists);return {jobs:[{id:"run-a",output_name:"Training preview",state:"running",step:10,max_steps:100}]}}};window.ryu={context:{view:"history"},app:{request:async({path})=>{const route=sidecar[path];if(!route)throw Error("Unexpected finetune sidecar path "+path);return route()}},finetune:{stream:async(_input,hooks)=>{document.body.dataset.streams="1";hooks.signal.addEventListener("abort",()=>{document.body.dataset.streamAborted="true"});addEventListener("message",e=>{if(e.data==="progress")hooks.onFrame(JSON.stringify({step:50}));if(e.data==="terminal"){for(let i=0;i<4;i++)hooks.onFrame(JSON.stringify({state:"succeeded",step:100}))}})}}};</script>`;
	await page.route("**/embedded-polling-child.html", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: html.replace("<head>", `<head>${bridge}`),
		})
	);
	await page.clock.install();
	await page.goto("/embedded-polling-proof.html");
	const frame = page.frameLocator('iframe[title="Companion workspace"]');
	await frame.getByRole("button", { name: /Training preview/ }).press("Enter");
	await expect(frame.locator("body")).toHaveAttribute("data-streams", "1");
	await hideCompanion(page);
	await page
		.locator("iframe")
		.evaluate((element: HTMLIFrameElement) =>
			element.contentWindow?.postMessage("progress", "*")
		);
	await page.clock.fastForward(9000);
	await expect(frame.locator("body")).toHaveAttribute("data-job-reads", "1");
	await expect(frame.getByText("50 / 100", { exact: true })).toHaveCount(1);
	expect(
		await frame.locator("body").getAttribute("data-stream-aborted")
	).toBeNull();
	await page.getByRole("button", { name: "Companion", exact: true }).click();
	await expect(frame.locator("body")).toHaveAttribute("data-job-reads", "2");
	await page
		.locator("iframe")
		.evaluate((element: HTMLIFrameElement) =>
			element.contentWindow?.postMessage("terminal", "*")
		);
	await expect(frame.locator("body")).toHaveAttribute("data-job-reads", "3");
	await expect(frame.locator("body")).toHaveAttribute(
		"data-adapter-reads",
		"2"
	);
	await expect(frame.getByText("100 / 100", { exact: true })).toBeVisible();
	expect(errors).toEqual([]);
	await mkdir(proofDir, { recursive: true });
	await page.screenshot({
		path: path.join(proofDir, "finetune-progress-completed.png"),
		fullPage: true,
		animations: "disabled",
	});
});

test("production Video Studio retains a newly queued export against an old poll and pauses hidden reads", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	const project = newProject("Performance preview");
	project.titles.push({
		id: crypto.randomUUID(),
		start: 0,
		end: 5,
		text: "Ryu Video Studio",
		x: 0.5,
		y: 0.5,
		fontSize: 0.08,
		color: "#ffffff",
		fadeIn: 0,
		fadeOut: 0,
		animation: "fade",
	});
	const html = await readCompanionHtml("video");
	const bridge = `<script>let reads=0;const project=${JSON.stringify(project)};const job={id:"render-preview",projectId:project.id,revision:0,status:"running",progress:0.2};window.ryu={app:{request:async({path,method})=>{if(path==="/projects")return {projects:[project]};if(path==="/assets")return {assets:[]};if(path==="/renders"){document.body.dataset.renderReads=String(++reads);if(reads===1){await new Promise(resolve=>{const done=e=>{if(e.data!=="release-renders")return;removeEventListener("message",done);resolve()};addEventListener("message",done)});return {jobs:[]}}return {jobs:[{...job,status:"completed",progress:1}]}}if(path.endsWith("/render")&&method==="POST"){document.body.dataset.exportRequests="1";return job}throw Error("Unexpected fixture request "+path)}}};</script>`;
	await page.route("**/embedded-polling-child.html", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: html.replace("<head>", `<head>${bridge}`),
		})
	);
	await page.clock.install();
	await page.setViewportSize({ width: 1600, height: 1200 });
	await page.goto("/embedded-polling-proof.html");
	await page.locator("main").evaluate((element) => {
		element.style.maxWidth = "none";
	});
	await page.locator("iframe").evaluate((element) => {
		element.style.height = "950px";
	});
	const frame = page.frameLocator('iframe[title="Companion workspace"]');
	await expect(
		frame.getByRole("button", { name: "Export video", exact: true })
	).toBeEnabled();
	await page.clock.fastForward(6000);
	await expect(frame.locator("body")).toHaveAttribute("data-render-reads", "1");
	await frame
		.getByRole("button", { name: "Export video", exact: true })
		.press("Enter");
	await expect(
		frame.getByText("Encoding video…", { exact: true })
	).toBeVisible();
	await page
		.locator("iframe")
		.evaluate((element: HTMLIFrameElement) =>
			element.contentWindow?.postMessage("release-renders", "*")
		);
	await page.clock.fastForward(1);
	await expect(
		frame.getByText("Encoding video…", { exact: true })
	).toBeVisible();
	await hideCompanion(page);
	await page.clock.fastForward(10_000);
	await expect(frame.locator("body")).toHaveAttribute("data-render-reads", "1");
	await page.getByRole("button", { name: "Companion", exact: true }).click();
	await expect(frame.locator("body")).toHaveAttribute("data-render-reads", "2");
	await expect(frame.getByRole("status")).toHaveText(
		"Export completed. Your video is ready to download."
	);
	await expect(
		frame.getByRole("button", { name: "Download MP4", exact: true })
	).toBeVisible();
	await frame
		.getByRole("button", { name: "Play timeline", exact: true })
		.press("Enter");
	await page.clock.runFor(1000);
	await frame
		.getByRole("button", { name: "Pause playback", exact: true })
		.press("Enter");
	await expect(
		frame.getByRole("spinbutton", { name: "Playhead", exact: true })
	).not.toHaveValue("0");
	expect(errors).toEqual([]);
	await page.screenshot({
		path: path.join(proofDir, "video-export-completed.png"),
		fullPage: true,
		animations: "disabled",
	});
});

test("production Video Studio resumes source analysis after a completed run without overlapping reads", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	const project = newProject("Analysis preview");
	const asset = {
		id: crypto.randomUUID(),
		name: "Scene study.mp4",
		kind: "video",
		duration: 5,
		width: 1920,
		height: 1080,
		hasAudio: true,
		createdAt: "2026-09-12T00:00:00Z",
	};
	const html = await readCompanionHtml("video");
	const bridge = `<script>let reads=0,starts=0;const project=${JSON.stringify(project)},asset=${JSON.stringify(asset)};const analysis={assetId:asset.id,status:"completed",createdAt:asset.createdAt,sceneCuts:[2.5],waveform:[0.1,0.4,0.2,0.6,0.1],duration:5};window.ryu={app:{request:async({path,method})=>{if(path==="/projects")return {projects:[project]};if(path==="/assets")return {assets:[asset]};if(path==="/renders")return {jobs:[]};if(path.endsWith("/analysis")){document.body.dataset.analysisReads=String(++reads);if(reads===1)await new Promise(resolve=>{const done=e=>{if(e.data!=="release-analysis")return;removeEventListener("message",done);resolve()};addEventListener("message",done)});return {analysis:{...analysis,status:reads===2?"running":"completed"}}}if(path.endsWith("/analyze")&&method==="POST"){document.body.dataset.analysisStarts=String(++starts);return {...analysis,status:"running"}}throw Error("Unexpected fixture request "+path)}}};</script>`;
	await page.route("**/embedded-polling-child.html", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: html.replace("<head>", `<head>${bridge}`),
		})
	);
	await page.clock.install();
	await page.setViewportSize({ width: 1600, height: 1200 });
	await page.goto("/embedded-polling-proof.html");
	await page.locator("main").evaluate((element) => {
		element.style.maxWidth = "none";
	});
	await page.locator("iframe").evaluate((element) => {
		element.style.height = "950px";
	});
	const frame = page.frameLocator('iframe[title="Companion workspace"]');
	await frame
		.getByRole("button", { name: "View analysis", exact: true })
		.press("Enter");
	await expect(frame.locator("body")).toHaveAttribute(
		"data-analysis-reads",
		"1"
	);
	await page.clock.fastForward(6000);
	await expect(frame.locator("body")).toHaveAttribute(
		"data-analysis-reads",
		"1"
	);
	await page
		.locator("iframe")
		.evaluate((element: HTMLIFrameElement) =>
			element.contentWindow?.postMessage("release-analysis", "*")
		);
	await expect(
		frame.getByText("1 detected scene changes", { exact: true })
	).toBeVisible();
	await page.clock.fastForward(10_000);
	await expect(frame.locator("body")).toHaveAttribute(
		"data-analysis-reads",
		"1"
	);
	await frame
		.getByRole("button", { name: "Analyze source", exact: true })
		.press("Enter");
	await expect(frame.locator("body")).toHaveAttribute(
		"data-analysis-reads",
		"2"
	);
	await expect(
		frame.getByText("Analyzing scenes and audio…", { exact: true })
	).toBeVisible();
	await hideCompanion(page);
	await page.clock.fastForward(10_000);
	await expect(frame.locator("body")).toHaveAttribute(
		"data-analysis-reads",
		"2"
	);
	await page.getByRole("button", { name: "Companion", exact: true }).click();
	await expect(frame.locator("body")).toHaveAttribute(
		"data-analysis-reads",
		"3"
	);
	await expect(
		frame.getByText("1 detected scene changes", { exact: true })
	).toBeVisible();
	await page.clock.fastForward(6000);
	await expect(frame.locator("body")).toHaveAttribute(
		"data-analysis-reads",
		"3"
	);
	await frame
		.getByText("1 detected scene changes", { exact: true })
		.scrollIntoViewIfNeeded();
	expect(errors).toEqual([]);
	await page.screenshot({
		path: path.join(proofDir, "video-analysis-completed.png"),
		fullPage: true,
		animations: "disabled",
	});
});

test("production Video Studio bounds preview blobs to the current project and abandons old preload queues", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	const assets = [
		"Slow old source",
		"Current preview",
		"Unused queued source",
	].map((name) => ({
		id: crypto.randomUUID(),
		name,
		kind: "image" as const,
		duration: 5,
		width: 640,
		height: 360,
		hasAudio: false,
		createdAt: "2026-09-12T00:00:00Z",
	}));
	const old = newProject("Old project");
	old.segments = [newSegment(assets[0]!), newSegment(assets[2]!, 5)];
	const current = newProject("Current project");
	current.segments = [newSegment(assets[1]!)];
	const shared = newProject("Shared source project");
	shared.segments = [newSegment(assets[1]!)];
	const empty = newProject("Empty project");
	const html = await readCompanionHtml("video");
	const bridge = `<script>const projects=${JSON.stringify([old, current, shared, empty])},assets=${JSON.stringify(assets)};const reads={};const live=new Set();const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL);URL.createObjectURL=blob=>{const url=create(blob);live.add(url);document.body.dataset.liveUrls=String(live.size);return url};URL.revokeObjectURL=url=>{live.delete(url);document.body.dataset.liveUrls=String(live.size);revoke(url)};window.ryu={app:{request:async({path})=>{if(path==="/projects")return {projects};const selected=projects.find(project=>path==="/projects/"+project.id);if(selected)return selected;if(path==="/assets")return {assets};if(path==="/renders")return {jobs:[]};const asset=assets.find(asset=>path.startsWith("/assets/"+asset.id+"/data?"));if(asset){reads[asset.name]=(reads[asset.name]||0)+1;document.body.dataset.mediaReads=JSON.stringify(reads);if(asset.id===assets[0].id){await new Promise(resolve=>{const done=e=>{if(e.data!=="release-old-media")return;removeEventListener("message",done);resolve()};addEventListener("message",done)});return {data:"AA==",done:false,size:100}}const canvas=document.createElement("canvas");canvas.width=640;canvas.height=360;const ctx=canvas.getContext("2d");ctx.fillStyle="#172554";ctx.fillRect(0,0,640,360);ctx.fillStyle="#ffffff";ctx.font="32px sans-serif";ctx.textAlign="center";ctx.fillText("Current project preview",320,180);const data=canvas.toDataURL("image/png").split(",")[1];return {data,size:data.length,done:true}}throw Error("Unexpected fixture request "+path)}}};</script>`;
	await page.route("**/embedded-polling-child.html", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: html.replace("<head>", `<head>${bridge}`),
		})
	);
	await page.setViewportSize({ width: 1600, height: 1200 });
	await page.goto("/embedded-polling-proof.html");
	await page.locator("main").evaluate((element) => {
		element.style.maxWidth = "none";
	});
	await page.locator("iframe").evaluate((element) => {
		element.style.height = "950px";
	});
	const frame = page.frameLocator('iframe[title="Companion workspace"]');
	await expect(frame.locator("body")).toHaveAttribute(
		"data-media-reads",
		JSON.stringify({ "Slow old source": 1 })
	);
	await frame
		.getByRole("combobox", { name: "Project", exact: true })
		.selectOption(current.id);
	await expect(frame.locator("body")).toHaveAttribute("data-live-urls", "1");
	await page
		.locator("iframe")
		.evaluate((element: HTMLIFrameElement) =>
			element.contentWindow?.postMessage("release-old-media", "*")
		);
	await frame
		.getByRole("combobox", { name: "Project", exact: true })
		.selectOption(shared.id);
	await expect(frame.locator("body")).toHaveAttribute(
		"data-media-reads",
		JSON.stringify({ "Slow old source": 1, "Current preview": 1 })
	);
	await expect(frame.locator("body")).toHaveAttribute("data-live-urls", "1");
	await frame
		.getByRole("combobox", { name: "Project", exact: true })
		.selectOption(empty.id);
	await expect(frame.locator("body")).toHaveAttribute("data-live-urls", "0");
	await frame
		.getByRole("combobox", { name: "Project", exact: true })
		.selectOption(current.id);
	await expect(frame.locator("body")).toHaveAttribute(
		"data-media-reads",
		JSON.stringify({ "Slow old source": 1, "Current preview": 2 })
	);
	await expect(frame.locator("body")).toHaveAttribute("data-live-urls", "1");
	await expect
		.poll(() =>
			frame
				.locator(".studio-preview img")
				.evaluateAll((images) =>
					images.some(
						(image) =>
							image instanceof HTMLImageElement &&
							image.complete &&
							image.naturalWidth === 640
					)
				)
		)
		.toBe(true);
	expect(errors).toEqual([]);
	await page.screenshot({
		path: path.join(proofDir, "video-preview-resources-completed.png"),
		fullPage: true,
		animations: "disabled",
	});
});
