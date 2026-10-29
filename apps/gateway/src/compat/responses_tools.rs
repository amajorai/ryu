//! Reversible client tool identities at the Responses/Chat boundary.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, Default)]
pub struct ToolRegistry {
    pub chat_tools: Vec<Value>,
    bindings: BTreeMap<String, Binding>,
    pub hosted_web: Option<Value>,
}

#[derive(Clone, Debug)]
struct Binding {
    name: String,
    namespace: Option<String>,
    custom: bool,
    format: Option<Value>,
}

impl ToolRegistry {
    pub fn parse(tools: &[Value]) -> Result<Self, String> {
        // Bound the flattened declarations before validating or compiling any child.
        let mut callable_count = 0_usize;
        for tool in tools {
            let count = if tool.get("type").and_then(Value::as_str) == Some("namespace") {
                tool.get("tools")
                    .and_then(Value::as_array)
                    .map_or(0, Vec::len)
            } else {
                1
            };
            callable_count = callable_count.saturating_add(count);
            if callable_count > 128 {
                return Err("tools may contain at most 128 callable tools".into());
            }
        }
        let mut registry = Self::default();
        let mut identities = BTreeSet::new();
        for tool in tools {
            match tool.get("type").and_then(Value::as_str) {
                Some("namespace") => {
                    fields(tool, &["type", "name", "description", "tools"])?;
                    let namespace = name(tool)?;
                    description(tool)?;
                    let children = tool
                        .get("tools")
                        .and_then(Value::as_array)
                        .ok_or("namespace requires a tools array")?;
                    if children.is_empty() {
                        return Err("namespace requires at least one tool".into());
                    }
                    for child in children {
                        registry.add(child, Some(namespace), &mut identities)?;
                    }
                }
                Some("web_search" | "web_search_preview") => {
                    fields(
                        tool,
                        &["type", "external_web_access", "search_context_size"],
                    )?;
                    if registry.hosted_web.is_some() {
                        return Err("only one web search declaration is allowed".into());
                    }
                    if tool
                        .get("external_web_access")
                        .is_some_and(|value| !value.is_boolean())
                    {
                        return Err("external_web_access must be a boolean".into());
                    }
                    if tool.get("search_context_size").is_some_and(|value| {
                        !matches!(value.as_str(), Some("low" | "medium" | "high"))
                    }) {
                        return Err("unsupported web search context size".into());
                    }
                    registry.hosted_web = Some(tool.clone());
                    registry.chat_tools.push(json!({"type":"function","function":{
                        "name":"ryu_responses_web_search", "description":"Search the web through the Gateway's governed search service. External access may be disabled; then only cached results are eligible.",
                        "parameters":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"],"additionalProperties":false},"strict":true
                    }}));
                }
                _ => registry.add(tool, None, &mut identities)?,
            }
        }
        if registry.chat_tools.len() > 128 {
            return Err("tools may contain at most 128 callable tools".into());
        }
        if registry.bindings.contains_key("ryu_responses_web_search") {
            return Err("reserved hosted tool name".into());
        }
        Ok(registry)
    }

