import { describe, expect, it } from "bun:test";
import { normalizeA2ui } from "./a2ui.ts";

const stream = [
	{
		version: "v0.9",
		createSurface: {
			surfaceId: "booking",
			catalogId:
				"https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json",
		},
	},
	{
		version: "v0.9",
		updateDataModel: {
			surfaceId: "booking",
			path: "/reservation",
			value: { guests: "2" },
		},
	},
	{
		version: "v0.9",
		updateComponents: {
			surfaceId: "booking",
			components: [
				{
					id: "root",
					component: "Column",
					children: ["heading", "guests", "submit"],
				},
				{
					id: "heading",
					component: "Text",
					text: "Confirm reservation",
					variant: "h2",
				},
				{
					id: "guests",
					component: "TextField",
					label: "Guests",
					value: { path: "/reservation/guests" },
				},
				{
					id: "submit",
					component: "Button",
					child: "submit-label",
					action: {
						event: {
							name: "confirm",
							context: { reservation: { path: "/reservation" } },
						},
					},
				},
				{
					id: "submit-label",
					component: "Text",
					text: "Confirm",
				},
			],
		},
	},
];

describe("normalizeA2ui", () => {
	it("maps a v0.9 surface into the closed Ryu catalog", () => {
		const result = normalizeA2ui(stream);

		expect(result.spec).toMatchObject({
			root: "root",
			elements: {
				root: {
					type: "Stack",
					props: { direction: "column" },
					children: ["heading", "guests", "submit"],
				},
				heading: {
					type: "Heading",
					props: { text: "Confirm reservation", level: 2 },
				},
				guests: {
					type: "Input",
					props: {
						label: "Guests",
						value: { $bindState: "/reservation/guests" },
					},
				},
				submit: {
					type: "Button",
					props: { label: "Confirm" },
					on: {
						press: {
							action: "submit",
							params: {
								value: {
									protocol: "a2ui",
									name: "confirm",
									surfaceId: "booking",
									context: {
										reservation: { $state: "/reservation" },
									},
								},
							},
						},
					},
				},
			},
			state: { reservation: { guests: "2" } },
		});
		expect(result.issues).toEqual([]);
	});

	it("accepts JSONL and keeps unsupported components inert", () => {
		const result = normalizeA2ui(
			stream
				.map((message) => JSON.stringify(message))
				.concat(
					JSON.stringify({
						version: "v0.9",
						updateComponents: {
							surfaceId: "booking",
							components: [
								{ id: "root", component: "Modal", content: "unknown" },
							],
						},
					})
				)
				.join("\n")
		);

		expect(result.spec?.elements.root).toMatchObject({
			type: "Alert",
			props: { title: "Unsupported A2UI component", description: "Modal" },
		});
		expect(result.issues).toContain("A2UI component is not mapped: Modal");
	});

	it("rejects unsafe paths and executable function calls", () => {
		const result = normalizeA2ui([
			{
				createSurface: { surfaceId: "safe", catalogId: A2UI_BASIC_CATALOG_ID },
			},
			{
				updateDataModel: {
					surfaceId: "safe",
					path: "/__proto__/polluted",
					value: true,
				},
			},
			{
				updateComponents: {
					surfaceId: "safe",
					components: [
						{
							id: "root",
							component: "Text",
							text: { functionCall: { call: "execute" } },
						},
					],
				},
			},
		]);

		expect(result.spec?.state).toEqual({});
		expect(result.issues).toContain(
			"A2UI data model paths may not address prototype keys"
		);
		expect(result.issues).toContain(
			"A2UI functionCall expressions are not executed by Ryu"
		);
	});

	it("does not merge multiple surfaces into one native card", () => {
		const result = normalizeA2ui([
			{ createSurface: { surfaceId: "one" } },
			{
				updateComponents: {
					surfaceId: "one",
					components: [{ id: "root", component: "Text", text: "One" }],
				},
			},
			{ createSurface: { surfaceId: "two" } },
		]);

		expect(result.spec).toBeNull();
		expect(result.issues).toContain(
			"Ryu Agent UI currently renders one A2UI surface per card"
		);
	});
});

