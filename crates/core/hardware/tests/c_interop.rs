//! C-to-Rust interop: the Rust node ([`ryu_hardware::secure::ServerHandshake`] and
//! the RHN halves) drives the C device simulator built by the firmware host tests
//! (`apps/hardware/firmware/host_tests`, target `rhp_device_sim`).
//!
//! The simulator is found through `RHP_DEVICE_SIM`. When the variable is unset the
//! test prints `c_interop: skipped` and passes (a plain `cargo test` has no C
//! toolchain build to lean on), unless `RHP_REQUIRE_DEVICE_SIM=1`, which CI sets:
//! then a missing simulator FAILS. When `RHP_DEVICE_SIM` is set but does not name an
//! executable file, the test FAILS too, so CI cannot silently lose the interop check.
//!
//! Simulator contract: `rhp_device_sim --device-id ID --static-sk HEX32 --node-pub
//! HEX32 [--relay]`, with every stdio frame written as a big-endian u32 length
//! followed by exactly one outer RHN frame. It sends HS1, checks the HS2 pin (exit 3
//! without writing anything on a mismatch), sends HS3 with its hello, answers
//! `hello_ack{proto:"1.1"}` with `capabilities_register` generation 1, answers each
//! `capability_invoke`, echoes AUDIO, and exits 0 on `unpaired` (4 on `error`, 5 on
//! EOF or a protocol error, 2 on bad usage).

use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

use rand::RngCore;
use ryu_hardware::capability;
use ryu_hardware::identity::NodeIdentity;
use ryu_hardware::pair_crypto;
use ryu_hardware::protocol::{
    parse_client_msg, AudioFormat, CapLimits, RhpClientMsg, RhpServerMsg, PROTO_V1_1,
};
use ryu_hardware::secure::{Inbound, OutboundKind, RecvHalf, SendHalf, ServerHandshake};
use serde_json::json;

const DEVICE_ID: &str = "rhw_0123456789abcdef";
const STEP_TIMEOUT: Duration = Duration::from_secs(15);
/// Largest frame the simulator may write (one DATA frame).
const MAX_FRAME: usize = ryu_hardware::secure::MAX_DATA_FRAME;

/// Resolve the simulator, or `None` to skip. Panics when it is configured but
/// unusable, or when `RHP_REQUIRE_DEVICE_SIM=1` and it is not configured.
fn simulator() -> Option<PathBuf> {
    let Some(raw) = std::env::var_os("RHP_DEVICE_SIM") else {
        assert!(
            std::env::var_os("RHP_REQUIRE_DEVICE_SIM").is_none_or(|value| value != "1"),
            "RHP_REQUIRE_DEVICE_SIM=1 but RHP_DEVICE_SIM is not set: the C interop \
             tests must run"
        );
        println!("c_interop: skipped (RHP_DEVICE_SIM is not set)");
        return None;
    };
    let path = PathBuf::from(raw);
    let metadata = std::fs::metadata(&path)
        .unwrap_or_else(|e| panic!("RHP_DEVICE_SIM={} is not readable: {e}", path.display()));
    assert!(
        metadata.is_file(),
        "RHP_DEVICE_SIM={} is not a file",
        path.display()
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert!(
            metadata.permissions().mode() & 0o111 != 0,
            "RHP_DEVICE_SIM={} is not executable",
            path.display()
        );
    }
    Some(path)
}

/// A running simulator: its stdin, and its stdout frames read on a thread so every
/// wait has a timeout.
struct Sim {
    child: Child,
    stdin: Option<ChildStdin>,
    frames: Receiver<Vec<u8>>,
}

impl Sim {
    /// `relay` passes `--relay`: the device then says `relay:true` in its hello, as a
    /// device does when its session runs through the phone relay.
    fn spawn(path: &PathBuf, static_sk: &[u8; 32], node_pub: &[u8; 32], relay: bool) -> Self {
        let mut command = Command::new(path);
        command.args([
            "--device-id",
            DEVICE_ID,
            "--static-sk",
            &hex::encode(static_sk),
            "--node-pub",
            &hex::encode(node_pub),
        ]);
        if relay {
            command.arg("--relay");
        }
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("spawn rhp_device_sim");
        let stdin = child.stdin.take();
        let mut stdout = child.stdout.take().expect("simulator stdout");
        let (tx, frames) = mpsc::channel();
        std::thread::spawn(move || loop {
            let mut len = [0u8; 4];
            if stdout.read_exact(&mut len).is_err() {
                return;
            }
            let len = u32::from_be_bytes(len) as usize;
            assert!(
                (1..=MAX_FRAME).contains(&len),
                "simulator wrote a frame of {len} bytes"
            );
            let mut frame = vec![0u8; len];
            if stdout.read_exact(&mut frame).is_err() || tx.send(frame).is_err() {
                return;
            }
        });
        Self {
            child,
            stdin,
            frames,
        }
    }

