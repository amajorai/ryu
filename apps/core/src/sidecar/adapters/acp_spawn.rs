//! Ryu's ACP spawn declaration.
//!
//! `agent-client-protocol` 0.11's `agent-client-protocol-tokio::AcpAgent`
//! wrapped a schema `McpServer`, and Ryu persists spawn commands in that JSON
//! shape (`{"name","command","args","env":[{name,value}]}`). 3.x's `AcpAgent`
//! wraps a launch-only `AcpAgentConfig` instead (JSON `{"command","args","env":{}}`
//! with unknown fields denied, and an env `BTreeMap`). [`AcpSpawn`] keeps the
//! `McpServer` form, with its stdio `name` and ordered `env` list, as Ryu's
//! declaration, parses spawn strings exactly as the 0.11 tokio crate did, and
//! converts to the SDK's `AcpAgent` only at connect time.

use std::path::PathBuf;
use std::str::FromStr;

use agent_client_protocol::schema::v1::{EnvVariable, McpServer, McpServerStdio};
use agent_client_protocol::util::internal_error;
use agent_client_protocol::{AcpAgent, AcpAgentConfig};

/// A parsed ACP agent spawn declaration.
#[derive(Debug, Clone)]
pub struct AcpSpawn {
    server: McpServer,
}

impl AcpSpawn {
    /// Wrap an already-built declaration.
    #[must_use]
    pub fn new(server: McpServer) -> Self {
        Self { server }
    }

    /// The declaration.
    #[must_use]
    pub fn server(&self) -> &McpServer {
        &self.server
    }

    /// Take the declaration.
    #[must_use]
    pub fn into_server(self) -> McpServer {
        self.server
    }

    /// Build the SDK subprocess component. Only stdio declarations spawn, as in
    /// 0.11, whose transport rejected HTTP and SSE servers the same way.
    pub fn into_agent(self) -> Result<AcpAgent, agent_client_protocol::Error> {
        match self.server {
            McpServer::Stdio(stdio) => Ok(stdio_agent(&stdio)),
            McpServer::Http(_) => Err(internal_error(
                "HTTP transport not yet supported by AcpAgent",
            )),
            McpServer::Sse(_) => Err(internal_error(
                "SSE transport not yet supported by AcpAgent",
            )),
            _ => Err(internal_error("Unknown MCP server transport type")),
        }
    }
}

/// The SDK component for a stdio declaration.
#[must_use]
pub fn stdio_agent(stdio: &McpServerStdio) -> AcpAgent {
    AcpAgent::new(
        AcpAgentConfig::new(stdio.command.clone())
            .args(stdio.args.iter().cloned())
            .envs(launch_env(&stdio.env)),
    )
}

/// The environment exactly as 0.11 applied it.
///
/// 0.11 called `Command::env` once per entry, in order, so a repeated name kept
/// its LAST value, and on Windows, where names match case-insensitively, the
/// last of two spellings won. `AcpAgentConfig` keeps env in a `BTreeMap` ordered
/// by bytes, which would let a different spelling win on Windows. Folding
/// duplicates here first leaves the map nothing to reorder.
fn launch_env(env: &[EnvVariable]) -> Vec<(String, String)> {
    let mut folded: Vec<(String, String)> = Vec::with_capacity(env.len());
    for variable in env {
        match folded
            .iter_mut()
            .find(|(name, _)| same_env_name(name, &variable.name))
        {
            Some((_, value)) => value.clone_from(&variable.value),
            None => folded.push((variable.name.clone(), variable.value.clone())),
        }
    }
    folded
}

fn same_env_name(left: &str, right: &str) -> bool {
    if cfg!(windows) {
        left.eq_ignore_ascii_case(right)
    } else {
        left == right
    }
}

/// `NAME=value` with a POSIX-style name, or `None` (0.11's `parse_env_var`).
fn parse_env_var(arg: &str) -> Option<(String, String)> {
    let (name, value) = arg.split_once('=')?;
    let mut chars = name.chars();
    let first = chars.next()?;
    if !first.is_ascii_alphabetic() && first != '_' {
        return None;
    }
    if !chars.all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return None;
    }
    Some((name.to_owned(), value.to_owned()))
}