    fn add(
        &mut self,
        tool: &Value,
        namespace: Option<&str>,
        identities: &mut BTreeSet<(Option<String>, String)>,
    ) -> Result<(), String> {
        let custom = match tool.get("type").and_then(Value::as_str) {
            Some("function") => {
                fields(
                    tool,
                    &["type", "name", "description", "parameters", "strict"],
                )?;
                false
            }
            Some("custom") => {
                fields(tool, &["type", "name", "description", "format"])?;
                true
            }
            _ => {
                return Err(
                    "only function/custom tools, namespaces, and web search are supported".into(),
                )
            }
        };
        let name = name(tool)?.to_owned();
        let namespace = namespace.map(str::to_owned);
        if !identities.insert((namespace.clone(), name.clone())) {
            return Err("duplicate tool identity".into());
        }
        description(tool)?;
        if tool.get("strict").is_some_and(|value| !value.is_boolean()) {
            return Err("function tool strict must be a boolean".into());
        }
        let format = tool.get("format").cloned();
        if let Some(format) = &format {
            match format.get("type").and_then(Value::as_str) {
                Some("text") => fields(format, &["type"])?,
                Some("grammar") => {
                    fields(format, &["type", "syntax", "definition"])?;
                    if !matches!(
                        format.get("syntax").and_then(Value::as_str),
                        Some("regex" | "lark")
                    ) || format
                        .get("definition")
                        .and_then(Value::as_str)
                        .is_none_or(str::is_empty)
                    {
                        return Err(
                            "custom grammar requires regex/lark syntax and a definition".into()
                        );
                    }
                    if format["syntax"] == "lark" {
                        return Err(
                            "Lark custom tool grammar is not supported by this Gateway".into()
                        );
                    }
                    let definition = format["definition"].as_str().unwrap_or_default();
                    if definition.len() > 16_384 {
                        return Err("custom regex exceeds the bounded grammar limit".into());
                    }
                    regex::RegexBuilder::new(&format!("\\A(?:{definition})\\z"))
                        .size_limit(262_144)
                        .build()
                        .map_err(|_| {
                            "custom regex is unsupported or exceeds the bounded compiler limit"
                        })?;
                }
                _ => return Err("unsupported custom tool format".into()),
            }
        }
        let parameters = if custom {
            json!({"type":"object","properties":{"input":{"type":"string"}},"required":["input"],"additionalProperties":false})
        } else {
            tool.get("parameters")
                .filter(|value| value.is_object())
                .cloned()
                .ok_or("each function tool requires an object parameters schema")?
        };
        let wire = if namespace.is_some() || custom {
            let digest = Sha256::digest(
                serde_json::to_vec(&(&namespace, &name, custom))
                    .map_err(|_| "tool identity could not be encoded")?,
            );
            format!("ryu_rsp_{}", hex::encode(&digest[..16]))
        } else {
            name.clone()
        };
        if self.bindings.contains_key(&wire) {
            return Err("colliding tool wire names".into());
        }
        let mut function = json!({"name":wire,"parameters":parameters});
        let identity = namespace
            .as_ref()
            .map(|namespace| format!("{namespace}.{name}"))
            .unwrap_or_else(|| name.clone());
        let mut guidance = format!(
            "Client tool {identity}. {}",
            tool.get("description")
                .and_then(Value::as_str)
                .unwrap_or_default()
        );
        if let Some(format) = &format {
            if format.get("type").and_then(Value::as_str) == Some("grammar") {
                guidance.push_str(&format!(
                    " Input must follow this {} grammar: {}",
                    format["syntax"].as_str().unwrap_or_default(),
                    format["definition"].as_str().unwrap_or_default()
                ));
            }
        }
        function["description"] = json!(guidance);
        if let Some(value) = tool.get("strict") {
            function["strict"] = value.clone();
        }
        self.chat_tools
            .push(json!({"type":"function","function":function}));
        self.bindings.insert(
            wire,
            Binding {
                name,
                namespace,
                custom,
                format,
            },
        );
        Ok(())
    }

    pub fn wire_name(&self, name: &str, namespace: Option<&str>) -> Result<String, String> {
        self.bindings
            .iter()
            .find(|(_, binding)| binding.name == name && binding.namespace.as_deref() == namespace)
            .map(|(wire, _)| wire.clone())
            .ok_or_else(|| "tool identity was not declared".into())
    }

    pub fn input_call(&self, item: &Value) -> Result<Value, String> {
        let name = name(item)?;
        let wire = self.wire_name(name, item.get("namespace").and_then(Value::as_str))?;
        let binding = &self.bindings[&wire];
        let custom = item.get("type").and_then(Value::as_str) == Some("custom_tool_call");
        if custom != binding.custom {
            return Err("tool call type does not match its declaration".into());
        }
        let mut normalized = item.clone();
        normalized["type"] = json!("function_call");
        normalized["name"] = json!(wire);
        if custom {
            let input = item
                .get("input")
                .and_then(Value::as_str)
                .ok_or("custom tool call requires string input")?;
            normalized["arguments"] = json!(serde_json::to_string(&json!({"input":input}))
                .map_err(|_| "custom input could not be encoded")?);
        }
        Ok(normalized)
    }

