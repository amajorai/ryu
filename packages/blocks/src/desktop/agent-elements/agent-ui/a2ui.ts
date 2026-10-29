import type { Spec, StateModel } from "@json-render/core";
import { z } from "zod";
import type { AgentUiSpec } from "./template.ts";

/** The A2UI catalog Ryu currently knows how to map into its native catalog. */
export const A2UI_BASIC_CATALOG_IDS = [
	"https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json",
	"https://a2ui.org/specification/v0_9.1/catalogs/basic/catalog.json",
] as const;

const MAX_MESSAGES = 128;
const MAX_COMPONENTS = 100;
const MAX_ID_LENGTH = 128;
const MAX_COMPONENT_NAME_LENGTH = 64;
const MAX_ISSUES = 32;
/** Array writes may only replace or append; a huge index would allocate a vast sparse array. */
const MAX_ARRAY_INDEX = 1000;
const FORBIDDEN_POINTER_SEGMENTS = new Set([
	"__proto__",
	"constructor",
	"prototype",
]);

const textSchema = z.string();
const flagSchema = z.boolean();
// Direct native messages can retain non-finite decoded numbers; the mapper
// previously passed these through rather than silently choosing a new bound.
const numberSchema = z.union([
	z.number(),
	z.nan(),
	z.literal(Number.POSITIVE_INFINITY),
	z.literal(Number.NEGATIVE_INFINITY),
]);
const versionSchema = z.enum(["v0.9", "v0.9.1"]);
const supportedCatalogIds = new Set<string>(A2UI_BASIC_CATALOG_IDS);

/** Raw wire slots are decoded independently so one bad field cannot discard a surface. */
interface A2uiCarrier {
	action?: unknown;
	align?: unknown;
	axis?: unknown;
	catalogId?: unknown;
	child?: unknown;
	children?: unknown;
	component?: unknown;
	components?: unknown;
	context?: unknown;
	createSurface?: unknown;
	deleteSurface?: unknown;
	description?: unknown;
	direction?: unknown;
	event?: unknown;
	href?: unknown;
	id?: unknown;
	justify?: unknown;
	label?: unknown;
	literalBoolean?: unknown;
	literalNumber?: unknown;
	literalString?: unknown;
	literalStringList?: unknown;
	max?: unknown;
	messages?: unknown;
	min?: unknown;
	name?: unknown;
	options?: unknown;
	path?: unknown;
	surfaceId?: unknown;
	text?: unknown;
	title?: unknown;
	updateComponents?: unknown;
	updateDataModel?: unknown;
	url?: unknown;
	value?: unknown;
	variant?: unknown;
	version?: unknown;
}

// An empty Zod object tests the native non-array object carrier without touching
// getters or replacing its identity. Every consumed slot has its own decoder.
const carrierSchema = z.custom<A2uiCarrier>(
	(value) => z.object({}).safeParse(value).success
);
const stateObjectSchema = z.custom<StateModel>(
	(value) => carrierSchema.safeParse(value).success
);
const messageOperations = [
	"createSurface",
	"updateComponents",
	"updateDataModel",
	"deleteSurface",
] as const;

interface A2uiComponent extends A2uiCarrier {
	component: string;
	id: string;
}

interface A2uiCreateSurface extends A2uiCarrier {
	catalogId?: string;
	surfaceId: string;
}

interface A2uiUpdateComponents extends A2uiCarrier {
	components: A2uiComponent[];
	surfaceId: string;
}

interface A2uiUpdateDataModel extends A2uiCarrier {
	path?: string;
	surfaceId: string;
	value?: unknown;
}

interface A2uiDeleteSurface extends A2uiCarrier {
	surfaceId: string;
}

interface A2uiMessage {
	createSurface?: A2uiCreateSurface;
	deleteSurface?: A2uiDeleteSurface;
	updateComponents?: A2uiUpdateComponents;
	updateDataModel?: A2uiUpdateDataModel;
	version?: string;
}

/** Renderer state retains the native JSON-render values and binding semantics. */
export type AgentUiRenderSpec = AgentUiSpec & Pick<Spec, "state">;

type AgentUiElement = AgentUiSpec["elements"][string];

export interface A2uiNormalizationResult {
	issues: string[];
	spec: AgentUiRenderSpec | null;
	surfaceId?: string;
}

interface SurfaceState {
	catalogId?: string;
	components: Map<string, A2uiComponent>;
	dataModel: unknown;
	id: string;
}