    fn write(&mut self, frame: &[u8]) {
        let stdin = self.stdin.as_mut().expect("simulator stdin is open");
        let len = u32::try_from(frame.len()).unwrap().to_be_bytes();
        stdin.write_all(&len).expect("write frame length");
        stdin.write_all(frame).expect("write frame");
        stdin.flush().expect("flush simulator stdin");
    }

    fn read(&self, what: &str) -> Vec<u8> {
        match self.frames.recv_timeout(STEP_TIMEOUT) {
            Ok(frame) => frame,
            Err(RecvTimeoutError::Timeout) => panic!("timed out waiting for {what}"),
            Err(RecvTimeoutError::Disconnected) => {
                panic!("simulator closed its output while waiting for {what}")
            }
        }
    }

    /// Wait for the simulator to exit and assert it wrote nothing more.
    fn finish(mut self) -> ExitStatus {
        drop(self.stdin.take());
        let deadline = Instant::now() + STEP_TIMEOUT;
        let status = loop {
            if let Some(status) = self.child.try_wait().expect("poll simulator") {
                break status;
            }
            if Instant::now() >= deadline {
                let _ = self.child.kill();
                panic!("simulator did not exit");
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        match self.frames.recv_timeout(Duration::from_secs(2)) {
            Ok(frame) => panic!("simulator wrote an unexpected {}-byte frame", frame.len()),
            Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => {}
        }
        status
    }
}

impl Drop for Sim {
    fn drop(&mut self) {
        if matches!(self.child.try_wait(), Ok(None)) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

fn random_secret() -> [u8; 32] {
    let mut secret = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut secret);
    secret
}

fn send_control(sim: &mut Sim, send: &mut SendHalf, msg: &RhpServerMsg) {
    let body = serde_json::to_vec(msg).unwrap();
    for frame in send
        .seal(OutboundKind::Control, &body, Instant::now())
        .unwrap()
    {
        sim.write(&frame);
    }
}

/// The next complete logical message, skipping REKEY records and KEEPALIVEs.
fn next_inbound(sim: &Sim, recv: &mut RecvHalf, what: &str) -> Inbound {
    loop {
        let frame = sim.read(what);
        match recv.open(&frame, Instant::now()) {
            Ok(Some(Inbound::Keepalive) | None) => {}
            Ok(Some(inbound)) => return inbound,
            Err(error) => panic!("opening a frame while waiting for {what}: {error}"),
        }
    }
}

/// The next control message of one of the expected kinds, skipping `mode` and
/// `telemetry` that a device may interleave.
fn next_control(sim: &Sim, recv: &mut RecvHalf, what: &str) -> (RhpClientMsg, usize) {
    loop {
        match next_inbound(sim, recv, what) {
            Inbound::Control(text) => {
                let msg = parse_client_msg(&text)
                    .unwrap_or_else(|e| panic!("bad control while waiting for {what}: {e}"));
                if matches!(
                    msg,
                    RhpClientMsg::Mode { .. } | RhpClientMsg::Telemetry { .. }
                ) {
                    continue;
                }
                return (msg, text.len());
            }
            other => panic!("expected control for {what}, got {other:?}"),
        }
    }
}

#[test]
fn rust_node_drives_the_c_device_simulator() {
    let Some(path) = simulator() else {
        return;
    };
    let identity = NodeIdentity::generate();
    let device_sk = random_secret();
    let device_pub = pair_crypto::public_key(&device_sk);
    let mut sim = Sim::spawn(&path, &device_sk, &identity.public(), false);

    // 1. Handshake.
    let mut server = ServerHandshake::new(&identity, DEVICE_ID).unwrap();
    let hs1 = sim.read("HS1");
    let hs2 = server.on_hs1(&hs1).expect("HS1 accepted");
    sim.write(&hs2);
    let hs3 = sim.read("HS3");
    let established = server.on_hs3(&hs3, Instant::now()).expect("HS3 accepted");
    assert_eq!(established.remote_static, device_pub, "pinned device key");
    match parse_client_msg(&established.hello).expect("hello parses") {
        RhpClientMsg::Hello {
            device_id, relay, ..
        } => {
            assert_eq!(device_id, DEVICE_ID);
            assert!(!relay);
        }
        other => panic!("HS3 carried {other:?}, not a hello"),
    }
    let mut send = established.send;
    let mut recv = established.recv;

    send_control(
        &mut sim,
        &mut send,
        &RhpServerMsg::HelloAck {
            session_id: "interop".into(),
            ambient_session_id: None,
            tts: AudioFormat {
                codec: "opus".into(),
                sample_rate: 16_000,
                frame_ms: 20,
            },
            proto: Some(PROTO_V1_1.into()),
            cap_limits: Some(CapLimits::V1_1),
        },
    );

    // 2. capabilities_register: two valid capabilities.
    let (register, register_len) = next_control(&sim, &mut recv, "capabilities_register");
    let RhpClientMsg::CapabilitiesRegister {
        generation,
        capabilities,
    } = register
    else {
        panic!("expected capabilities_register, got {register:?}");
    };
    assert_eq!(generation, 1);
    let (accepted, rejected) =
        capability::validate_register(generation, None, &capabilities, register_len)
            .expect("register validates");
    assert_eq!(accepted.len(), 2, "accepted {accepted:?}");
    assert!(rejected.is_empty(), "rejected {rejected:?}");
    let show_text = accepted
        .iter()
        .find(|cap| cap.name == "display.show_text")
        .expect("display.show_text registered");
    let args = json!({ "text": "Hi" });
    capability::validate_args(show_text, &args).expect("args validate");

    // 3. capabilities_ack.
    send_control(
        &mut sim,
        &mut send,
        &RhpServerMsg::CapabilitiesAck {
            generation,
            accepted: accepted.iter().map(|cap| cap.name.clone()).collect(),
            rejected: Vec::new(),
        },
    );

    // 4. Invoke display.show_text.
    send_control(
        &mut sim,
        &mut send,
        &RhpServerMsg::CapabilityInvoke {
            request_id: "inv_1_1".into(),
            generation,
            name: "display.show_text".into(),
            args,
            deadline_ms: 10_000,
        },
    );
    let (result, _) = next_control(&sim, &mut recv, "capability_result");
    match result {
        RhpClientMsg::CapabilityResult {
            request_id,
            ok,
            result,
            error,
        } => {
            assert_eq!(request_id, "inv_1_1");
            assert!(ok, "device error {error:?}");
            assert_eq!(result, Some(json!({ "shown": true })));
        }
        other => panic!("expected capability_result, got {other:?}"),
    }

    // 5. 100 audio echoes, with a node rekey after the 50th.
    for index in 0..100u8 {
        if index == 50 {
            sim.write(&send.rekey_now(Instant::now()).unwrap());
        }
        let packet: Vec<u8> = (0..40 + usize::from(index))
            .map(|i| index ^ (i as u8))
            .collect();
        for frame in send
            .seal(OutboundKind::Audio, &packet, Instant::now())
            .unwrap()
        {
            sim.write(&frame);
        }
        match next_inbound(&sim, &mut recv, "an audio echo") {
            Inbound::Audio(echo) => assert_eq!(echo, packet, "echo {index}"),
            other => panic!("expected an audio echo, got {other:?}"),
        }
    }

    // 6. unpaired: the device wipes its credentials and exits 0.
    send_control(&mut sim, &mut send, &RhpServerMsg::Unpaired);
    let status = sim.finish();
    assert_eq!(status.code(), Some(0), "simulator exit status {status}");
}

#[test]
fn simulator_refuses_a_node_that_is_not_pinned() {
    let Some(path) = simulator() else {
        return;
    };
    let identity = NodeIdentity::generate();
    let pinned_elsewhere = NodeIdentity::generate().public();
    let mut sim = Sim::spawn(&path, &random_secret(), &pinned_elsewhere, false);

    let mut server = ServerHandshake::new(&identity, DEVICE_ID).unwrap();
    let hs1 = sim.read("HS1");
    sim.write(&server.on_hs1(&hs1).expect("HS1 accepted"));
    // The device aborts before HS3, so its static key is never revealed.
    let status = sim.finish();
    assert_eq!(status.code(), Some(3), "simulator exit status {status}");
}

/// A device whose session runs through the phone relay (`--relay`) says so in the
/// hello inside HS3; Core refuses a session whose `hello.relay` does not match the
/// bearer's token kind (design 4.4 step 8), so the C encoding must carry it.
#[test]
fn relayed_c_device_sets_relay_in_its_hs3_hello() {
    let Some(path) = simulator() else {
        return;
    };
    let identity = NodeIdentity::generate();
    let device_sk = random_secret();
    let mut sim = Sim::spawn(&path, &device_sk, &identity.public(), true);

    let mut server = ServerHandshake::new(&identity, DEVICE_ID).unwrap();
    let hs1 = sim.read("HS1");
    sim.write(&server.on_hs1(&hs1).expect("HS1 accepted"));
    let hs3 = sim.read("HS3");
    let established = server.on_hs3(&hs3, Instant::now()).expect("HS3 accepted");
    assert_eq!(
        established.remote_static,
        pair_crypto::public_key(&device_sk),
        "pinned device key"
    );
    match parse_client_msg(&established.hello).expect("hello parses") {
        RhpClientMsg::Hello {
            device_id, relay, ..
        } => {
            assert_eq!(device_id, DEVICE_ID);
            assert!(relay, "a --relay device must send hello.relay=true");
        }
        other => panic!("HS3 carried {other:?}, not a hello"),
    }

    // The relayed session is a normal secure session: unpaired ends it cleanly.
    let mut send = established.send;
    send_control(&mut sim, &mut send, &RhpServerMsg::Unpaired);
    let status = sim.finish();
    assert_eq!(status.code(), Some(0), "simulator exit status {status}");
}
