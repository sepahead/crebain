//! Closed private engine channel. Paths are trusted construction inputs, never peer fields.

use std::cell::RefCell;
use std::io::{Read, Write};
use std::net::Shutdown;
use std::os::fd::OwnedFd;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::rc::Rc;
use std::time::{Duration, Instant};

use ncp_local::modular_buffer::decode_chunk;
use ncp_local::modular_wire;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::contract;
use crate::types::{AdvanceTick, Prepare};

/// Closed private response to successful native preparation.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EnginePrepared {
    /// Native observation owner identity.
    pub engine_owner_id: String,
    /// Opaque engine-owned exact scene digest.
    pub scene_sha256: String,
}

/// Project-owned retained payload extent.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EnginePayload {
    /// Installed sensor identifier.
    pub sensor_id: String,
    /// Installed modality tag.
    pub kind: String,
    /// Exact raw byte count.
    pub byte_length: u64,
    /// Exact raw SHA-256.
    pub payload_sha256: String,
}

/// Sensor-only projection of one retained native observation lease.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EngineBatch {
    /// Native observation owner identity.
    pub engine_owner_id: String,
    /// Trusted construction source identity.
    pub source_identity: String,
    /// Engine scene identity.
    pub scene_sha256: String,
    /// Actual source body tick of the complete observation.
    pub body_tick: u64,
    /// Exact native observation JSON digest.
    pub engine_batch_sha256: String,
    /// Previous complete native observation JSON digest.
    pub previous_engine_batch_sha256: Option<String>,
    /// Ordered due payload roster.
    pub payloads: Vec<EnginePayload>,
}

/// Private engine failure; no value here attests an executed body tick.
#[derive(Clone, Copy, Debug)]
pub struct EngineError;

/// Project-owned engine methods. Production uses the framed private process below.
pub trait EnginePort {
    /// Prepare an initial owner without acquiring tick-zero sensors.
    fn prepare(
        &mut self,
        run_id: &str,
        source: &str,
        prepare: &Prepare,
    ) -> Result<EnginePrepared, EngineError>;
    /// Advance exactly once after application admission reserved every output.
    fn advance(
        &mut self,
        command: &AdvanceTick,
        previous: Option<&str>,
        accepted: &str,
    ) -> Result<EngineBatch, EngineError>;
    /// Copy one bounded chunk from the exact retained native lease.
    fn read_chunk(
        &mut self,
        tick: u64,
        batch: &str,
        sensor: &str,
        offset: usize,
        count: usize,
    ) -> Result<Vec<u8>, EngineError>;
    /// Release only after every NCP output has sealed.
    fn release_lease(&mut self, tick: u64, batch: &str) -> Result<(), EngineError>;
    /// Confirm retirement or retain an unresolved failure.
    fn retire(&mut self) -> Result<(), EngineError>;
}