function isObject(
	value: Parameters<typeof carrierSchema.safeParse>[0]
): value is A2uiCarrier {
	return carrierSchema.safeParse(value).success;
}

function boundedTextSchema(maxLength: number) {
	return textSchema.min(1).max(maxLength).nullable().catch(null);
}

function pushIssue(issues: string[], message: string): void {
	if (issues.length < MAX_ISSUES && !issues.includes(message)) {
		issues.push(message);
	}
}

function versionInputSchema(issues: string[]) {
	return versionSchema.optional().catch(({ input }) => {
		pushIssue(issues, `Unsupported A2UI protocol version: ${String(input)}`);
		return undefined;
	});
}

function surfaceIdInputSchema(operation: string, issues: string[]) {
	return boundedTextSchema(MAX_ID_LENGTH).transform((surfaceId) => {
		if (!surfaceId) {
			pushIssue(issues, `${operation} requires a bounded string surfaceId`);
		}
		return surfaceId;
	});
}

function messageInputSchema(index: number, issues: string[]) {
	return z.unknown().transform((input): A2uiMessage | null => {
		if (!isObject(input)) {
			pushIssue(issues, `A2UI message ${index + 1} must be an object`);
			return null;
		}

		const version = versionInputSchema(issues).parse(input.version);
		const operations = messageOperations.filter((key) => key in input);
		if (operations.length !== 1) {
			pushIssue(
				issues,
				`A2UI message ${index + 1} must contain exactly one supported operation`
			);
			return null;
		}

		const operation = operations[0];
		if (!operation) {
			return null;
		}
		const payload = input[operation];
		if (!isObject(payload)) {
			pushIssue(issues, `A2UI ${operation} payload must be an object`);
			return null;
		}

		if (operation === "createSurface") {
			const surfaceId = surfaceIdInputSchema(operation, issues).parse(
				payload.surfaceId
			);
			if (!surfaceId) {
				return null;
			}
			const catalogId =
				payload.catalogId === undefined
					? undefined
					: boundedTextSchema(512).parse(payload.catalogId);
			if (payload.catalogId !== undefined && !catalogId) {
				pushIssue(
					issues,
					"A2UI createSurface catalogId must be a bounded string"
				);
				return null;
			}
			return {
				version,
				createSurface: {
					...payload,
					surfaceId,
					catalogId: catalogId ?? undefined,
				},
			};
		}

		if (operation === "updateComponents") {
			const surfaceId = surfaceIdInputSchema(operation, issues).parse(
				payload.surfaceId
			);
			if (!(surfaceId && Array.isArray(payload.components))) {
				pushIssue(issues, "A2UI updateComponents requires a components array");
				return null;
			}
			const components: A2uiComponent[] = [];
			for (const [
				componentIndex,
				rawComponent,
			] of payload.components.entries()) {
				if (!isObject(rawComponent)) {
					pushIssue(
						issues,
						`A2UI component ${componentIndex + 1} in message ${index + 1} must be an object`
					);
					continue;
				}
				const id = boundedTextSchema(MAX_ID_LENGTH).parse(rawComponent.id);
				const component = boundedTextSchema(MAX_COMPONENT_NAME_LENGTH).parse(
					rawComponent.component
				);
				if (!(id && component)) {
					pushIssue(
						issues,
						`A2UI component ${componentIndex + 1} needs bounded id and component fields`
					);
					continue;
				}
				components.push({ ...rawComponent, id, component });
			}
			return {
				version,
				updateComponents: { ...payload, surfaceId, components },
			};
		}

		if (operation === "updateDataModel") {
			const surfaceId = surfaceIdInputSchema(operation, issues).parse(
				payload.surfaceId
			);
			const parsedPath = textSchema.safeParse(
				payload.path === undefined ? "/" : payload.path
			);
			if (
				!(surfaceId && parsedPath.success && parsedPath.data.startsWith("/"))
			) {
				pushIssue(
					issues,
					"A2UI updateDataModel path must be an absolute JSON Pointer"
				);
				return null;
			}
			return {
				version,
				updateDataModel: { ...payload, path: parsedPath.data, surfaceId },
			};
		}

		const surfaceId = surfaceIdInputSchema(operation, issues).parse(
			payload.surfaceId
		);
		return surfaceId
			? { version, deleteSurface: { ...payload, surfaceId } }
			: null;
	});
}

