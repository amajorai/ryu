//! Stream multiplexer shared by both ends of the desktop route.
//!
//! A [`Mux`] turns one ordered frame transport (the WebSocket) into many TCP-like
//! streams. Each direction of each stream is credit-limited: a sender may have at
//! most [`WINDOW`] unacknowledged bytes in flight, and the receiver returns
//! credit only after the bytes reach its socket. That bounds memory per stream
//! even when one side reads far faster than the other. A peer that ignores its
//! credit has the stream reset.

use super::frame::{Frame, RefuseCode};
use std::{
    collections::HashMap,
    future::Future,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    sync::{mpsc, oneshot, Semaphore},
};

/// Per-direction, per-stream credit.
pub(crate) const WINDOW: usize = 128 * 1024;
/// Largest `Data` payload one frame carries.
const CHUNK: usize = 16 * 1024;
/// Concurrent streams one session admits.
pub(crate) const MAX_STREAMS: usize = 128;
/// How long the node waits for the desktop to answer an `Open`.
const OPEN_TIMEOUT: Duration = Duration::from_secs(15);

/// Desktop-side connector: resolve, screen, and dial one destination.
pub(crate) type Dialer = Arc<
    dyn Fn(
            String,
            u16,
        )
            -> Pin<Box<dyn Future<Output = Result<tokio::net::TcpStream, RefuseCode>> + Send>>
        + Send
        + Sync,
>;

enum Inbound {
    Data(Vec<u8>),
    Fin,
}

struct Slot {
    inbound: mpsc::UnboundedSender<Inbound>,
    credit: Arc<Semaphore>,
    /// Bytes received from the peer and not yet written to our socket.
    unacknowledged: usize,
    opening: Option<oneshot::Sender<Result<(), RefuseCode>>>,
}

/// The receiving half handed to [`Mux::pump`].
pub(crate) struct StreamIo {
    id: u32,
    inbound: mpsc::UnboundedReceiver<Inbound>,
    credit: Arc<Semaphore>,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum OpenError {
    Refused(RefuseCode),
    Closed,
    Timeout,
    Busy,
}

pub(crate) struct Mux {
    outbound: mpsc::UnboundedSender<Vec<u8>>,
    streams: Mutex<HashMap<u32, Slot>>,
    next_id: AtomicU32,
    closed: AtomicBool,
    /// Present only on the exit (desktop) side.
    dialer: Option<Dialer>,
}

impl Mux {
    /// Build a mux whose encoded frames are written to the returned receiver.
    pub(crate) fn new(dialer: Option<Dialer>) -> (Arc<Self>, mpsc::UnboundedReceiver<Vec<u8>>) {
        let (outbound, receiver) = mpsc::unbounded_channel();
        let mux = Arc::new(Self {
            outbound,
            streams: Mutex::new(HashMap::new()),
            next_id: AtomicU32::new(1),
            closed: AtomicBool::new(false),
            dialer,
        });
        (mux, receiver)
    }

    pub(crate) fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    pub(crate) fn active_streams(&self) -> usize {
        self.streams
            .lock()
            .map(|streams| streams.len())
            .unwrap_or(0)
    }

    fn send(&self, frame: &Frame) {
        let _ = self.outbound.send(frame.encode());
    }

    fn register(
        &self,
        id: u32,
        opening: Option<oneshot::Sender<Result<(), RefuseCode>>>,
    ) -> Option<StreamIo> {
        let mut streams = self.streams.lock().ok()?;
        if self.is_closed() || streams.len() >= MAX_STREAMS || streams.contains_key(&id) {
            return None;
        }
        let (inbound, receiver) = mpsc::unbounded_channel();
        let credit = Arc::new(Semaphore::new(WINDOW));
        streams.insert(
            id,
            Slot {
                inbound,
                credit: credit.clone(),
                unacknowledged: 0,
                opening,
            },
        );
        Some(StreamIo {
            id,
            inbound: receiver,
            credit,
        })
    }

    fn remove(&self, id: u32) -> Option<Slot> {
        let slot = self.streams.lock().ok()?.remove(&id);
        if let Some(slot) = &slot {
            slot.credit.close();
        }
        slot
    }

    /// Entry side: ask the exit to connect `host:port`, waiting for its answer.
    pub(crate) async fn open(&self, host: &str, port: u16) -> Result<StreamIo, OpenError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (answer, answered) = oneshot::channel();
        let io = self.register(id, Some(answer)).ok_or(if self.is_closed() {
            OpenError::Closed
        } else {
            OpenError::Busy
        })?;
        self.send(&Frame::Open {
            stream: id,
            host: host.to_owned(),
            port,
        });
        match tokio::time::timeout(OPEN_TIMEOUT, answered).await {
            Ok(Ok(Ok(()))) => Ok(io),
            Ok(Ok(Err(code))) => {
                self.remove(id);
                Err(OpenError::Refused(code))
            }
            Ok(Err(_)) => {
                self.remove(id);
                Err(OpenError::Closed)
            }
            Err(_) => {
                self.remove(id);
                self.send(&Frame::Reset { stream: id });
                Err(OpenError::Timeout)
            }
        }
    }