/// Local host retirement handle shared with the synchronous application.
pub struct SharedEngine<E: EnginePort>(Rc<RefCell<E>>);
impl<E: EnginePort> SharedEngine<E> {
    /// Wrap one engine owner without creating a second engine or channel.
    pub fn new(engine: E) -> Self {
        Self(Rc::new(RefCell::new(engine)))
    }
}
impl<E: EnginePort> Clone for SharedEngine<E> {
    fn clone(&self) -> Self {
        Self(Rc::clone(&self.0))
    }
}
impl<E: EnginePort> EnginePort for SharedEngine<E> {
    fn prepare(
        &mut self,
        run: &str,
        source: &str,
        p: &Prepare,
    ) -> Result<EnginePrepared, EngineError> {
        self.0
            .try_borrow_mut()
            .map_err(|_| EngineError)?
            .prepare(run, source, p)
    }
    fn advance(
        &mut self,
        c: &AdvanceTick,
        previous: Option<&str>,
        accepted: &str,
    ) -> Result<EngineBatch, EngineError> {
        self.0
            .try_borrow_mut()
            .map_err(|_| EngineError)?
            .advance(c, previous, accepted)
    }
    fn read_chunk(
        &mut self,
        tick: u64,
        batch: &str,
        sensor: &str,
        offset: usize,
        count: usize,
    ) -> Result<Vec<u8>, EngineError> {
        self.0
            .try_borrow_mut()
            .map_err(|_| EngineError)?
            .read_chunk(tick, batch, sensor, offset, count)
    }
    fn release_lease(&mut self, tick: u64, batch: &str) -> Result<(), EngineError> {
        self.0
            .try_borrow_mut()
            .map_err(|_| EngineError)?
            .release_lease(tick, batch)
    }
    fn retire(&mut self) -> Result<(), EngineError> {
        self.0.try_borrow_mut().map_err(|_| EngineError)?.retire()
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Response {
    schema: String,
    generation: String,
    sequence: u64,
    body: ResponseBody,
}
#[derive(Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
enum ResponseBody {
    #[serde(rename = "prepared")]
    Prepared {
        engine_owner_id: String,
        scene_sha256: String,
    },
    #[serde(rename = "advanced")]
    Advanced { batch: EngineBatch },
    #[serde(rename = "chunk")]
    Chunk {
        tick: u64,
        engine_batch_sha256: String,
        sensor_id: String,
        offset: usize,
        bytes_base64: String,
        chunk_sha256: String,
    },
    #[serde(rename = "released")]
    Released {
        tick: u64,
        engine_batch_sha256: String,
    },
    #[serde(rename = "retired")]
    Retired { cleanup_confirmed: bool },
    #[serde(rename = "failed")]
    Failed {
        reason: String,
        cleanup_confirmed: bool,
    },
}

fn wrap_floats(value: Value) -> Result<Value, EngineError> {
    Ok(match value {
        Value::Number(n) if n.is_f64() => {
            let value = n.as_f64().ok_or(EngineError)?;
            if !value.is_finite() {
                return Err(EngineError);
            }
            json!({"f64":format!("{:016x}",value.to_bits())})
        }
        Value::Array(values) => Value::Array(
            values
                .into_iter()
                .map(wrap_floats)
                .collect::<Result<_, _>>()?,
        ),
        Value::Object(values) => Value::Object(
            values
                .into_iter()
                .map(|(k, v)| Ok((k, wrap_floats(v)?)))
                .collect::<Result<_, EngineError>>()?,
        ),
        other => other,
    })
}

/// Encode continuous scalars as exact binary64 words; integers retain integer tokens.
pub fn bridge_value<T: Serialize>(value: &T) -> Result<Value, EngineError> {
    wrap_floats(serde_json::to_value(value).map_err(|_| EngineError)?)
}

/// One Bun child and one owner-created socket pair with absolute I/O deadlines.
pub struct EngineProcess {
    child: Child,
    stream: UnixStream,
    generation: String,
    sequence: u64,
    broken: bool,
    retired: bool,
    transfer_deadline: Option<Instant>,
}

impl EngineProcess {
    /// Start only explicitly selected local executables after launcher source admission.
    pub fn spawn(
        bun: &Path,
        node: &Path,
        bridge: &Path,
        generation: String,
    ) -> Result<Self, EngineError> {
        if !bun.is_absolute()
            || !node.is_absolute()
            || !bridge.is_absolute()
            || !contract::valid_uuid(&generation)
        {
            return Err(EngineError);
        }
        let (stream, child_stream) = UnixStream::pair().map_err(|_| EngineError)?;
        let child_input = child_stream.try_clone().map_err(|_| EngineError)?;
        let child = Command::new(bun)
            .arg("run")
            .arg(bridge)
            .arg("--node")
            .arg(node)
            .arg("--generation")
            .arg(&generation)
            .stdin(Stdio::from(OwnedFd::from(child_input)))
            .stdout(Stdio::from(OwnedFd::from(child_stream)))
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|_| EngineError)?;
        Ok(Self {
            child,
            stream,
            generation,
            sequence: 0,
            broken: false,
            retired: false,
            transfer_deadline: None,
        })
    }

    fn request(&mut self, command: Value, seconds: u64) -> Result<ResponseBody, EngineError> {
        self.request_until(command, Instant::now() + Duration::from_secs(seconds))
    }
    fn transfer_request(&mut self, command: Value) -> Result<ResponseBody, EngineError> {
        let deadline = self.transfer_deadline.ok_or(EngineError)?;
        self.request_until(command, deadline)
    }
    fn request_until(
        &mut self,
        command: Value,
        deadline: Instant,
    ) -> Result<ResponseBody, EngineError> {
        if self.broken || self.retired {
            return Err(EngineError);
        }
        self.sequence = self.sequence.checked_add(1).ok_or(EngineError)?;
        let bytes = serde_json::to_vec(&json!({"schema":"crebain.sensor-engine-request.v1",
            "generation":self.generation,"sequence":self.sequence,"command":command}))
        .map_err(|_| EngineError)?;
        let result = (|| {
            if bytes.len() > 65_536 {
                return Err(EngineError);
            }
            write_until(
                &mut self.stream,
                &(bytes.len() as u32).to_be_bytes(),
                deadline,
            )?;
            write_until(&mut self.stream, &bytes, deadline)?;
            let mut prefix = [0; 4];
            read_until(&mut self.stream, &mut prefix, deadline)?;
            let length = u32::from_be_bytes(prefix) as usize;
            if length == 0 || length > 65_536 {
                return Err(EngineError);
            }
            let mut bytes = vec![0; length];
            read_until(&mut self.stream, &mut bytes, deadline)?;
            let value = private_value(&bytes)?;
            let response: Response = serde_json::from_value(value).map_err(|_| EngineError)?;
            if response.schema != "crebain.sensor-engine-response.v1"
                || response.generation != self.generation
                || response.sequence != self.sequence
            {
                return Err(EngineError);
            }
            if let ResponseBody::Failed {
                reason,
                cleanup_confirmed,
            } = response.body
            {
                // A failed request stays unknown even when private cleanup was confirmed.
                let _diagnostic = (reason, cleanup_confirmed);
                return Err(EngineError);
            }
            Ok(response.body)
        })();
        if result.is_err() {
            self.broken = true;
            let _closed = self.stream.shutdown(Shutdown::Both);
        }
        result
    }

    fn wait_exit(&mut self, deadline: Instant) -> Result<(), EngineError> {
        loop {
            if let Some(status) = self.child.try_wait().map_err(|_| EngineError)? {
                return if status.success() {
                    Ok(())
                } else {
                    Err(EngineError)
                };
            }
            if Instant::now() >= deadline {
                return Err(EngineError);
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

fn remaining(deadline: Instant) -> Result<Duration, EngineError> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|duration| !duration.is_zero())
        .ok_or(EngineError)
}

fn private_value(bytes: &[u8]) -> Result<Value, EngineError> {
    let value = modular_wire::parse_value(bytes).map_err(|_| EngineError)?;
    let mut stack = vec![(&value, 0)];
    let mut nodes = 0;
    while let Some((item, depth)) = stack.pop() {
        nodes += 1;
        if nodes > 4096 || depth > 16 {
            return Err(EngineError);
        }
        match item {
            Value::Number(number) if number.as_u64().is_none_or(|n| n > 9_007_199_254_740_991) => {
                return Err(EngineError)
            }
            Value::String(text) if !text.is_ascii() => return Err(EngineError),
            Value::Array(items) => stack.extend(items.iter().map(|item| (item, depth + 1))),
            Value::Object(items) => stack.extend(items.values().map(|item| (item, depth + 1))),
            _ => {}
        }
    }
    // Object order is irrelevant. Each string token must still use canonical
    // escaping, and whitespace outside strings is not part of this grammar.
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'"' {
            let start = index;
            index += 1;
            let mut escaped = false;
            while index < bytes.len() {
                let byte = bytes[index];
                index += 1;
                if escaped {
                    escaped = false;
                } else if byte == b'\\' {
                    escaped = true;
                } else if byte == b'"' {
                    break;
                }
            }
            let text: String =
                serde_json::from_slice(&bytes[start..index]).map_err(|_| EngineError)?;
            if serde_json::to_vec(&text).map_err(|_| EngineError)? != bytes[start..index] {
                return Err(EngineError);
            }
        } else {
            if bytes[index].is_ascii_whitespace() {
                return Err(EngineError);
            }
            index += 1;
        }
    }
    Ok(value)
}
fn write_until(
    stream: &mut UnixStream,
    mut bytes: &[u8],
    deadline: Instant,
) -> Result<(), EngineError> {
    while !bytes.is_empty() {
        stream
            .set_write_timeout(Some(remaining(deadline)?))
            .map_err(|_| EngineError)?;
        match stream.write(bytes) {
            Ok(0) => return Err(EngineError),
            Ok(count) => bytes = &bytes[count..],
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => return Err(EngineError),
        }
    }
    Ok(())
}
fn read_until(
    stream: &mut UnixStream,
    mut bytes: &mut [u8],
    deadline: Instant,
) -> Result<(), EngineError> {
    while !bytes.is_empty() {
        stream
            .set_read_timeout(Some(remaining(deadline)?))
            .map_err(|_| EngineError)?;
        match stream.read(bytes) {
            Ok(0) => return Err(EngineError),
            Ok(count) => bytes = &mut bytes[count..],
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => return Err(EngineError),
        }
    }
    Ok(())
}

impl EnginePort for EngineProcess {
    fn prepare(
        &mut self,
        run_id: &str,
        source: &str,
        p: &Prepare,
    ) -> Result<EnginePrepared, EngineError> {
        match self.request(
            json!({"kind":"prepare","run_id":run_id,"source_identity":source,
            "specification":bridge_value(&p.specification)?,"planned_ticks":p.planned_ticks}),
            60,
        )? {
            ResponseBody::Prepared {
                engine_owner_id,
                scene_sha256,
            } if contract::valid_uuid(&engine_owner_id)
                && modular_wire::valid_digest(&scene_sha256) =>
            {
                Ok(EnginePrepared {
                    engine_owner_id,
                    scene_sha256,
                })
            }
            _ => Err(EngineError),
        }
    }
    fn advance(
        &mut self,
        c: &AdvanceTick,
        previous: Option<&str>,
        accepted: &str,
    ) -> Result<EngineBatch, EngineError> {
        if self.transfer_deadline.is_some() {
            return Err(EngineError);
        }
        self.transfer_deadline = Some(Instant::now() + Duration::from_secs(60));
        match self.transfer_request(
            json!({"kind":"advance","tick":c.tick,"previous_engine_batch_sha256":previous,
            "action":bridge_value(&c.action)?,"accepted_action_request_digest":accepted}),
        )? {
            ResponseBody::Advanced { batch } => Ok(batch),
            _ => Err(EngineError),
        }
    }
    fn read_chunk(
        &mut self,
        tick: u64,
        batch: &str,
        sensor: &str,
        offset: usize,
        count: usize,
    ) -> Result<Vec<u8>, EngineError> {
        match self.transfer_request(json!({"kind":"read_chunk","tick":tick,"engine_batch_sha256":batch,"sensor_id":sensor,"offset":offset,"max_bytes":count}))?{
            ResponseBody::Chunk{tick:t,engine_batch_sha256:b,sensor_id:s,offset:o,bytes_base64,chunk_sha256}
                if t==tick&&b==batch&&s==sensor&&o==offset=>{
                    let bytes=decode_chunk(&bytes_base64).map_err(|_|EngineError)?;
                    if bytes.len()!=count||format!("{:x}",Sha256::digest(&bytes))!=chunk_sha256{return Err(EngineError);}
                    Ok(bytes)
                }
            _=>Err(EngineError)
        }
    }
    fn release_lease(&mut self, tick: u64, batch: &str) -> Result<(), EngineError> {
        match self.transfer_request(
            json!({"kind":"release_lease","tick":tick,"engine_batch_sha256":batch}),
        )? {
            ResponseBody::Released {
                tick: t,
                engine_batch_sha256: b,
            } if t == tick && b == batch => {
                self.transfer_deadline = None;
                Ok(())
            }
            _ => Err(EngineError),
        }
    }
    fn retire(&mut self) -> Result<(), EngineError> {
        if self.retired {
            return Ok(());
        }
        let deadline = Instant::now() + Duration::from_secs(45);
        if self.broken {
            let _closed = self.stream.shutdown(Shutdown::Both);
            let _exit = self.wait_exit(deadline);
            return Err(EngineError);
        }
        let confirmed = matches!(
            self.request_until(json!({"kind":"retire"}), deadline)?,
            ResponseBody::Retired {
                cleanup_confirmed: true
            }
        );
        let _closed = self.stream.shutdown(Shutdown::Both);
        if !confirmed || self.wait_exit(deadline).is_err() {
            self.broken = true;
            return Err(EngineError);
        }
        self.retired = true;
        Ok(())
    }
}

impl Drop for EngineProcess {
    fn drop(&mut self) {
        let _closed = self.stream.shutdown(Shutdown::Both);
        if !self.retired {
            // This handle is the sole waiter. A still-unreaped direct child cannot have
            // its PID reused. Killing it never counts as graphics-family retirement.
            if matches!(self.child.try_wait(), Ok(None)) {
                let _kill = self.child.kill();
            }
            if self
                .wait_exit(Instant::now() + Duration::from_secs(5))
                .is_err()
            {
                eprintln!("CREBAIN direct-child clean exit not confirmed; graphics-family cleanup is not confirmed");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn simulated_channel(slow_second_read: bool) -> (EngineProcess, std::thread::JoinHandle<()>) {
        let (stream, mut peer) = UnixStream::pair().unwrap();
        let generation = "33333333-3333-4333-8333-333333333333".to_owned();
        let child = Command::new("/usr/bin/true").spawn().unwrap();
        let engine = EngineProcess {
            child,
            stream,
            generation: generation.clone(),
            sequence: 0,
            broken: false,
            retired: false,
            transfer_deadline: None,
        };
        let peer_thread = std::thread::spawn(move || {
            let mut reads = 0;
            loop {
                let mut prefix = [0; 4];
                if peer.read_exact(&mut prefix).is_err() {
                    break;
                }
                let mut bytes = vec![0; u32::from_be_bytes(prefix) as usize];
                if peer.read_exact(&mut bytes).is_err() {
                    break;
                }
                let request: Value = serde_json::from_slice(&bytes).unwrap();
                let command = &request["command"];
                let body = match command["kind"].as_str().unwrap() {
                    "advance" => json!({"kind":"advanced","batch":{
                        "engine_owner_id":"44444444-4444-4444-8444-444444444444","source_identity":"a".repeat(64),
                        "scene_sha256":"b".repeat(64),"body_tick":1,"engine_batch_sha256":"c".repeat(64),
                        "previous_engine_batch_sha256":null,"payloads":[]}}),
                    "read_chunk" => {
                        reads += 1;
                        if slow_second_read && reads == 2 {
                            std::thread::sleep(Duration::from_millis(100));
                        }
                        json!({"kind":"chunk","tick":1,"engine_batch_sha256":"c".repeat(64),"sensor_id":"rgb:rgb-a",
                            "offset":command["offset"],"bytes_base64":"AA==","chunk_sha256":format!("{:x}",Sha256::digest([0]))})
                    }
                    "release_lease" => {
                        json!({"kind":"released","tick":1,"engine_batch_sha256":"c".repeat(64)})
                    }
                    _ => break,
                };
                let bytes =
                    serde_json::to_vec(&json!({"schema":"crebain.sensor-engine-response.v1",
                    "generation":generation,"sequence":request["sequence"],"body":body}))
                    .unwrap();
                if peer.write_all(&(bytes.len() as u32).to_be_bytes()).is_err()
                    || peer.write_all(&bytes).is_err()
                {
                    break;
                }
            }
        });
        (engine, peer_thread)
    }

    #[test]
    fn one_transfer_deadline_survives_successful_partial_reads_and_release() {
        use crate::types::{Action, AdvanceTickCaptureReservation};
        let command = AdvanceTick {
            kind: "advance_tick".into(),
            tick: 1,
            previous_batch_digest: None,
            action: Action::Hold {
                accepted_action_request_digest: "d".repeat(64),
            },
            capture_reservation: AdvanceTickCaptureReservation {
                kind: "absent".into(),
            },
        };
        let (mut engine, peer) = simulated_channel(false);
        engine.advance(&command, None, &"d".repeat(64)).unwrap();
        let deadline = engine.transfer_deadline.unwrap();
        assert_eq!(
            engine
                .read_chunk(1, &"c".repeat(64), "rgb:rgb-a", 0, 1)
                .unwrap(),
            [0]
        );
        assert_eq!(engine.transfer_deadline, Some(deadline));
        engine.release_lease(1, &"c".repeat(64)).unwrap();
        assert!(engine.transfer_deadline.is_none());
        assert!(engine
            .read_chunk(1, &"c".repeat(64), "rgb:rgb-a", 1, 1)
            .is_err());
        drop(engine);
        peer.join().unwrap();

        let (mut engine, peer) = simulated_channel(true);
        engine.advance(&command, None, &"d".repeat(64)).unwrap();
        // A test-only shortened budget exercises the same production deadline field.
        let deadline = Instant::now() + Duration::from_millis(35);
        engine.transfer_deadline = Some(deadline);
        engine
            .read_chunk(1, &"c".repeat(64), "rgb:rgb-a", 0, 1)
            .unwrap();
        assert_eq!(engine.transfer_deadline, Some(deadline));
        assert!(engine
            .read_chunk(1, &"c".repeat(64), "rgb:rgb-a", 1, 1)
            .is_err());
        assert!(engine.broken);
        let sequence = engine.sequence;
        assert!(engine
            .read_chunk(1, &"c".repeat(64), "rgb:rgb-a", 2, 1)
            .is_err());
        assert_eq!(engine.sequence, sequence);
        assert!(engine.release_lease(1, &"c".repeat(64)).is_err());
        drop(engine);
        peer.join().unwrap();
    }

    #[test]
    fn private_response_grammar_has_paired_canonical_controls() {
        assert!(private_value(br#"{"value":1,"text":"accepted"}"#).is_ok());
        for bytes in [
            br#"{"value":1.0}"#.as_slice(),
            br#"{"value":1,"value":1}"#,
            br#" {"value":1}"#,
            br#"{"value":-0}"#,
            br#"{"text":"\u0061"}"#,
        ] {
            assert!(private_value(bytes).is_err());
        }
    }

    #[test]
    fn fragmented_socket_reads_obey_one_absolute_deadline() {
        let (mut reader, mut writer) = UnixStream::pair().unwrap();
        let child = std::thread::spawn(move || {
            for byte in [1, 2, 3, 4] {
                std::thread::sleep(Duration::from_millis(5));
                writer.write_all(&[byte]).unwrap();
            }
        });
        let mut bytes = [0; 4];
        read_until(
            &mut reader,
            &mut bytes,
            Instant::now() + Duration::from_secs(1),
        )
        .unwrap();
        assert_eq!(bytes, [1, 2, 3, 4]);
        child.join().unwrap();

        let (mut reader, mut writer) = UnixStream::pair().unwrap();
        let child = std::thread::spawn(move || {
            for _ in 0..20 {
                std::thread::sleep(Duration::from_millis(10));
                if writer.write_all(&[1]).is_err() {
                    break;
                }
            }
        });
        let started = Instant::now();
        let mut bytes = [0; 20];
        assert!(read_until(&mut reader, &mut bytes, started + Duration::from_millis(35)).is_err());
        assert!(started.elapsed() < Duration::from_secs(1));
        reader.shutdown(Shutdown::Both).unwrap();
        child.join().unwrap();
    }

    #[test]
    fn stalled_writer_is_bounded_and_shutdown_delivers_eof() {
        let (mut writer, mut reader) = UnixStream::pair().unwrap();
        let started = Instant::now();
        assert!(write_until(
            &mut writer,
            &vec![0; 4 * 1024 * 1024],
            started + Duration::from_millis(25)
        )
        .is_err());
        assert!(started.elapsed() < Duration::from_secs(1));
        writer.shutdown(Shutdown::Both).unwrap();
        let mut bytes = [0; 8192];
        while reader.read(&mut bytes).unwrap() != 0 {}

        let (mut writer, mut reader) = UnixStream::pair().unwrap();
        write_until(
            &mut writer,
            b"accepted",
            Instant::now() + Duration::from_secs(1),
        )
        .unwrap();
        let mut received = [0; 8];
        read_until(
            &mut reader,
            &mut received,
            Instant::now() + Duration::from_secs(1),
        )
        .unwrap();
        assert_eq!(&received, b"accepted");
    }

    #[test]
    fn actual_bun_private_channel_can_retire_without_preparing_an_engine() {
        let Some(bun) = std::env::var_os("CREBAIN_SENSOR_BUN") else {
            return;
        };
        let node = std::env::var_os("CREBAIN_SENSOR_NODE").expect("paired trusted Node path");
        let bridge = std::env::var_os("CREBAIN_SENSOR_BRIDGE").expect("paired owned bridge path");
        let mut engine = EngineProcess::spawn(
            Path::new(&bun),
            Path::new(&node),
            Path::new(&bridge),
            "33333333-3333-4333-8333-333333333333".into(),
        )
        .unwrap();
        engine.retire().unwrap();
        engine.retire().unwrap();
        assert!(EngineProcess::spawn(
            Path::new(&bun),
            Path::new(&node),
            Path::new(&bridge),
            "not-a-generation".into()
        )
        .is_err());
    }
}