function streamInputSchema(issues: string[]) {
	return z.unknown().transform((input): A2uiMessage[] => {
		let rawMessages: unknown[];
		const jsonLines = textSchema.safeParse(input);
		if (jsonLines.success) {
			rawMessages = jsonLines.data
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter(Boolean)
				.map((line, index) => {
					try {
						return JSON.parse(line);
					} catch {
						pushIssue(issues, `A2UI JSONL line ${index + 1} is not valid JSON`);
						return null;
					}
				});
		} else if (Array.isArray(input)) {
			rawMessages = input;
		} else if (isObject(input) && Array.isArray(input.messages)) {
			rawMessages = input.messages;
		} else {
			rawMessages = [input];
		}

		if (rawMessages.length > MAX_MESSAGES) {
			pushIssue(
				issues,
				`A2UI streams may contain at most ${MAX_MESSAGES} messages`
			);
			rawMessages = rawMessages.slice(0, MAX_MESSAGES);
		}
		return rawMessages.flatMap((message, index) => {
			const parsed = messageInputSchema(index, issues).parse(message);
			return parsed ? [parsed] : [];
		});
	});
}

function decodePointerSegment(segment: string): string | null {
	const decoded = segment.replaceAll("~1", "/").replaceAll("~0", "~");
	return FORBIDDEN_POINTER_SEGMENTS.has(decoded) ? null : decoded;
}

function pointerSegments(path: string): string[] | null {
	if (path === "/") {
		return [];
	}
	const segments = path.slice(1).split("/");
	const decoded = segments.map(decodePointerSegment);
	return decoded.every((segment): segment is string => segment !== null)
		? decoded
		: null;
}

/** Clone values for the real JSON-render state store, retaining its native leaf contract. */
function cloneJson(value: StateModel[string]): StateModel[string] {
	if (Array.isArray(value)) {
		return value.map(cloneJson);
	}
	if (isObject(value)) {
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [key, cloneJson(entry)])
		);
	}
	return value;
}

function updateDataModel(
	current: StateModel[string],
	path: string,
	value: StateModel[string],
	hasValue: boolean,
	issues: string[]
): StateModel[string] {
	const segments = pointerSegments(path);
	if (!segments) {
		pushIssue(issues, "A2UI data model paths may not address prototype keys");
		return current;
	}
	if (segments.length === 0) {
		return hasValue ? cloneJson(value) : {};
	}

	const root = cloneJson(current);
	let cursor: StateModel[string] = root;
	if (!(Array.isArray(cursor) || isObject(cursor))) {
		cursor = {};
	}
	const rootValue = cursor;
	for (const [index, segment] of segments.entries()) {
		const last = index === segments.length - 1;
		if (Array.isArray(cursor)) {
			const arrayIndex = Number(segment);
			if (!Number.isInteger(arrayIndex) || arrayIndex < 0) {
				pushIssue(issues, `A2UI array path segment is invalid: ${segment}`);
				return current;
			}
			if (arrayIndex > cursor.length || arrayIndex >= MAX_ARRAY_INDEX) {
				pushIssue(
					issues,
					`A2UI array path segment is out of range: ${segment}`
				);
				return current;
			}
			if (last) {
				if (hasValue) {
					cursor[arrayIndex] = cloneJson(value);
				} else {
					cursor.splice(arrayIndex, 1);
				}
				return rootValue;
			}
			if (
				!(Array.isArray(cursor[arrayIndex]) || isObject(cursor[arrayIndex]))
			) {
				cursor[arrayIndex] = {};
			}
			cursor = cursor[arrayIndex];
			continue;
		}
		const cursorObject = stateObjectSchema.safeParse(cursor);
		if (!cursorObject.success) {
			pushIssue(
				issues,
				"A2UI data model path does not address an object or array"
			);
			return current;
		}
		if (last) {
			if (hasValue) {
				cursorObject.data[segment] = cloneJson(value);
			} else {
				delete cursorObject.data[segment];
			}
			return rootValue;
		}
		if (
			!(
				Array.isArray(cursorObject.data[segment]) ||
				isObject(cursorObject.data[segment])
			)
		) {
			cursorObject.data[segment] = {};
		}
		cursor = cursorObject.data[segment];
	}
	return rootValue;
}

function supportedCatalog(catalogId: string | undefined): boolean {
	return catalogId === undefined || supportedCatalogIds.has(catalogId);
}

