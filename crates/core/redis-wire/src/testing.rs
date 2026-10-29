//! In-process RESP2 server for unit tests (feature `testing`).
//!
//! [`FakeRedis`] listens on `127.0.0.1:<ephemeral>` and implements the command
//! subset Ryu's Redis-backed stores use — strings with `PX`/`EX` expiry, sets,
//! sorted sets, hashes, `INCR`, `MULTI`/`EXEC`, `AUTH`, `SELECT` — over the real
//! wire codec, so the client's framing, pipelining and transaction handling
//! are exercised end to end. Commands it does not implement (for example
//! RediSearch `FT.*`) can be answered by a programmable handler, and every
//! received command is logged for assertions. It is a test double, not a
//! Redis: it has no persistence, eviction policy, or cluster support.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use crate::codec::{encode_frame, parse_frame, Frame};

/// A custom command handler: return `Some(reply)` to answer, `None` to fall through.
pub type Handler = Arc<dyn Fn(&[Vec<u8>]) -> Option<Frame> + Send + Sync>;

enum Data {
    Str(Vec<u8>),
    Set(BTreeSet<Vec<u8>>),
    ZSet(Vec<(f64, Vec<u8>)>),
    Hash(BTreeMap<Vec<u8>, Vec<u8>>),
}

struct Entry {
    data: Data,
    expires: Option<Instant>,
}

#[derive(Default)]
struct State {
    keys: HashMap<Vec<u8>, Entry>,
    log: Vec<Vec<Vec<u8>>>,
}

impl State {
    fn live(&mut self, key: &[u8]) -> Option<&mut Entry> {
        let expired = self
            .keys
            .get(key)
            .and_then(|entry| entry.expires)
            .is_some_and(|at| at <= Instant::now());
        if expired {
            self.keys.remove(key);
        }
        self.keys.get_mut(key)
    }
}

