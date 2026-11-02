import path from "node:path";
import { expect, test } from "@playwright/test";
import { newProject } from "../../../apps-store/video-studio/shared/project.ts";
import {
	hideCompanion,
	proofDir,
	readCompanionHtml,
	workflowBridge,
} from "./embedded-polling-proof.helpers.ts";

test("shared display clocks stop while hidden, catch up on return, and preserve active playback clocks", async ({
	page,
}) => {
	await page.clock.install({ time: new Date("2026-09-12T00:00:00Z") });
	await page.goto("/embedded-polling-proof.html");
	const frame = page.frameLocator('iframe[title="Companion workspace"]');
	const passive = frame.getByTestId("passive-clock");
	const playback = frame.getByTestId("playback-clock");
	await expect(passive).toHaveText(/\d+/);
	const first = await passive.textContent();
	await page.clock.fastForward(2000);
	await expect(passive).not.toHaveText(first!);
	await hideCompanion(page);
	const hidden = await passive.textContent();
	await page.clock.fastForward(9000);
	await expect(passive).toHaveText(hidden!);
	await expect(playback).not.toHaveText(hidden!);
	await page.getByRole("button", { name: "Companion", exact: true }).click();
	await expect(passive).not.toHaveText(hidden!);
	await frame.getByRole("button", { name: "Close panels" }).press("Enter");
	await page.clock.fastForward(3000);
	await expect(passive).toHaveCount(0);
});

test("production Research retains slow campaign reads and scopes details to the selection", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	const html = await readCompanionHtml("research");
	const bridge = `<script>let lists=0,onlyB=false;addEventListener("message",e=>{if(e.data==="select-campaign-b")onlyB=true});const detailReads={};const campaigns=[{id:"a",name:"Campaign A",status:"running",started_at:"2026-09-12T00:00:00Z",baseline_score:0.6,best_score:0.8,attempt_count:2},{id:"b",name:"Campaign B",status:"running",started_at:"2026-09-12T00:00:00Z",baseline_score:0.7,best_score:0.9,attempt_count:1}];const waitFor=message=>new Promise(resolve=>{const done=e=>{if(e.data!==message)return;removeEventListener("message",done);resolve()};addEventListener("message",done)});window.ryu={app:{request:async({path})=>{if(path==="/campaigns"){document.body.dataset.campaignReads=String(++lists);if(lists===1)await waitFor("release-campaigns");return {campaigns:onlyB?campaigns.filter(campaign=>campaign.id==="b"):campaigns}}const id=path.split("/").at(-1);detailReads[id]=(detailReads[id]||0)+1;document.body.dataset.detailReads=JSON.stringify(detailReads);if(id==="a"&&detailReads[id]===1)await waitFor("release-detail-a");return {campaign:{...campaigns.find(campaign=>campaign.id===id),goal:"Goal "+id.toUpperCase(),attempts:[],reasoning:[]}}}}};</script>`;
	await page.route("**/embedded-polling-child.html", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: html.replace("<head>", `<head>${bridge}`),
		})
	);
	await page.clock.install({ time: new Date("2026-09-12T00:00:00Z") });
	await page.goto("/embedded-polling-proof.html");
	const frame = page.frameLocator('iframe[title="Companion workspace"]');
	await expect(frame.locator("body")).toHaveAttribute(
		"data-campaign-reads",
		"1"
	);
	await page.clock.fastForward(16_000);
	await expect(frame.locator("body")).toHaveAttribute(
		"data-campaign-reads",
		"1"
	);
	await page
		.locator("iframe")
		.evaluate((element: HTMLIFrameElement) =>
			element.contentWindow?.postMessage("release-campaigns", "*")
		);
	await expect(frame.locator("body")).toHaveAttribute(
		"data-detail-reads",
		JSON.stringify({ a: 1 })
	);
	await page.clock.fastForward(11_000);
	await expect(frame.locator("body")).toHaveAttribute(
		"data-detail-reads",
		JSON.stringify({ a: 1 })
	);
	await page
		.locator("iframe")
		.evaluate((element: HTMLIFrameElement) =>
			element.contentWindow?.postMessage("select-campaign-b", "*")
		);
	await page.clock.fastForward(5000);
	await expect(frame.getByText("Goal B", { exact: true })).toBeVisible();
	await page
		.locator("iframe")
		.evaluate((element: HTMLIFrameElement) =>
			element.contentWindow?.postMessage("release-detail-a", "*")
		);
	await page.clock.fastForward(1);
	await expect(frame.getByText("Goal A", { exact: true })).toHaveCount(0);
	await hideCompanion(page);
	const lists = await frame.locator("body").getAttribute("data-campaign-reads");
	const details = await frame.locator("body").getAttribute("data-detail-reads");
	await page.clock.fastForward(20_000);
	await expect(frame.locator("body")).toHaveAttribute(
		"data-campaign-reads",
		lists!
	);
	await expect(frame.locator("body")).toHaveAttribute(
		"data-detail-reads",
		details!
	);
	await page.getByRole("button", { name: "Companion", exact: true }).click();
	await expect
		.poll(async () =>
			Number(await frame.locator("body").getAttribute("data-campaign-reads"))
		)
		.toBeGreaterThan(Number(lists));
	await frame
		.getByRole("button", { name: "Refresh experiments", exact: true })
		.press("Enter");
	await expect
		.poll(async () =>
			Number(await frame.locator("body").getAttribute("data-campaign-reads"))
		)
		.toBeGreaterThan(Number(lists) + 1);
	await expect(frame.getByText("Goal B", { exact: true })).toBeVisible();
	expect(errors).toEqual([]);
	await page.screenshot({
		path: path.join(proofDir, "research-completed.png"),
		fullPage: true,
		animations: "disabled",
	});
});

