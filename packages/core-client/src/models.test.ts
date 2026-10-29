import { expect, test } from "bun:test";
import { z } from "zod";
import {
	type ActiveModelPreview,
	activeModelPreviewSchema,
	type ModelInstallPreview,
	type ModelPreviewDetail,
	type ModelUninstallPreview,
	modelInstallPreviewSchema,
	modelUninstallPreviewSchema,
} from "./model-preview-contracts.ts";

const seam = {
	success: true,
	dryRun: true,
	action: "install",
	source: "mirror",
	repoId: "owner/model",
	files: [
		{ url: "https://model.example/x", sha256: null, dest_filename: "x.gguf" },
	],
	writes: [],
	future: JSON.parse('{"__proto__":{"keep":1}}'),
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
const diffusion = {
	success: true,
	dryRun: true,
	action: "switch",
	active: "x",
	engine: "sdcpp",
	format: "gguf",
	current: null,
	alreadyActive: false,
	wouldPersist: true,
	wouldRestart: true,
	diffusion: true,
	wouldRefreshGateway: false,
	writes: ["active diffusion model preference"],
} satisfies ActiveModelPreview;
const completeDetail = {
	card: {
		id: "owner/model",
		author: "owner",
		name: "model",
		downloads: 2 ** 60,
		likes: 0,
		pipeline_tag: null,
		tags: [],
		gated: false,
		last_modified: null,
		created_at: null,
		context_length: null,
		architecture: null,
		params: null,
		installed: false,
		format: "gguf",
		compatible: true,
		needs_engine: null,
		diffusion: false,
	},
	readme: null,
	format: "gguf",
	files: [
		{
			filename: "x.gguf",
			quant: null,
			size_bytes: null,
			size_human: "unknown",
			sha256: null,
			url: "https://model.example/x",
			installed: false,
			fit: "tight",
			fit_label: "Native label",
		},
	],
	vision: false,
	repo_size_bytes: null,
	repo_fit: "",
	repo_fit_label: "",
	stats: null,
	stats_api_key_present: false,
	device: {
		total_ram_bytes: null,
		ram_human: "unknown",
		vram_bytes: null,
		vram_human: "unknown",
		gpu_name: null,
		gpu_vendor: null,
		unified_memory: false,
		os: "linux",
	},
} satisfies ModelPreviewDetail;
const hf = {
	success: true,
	dryRun: true,
	action: "install",
	id: "owner/model",
	file: "",
	format: "historical-format",
	detail: completeDetail,
	writes: [],
} satisfies ModelInstallPreview;

const requestBodySchema = z.object({
	dryRun: z.literal(true),
	id: z.string(),
	file: z.string().optional(),
	format: z.string().optional(),
	engine: z.string().optional(),
});
type PreviewBody = z.output<typeof requestBodySchema>;

import {
	previewActiveModel,
	previewModelInstall,
	previewModelUninstall,
} from "./models.ts";

test("model previews carry dryRun without touching model files", async () => {
	const bodies: PreviewBody[] = [];
	const target = {
		url: "https://node.example",
		token: "node-token",
		fetch: async (_url: RequestInfo | URL, init?: RequestInit) => {
			bodies.push(requestBodySchema.parse(JSON.parse(String(init?.body))));
			return Response.json(bodies.length === 1 ? seam : removal);
		},
	};

	await previewModelInstall(target, "owner/model", {
		file: "model-Q4.gguf",
		format: "gguf",
	});
	await previewModelUninstall(target, "owner/model", "model-Q4.gguf");

	expect(bodies).toEqual([
		{
			dryRun: true,
			file: "model-Q4.gguf",
			format: "gguf",
			id: "owner/model",
		},
		{ dryRun: true, file: "model-Q4.gguf", id: "owner/model" },
	]);
});

test("previews active model switches without using a live mutation body", async () => {
	const bodies: PreviewBody[] = [];
	const target = {
		url: "https://node.example",
		token: "node-token",
		fetch: async (_url: RequestInfo | URL, init?: RequestInit) => {
			bodies.push(requestBodySchema.parse(JSON.parse(String(init?.body))));
			return Response.json(switching);
		},
	};

	await previewActiveModel(target, "TheBloke/model.gguf", "llamacpp");

	expect(bodies).toEqual([
		{ dryRun: true, id: "TheBloke/model.gguf", engine: "llamacpp" },
	]);
});

test("native previews retain complete publisher fields and future JSON", () => {
	for (const value of [seam, hf]) {
		expect(modelInstallPreviewSchema.parse(value)).toBe(value);
	}
	expect(modelUninstallPreviewSchema.parse(removal)).toBe(removal);
	for (const value of [switching, diffusion]) {
		expect(activeModelPreviewSchema.parse(value)).toBe(value);
	}
	const decodedMaximum = JSON.parse("18446744073709551615");
	const maximumPublisher = {
		...hf,
		detail: {
			...completeDetail,
			card: { ...completeDetail.card, downloads: decodedMaximum },
		},
	};
	expect(modelInstallPreviewSchema.parse(maximumPublisher)).toBe(
		maximumPublisher
	);
	const future = JSON.parse('{"__proto__":{"keep":1}}');
	const withFuture = { ...hf, future };
	expect(modelInstallPreviewSchema.parse(withFuture).future).toBe(future);
	expect(
		modelInstallPreviewSchema.safeParse({
			success: true,
			dryRun: true,
			action: "install",
		}).success
	).toBe(false);
	expect(
		modelUninstallPreviewSchema.safeParse({
			...removal,
			plan: { ...removal.plan, modelExists: 1 },
		}).success
	).toBe(false);
	expect(
		activeModelPreviewSchema.safeParse({
			...switching,
			wouldRefreshGateway: false,
		}).success
	).toBe(false);
	expect(
		modelInstallPreviewSchema.safeParse({
			...hf,
			detail: {
				...completeDetail,
				card: { ...completeDetail.card, downloads: 0.5 },
			},
		}).success
	).toBe(false);
	expect(
		modelInstallPreviewSchema.safeParse({
			...hf,
			detail: {
				...completeDetail,
				card: { ...completeDetail.card, downloads: 1e100 },
			},
		}).success
	).toBe(false);
});