const A2UI_BASIC_CATALOG_ID =
	"https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json";

describe("A2UI native transport compatibility", () => {
	it("retains native state leaves and scalar literal values", () => {
		const token = Symbol("native state");
		const callback = () => "native callback";
		const result = normalizeA2ui([
			{ createSurface: { surfaceId: "native" } },
			{
				updateDataModel: {
					surfaceId: "native",
					value: {
						token,
						callback,
						createdAt: new Date(0),
						infinite: Number.POSITIVE_INFINITY,
					},
				},
			},
			{
				updateComponents: {
					surfaceId: "native",
					components: [
						{
							id: "root",
							component: "Slider",
							value: { literalNumber: Number.POSITIVE_INFINITY },
						},
					],
				},
			},
		]);
		expect(result.spec?.state).toEqual({
			token,
			callback,
			createdAt: {},
			infinite: Number.POSITIVE_INFINITY,
		});
		expect(result.spec?.elements.root?.props.value).toBe(
			Number.POSITIVE_INFINITY
		);
		expect(result.issues).toEqual([]);
	});

	it("degrades malformed fields independently while retaining usable components", () => {
		const result = normalizeA2ui([
			{ createSurface: { surfaceId: "native" } },
			{
				version: "future",
				updateComponents: {
					surfaceId: "native",
					components: [
						null,
						{ id: "", component: "Text" },
						{
							id: "root",
							component: "Column",
							children: ["label", false, "missing"],
						},
						{
							id: "label",
							component: "Text",
							text: { literalStringList: ["visible", 42, null, "label"] },
						},
					],
				},
			},
		]);
		expect(result.spec?.elements.root?.children).toEqual(["label"]);
		expect(result.spec?.elements.label?.props.text).toEqual([
			"visible",
			"label",
		]);
		expect(result.issues).toEqual([
			"Unsupported A2UI protocol version: future",
			"A2UI component 1 in message 2 must be an object",
			"A2UI component 2 needs bounded id and component fields",
		]);
	});

	it("applies pointer updates and deletion without modifying the original state", () => {
		const original = {
			reservation: { guests: "2", note: "original" },
			rows: ["one", "two"],
		};
		const result = normalizeA2ui([
			{ createSurface: { surfaceId: "native" } },
			{ updateDataModel: { surfaceId: "native", value: original } },
			{
				updateDataModel: {
					surfaceId: "native",
					path: "/reservation/guests",
					value: "3",
				},
			},
			{ updateDataModel: { surfaceId: "native", path: "/reservation/note" } },
			{
				updateDataModel: {
					surfaceId: "native",
					path: "/rows/1",
					value: "changed",
				},
			},
			{
				updateComponents: {
					surfaceId: "native",
					components: [
						{
							id: "root",
							component: "Text",
							text: { path: "/reservation/guests" },
						},
					],
				},
			},
		]);
		expect(result.spec?.state).toEqual({
			reservation: { guests: "3" },
			rows: ["one", "changed"],
		});
		expect(original).toEqual({
			reservation: { guests: "2", note: "original" },
			rows: ["one", "two"],
		});
		expect(result.spec?.elements.root?.props.text).toEqual({
			$state: "/reservation/guests",
		});
		expect(result.issues).toEqual([]);
	});

	it("rejects array indices past the end so a stream cannot allocate a huge sparse array", () => {
		for (const path of ["/rows/4294967294", "/rows/4294967294/label"]) {
			const result = normalizeA2ui([
				{ createSurface: { surfaceId: "native" } },
				{ updateDataModel: { surfaceId: "native", value: { rows: ["one"] } } },
				{ updateDataModel: { surfaceId: "native", path, value: "x" } },
				{
					updateDataModel: {
						surfaceId: "native",
						path: "/rows/1",
						value: "two",
					},
				},
				{
					updateComponents: {
						surfaceId: "native",
						components: [{ id: "root", component: "Text", text: "ok" }],
					},
				},
			]);
			expect(result.spec?.state).toEqual({ rows: ["one", "two"] });
			expect(result.issues).toEqual([
				"A2UI array path segment is out of range: 4294967294",
			]);
		}
	});
});