    /// Feed one frame received from the transport.
    pub(crate) fn receive(self: &Arc<Self>, raw: &[u8]) {
        let Some(frame) = Frame::decode(raw) else {
            tracing::debug!("local egress: dropping malformed frame");
            return;
        };
        match frame {
            Frame::Open { stream, host, port } => self.accept_open(stream, host, port),
            Frame::Opened { stream } => self.answer_open(stream, Ok(())),
            Frame::Refused { stream, code } => self.answer_open(stream, Err(code)),
            Frame::Data { stream, bytes } => self.deliver(stream, bytes),
            Frame::Window { stream, bytes } => {
                if let Ok(streams) = self.streams.lock() {
                    if let Some(slot) = streams.get(&stream) {
                        let room = WINDOW.saturating_sub(slot.credit.available_permits());
                        slot.credit.add_permits((bytes as usize).min(room));
                    }
                }
            }
            Frame::Fin { stream } => {
                if let Ok(streams) = self.streams.lock() {
                    if let Some(slot) = streams.get(&stream) {
                        let _ = slot.inbound.send(Inbound::Fin);
                    }
                }
            }
            Frame::Reset { stream } => {
                self.remove(stream);
            }
        }
    }

    fn answer_open(&self, stream: u32, result: Result<(), RefuseCode>) {
        let opening = self.streams.lock().ok().and_then(|mut streams| {
            streams
                .get_mut(&stream)
                .and_then(|slot| slot.opening.take())
        });
        if let Some(opening) = opening {
            let _ = opening.send(result);
        }
    }

    fn deliver(&self, stream: u32, bytes: Vec<u8>) {
        let overrun = {
            let Ok(mut streams) = self.streams.lock() else {
                return;
            };
            let Some(slot) = streams.get_mut(&stream) else {
                return;
            };
            slot.unacknowledged += bytes.len();
            if slot.unacknowledged > WINDOW {
                true
            } else {
                let _ = slot.inbound.send(Inbound::Data(bytes));
                false
            }
        };
        if overrun {
            tracing::warn!("local egress: peer exceeded its stream window; resetting");
            self.remove(stream);
            self.send(&Frame::Reset { stream });
        }
    }

    fn acknowledge(&self, stream: u32, bytes: usize) {
        if let Ok(mut streams) = self.streams.lock() {
            if let Some(slot) = streams.get_mut(&stream) {
                slot.unacknowledged = slot.unacknowledged.saturating_sub(bytes);
            }
        }
        self.send(&Frame::Window {
            stream,
            bytes: bytes as u32,
        });
    }

    fn accept_open(self: &Arc<Self>, stream: u32, host: String, port: u16) {
        let Some(dialer) = self.dialer.clone() else {
            // Only the desktop dials. A node receiving `Open` is a protocol error.
            self.send(&Frame::Reset { stream });
            return;
        };
        let Some(io) = self.register(stream, None) else {
            self.send(&Frame::Refused {
                stream,
                code: RefuseCode::Busy,
            });
            return;
        };
        let mux = self.clone();
        tokio::spawn(async move {
            match dialer(host, port).await {
                Ok(socket) => {
                    mux.send(&Frame::Opened { stream });
                    mux.pump(io, socket).await;
                }
                Err(code) => {
                    mux.remove(stream);
                    mux.send(&Frame::Refused { stream, code });
                }
            }
        });
    }

    /// Relay bytes between `socket` and an open stream until both directions
    /// finish or either side resets.
    pub(crate) async fn pump<S>(&self, io: StreamIo, socket: S)
    where
        S: AsyncRead + AsyncWrite + Unpin,
    {
        let StreamIo {
            id,
            mut inbound,
            credit,
        } = io;
        let (mut reader, mut writer) = tokio::io::split(socket);
        let upstream = async {
            let mut buffer = vec![0u8; CHUNK];
            loop {
                let read = reader.read(&mut buffer).await.map_err(|_| ())?;
                if read == 0 {
                    self.send(&Frame::Fin { stream: id });
                    return Ok::<(), ()>(());
                }
                credit
                    .acquire_many(read as u32)
                    .await
                    .map_err(|_| ())?
                    .forget();
                self.send(&Frame::Data {
                    stream: id,
                    bytes: buffer[..read].to_vec(),
                });
            }
        };
        let downstream = async {
            while let Some(message) = inbound.recv().await {
                match message {
                    Inbound::Data(bytes) => {
                        writer.write_all(&bytes).await.map_err(|_| ())?;
                        self.acknowledge(id, bytes.len());
                    }
                    Inbound::Fin => {
                        let _ = writer.shutdown().await;
                        return Ok::<(), ()>(());
                    }
                }
            }
            // The slot was removed: peer reset or the session ended.
            Err(())
        };
        let finished = tokio::try_join!(upstream, downstream).is_ok();
        if self.remove(id).is_some() && !finished {
            self.send(&Frame::Reset { stream: id });
        }
    }