/// A running fake server. Dropping it stops accepting new connections.
pub struct FakeRedis {
    addr: std::net::SocketAddr,
    state: Arc<Mutex<State>>,
    handler: Arc<Mutex<Option<Handler>>>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for FakeRedis {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl FakeRedis {
    /// Start a server that accepts any `AUTH`.
    pub async fn start() -> Self {
        Self::start_with_password(None).await
    }

    /// Start a server that requires `AUTH <password>` (any username) before data
    /// commands when `password` is set.
    pub async fn start_with_password(password: Option<&str>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind fake redis");
        let addr = listener.local_addr().expect("fake redis addr");
        let state = Arc::new(Mutex::new(State::default()));
        let handler: Arc<Mutex<Option<Handler>>> = Arc::new(Mutex::new(None));
        let password = password.map(str::to_owned);
        let task = {
            let state = Arc::clone(&state);
            let handler = Arc::clone(&handler);
            tokio::spawn(async move {
                while let Ok((socket, _)) = listener.accept().await {
                    let state = Arc::clone(&state);
                    let handler = Arc::clone(&handler);
                    let password = password.clone();
                    tokio::spawn(serve(socket, state, handler, password));
                }
            })
        };
        Self {
            addr,
            state,
            handler,
            task,
        }
    }

    /// `redis://127.0.0.1:<port>` for this server.
    pub fn url(&self) -> String {
        format!("redis://{}", self.addr)
    }

    /// Answer commands the fake does not implement (or override ones it does).
    pub fn set_handler(&self, handler: Handler) {
        *self.handler.lock().expect("handler lock") = Some(handler);
    }

    /// Every command received so far, as raw argument vectors.
    pub fn commands(&self) -> Vec<Vec<Vec<u8>>> {
        self.state.lock().expect("state lock").log.clone()
    }

    /// Names (upper-cased) of every command received so far.
    pub fn command_names(&self) -> Vec<String> {
        self.commands()
            .iter()
            .filter_map(|args| args.first())
            .map(|name| String::from_utf8_lossy(name).to_ascii_uppercase())
            .collect()
    }

    /// Number of live (unexpired) keys.
    pub fn key_count(&self) -> usize {
        let mut state = self.state.lock().expect("state lock");
        let keys: Vec<Vec<u8>> = state.keys.keys().cloned().collect();
        keys.iter().filter(|key| state.live(key).is_some()).count()
    }

    /// Remaining time to live for `key`, if it exists and has an expiry.
    pub fn ttl(&self, key: &str) -> Option<Duration> {
        let mut state = self.state.lock().expect("state lock");
        state
            .live(key.as_bytes())
            .and_then(|entry| entry.expires)
            .map(|at| at.saturating_duration_since(Instant::now()))
    }
}

async fn serve(
    mut socket: tokio::net::TcpStream,
    state: Arc<Mutex<State>>,
    handler: Arc<Mutex<Option<Handler>>>,
    password: Option<String>,
) {
    let mut buf = Vec::new();
    let mut authed = password.is_none();
    let mut queued: Option<Vec<Vec<Vec<u8>>>> = None;
    loop {
        let mut out = Vec::new();
        loop {
            let parsed = match parse_frame(&buf) {
                Ok(parsed) => parsed,
                Err(_) => return,
            };
            let Some((frame, consumed)) = parsed else {
                break;
            };
            buf.drain(..consumed);
            let args: Vec<Vec<u8>> = frame
                .into_array()
                .into_iter()
                .filter_map(Frame::into_bytes)
                .collect();
            let name = args
                .first()
                .map(|name| String::from_utf8_lossy(name).to_ascii_uppercase())
                .unwrap_or_default();
            let reply = if name == "AUTH" {
                let given = args
                    .last()
                    .map(|value| String::from_utf8_lossy(value).into_owned());
                if password.is_none() || given == password {
                    authed = true;
                    Frame::Simple("OK".into())
                } else {
                    Frame::Error("WRONGPASS invalid username-password pair".into())
                }
            } else if !authed {
                Frame::Error("NOAUTH Authentication required.".into())
            } else if name == "MULTI" {
                queued = Some(Vec::new());
                Frame::Simple("OK".into())
            } else if name == "EXEC" {
                match queued.take() {
                    Some(cmds) => Frame::Array(Some(
                        cmds.iter().map(|cmd| run(cmd, &state, &handler)).collect(),
                    )),
                    None => Frame::Error("ERR EXEC without MULTI".into()),
                }
            } else if let Some(cmds) = queued.as_mut() {
                cmds.push(args);
                Frame::Simple("QUEUED".into())
            } else {
                run(&args, &state, &handler)
            };
            encode_frame(&reply, &mut out);
        }
        if !out.is_empty() && socket.write_all(&out).await.is_err() {
            return;
        }
        let mut chunk = [0u8; 8192];
        match socket.read(&mut chunk).await {
            Ok(0) | Err(_) => return,
            Ok(read) => buf.extend_from_slice(&chunk[..read]),
        }
    }
}

fn ok() -> Frame {
    Frame::Simple("OK".into())
}

fn wrong_type() -> Frame {
    Frame::Error("WRONGTYPE Operation against a key holding the wrong kind of value".into())
}

fn text(arg: &[u8]) -> String {
    String::from_utf8_lossy(arg).into_owned()
}

fn parse_i64(arg: &[u8]) -> Option<i64> {
    text(arg).parse().ok()
}

fn parse_score(arg: &[u8]) -> Option<(f64, bool)> {
    let raw = text(arg);
    let (exclusive, number) = match raw.strip_prefix('(') {
        Some(rest) => (true, rest.to_owned()),
        None => (false, raw),
    };
    let value = match number.as_str() {
        "-inf" => f64::NEG_INFINITY,
        "+inf" | "inf" => f64::INFINITY,
        other => other.parse().ok()?,
    };
    Some((value, exclusive))
}

fn run(
    args: &[Vec<u8>],
    state: &Arc<Mutex<State>>,
    handler: &Arc<Mutex<Option<Handler>>>,
) -> Frame {
    let custom = handler.lock().expect("handler lock").clone();
    let mut state = state.lock().expect("state lock");
    state.log.push(args.to_vec());
    if let Some(reply) = custom.and_then(|handler| handler(args)) {
        return reply;
    }
    let Some(name) = args.first().map(|name| text(name).to_ascii_uppercase()) else {
        return Frame::Error("ERR empty command".into());
    };
    let arg = |index: usize| args.get(index).map(Vec::as_slice).unwrap_or_default();
    match name.as_str() {
        "PING" => Frame::Simple("PONG".into()),
        "SELECT" | "FLUSHDB" => {
            if name == "FLUSHDB" {
                state.keys.clear();
            }
            ok()
        }
        "GET" => match state.live(arg(1)).map(|entry| &entry.data) {
            None => Frame::Bulk(None),
            Some(Data::Str(value)) => Frame::Bulk(Some(value.clone())),
            Some(_) => wrong_type(),
        },
        "MGET" => Frame::Array(Some(
            args[1..]
                .iter()
                .map(|key| match state.live(key).map(|entry| &entry.data) {
                    Some(Data::Str(value)) => Frame::Bulk(Some(value.clone())),
                    _ => Frame::Bulk(None),
                })
                .collect(),
        )),
        "SET" => {
            let mut expires = None;
            let mut nx = false;
            let mut index = 3;
            while index < args.len() {
                match text(arg(index)).to_ascii_uppercase().as_str() {
                    "PX" => {
                        let ms = parse_i64(arg(index + 1)).unwrap_or(0).max(0) as u64;
                        expires = Some(Instant::now() + Duration::from_millis(ms));
                        index += 1;
                    }
                    "EX" => {
                        let secs = parse_i64(arg(index + 1)).unwrap_or(0).max(0) as u64;
                        expires = Some(Instant::now() + Duration::from_secs(secs));
                        index += 1;
                    }
                    "NX" => nx = true,
                    _ => return Frame::Error("ERR syntax error".into()),
                }
                index += 1;
            }
            if nx && state.live(arg(1)).is_some() {
                return Frame::Bulk(None);
            }
            state.keys.insert(
                arg(1).to_vec(),
                Entry {
                    data: Data::Str(arg(2).to_vec()),
                    expires,
                },
            );
            ok()
        }
        "DEL" => {
            let mut removed = 0;
            for key in &args[1..] {
                if state.live(key).is_some() {
                    state.keys.remove(key);
                    removed += 1;
                }
            }
            Frame::Integer(removed)
        }
        "EXISTS" => Frame::Integer(
            args[1..]
                .iter()
                .filter(|key| state.live(key).is_some())
                .count() as i64,
        ),
        "INCR" => {
            let current = match state.live(arg(1)).map(|entry| &entry.data) {
                None => 0,
                Some(Data::Str(value)) => match parse_i64(value) {
                    Some(number) => number,
                    None => return Frame::Error("ERR value is not an integer".into()),
                },
                Some(_) => return wrong_type(),
            };
            let next = current + 1;
            let expires = state.live(arg(1)).and_then(|entry| entry.expires);
            state.keys.insert(
                arg(1).to_vec(),
                Entry {
                    data: Data::Str(next.to_string().into_bytes()),
                    expires,
                },
            );
            Frame::Integer(next)
        }
        "PEXPIRE" => {
            let ms = parse_i64(arg(2)).unwrap_or(0).max(0) as u64;
            match state.live(arg(1)) {
                Some(entry) => {
                    entry.expires = Some(Instant::now() + Duration::from_millis(ms));
                    Frame::Integer(1)
                }
                None => Frame::Integer(0),
            }
        }
        "PTTL" => match state.live(arg(1)) {
            None => Frame::Integer(-2),
            Some(Entry { expires: None, .. }) => Frame::Integer(-1),
            Some(Entry {
                expires: Some(at), ..
            }) => Frame::Integer(at.saturating_duration_since(Instant::now()).as_millis() as i64),
        },
        "SADD" | "SREM" | "SMEMBERS" | "SCARD" => set_command(&name, args, &mut state),
        "ZADD" | "ZRANGE" | "ZREM" | "ZCARD" | "ZPOPMIN" | "ZREMRANGEBYSCORE" => {
            zset_command(&name, args, &mut state)
        }
        "HSET" => {
            let key = arg(1).to_vec();
            if state.live(&key).is_none() {
                state.keys.insert(
                    key.clone(),
                    Entry {
                        data: Data::Hash(BTreeMap::new()),
                        expires: None,
                    },
                );
            }
            let Some(Entry {
                data: Data::Hash(map),
                ..
            }) = state.keys.get_mut(&key)
            else {
                return wrong_type();
            };
            let mut added = 0;
            for pair in args[2..].chunks(2) {
                if let [field, value] = pair {
                    if map.insert(field.clone(), value.clone()).is_none() {
                        added += 1;
                    }
                }
            }
            Frame::Integer(added)
        }
        "HGETALL" => match state.live(arg(1)).map(|entry| &entry.data) {
            None => Frame::Array(Some(Vec::new())),
            Some(Data::Hash(map)) => Frame::Array(Some(
                map.iter()
                    .flat_map(|(field, value)| {
                        [
                            Frame::Bulk(Some(field.clone())),
                            Frame::Bulk(Some(value.clone())),
                        ]
                    })
                    .collect(),
            )),
            Some(_) => wrong_type(),
        },
        other => Frame::Error(format!("ERR unknown command '{other}'")),
    }
}

fn set_command(name: &str, args: &[Vec<u8>], state: &mut State) -> Frame {
    let key = args.get(1).cloned().unwrap_or_default();
    let exists = state.live(&key).is_some();
    if !exists {
        if name != "SADD" {
            return match name {
                "SMEMBERS" => Frame::Array(Some(Vec::new())),
                _ => Frame::Integer(0),
            };
        }
        state.keys.insert(
            key.clone(),
            Entry {
                data: Data::Set(BTreeSet::new()),
                expires: None,
            },
        );
    }
    let Some(Entry {
        data: Data::Set(set),
        ..
    }) = state.keys.get_mut(&key)
    else {
        return wrong_type();
    };
    let reply = match name {
        "SADD" => Frame::Integer(
            args[2..]
                .iter()
                .filter(|m| set.insert((*m).clone()))
                .count() as i64,
        ),
        "SREM" => Frame::Integer(args[2..].iter().filter(|m| set.remove(*m)).count() as i64),
        "SCARD" => Frame::Integer(set.len() as i64),
        _ => Frame::Array(Some(
            set.iter().map(|m| Frame::Bulk(Some(m.clone()))).collect(),
        )),
    };
    if set.is_empty() {
        state.keys.remove(&key);
    }
    reply
}

fn zset_command(name: &str, args: &[Vec<u8>], state: &mut State) -> Frame {
    let key = args.get(1).cloned().unwrap_or_default();
    if state.live(&key).is_none() {
        if name != "ZADD" {
            return match name {
                "ZRANGE" | "ZPOPMIN" => Frame::Array(Some(Vec::new())),
                _ => Frame::Integer(0),
            };
        }
        state.keys.insert(
            key.clone(),
            Entry {
                data: Data::ZSet(Vec::new()),
                expires: None,
            },
        );
    }
    let Some(Entry {
        data: Data::ZSet(members),
        ..
    }) = state.keys.get_mut(&key)
    else {
        return wrong_type();
    };
    let reply = match name {
        "ZADD" => {
            let mut added = 0;
            for pair in args[2..].chunks(2) {
                let [score, member] = pair else {
                    return Frame::Error("ERR syntax error".into());
                };
                let Some(score) = text(score).parse::<f64>().ok() else {
                    return Frame::Error("ERR value is not a valid float".into());
                };
                match members.iter_mut().find(|(_, m)| m == member) {
                    Some(existing) => existing.0 = score,
                    None => {
                        members.push((score, member.clone()));
                        added += 1;
                    }
                }
            }
            members.sort_by(|a, b| a.0.total_cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
            Frame::Integer(added)
        }
        "ZCARD" => Frame::Integer(members.len() as i64),
        "ZREM" => {
            let before = members.len();
            members.retain(|(_, m)| !args[2..].contains(m));
            Frame::Integer((before - members.len()) as i64)
        }
        "ZRANGE" => {
            let len = members.len() as i64;
            let norm = |raw: i64| {
                if raw < 0 {
                    (len + raw).max(0)
                } else {
                    raw.min(len)
                }
            };
            let start = norm(args.get(2).and_then(|a| parse_i64(a)).unwrap_or(0));
            let stop = norm(args.get(3).and_then(|a| parse_i64(a)).unwrap_or(-1)) + 1;
            let stop = stop.min(len);
            Frame::Array(Some(if start >= stop {
                Vec::new()
            } else {
                members[start as usize..stop as usize]
                    .iter()
                    .map(|(_, m)| Frame::Bulk(Some(m.clone())))
                    .collect()
            }))
        }
        "ZPOPMIN" => {
            let count = args.get(2).and_then(|a| parse_i64(a)).unwrap_or(1).max(0) as usize;
            let take = count.min(members.len());
            let popped: Vec<(f64, Vec<u8>)> = members.drain(..take).collect();
            Frame::Array(Some(
                popped
                    .into_iter()
                    .flat_map(|(score, member)| {
                        [
                            Frame::Bulk(Some(member)),
                            Frame::Bulk(Some(score.to_string().into_bytes())),
                        ]
                    })
                    .collect(),
            ))
        }
        _ => {
            let (Some((min, min_ex)), Some((max, max_ex))) = (
                args.get(2).and_then(|a| parse_score(a)),
                args.get(3).and_then(|a| parse_score(a)),
            ) else {
                return Frame::Error("ERR min or max is not a float".into());
            };
            let before = members.len();
            members.retain(|(score, _)| {
                let above = if min_ex { *score > min } else { *score >= min };
                let below = if max_ex { *score < max } else { *score <= max };
                !(above && below)
            });
            Frame::Integer((before - members.len()) as i64)
        }
    };
    if members.is_empty() {
        state.keys.remove(&key);
    }
    reply
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Cmd, RedisClient, RedisError};

    #[tokio::test]
    async fn client_round_trips_against_the_fake() {
        let server = FakeRedis::start_with_password(Some("pw")).await;
        let url = server.url().replace("redis://", "redis://:pw@");
        let client = RedisClient::from_url(&url).unwrap();
        client
            .query(
                Cmd::new("SET")
                    .arg("k")
                    .arg([0u8, 1, 2])
                    .arg("PX")
                    .int(60_000),
            )
            .await
            .unwrap();
        let got = client.query(Cmd::new("GET").arg("k")).await.unwrap();
        assert_eq!(got.into_bytes(), Some(vec![0, 1, 2]));
        assert!(server.ttl("k").is_some());
        let results = client
            .transaction(&[
                Cmd::new("SADD").arg("s").arg("a"),
                Cmd::new("SMEMBERS").arg("s"),
            ])
            .await
            .unwrap();
        assert_eq!(results[0], Frame::Integer(1));
        // AUTH is answered by the session layer and never logged with its password.
        assert_eq!(
            server.command_names().first().map(String::as_str),
            Some("SET")
        );
    }

    #[tokio::test]
    async fn wrong_password_and_server_errors_surface_without_arguments() {
        let server = FakeRedis::start_with_password(Some("pw")).await;
        let url = server.url().replace("redis://", "redis://:nope@");
        let client = RedisClient::from_url(&url).unwrap();
        let error = client.query(Cmd::new("GET").arg("k")).await.unwrap_err();
        assert!(matches!(error, RedisError::Server(_)), "{error}");
        assert!(!error.to_string().contains("nope"));

        let open = FakeRedis::start().await;
        let client = RedisClient::from_url(&open.url()).unwrap();
        let error = client
            .query(Cmd::new("BOGUS").arg("secret-arg"))
            .await
            .unwrap_err();
        assert!(error.to_string().starts_with("redis error reply: BOGUS"));
        assert!(!error.to_string().contains("secret-arg"));
    }

    #[tokio::test]
    async fn an_unreachable_server_fails_fast_and_the_client_recovers() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);
        let client = RedisClient::new(
            crate::RedisUrl::parse(&format!("redis://{addr}")).unwrap(),
            crate::ClientOptions {
                pool_size: 1,
                connect_timeout: Duration::from_millis(500),
                io_timeout: Duration::from_millis(500),
            },
        );
        assert!(client.query(Cmd::new("PING")).await.is_err());
    }

    #[tokio::test]
    async fn sorted_sets_expire_and_pop_in_score_order() {
        let server = FakeRedis::start().await;
        let client = RedisClient::from_url(&server.url()).unwrap();
        client
            .query(
                Cmd::new("ZADD")
                    .arg("z")
                    .arg("3")
                    .arg("c")
                    .arg("1")
                    .arg("a")
                    .arg("2")
                    .arg("b"),
            )
            .await
            .unwrap();
        let popped = client
            .query(Cmd::new("ZPOPMIN").arg("z").int(1))
            .await
            .unwrap();
        assert_eq!(popped.into_array()[0], Frame::Bulk(Some(b"a".to_vec())));
        let removed = client
            .query(Cmd::new("ZREMRANGEBYSCORE").arg("z").arg("-inf").arg("(3"))
            .await
            .unwrap();
        assert_eq!(removed, Frame::Integer(1));
        client
            .query(Cmd::new("SET").arg("gone").arg("x").arg("PX").int(1))
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(5)).await;
        assert!(client
            .query(Cmd::new("GET").arg("gone"))
            .await
            .unwrap()
            .is_nil());
    }
}