function expressionInputSchema(
	binding: boolean,
	issues: string[]
): z.ZodType<StateModel[string]> {
	return z.unknown().transform((value) => {
		if (!isObject(value)) {
			return value;
		}
		const literalString = textSchema.safeParse(value.literalString);
		if (literalString.success) {
			return literalString.data;
		}
		const literalNumber = numberSchema.safeParse(value.literalNumber);
		if (literalNumber.success) {
			return literalNumber.data;
		}
		const literalBoolean = flagSchema.safeParse(value.literalBoolean);
		if (literalBoolean.success) {
			return literalBoolean.data;
		}
		if (Array.isArray(value.literalStringList)) {
			return value.literalStringList.flatMap((entry) => {
				const parsed = textSchema.safeParse(entry);
				return parsed.success ? [parsed.data] : [];
			});
		}
		const statePath = textSchema.safeParse(value.path);
		if (statePath.success) {
			if (!statePath.data.startsWith("/")) {
				pushIssue(
					issues,
					`A2UI relative data path is not supported: ${statePath.data}`
				);
				return undefined;
			}
			return binding
				? { $bindState: statePath.data }
				: { $state: statePath.data };
		}
		if ("functionCall" in value) {
			pushIssue(
				issues,
				"A2UI functionCall expressions are not executed by Ryu"
			);
			return undefined;
		}
		return Object.fromEntries(
			Object.entries(value)
				.map(([key, entry]) => [
					key,
					expressionInputSchema(false, issues).parse(entry),
				])
				.filter(([, entry]) => entry !== undefined)
		);
	});
}

function childrenOf(component: A2uiComponent, issues: string[]): string[] {
	const children = component.children;
	if (Array.isArray(children)) {
		return children.flatMap((child) => {
			const parsed = textSchema.min(1).max(MAX_ID_LENGTH).safeParse(child);
			return parsed.success ? [parsed.data] : [];
		});
	}
	if (isObject(children)) {
		pushIssue(
			issues,
			`A2UI repeat/template children are not supported for ${component.component}`
		);
	}
	return [];
}

function textFromComponent(
	component: A2uiComponent | undefined,
	issues: string[]
) {
	return component?.component === "Text"
		? expressionInputSchema(false, issues).parse(component.text ?? "")
		: undefined;
}

function actionFor(
	component: A2uiComponent,
	surfaceId: string,
	issues: string[]
) {
	if (!isObject(component.action)) {
		return undefined;
	}
	if ("functionCall" in component.action) {
		pushIssue(
			issues,
			"A2UI local functionCall actions are not executed by Ryu"
		);
		return undefined;
	}
	const event = component.action.event;
	if (!isObject(event)) {
		return undefined;
	}
	const eventName = textSchema.safeParse(event.name);
	if (!eventName.success) {
		return undefined;
	}
	return {
		press: {
			action: "submit",
			params: {
				value: {
					protocol: "a2ui",
					name: eventName.data,
					surfaceId,
					context: expressionInputSchema(false, issues).parse(
						event.context ?? {}
					),
				},
			},
		},
	};
}

const alignValue = z
	.enum(["start", "center", "end", "stretch"])
	.optional()
	.catch(undefined).parse;

const justifyValue = z
	.enum([
		"start",
		"center",
		"end",
		"spaceBetween",
		"spaceAround",
		"spaceEvenly",
	])
	.optional()
	.catch(undefined)
	.transform((value) => {
		switch (value) {
			case "start":
			case "center":
			case "end":
				return value;
			case "spaceBetween":
				return "between";
			case "spaceAround":
			case "spaceEvenly":
				return "around";
			default:
				return undefined;
		}
	}).parse;

function unsupportedElement(
	component: A2uiComponent,
	issues: string[]
): AgentUiElement {
	pushIssue(issues, `A2UI component is not mapped: ${component.component}`);
	return {
		type: "Alert",
		props: {
			title: "Unsupported A2UI component",
			description: component.component,
		},
		children: [],
	};
}