    pub fn output_call(&self, item: &mut Value) -> Result<(), String> {
        let wire = item.get("name").and_then(Value::as_str).unwrap_or_default();
        let Some(binding) = self.bindings.get(wire) else {
            return Ok(());
        };
        item["name"] = json!(binding.name);
        if let Some(namespace) = &binding.namespace {
            item["namespace"] = json!(namespace);
        }
        if binding.custom {
            let arguments = item
                .get("arguments")
                .and_then(Value::as_str)
                .ok_or("custom tool arguments are missing")?;
            let arguments: Value =
                serde_json::from_str(arguments).map_err(|_| "invalid encoded custom tool input")?;
            let input = arguments
                .get("input")
                .and_then(Value::as_str)
                .ok_or("custom tool input must be text")?;
            if let Some(format) = &binding.format {
                if format.get("type").and_then(Value::as_str) == Some("grammar") {
                    if format["syntax"] == "regex" {
                        let pattern = format["definition"].as_str().unwrap_or_default();
                        let regex = regex::Regex::new(&format!("\\A(?:{pattern})\\z"))
                            .map_err(|_| "custom regex is unsupported")?;
                        if !regex.is_match(input) {
                            return Err("custom tool input violates its regex grammar".into());
                        }
                    } else {
                        return Err("this provider cannot validate Lark custom tool grammar".into());
                    }
                }
            }
            let input = input.to_owned();
            item["type"] = json!("custom_tool_call");
            item["input"] = json!(input);
            item.as_object_mut()
                .ok_or("tool call must be an object")?
                .remove("arguments");
        }
        Ok(())
    }

    pub fn output_start(&self, item: &mut Value) {
        let wire = item.get("name").and_then(Value::as_str).unwrap_or_default();
        let Some(binding) = self.bindings.get(wire) else {
            return;
        };
        item["name"] = json!(binding.name);
        if let Some(namespace) = &binding.namespace {
            item["namespace"] = json!(namespace);
        }
        if binding.custom {
            item["type"] = json!("custom_tool_call");
            item["input"] = json!("");
            item.as_object_mut()
                .expect("call object")
                .remove("arguments");
        }
    }

    pub fn custom_wire(&self, wire: &str) -> bool {
        self.bindings
            .get(wire)
            .is_some_and(|binding| binding.custom)
    }
}

