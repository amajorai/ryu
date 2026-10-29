import { expect, test } from "bun:test";
import { createChatPageNativeHttpFixture, CHAT_PAGE_NATIVE_HTTP_SERVER_OPTIONS } from "./chat-page-native-http.host.ts";
test("observed max-model GET contracts use owned native HTTP authority and reject unknown models, queries and credentials", async () => {
 const fixture=createChatPageNativeHttpFixture("http://owned-max-model.test");
 const server=Bun.serve({...CHAT_PAGE_NATIVE_HTTP_SERVER_OPTIONS,port:0,fetch:req=>fixture.fetch(req,"a")});
 const headers={origin:"http://owned-max-model.test",authorization:"Bearer chat-page-native-node-a-token"};
 const model="gpt-5.1-codex-max";
 const paths=[`/api/models/${model}/launch-config`,`/api/agents/agent-fixture/capabilities?model=${model}`,`/api/routing/advice?agent_id=agent-fixture&model=${model}&at_conversation_start=true`];
 try {
 const replies=[];
 for(const path of paths){const response=await fetch(new URL(path,server.url),{headers});expect(response.status).toBe(200);replies.push(await response.json());}
 expect(replies[0]).toEqual({});
 expect(replies[1]).toEqual({detected:{reasoning:false,tools:false,vision:false},overrides:{reasoning:null,tools:null,vision:null},reasoning:false,tools:false,vision:false,source:"default"});
 expect(replies[2]).toEqual({original:{agent_id:"agent-fixture",model},effective:{agent_id:"agent-fixture",model},severity:"continue"});
 expect(fixture.snapshot().unexpected).toEqual([]);
 for(const path of [paths[0].replace(model,"foreign-model"),paths[1]+"&unknown=true",paths[2].replace("true","false")])expect((await fetch(new URL(path,server.url),{headers})).status).toBe(503);
 expect((await fetch(new URL(paths[0],server.url),{headers:{...headers,authorization:"Bearer foreign-token"}})).status).toBe(403);
 expect(fixture.snapshot().unexpected).toHaveLength(4);
 } finally {fixture.close();server.stop(true);}
});