function mapComponent(
	component: A2uiComponent,
	components: Map<string, A2uiComponent>,
	surfaceId: string,
	issues: string[]
): AgentUiElement {
	const children = childrenOf(component, issues);
	const parsedChild = textSchema.safeParse(component.child);
	const child = parsedChild.success ? parsedChild.data : children[0];
	const on = actionFor(component, surfaceId, issues);
	const mapped = (
		type: string,
		props: AgentUiElement["props"],
		nextChildren = children
	): AgentUiElement => {
		const element: AgentUiElement = { type, props, children: nextChildren };
		if (on) {
			element.on = on;
		}
		return element;
	};

	switch (component.component) {
		case "Column":
			return mapped("Stack", {
				direction: "column",
				align: alignValue(component.align),
				justify: justifyValue(component.justify),
			});
		case "Row":
			return mapped("Stack", {
				direction: "row",
				align: alignValue(component.align),
				justify: justifyValue(component.justify),
			});
		case "List":
			return mapped("Stack", {
				direction: component.direction === "horizontal" ? "row" : "column",
				align: alignValue(component.align),
			});
		case "Card":
			return mapped("Card", {}, child ? [child] : []);
		case "Divider":
			return mapped(
				"Separator",
				{
					orientation:
						component.axis === "vertical" ? "vertical" : "horizontal",
				},
				[]
			);
		case "Text": {
			const text = expressionInputSchema(false, issues).parse(
				component.text ?? ""
			);
			const variant = component.variant;
			if (
				variant === "h1" ||
				variant === "h2" ||
				variant === "h3" ||
				variant === "h4" ||
				variant === "h5"
			) {
				return mapped(
					"Heading",
					{
						text,
						level: variant === "h5" ? 4 : Number(variant.slice(1)),
					},
					[]
				);
			}
			return mapped(
				"Text",
				{
					text,
					size: variant === "caption" ? "xs" : "sm",
				},
				[]
			);
		}
		case "Image":
			return mapped(
				"Image",
				{
					src: expressionInputSchema(false, issues).parse(component.url ?? ""),
					alt: expressionInputSchema(false, issues).parse(
						component.description ?? ""
					),
				},
				[]
			);
		case "Link":
			return mapped(
				"Link",
				{
					text: expressionInputSchema(false, issues).parse(
						component.text ?? component.title ?? "Open link"
					),
					href: expressionInputSchema(false, issues).parse(
						component.url ?? component.href ?? ""
					),
				},
				[]
			);
		case "Button":
			return mapped(
				"Button",
				{
					label:
						textFromComponent(
							child ? components.get(child) : undefined,
							issues
						) ?? "Continue",
					variant:
						component.variant === "primary"
							? "default"
							: component.variant === "borderless"
								? "link"
								: "secondary",
				},
				[]
			);
		case "TextField": {
			const value = expressionInputSchema(true, issues).parse(
				component.value ?? ""
			);
			const props = {
				label: expressionInputSchema(false, issues).parse(
					component.label ?? ""
				),
				value,
			};
			if (component.variant === "longText") {
				return mapped("Textarea", props, []);
			}
			return mapped(
				"Input",
				{
					...props,
					type:
						component.variant === "number"
							? "number"
							: component.variant === "obscured"
								? "password"
								: "text",
				},
				[]
			);
		}
		case "CheckBox":
			return mapped(
				"Checkbox",
				{
					label: expressionInputSchema(false, issues).parse(
						component.label ?? ""
					),
					checked: expressionInputSchema(true, issues).parse(
						component.value ?? false
					),
				},
				[]
			);
		case "ChoicePicker": {
			if (component.variant === "multipleSelection") {
				return unsupportedElement(component, issues);
			}
			const options = Array.isArray(component.options)
				? component.options.flatMap((option) => {
						if (!isObject(option)) {
							return [];
						}
						const optionValue = textSchema.safeParse(option.value);
						if (!optionValue.success) {
							return [];
						}
						return [
							{
								label: expressionInputSchema(false, issues).parse(
									option.label ?? optionValue.data
								),
								value: optionValue.data,
							},
						];
					})
				: [];
			return mapped(
				"OptionList",
				{
					label: expressionInputSchema(false, issues).parse(
						component.label ?? ""
					),
					value: expressionInputSchema(true, issues).parse(
						component.value ?? ""
					),
					options,
				},
				[]
			);
		}
		case "Slider":
			return mapped(
				"Slider",
				{
					label: expressionInputSchema(false, issues).parse(
						component.label ?? ""
					),
					value: expressionInputSchema(true, issues).parse(
						component.value ?? 0
					),
					min: numberSchema.catch(0).parse(component.min),
					max: numberSchema.catch(100).parse(component.max),
				},
				[]
			);
		case "DateTimeInput":
			return mapped(
				"Input",
				{
					label: expressionInputSchema(false, issues).parse(
						component.label ?? "Date and time"
					),
					value: expressionInputSchema(true, issues).parse(
						component.value ?? ""
					),
					type: "text",
				},
				[]
			);
		default:
			return unsupportedElement(component, issues);
	}
}

