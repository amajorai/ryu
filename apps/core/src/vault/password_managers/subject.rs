//! A consumer subject split into its channel and the names it carries, so an
//! approval request can be worded per channel (see [`super::describe_subject`]
//! and the broker proposal notification).

/// Who a consumer subject names (see [`super::broker_subject`],
/// [`super::read_subject`], [`super::runtime_subject`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConsumerSubject<'a> {
    /// `broker:<minter>`: a broker session minted by `minter`.
    BrokerSession { minter: &'a str },
    /// `read:<principal>`: the explicit read API for `principal`.
    ExplicitRead { principal: &'a str },
    /// `runtime:<mcp>:<owner>`: MCP server or plugin `mcp` running for `owner`.
    Runtime { mcp: &'a str, owner: &'a str },
    /// Any other subject, shown as is.
    Other(&'a str),
}

impl<'a> ConsumerSubject<'a> {
    /// Split `subject` by its channel prefix.
    pub fn parse(subject: &'a str) -> Self {
        if let Some(minter) = subject.strip_prefix("broker:") {
            return Self::BrokerSession { minter };
        }
        if let Some(principal) = subject.strip_prefix("read:") {
            return Self::ExplicitRead { principal };
        }
        if let Some((mcp, owner)) = subject
            .strip_prefix("runtime:")
            .and_then(|rest| rest.split_once(':'))
        {
            return Self::Runtime { mcp, owner };
        }
        Self::Other(subject)
    }
}

#[cfg(test)]
mod tests {
    use super::super::describe_subject;
    use super::ConsumerSubject;

    #[test]
    fn each_channel_prefix_parses_to_its_kind() {
        assert_eq!(
            ConsumerSubject::parse("broker:user:u1"),
            ConsumerSubject::BrokerSession { minter: "user:u1" }
        );
        assert_eq!(
            ConsumerSubject::parse("read:operator"),
            ConsumerSubject::ExplicitRead {
                principal: "operator"
            }
        );
        assert_eq!(
            ConsumerSubject::parse("runtime:github:user:u2"),
            ConsumerSubject::Runtime {
                mcp: "github",
                owner: "user:u2"
            }
        );
        assert_eq!(
            ConsumerSubject::parse("runtime:github"),
            ConsumerSubject::Other("runtime:github"),
            "a runtime subject without an owner is not a runtime subject"
        );
        assert_eq!(
            ConsumerSubject::parse("machine:m1"),
            ConsumerSubject::Other("machine:m1")
        );
    }

    #[test]
    fn describe_subject_keeps_its_english_wording() {
        assert_eq!(
            describe_subject("broker:user:u1"),
            "A broker session minted by user:u1"
        );
        assert_eq!(
            describe_subject("read:operator"),
            "operator (explicit read)"
        );
        assert_eq!(
            describe_subject("runtime:github:node:n1"),
            "MCP server or plugin `github` running for node:n1"
        );
        assert_eq!(describe_subject("machine:m1"), "machine:m1");
    }
}