test("production Workflows prevents late recorder reads from resurrecting a stopped recording", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	const html = await readCompanionHtml("workflows");
	await page.route("**/embedded-polling-child.html", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: html.replace("<head>", `<head>${workflowBridge}`),
		})
	);
	await page.clock.install();
	await page.goto("/embedded-polling-proof.html");
	const frame = page.frameLocator('iframe[title="Companion workspace"]');
	await frame
		.getByRole("button", { name: "Record a task", exact: true })
		.press("Enter");
	await frame
		.getByRole("textbox", { name: "What are you doing?" })
		.fill("Review task");
	await frame
		.getByRole("button", { name: "Start recording", exact: true })
		.press("Enter");
	await expect(frame.getByText("Recording…", { exact: true })).toBeVisible();
	await page.clock.fastForward(1200);
	await expect(frame.locator("body")).toHaveAttribute("data-record-reads", "1");
	await page.clock.fastForward(6000);
	await expect(frame.locator("body")).toHaveAttribute("data-record-reads", "1");
	await hideCompanion(page);
	await page
		.locator("iframe")
		.evaluate((element: HTMLIFrameElement) =>
			element.contentWindow?.postMessage("release-record-status", "*")
		);
	await page.clock.fastForward(6000);
	await expect(frame.locator("body")).toHaveAttribute("data-record-reads", "1");
	expect(
		await frame.locator("body").getAttribute("data-record-stops")
	).toBeNull();
	await page.getByRole("button", { name: "Companion", exact: true }).click();
	await expect(frame.locator("body")).toHaveAttribute("data-record-reads", "2");
	await frame
		.getByRole("button", { name: "Stop & build workflow", exact: true })
		.press("Enter");
	await expect(frame.locator("body")).toHaveAttribute("data-record-stops", "1");
	await expect(frame.getByRole("dialog")).toHaveCount(0);
	await page
		.locator("iframe")
		.evaluate((element: HTMLIFrameElement) =>
			element.contentWindow?.postMessage("release-record-status", "*")
		);
	await page.clock.fastForward(4000);
	await frame
		.getByRole("button", { name: "Record a task", exact: true })
		.press("Enter");
	await expect(
		frame.getByRole("button", { name: "Start recording", exact: true })
	).toBeVisible();
	await expect(frame.getByText("Recording…", { exact: true })).toHaveCount(0);
	await expect(frame.locator("body")).toHaveAttribute("data-record-reads", "2");
	expect(errors).toEqual([]);
	await page.screenshot({
		path: path.join(proofDir, "workflow-recording-completed.png"),
		fullPage: true,
		animations: "disabled",
	});
});

test("production Workflows pauses awaiting-input reads while hidden and stops after completion", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	const html = await readCompanionHtml("workflows");
	await page.route("**/embedded-polling-child.html", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: html.replace("<head>", `<head>${workflowBridge}`),
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
	await frame.getByRole("button", { name: "Run", exact: true }).press("Enter");
	await frame
		.getByRole("button", { name: "Run", exact: true })
		.last()
		.press("Enter");
	await expect(
		frame.getByText("Awaiting approvals", { exact: true })
	).toBeVisible();
	await expect(frame.locator("body")).toHaveAttribute("data-run-reads", "1");
	await page.clock.fastForward(9000);
	await expect(frame.locator("body")).toHaveAttribute("data-run-reads", "1");
	await hideCompanion(page);
	await page
		.locator("iframe")
		.evaluate((element: HTMLIFrameElement) =>
			element.contentWindow?.postMessage("release-workflow-run", "*")
		);
	await page.clock.fastForward(10_000);
	await expect(frame.locator("body")).toHaveAttribute("data-run-reads", "1");
	await page.getByRole("button", { name: "Companion", exact: true }).click();
	await expect(frame.locator("body")).toHaveAttribute("data-run-reads", "2");
	await expect(
		frame.getByText("Awaiting approvals", { exact: true })
	).toHaveCount(0);
	await page.clock.fastForward(9000);
	await expect(frame.locator("body")).toHaveAttribute("data-run-reads", "2");
	await expect(frame.getByText("awaiting_input", { exact: true })).toHaveCount(
		0
	);
	await expect(
		frame.getByText("Result", { exact: true }).locator("..")
	).toContainText("completed");
	await frame
		.getByRole("button", { name: "Hide palette", exact: true })
		.press("Enter");
	expect(errors).toEqual([]);
	await page.screenshot({
		path: path.join(proofDir, "workflow-run-completed.png"),
		fullPage: true,
		animations: "disabled",
	});
});