function isSupportedRoot(elements: AgentUiSpec["elements"]): boolean {
	return Object.hasOwn(elements, "root");
}

/**
 * Convert a bounded A2UI v0.9/v0.9.1 message sequence into Ryu's native spec.
 *
 * This deliberately maps only the known A2UI basic catalog into the closed Ryu
 * catalog. It never downloads a catalog, evaluates a function call, or executes
 * HTML/JavaScript. Unsupported components remain visible as inert Alert nodes so
 * a foreign surface cannot crash or escape the native renderer.
 */
export const normalizeA2ui = z
	.unknown()
	.transform((input): A2uiNormalizationResult => {
		const issues: string[] = [];
		const messages = streamInputSchema(issues).parse(input);
		let surface: SurfaceState | null = null;
		let sawMultipleSurfaces = false;

		for (const message of messages) {
			if (message.createSurface) {
				if (surface && surface.id !== message.createSurface.surfaceId) {
					sawMultipleSurfaces = true;
					pushIssue(
						issues,
						"Ryu Agent UI currently renders one A2UI surface per card"
					);
					continue;
				}
				surface = {
					catalogId: message.createSurface.catalogId,
					components: new Map(),
					dataModel: {},
					id: message.createSurface.surfaceId,
				};
				if (!supportedCatalog(surface.catalogId)) {
					pushIssue(issues, `Unsupported A2UI catalog: ${surface.catalogId}`);
				}
				continue;
			}

			if (message.deleteSurface) {
				if (surface?.id === message.deleteSurface.surfaceId) {
					surface = null;
				}
				continue;
			}

			if (message.updateComponents) {
				if (!surface) {
					pushIssue(
						issues,
						"A2UI updateComponents arrived before createSurface"
					);
					continue;
				}
				if (surface.id !== message.updateComponents.surfaceId) {
					pushIssue(issues, "A2UI updateComponents targets another surface");
					continue;
				}
				for (const component of message.updateComponents.components) {
					if (
						surface.components.size >= MAX_COMPONENTS &&
						!surface.components.has(component.id)
					) {
						pushIssue(
							issues,
							`A2UI surfaces may contain at most ${MAX_COMPONENTS} components`
						);
						break;
					}
					surface.components.set(component.id, component);
				}
				continue;
			}

			if (message.updateDataModel) {
				if (!surface) {
					pushIssue(
						issues,
						"A2UI updateDataModel arrived before createSurface"
					);
					continue;
				}
				if (surface.id !== message.updateDataModel.surfaceId) {
					pushIssue(issues, "A2UI updateDataModel targets another surface");
					continue;
				}
				surface.dataModel = updateDataModel(
					surface.dataModel,
					message.updateDataModel.path ?? "/",
					message.updateDataModel.value,
					Object.hasOwn(message.updateDataModel, "value"),
					issues
				);
			}
		}

		if (!surface) {
			return { issues, spec: null };
		}
		if (sawMultipleSurfaces) {
			return { issues, spec: null, surfaceId: surface.id };
		}
		if (!supportedCatalog(surface.catalogId)) {
			return { issues, spec: null, surfaceId: surface.id };
		}
		const rawElements: AgentUiSpec["elements"] = {};
		const mappedIds = new Set<string>();
		for (const [id, component] of surface.components) {
			rawElements[id] = mapComponent(
				component,
				surface.components,
				surface.id,
				issues
			);
			mappedIds.add(id);
		}
		if (!isSupportedRoot(rawElements)) {
			pushIssue(issues, "A2UI surface must define a component with id 'root'");
			return { issues, spec: null, surfaceId: surface.id };
		}

		const elements = Object.fromEntries(
			Object.entries(rawElements).map(([id, element]) => {
				return [
					id,
					{
						...element,
						children: element.children.filter((child) => mappedIds.has(child)),
					},
				];
			})
		);

		const stateInput = stateObjectSchema.safeParse(surface.dataModel);
		const state = stateInput.success
			? stateInput.data
			: { value: surface.dataModel };
		return {
			issues,
			spec: { root: "root", elements, state },
			surfaceId: surface.id,
		};
	}).parse;
