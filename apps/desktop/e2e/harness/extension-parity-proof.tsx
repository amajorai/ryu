import { useModelContextStore } from "@ryu/app-host/model-context";
import { AppWidget } from "@ryu/blocks/desktop/agent-elements/app-widget.tsx";
import {
	WidgetHostContext,
	type WidgetHostValue,
} from "@ryu/blocks/desktop/agent-elements/widget-host-context.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { ThemeProvider, useTheme } from "next-themes";
import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { RichMcpForm } from "../../src/components/chat/McpForms.tsx";
import { parseMcpForms } from "../../src/components/chat/mcp-form-schema.ts";
import { createOpenedFileAccess } from "../../src/lib/plugin-file-handlers.ts";
import "../../src/index.css";

const fileAccess = createOpenedFileAccess("selected-file.txt", true, {
	read: async () => {
		const response = await fetch("/__proof/file");
		return response.text();
	},
	write: async (_path, text) => {
		const response = await fetch("/__proof/file", {
			method: "PUT",
			body: text,
		});
		if (!response.ok) {
			throw new Error("Save failed");
		}
	},
});
const appHtml = `<!doctype html><html><head><style>body{font:14px system-ui;background:transparent;color:inherit;padding:16px}button,textarea{font:inherit;margin:4px;padding:8px;border:1px solid #888;border-radius:6px}textarea{display:block;width:85%}#status{margin-top:12px}</style></head><body><h2>Parts editor</h2><p>Selected file and model context</p><button id="context">Share selection</button><button id="pip">Picture in picture</button><button id="fullscreen">Fullscreen</button><button id="read">Read file</button><textarea id="text" aria-label="File contents"></textarea><button id="save">Save file</button><p id="status">Connecting to Ryu…</p><script>
let next=1,etag;const pending=new Map();function call(method,params={}){return new Promise((resolve,reject)=>{const id=next++;pending.set(id,{resolve,reject});parent.postMessage({jsonrpc:'2.0',id,method,params},'*');});}
addEventListener('message',event=>{const data=event.data;if(data?.jsonrpc!=='2.0')return;if('id'in data){const waiter=pending.get(data.id);if(waiter){pending.delete(data.id);data.error?waiter.reject(new Error(data.error.message)):waiter.resolve(data.result);}}});
async function run(action){try{await action();}catch(error){document.getElementById('status').textContent=error.message;}}
call('ui/initialize',{protocolVersion:'2026-01-26',appInfo:{name:'Parts editor',version:'1.0.0'},appCapabilities:{}}).then(()=>{parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized'},'*');document.getElementById('status').textContent='Connected';});
document.getElementById('context').onclick=()=>run(async()=>{await call('ui/update-model-context',{content:[{type:'text',text:'Selected part: M6 hex bolt',_meta:{secret:'must not reach model'}}],structuredContent:{part:'hex-bolt'}});document.getElementById('status').textContent='Selection shared';});
document.getElementById('pip').onclick=()=>run(()=>call('ui/request-display-mode',{mode:'pip'}));document.getElementById('fullscreen').onclick=()=>run(()=>call('ui/request-display-mode',{mode:'fullscreen'}));
document.getElementById('read').onclick=()=>run(async()=>{const result=await call('resources/read',{uri:'${fileAccess.uri}'});document.getElementById('text').value=result.contents[0].text;etag=result.contents[0]._meta['openai/resource'].etag;document.getElementById('status').textContent='File loaded';});
document.getElementById('save').onclick=()=>run(async()=>{const result=await call('openai/resources/write',{uri:'${fileAccess.uri}',text:document.getElementById('text').value,ifMatch:etag});etag=result.etag;document.getElementById('status').textContent=result.outcome==='saved'?'File saved':result.outcome;});
</script></body></html>`;
const part = {
	type: "data-tool-widget-available",
	data: {
		toolCallId: "proof-call",
		toolName: "parts.open",
		instanceId: "proof-instance",
		serverId: "parts",
		toolInput: {},
		toolOutput: { part: "hex-bolt" },
		toolResponseMetadata: {},
		widgetAccessible: false,
		approvedGrants: ["assistant:context"],
		widget: { html: appHtml, mimeType: "text/html" },
	},
};
const forms = parseMcpForms({
	forms: [
		{
			id: "proof-form",
			conversation_id: "proof-conversation",
			server: "Parts",
			message: "Choose a part and quantity",
			requested_schema: {
				type: "object",
				properties: {
					part: {
						type: "string",
						title: "Part",
						oneOf: [
							{
								const: "bolt",
								title: "Hex bolt",
								"x-openai-thumbnail": { src: "https://proof.example/bolt.png" },
							},
							{
								const: "washer",
								title: "Washer",
								"x-openai-thumbnail": {
									src: "https://proof.example/washer.png",
								},
							},
						],
					},
					quantity: {
						type: "integer",
						title: "Quantity",
						minimum: 1,
						maximum: 10,
						default: 2,
					},
				},
				required: ["part", "quantity"],
			},
		},
	],
});
function Proof() {
	const [outcome, setOutcome] = useState("");
	const { resolvedTheme, setTheme } = useTheme();
	const dark = resolvedTheme === "dark";
	const entries = useModelContextStore((state) => state.entries);
	const host = useMemo<WidgetHostValue>(
		() => ({
			Renderer: AppWidget,
			env: {
				proxyOrigin: location.origin,
				openExternal: () => undefined,
				appTitle: "Parts editor",
			},
			services: {
				fileAccess,
				callTool: async () => ({ ok: true, output: {} }),
				setWidgetState: async () => undefined,
				sendFollowUpMessage: async () => undefined,
				updateModelContext: async ({ owner, input }) =>
					useModelContextStore.getState().update("proof", owner, input),
				getModelContext: (owner) =>
					useModelContextStore.getState().get("proof", owner),
				clearModelContext: (owner) =>
					useModelContextStore.getState().clear(owner),
			},
		}),
		[]
	);
	return (
		<main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 bg-background p-6 text-foreground">
			<header className="flex items-center justify-between">
				<div>
					<h1 className="font-semibold text-2xl">Extension host</h1>
					<p className="text-muted-foreground text-sm">
						Ryu production components · local integration harness
					</p>
				</div>
				<Button
					onClick={() => {
						setTheme(dark ? "light" : "dark");
					}}
					variant="outline"
				>
					{dark ? "Light mode" : "Dark mode"}
				</Button>
			</header>
			<div className="grid gap-6 lg:grid-cols-2">
				<section className="flex min-h-96 flex-col gap-3 rounded-xl border bg-card p-4">
					<h2 className="font-medium">MCP App</h2>
					<WidgetHostContext.Provider value={host}>
						<AppWidget part={part} />
					</WidgetHostContext.Provider>
					<p className="text-sm" data-testid="model-context">
						{Object.keys(entries).length
							? "Selected part: M6 hex bolt shared with model"
							: "No app context attached"}
					</p>
				</section>
				<section className="flex flex-col gap-4 rounded-xl border bg-card p-4">
					<h2 className="font-medium">Requested information</h2>
					{forms[0] ? (
						<RichMcpForm
							form={forms[0]}
							onRespond={async (response) => {
								setOutcome(
									response.action === "accept"
										? `Submitted: ${JSON.stringify(response.content)}`
										: `Request ${response.action}ed`
								);
							}}
						/>
					) : null}
					<p className="text-sm" role="status">
						{outcome}
					</p>
				</section>
			</div>
		</main>
	);
}
const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<ThemeProvider attribute="class" defaultTheme="light" enableSystem={false}>
			<Proof />
		</ThemeProvider>
	);
}