fn fields(value: &Value, allowed: &[&str]) -> Result<(), String> {
    if value
        .as_object()
        .is_none_or(|object| object.keys().any(|key| !allowed.contains(&key.as_str())))
    {
        Err("tool declaration contains an unsupported field".into())
    } else {
        Ok(())
    }
}
fn name(value: &Value) -> Result<&str, String> {
    value
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.trim().is_empty() && name.len() <= 64)
        .ok_or_else(|| "tool requires a non-empty bounded name".into())
}
fn description(value: &Value) -> Result<(), String> {
    if value
        .get("description")
        .is_some_and(|value| !value.is_string())
    {
        Err("tool description must be a string".into())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn aggregate_namespace_limit_precedes_regex_compilation() {
        let children: Vec<Value> = (0..129)
            .map(|index| json!({"type":"custom","name":format!("tool_{index}"),"format":{"type":"grammar","syntax":"regex","definition":"["}}))
            .collect();
        let error =
            ToolRegistry::parse(&[json!({"type":"namespace","name":"many","tools":children})])
                .err()
                .unwrap();
        assert_eq!(error, "tools may contain at most 128 callable tools");
    }

    #[test]
    fn aggregate_namespace_limit_includes_hosted_and_top_level_tools() {
        let children: Vec<Value> = (0..126)
            .map(|index| json!({"type":"function","name":format!("tool_{index}"),"parameters":{}}))
            .collect();
        let mut tools = vec![
            json!({"type":"namespace","name":"many","tools":children}),
            json!({"type":"function","name":"plain","parameters":{}}),
            json!({"type":"web_search"}),
        ];
        assert_eq!(ToolRegistry::parse(&tools).unwrap().chat_tools.len(), 128);
        tools.push(json!({"type":"namespace","name":"other","tools":[{"type":"function","name":"extra","parameters":{}}]}));
        assert_eq!(
            ToolRegistry::parse(&tools).err().unwrap(),
            "tools may contain at most 128 callable tools"
        );
    }
    #[test]
    fn exact_installed_codex_default_tools_keep_namespace_and_cached_search() {
        let tools: Vec<Value> =
            serde_json::from_str(include_str!("fixtures/codex-default-tools.json")).unwrap();
        let registry = ToolRegistry::parse(&tools).unwrap();
        assert_eq!(
            registry.hosted_web.as_ref().unwrap()["external_web_access"],
            false
        );
        let wire = registry
            .wire_name("spawn_agent", Some("multi_agent_v1"))
            .unwrap();
        assert!(registry
            .chat_tools
            .iter()
            .any(|tool| tool["function"]["name"] == wire));
        let mut call =
            json!({"type":"function_call","name":wire,"arguments":"{}","call_id":"spawn"});
        registry.output_call(&mut call).unwrap();
        assert_eq!(call["namespace"], "multi_agent_v1");
        assert_eq!(call["name"], "spawn_agent");
    }
    #[test]
    fn namespace_same_names_remain_distinct_and_roundtrip() {
        let registry=ToolRegistry::parse(&[
            json!({"type":"namespace","name":"multi_agent_v1","tools":[{"type":"function","name":"spawn_agent","parameters":{}}]}),
            json!({"type":"namespace","name":"other","tools":[{"type":"function","name":"spawn_agent","parameters":{}}]}),
        ]).unwrap();
        let wire = registry
            .wire_name("spawn_agent", Some("multi_agent_v1"))
            .unwrap();
        assert_ne!(
            wire,
            registry.wire_name("spawn_agent", Some("other")).unwrap()
        );
        let input=registry.input_call(&json!({"type":"function_call","namespace":"multi_agent_v1","name":"spawn_agent","call_id":"c","arguments":"{}"})).unwrap();
        assert_eq!(input["name"], wire);
        let mut output = input;
        registry.output_call(&mut output).unwrap();
        assert_eq!(output["name"], "spawn_agent");
        assert_eq!(output["namespace"], "multi_agent_v1");
    }
    #[test]
    fn custom_text_preserves_quotes_and_newlines() {
        let registry = ToolRegistry::parse(&[
            json!({"type":"custom","name":"patch","format":{"type":"text"}}),
        ])
        .unwrap();
        let mut call=registry.input_call(&json!({"type":"custom_tool_call","name":"patch","call_id":"c","input":"line \"one\"\nline two"})).unwrap();
        registry.output_call(&mut call).unwrap();
        assert_eq!(call["type"], "custom_tool_call");
        assert_eq!(call["input"], "line \"one\"\nline two");
        assert!(call.get("arguments").is_none());
    }
    #[test]
    fn unsupported_grammar_and_resource_expansion_rejected_before_acceptance() {
        assert!(ToolRegistry::parse(&[json!({"type":"custom","name":"patch","format":{"type":"grammar","syntax":"lark","definition":"start: \"hello\""}})]).is_err());
        assert!(ToolRegistry::parse(&[json!({"type":"custom","name":"patch","format":{"type":"grammar","syntax":"regex","definition":"a{999999999}"}})]).is_err());
    }
    #[test]
    fn regex_output_is_checked_and_duplicate_wire_names_fail_closed() {
        let registry=ToolRegistry::parse(&[json!({"type":"custom","name":"word","format":{"type":"grammar","syntax":"regex","definition":"[a-z]+"}})]).unwrap();
        let mut call = json!({"name":registry.wire_name("word",None).unwrap(),"arguments":"{\"input\":\"123\"}"});
        assert!(registry.output_call(&mut call).is_err());
        assert!(ToolRegistry::parse(&[
            json!({"type":"function","name":"x","parameters":{}}),
            json!({"type":"function","name":"x","parameters":{}})
        ])
        .is_err());
    }
}
