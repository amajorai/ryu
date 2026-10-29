import { afterAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
	ActiveModelPreview,
	ModelInstallPreview,
	ModelUninstallPreview,
} from "@ryuhq/core-client/model-preview-contracts.ts";
import { ZodError } from "zod";
import { TOKEN_KEY } from "@/lib/auth-client.ts";
import { ApiError } from "./client.ts";
import {
	previewActiveModel,
	previewModelInstall,
	previewModelUninstall,
} from "./models.ts";

// Real native HTTP exercises the full Desktop module and its existing request
// helper. Only the remote publisher is a fixture; no request/codec is mocked.
const NativeResponse = Response;
const NativeURL = URL;
const nativeFetch = globalThis.fetch;
let reply = NativeResponse.json({});
const received: { body: string; path: string; method: string }[] = [];
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		received.push({
			body: await request.text(),
			path: new NativeURL(request.url).pathname,
			method: request.method,
		});
		return reply.clone();
	},
});
const registeredHere = globalThis.document === undefined;
if (registeredHere) {
	GlobalRegistrator.register({ url: "http://fixture.invalid" });
}
globalThis.fetch = nativeFetch;
const originalToken = localStorage.getItem(TOKEN_KEY);
localStorage.removeItem(TOKEN_KEY);
const target = { url: server.url.toString(), token: null };
beforeEach(() => {
	received.length = 0;
});
afterAll(async () => {
	globalThis.fetch = nativeFetch;
	if (originalToken === null) {
		localStorage.removeItem(TOKEN_KEY);
	} else {
		localStorage.setItem(TOKEN_KEY, originalToken);
	}
	server.stop(true);
	if (registeredHere) {
		await GlobalRegistrator.unregister();
	}
});

const install = {
	success: true,
	dryRun: true,
	action: "install",
	source: "mirror",
	repoId: "owner/model",
	files: [
		{ url: "https://model.example/x", sha256: null, dest_filename: "x.gguf" },
	],
	writes: [],
	future: { nested: [null, true, "kept"] },
} satisfies ModelInstallPreview;
const removal = {
	success: true,
	dryRun: true,
	action: "uninstall",
	plan: {
		repoId: "owner/model",
		filename: "x.gguf",
		modelPath: "/models/x.gguf",
		modelExists: true,
		adapterPath: "/models/mm.gguf",
		adapterExists: false,
	},
	writes: [],
} satisfies ModelUninstallPreview;
const switching = {
	success: true,
	dryRun: true,
	action: "switch",
	active: "x",
	engine: "llamacpp",
	format: "gguf",
	current: null,
	alreadyActive: false,
	wouldPersist: true,
	wouldRestart: true,
	residentEngine: null,
	wouldSwap: false,
	wouldRefreshGateway: true,
	writes: ["active model preference"],
} satisfies ActiveModelPreview;

test("complete install preview retains future fields and existing request values", async () => {
	reply = NativeResponse.json(install);
	expect(
		await previewModelInstall(target, "owner/model", {
			file: "x.gguf",
			format: "gguf",
		})
	).toEqual(install);
	expect(received).toEqual([
		{
			body: JSON.stringify({
				dryRun: true,
				id: "owner/model",
				file: "x.gguf",
				format: "gguf",
			}),
			method: "POST",
			path: "/api/models/catalog/install",
		},
	]);
});
test("complete removal and switch plans retain nullable and boolean publisher values", async () => {
	reply = NativeResponse.json(removal);
	expect(await previewModelUninstall(target, "owner/model", "x.gguf")).toEqual(
		removal
	);
	reply = NativeResponse.json(switching);
	expect(await previewActiveModel(target, "x", "future-engine")).toEqual(
		switching
	);
	expect(
		received.map(({ body, method, path }) => ({ body, method, path }))
	).toEqual([
		{
			body: JSON.stringify({ dryRun: true, file: "x.gguf", id: "owner/model" }),
			method: "POST",
			path: "/api/models/catalog/uninstall",
		},
		{
			body: JSON.stringify({ dryRun: true, id: "x", engine: "future-engine" }),
			method: "POST",
			path: "/api/models/active",
		},
	]);
});
test("incomplete successful prefixes are refused at each complete preview boundary", async () => {
	reply = NativeResponse.json({
		success: true,
		dryRun: true,
		action: "install",
	});
	await expect(
		previewModelInstall(target, "owner/model")
	).rejects.toBeInstanceOf(ZodError);
	reply = NativeResponse.json({
		success: true,
		dryRun: true,
		action: "uninstall",
	});
	await expect(
		previewModelUninstall(target, "owner/model", "x.gguf")
	).rejects.toBeInstanceOf(ZodError);
	reply = NativeResponse.json({
		success: true,
		dryRun: true,
		action: "switch",
	});
	await expect(previewActiveModel(target, "x")).rejects.toBeInstanceOf(
		ZodError
	);
	expect(received).toEqual([
		{
			body: JSON.stringify({ dryRun: true, id: "owner/model" }),
			method: "POST",
			path: "/api/models/catalog/install",
		},
		{
			body: JSON.stringify({ dryRun: true, file: "x.gguf", id: "owner/model" }),
			method: "POST",
			path: "/api/models/catalog/uninstall",
		},
		{
			body: JSON.stringify({ dryRun: true, id: "x" }),
			method: "POST",
			path: "/api/models/active",
		},
	]);
});
test("malformed nested removal fields are refused without changing transport errors", async () => {
	reply = NativeResponse.json({
		...removal,
		plan: { ...removal.plan, modelExists: "yes" },
	});
	await expect(
		previewModelUninstall(target, "owner/model", "x.gguf")
	).rejects.toBeInstanceOf(ZodError);
	expect(received).toEqual([
		{
			body: JSON.stringify({ dryRun: true, file: "x.gguf", id: "owner/model" }),
			method: "POST",
			path: "/api/models/catalog/uninstall",
		},
	]);
	reply = NativeResponse.json({ error: "Unavailable" }, { status: 503 });
	await expect(
		previewModelInstall(target, "owner/model")
	).rejects.toBeInstanceOf(ApiError);
});