/// Leading `NAME=value` words are environment, the next word is the command,
/// and the rest are its arguments (0.11's `AcpAgent::from_args`).
fn stdio_from_args(args: Vec<String>) -> Result<McpServerStdio, agent_client_protocol::Error> {
    if args.is_empty() {
        return Err(internal_error("Arguments cannot be empty"));
    }
    let mut env = Vec::new();
    let mut command_idx = 0;
    for (index, arg) in args.iter().enumerate() {
        let Some((name, value)) = parse_env_var(arg) else {
            break;
        };
        env.push(EnvVariable::new(name, value));
        command_idx = index + 1;
    }
    let Some(command) = args.get(command_idx) else {
        return Err(internal_error(
            "No command found (only environment variables provided)",
        ));
    };
    let command = PathBuf::from(command);
    let name = command
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("agent")
        .to_owned();
    Ok(McpServerStdio::new(name, command)
        .args(args[command_idx + 1..].to_vec())
        .env(env))
}

impl FromStr for AcpSpawn {
    type Err = agent_client_protocol::Error;

    /// A `{`-prefixed string is a JSON `McpServer`; anything else is a shell
    /// command line. Same grammar and error messages as 0.11's `AcpAgent`.
    fn from_str(spawn: &str) -> Result<Self, Self::Err> {
        let trimmed = spawn.trim();
        if trimmed.starts_with('{') {
            let server = serde_json::from_str::<McpServer>(trimmed)
                .map_err(|error| internal_error(format!("Failed to parse JSON: {error}")))?;
            return Ok(Self::new(server));
        }
        let args = shell_words::split(trimmed)
            .map_err(|error| internal_error(format!("Failed to parse command: {error}")))?;
        Ok(Self::new(McpServer::Stdio(stdio_from_args(args)?)))
    }
}

#[cfg(test)]
mod tests {
    use super::{launch_env, AcpSpawn};
    use agent_client_protocol::schema::v1::{EnvVariable, McpServer};
    use std::str::FromStr;

    fn stdio(spawn: &str) -> agent_client_protocol::schema::v1::McpServerStdio {
        match AcpSpawn::from_str(spawn).unwrap().into_server() {
            McpServer::Stdio(stdio) => stdio,
            other => panic!("not stdio: {other:?}"),
        }
    }

    #[test]
    fn shell_strings_keep_leading_env_in_order() {
        let stdio = stdio("ZED=1 ALPHA='a b' npx -y pkg --flag");
        assert_eq!(stdio.name, "npx");
        assert_eq!(stdio.command.to_str(), Some("npx"));
        assert_eq!(stdio.args, ["-y", "pkg", "--flag"]);
        let env: Vec<_> = stdio
            .env
            .iter()
            .map(|v| (v.name.as_str(), v.value.as_str()))
            .collect();
        assert_eq!(env, [("ZED", "1"), ("ALPHA", "a b")]);
    }

    #[test]
    fn json_is_the_mcp_server_shape() {
        let json = r#"{"name":"agent","command":"/bin/agent","args":["--acp"],"env":[{"name":"B","value":"2"},{"name":"A","value":"1"}]}"#;
        let stdio = stdio(json);
        assert_eq!(stdio.name, "agent");
        assert_eq!(stdio.args, ["--acp"]);
        assert_eq!(stdio.env[0].name, "B");
        assert_eq!(stdio.env[1].name, "A");
        let error = AcpSpawn::from_str(r#"{"command":"x","env":{}}"#).unwrap_err();
        assert!(
            error.to_string().contains("Failed to parse JSON"),
            "{error}"
        );
    }

    #[test]
    fn env_only_and_empty_are_rejected() {
        assert!(AcpSpawn::from_str("A=1 B=2").is_err());
        assert!(AcpSpawn::from_str("   ").is_err());
    }

    #[test]
    fn repeated_names_keep_the_last_value() {
        let env = vec![
            EnvVariable::new("A", "1"),
            EnvVariable::new("B", "2"),
            EnvVariable::new("A", "3"),
        ];
        assert_eq!(
            launch_env(&env),
            [
                ("A".to_owned(), "3".to_owned()),
                ("B".to_owned(), "2".to_owned())
            ]
        );
    }

    #[test]
    fn only_stdio_declarations_spawn() {
        let http = McpServer::Http(agent_client_protocol::schema::v1::McpServerHttp::new(
            "x",
            "https://example.invalid",
        ));
        assert!(AcpSpawn::new(http).into_agent().is_err());
        assert!(AcpSpawn::from_str("agent --acp")
            .unwrap()
            .into_agent()
            .is_ok());
    }
}
