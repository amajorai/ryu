import { appendFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const host = createRequire(
	import.meta.resolve("@earendil-works/pi-coding-agent")
);
const { Type } = host("typebox");
const { Check } = host("typebox/value");
const valueSchema = Type.Cyclic(
	{
		Value: Type.Union([
			Type.Null(),
			Type.Boolean(),
			Type.Number(),
			Type.String(),
			Type.Array(Type.Ref("Value")),
			Type.Record(Type.String(), Type.Ref("Value")),
		]),
	},
	"Value"
);
const envelopeSchema = Type.Object({
	id: Type.Optional(Type.Union([Type.Number(), Type.String()])),
	method: Type.Optional(Type.String()),
	params: Type.Optional(valueSchema),
	result: Type.Optional(valueSchema),
});
const hierarchyParamsSchema = Type.Object({
	item: Type.Object({ name: Type.String(), data: valueSchema }),
});
const documentSchema = Type.Object({
	textDocument: Type.Object({ uri: Type.String(), version: Type.Number() }),
});
const position = { line: 4, character: 2 };
const range = { start: position, end: { line: 4, character: 6 } };
const opaque = JSON.parse(
	'{"__proto__":{"retained":"yes"},"future":[false,0,null]}'
);
let uri = "";
let buffer = Buffer.alloc(0);
const log = process.argv[2];
writeFileSync(`${log}.pid`, String(process.pid));
function send(message) {
	const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }));
	const frame = Buffer.concat([
		Buffer.from(`Content-Length: ${body.length}\r\n\r\n`),
		body,
	]);
	// Every frame is fragmented; multibyte payloads exercise byte-count framing.
	const split = Math.floor(frame.length / 2);
	process.stdout.write(frame.subarray(0, split));
	process.stdout.write(frame.subarray(split));
}
function item(name) {
	return {
		name,
		kind: name === "Child" ? 999 : 12,
		uri,
		range,
		selectionRange: range,
		data: opaque,
		futureMetadata: { retained: true },
	};
}
function dispatch(message) {
	appendFileSync(log, `${JSON.stringify(message)}\n`);
	switch (message.method) {
		case "initialize":
			process.stdout.write("Content-Length: 67108865\r\n\r\n");
			send({
				id: 1001,
				method: "workspace/configuration",
				params: { items: [{ section: "one" }, { section: "two" }] },
			});
			send({
				id: 1002,
				method: "client/registerCapability",
				params: { registrations: [] },
			});
			send({
				id: message.id,
				result: {
					capabilities: {
						definitionProvider: true,
						hoverProvider: true,
						documentSymbolProvider: true,
						workspaceSymbolProvider: true,
						callHierarchyProvider: true,
						textDocumentSync: { save: { includeText: true } },
					},
				},
			});
			break;
		case "textDocument/didOpen":
		case "textDocument/didChange":
			if (!Check(documentSchema, message.params)) {
				throw new Error("Invalid native document sync");
			}
			uri = message.params.textDocument.uri.replaceAll("%C3%A9", "%c3%a9");
			send({
				method: "textDocument/publishDiagnostics",
				params: {
					uri,
					version: message.params.textDocument.version,
					diagnostics: [
						{ message: "Fresh café 診断", range, severity: 2 },
						{ message: 123 },
					],
				},
			});
			send({
				method: "textDocument/publishDiagnostics",
				params: {
					uri,
					version: message.params.textDocument.version - 1,
					diagnostics: [{ message: "Stale error", range, severity: 1 }],
				},
			});
			break;
		case "textDocument/definition":
			send({
				id: message.id,
				result: [
					{
						targetUri: uri,
						targetSelectionRange: range,
						targetRange: {
							start: { line: 1, character: 0 },
							end: { line: 9, character: 0 },
						},
					},
					{ uri, range: { start: "invalid" } },
				],
			});
			break;
		case "textDocument/hover":
			send({
				id: message.id,
				result: {
					contents: ["Café", { kind: "markdown", value: "診断 documentation" }],
				},
			});
			break;
		case "textDocument/prepareCallHierarchy":
			send({ id: message.id, result: [item("Root")] });
			break;
		case "callHierarchy/outgoingCalls":
			if (!Check(hierarchyParamsSchema, message.params)) {
				throw new Error("Invalid native hierarchy request");
			}
			if (JSON.stringify(message.params.item.data) !== JSON.stringify(opaque)) {
				throw new Error("Opaque hierarchy data was changed");
			}
			send({
				id: message.id,
				result:
					message.params.item.name === "Root"
						? [{ to: item("Child"), fromRanges: [range] }]
						: [],
			});
			break;
		case "shutdown":
			send({ id: message.id, result: null });
			break;
		case "exit":
			process.exit(0);
			break;
		default:
			if (message.id !== undefined && message.method) {
				send({ id: message.id, result: null });
			}
	}
}
process.stdin.on("data", (chunk) => {
	buffer = Buffer.concat([buffer, chunk]);
	for (;;) {
		const headerEnd = buffer.indexOf("\r\n\r\n");
		if (headerEnd < 0) {
			return;
		}
		const length = Number(
			/Content-Length:\s*(\d+)/i.exec(
				buffer.subarray(0, headerEnd).toString()
			)?.[1]
		);
		const end = headerEnd + 4 + length;
		if (buffer.length < end) {
			return;
		}
		const message = JSON.parse(buffer.subarray(headerEnd + 4, end).toString());
		buffer = buffer.subarray(end);
		if (!Check(envelopeSchema, message)) {
			throw new Error("Invalid native JSONRPC request");
		}
		dispatch(message);
	}
});