    /// Tear down every stream. Pending opens fail and pumps unwind.
    pub(crate) fn close(&self) {
        self.closed.store(true, Ordering::Release);
        if let Ok(mut streams) = self.streams.lock() {
            for (_, slot) in streams.drain() {
                slot.credit.close();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::{TcpListener, TcpStream};

    /// Wire two muxes back to back, as the WebSocket would.
    fn connect(
        entry: &Arc<Mux>,
        mut entry_out: mpsc::UnboundedReceiver<Vec<u8>>,
        exit: &Arc<Mux>,
        mut exit_out: mpsc::UnboundedReceiver<Vec<u8>>,
    ) {
        let to_exit = exit.clone();
        tokio::spawn(async move {
            while let Some(frame) = entry_out.recv().await {
                to_exit.receive(&frame);
            }
        });
        let to_entry = entry.clone();
        tokio::spawn(async move {
            while let Some(frame) = exit_out.recv().await {
                to_entry.receive(&frame);
            }
        });
    }

    fn loopback_dialer() -> Dialer {
        Arc::new(|host, port| {
            Box::pin(async move {
                if host == "blocked.test" {
                    return Err(RefuseCode::Blocked);
                }
                TcpStream::connect(("127.0.0.1", port))
                    .await
                    .map_err(|_| RefuseCode::Unreachable)
            })
        })
    }

    async fn echo_server() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let (mut reader, mut writer) = socket.split();
                    let _ = tokio::io::copy(&mut reader, &mut writer).await;
                    let _ = writer.shutdown().await;
                });
            }
        });
        port
    }

    #[tokio::test]
    async fn bulk_data_round_trips_through_the_window() {
        let port = echo_server().await;
        let (entry, entry_out) = Mux::new(None);
        let (exit, exit_out) = Mux::new(Some(loopback_dialer()));
        connect(&entry, entry_out, &exit, exit_out);

        let io = entry.open("echo.test", port).await.unwrap();
        let (client, local) = tokio::io::duplex(64 * 1024);
        let pump_entry = entry.clone();
        tokio::spawn(async move { pump_entry.pump(io, local).await });

        // Several windows' worth, so credit must be returned to finish.
        let payload: Vec<u8> = (0..(WINDOW * 5)).map(|i| (i % 251) as u8).collect();
        let (mut reader, mut writer) = tokio::io::split(client);
        let sent = payload.clone();
        let writing = tokio::spawn(async move {
            writer.write_all(&sent).await.unwrap();
            writer.shutdown().await.unwrap();
        });
        let mut received = Vec::new();
        reader.read_to_end(&mut received).await.unwrap();
        writing.await.unwrap();
        assert_eq!(received, payload);
    }

    #[tokio::test]
    async fn refusals_and_closed_sessions_fail_the_open() {
        let (entry, entry_out) = Mux::new(None);
        let (exit, exit_out) = Mux::new(Some(loopback_dialer()));
        connect(&entry, entry_out, &exit, exit_out);
        assert_eq!(
            entry.open("blocked.test", 443).await.err(),
            Some(OpenError::Refused(RefuseCode::Blocked))
        );
        assert_eq!(entry.active_streams(), 0);
        entry.close();
        assert_eq!(
            entry.open("echo.test", 1).await.err(),
            Some(OpenError::Closed)
        );
    }

    #[tokio::test]
    async fn an_entry_never_dials_for_its_peer() {
        let (entry, mut entry_out) = Mux::new(None);
        entry.receive(
            &Frame::Open {
                stream: 9,
                host: "example.com".into(),
                port: 443,
            }
            .encode(),
        );
        assert_eq!(
            Frame::decode(&entry_out.recv().await.unwrap()),
            Some(Frame::Reset { stream: 9 })
        );
    }

    #[tokio::test]
    async fn a_peer_that_ignores_credit_is_reset() {
        let (exit, mut exit_out) = Mux::new(Some(loopback_dialer()));
        let _io = exit.register(5, None).unwrap();
        let chunk = vec![0u8; CHUNK];
        for _ in 0..=(WINDOW / CHUNK) {
            exit.receive(
                &Frame::Data {
                    stream: 5,
                    bytes: chunk.clone(),
                }
                .encode(),
            );
        }
        assert_eq!(exit.active_streams(), 0);
        assert_eq!(
            Frame::decode(&exit_out.recv().await.unwrap()),
            Some(Frame::Reset { stream: 5 })
        );
    }
}