test("production Video Studio history stays responsive while budget reads wait and hidden polling stops", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	const project = newProject("Generation history preview");
	const asset = {
		id: crypto.randomUUID(),
		name: "Completed frame.png",
		kind: "image",
		duration: 5,
		width: 640,
		height: 360,
		hasAudio: false,
		createdAt: "2026-09-12T00:00:00Z",
	};
	const job = {
		id: crypto.randomUUID(),
		request: {
			id: crypto.randomUUID(),
			projectId: project.id,
			kind: "image",
			prompt: "Stored generation request",
		},
		projectRevision: 0,
		status: "requested",
		assetIds: [],
		message: "",
		createdAt: asset.createdAt,
		updatedAt: asset.createdAt,
	};
	const html = await readCompanionHtml("video");
	const bridge = `<script>
	const project=${JSON.stringify(project)},asset=${JSON.stringify(asset)},job=${JSON.stringify(job)};
	let reads=0,budgets=0,audits=0,complete=false,released=false;
	addEventListener("message",event=>{if(event.data==="complete-generation")complete=true;if(event.data==="release-metadata")released=true});
	const metadata=()=>released?Promise.resolve():new Promise(resolve=>{const done=event=>{if(event.data!=="release-metadata")return;removeEventListener("message",done);resolve()};addEventListener("message",done)});
	const request=async({path})=>{
		if(path==="/projects")return {projects:[project]};
		if(path==="/assets")return {assets:[asset]};
		if(path==="/renders")return {jobs:[]};
		if(path.startsWith("/generations?")){document.body.dataset.generationReads=String(++reads);return {jobs:[{...job,status:complete?"completed":"requested",assetIds:complete?[asset.id]:[]}]}};
		if(path==="/budget"){document.body.dataset.budgetReads=String(++budgets);await metadata();return {reachable:true,users:{},agents:{},sessions:{},unit:"micro_usd"}};
		if(path==="/budget/audit"){document.body.dataset.auditReads=String(++audits);await metadata();return {reachable:true,entries:[]}};
		throw Error("Unexpected fixture request "+path);
	};
	window.ryu={app:{request},media:{image:async()=>{document.body.dataset.generated="true";throw Error("Generation is not part of this read-only proof")}}};
	</script>`;
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
	await frame.getByRole("button", { name: /Show .*more tabs/ }).click();
	await frame.getByRole("option", { name: /^Reorder Generate / }).click();
	await expect(frame.locator("body")).toHaveAttribute(
		"data-generation-reads",
		"1"
	);
	await frame.locator("summary").filter({ hasText: "Requested" }).click();
	await expect(
		frame.getByText("Stored generation request", { exact: true })
	).toBeVisible();
	await page.clock.fastForward(2100);
	await expect(frame.locator("body")).toHaveAttribute(
		"data-generation-reads",
		"2"
	);
	await page.clock.fastForward(2100);
	await expect(frame.locator("body")).toHaveAttribute(
		"data-generation-reads",
		"3"
	);
	await expect(frame.locator("body")).toHaveAttribute("data-budget-reads", "1");
	await expect(frame.locator("body")).toHaveAttribute("data-audit-reads", "1");
	await hideCompanion(page);
	await page.clock.fastForward(35_000);
	await expect(frame.locator("body")).toHaveAttribute(
		"data-generation-reads",
		"3"
	);
	await expect(frame.locator("body")).toHaveAttribute("data-budget-reads", "1");
	await page
		.locator("iframe")
		.evaluate((element: HTMLIFrameElement) =>
			element.contentWindow?.postMessage("complete-generation", "*")
		);
	await page.getByRole("button", { name: "Companion", exact: true }).click();
	await expect(frame.locator("body")).toHaveAttribute(
		"data-generation-reads",
		"4"
	);
	await expect(
		frame.getByText("Saved media: Completed frame.png", { exact: true })
	).toBeVisible();
	await page
		.locator("iframe")
		.evaluate((element: HTMLIFrameElement) =>
			element.contentWindow?.postMessage("release-metadata", "*")
		);
	await expect(frame.locator("body")).toHaveAttribute("data-budget-reads", "2");
	await expect(frame.locator("body")).toHaveAttribute("data-audit-reads", "2");
	await page.clock.fastForward(10_000);
	await expect(frame.locator("body")).toHaveAttribute(
		"data-generation-reads",
		"4"
	);
	expect(await frame.locator("body").getAttribute("data-generated")).toBeNull();
	await frame
		.getByText("Saved media: Completed frame.png", { exact: true })
		.scrollIntoViewIfNeeded();
	expect(errors).toEqual([]);
	await page.screenshot({
		path: path.join(proofDir, "video-generation-history-completed.png"),
		fullPage: true,
		animations: "disabled",
	});
});
