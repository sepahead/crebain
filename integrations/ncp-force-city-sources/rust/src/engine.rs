//! Closed private process operations; selected paths never come from an NCP request.

use std::cell::RefCell;
use std::io::{Read, Write};
use std::net::Shutdown;
use std::os::fd::OwnedFd;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::rc::Rc;
use std::time::{Duration, Instant};

use ncp_local::{modular_buffer::decode_chunk, modular_wire};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::contract;
use crate::types::{Advance, ControlReceipt, Prepare, SourceOutcome};

/// Bounded private failure category; unknown execution never becomes a typed source failure.
#[derive(Clone, Copy, Debug)]
pub struct EngineError;

/// Exact native preparation identity and actually allocated backing extents.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EnginePrepared {
    /// Fresh native owner identity.
    pub owner_id: String,
    /// Exact prepared native plan.
    pub native_plan_sha256: String,
    /// Actual shared observation scene.
    pub scene_sha256: String,
    /// Original, receipt, and privileged control backing bytes.
    pub backing_bytes: [usize; 3],
}

/// Complete native outcome projection; copied originals remain under the native lease.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EngineBatch {
    /// Fresh native owner identity.
    pub owner_id: String,
    /// Exact prepared native plan.
    pub native_plan_sha256: String,
    /// Shared actual scene identity.
    pub scene_sha256: String,
    /// Known completed physical tick.
    pub tick: u64,
    /// Previous released native lease, independently of public buffer operations.
    pub previous_native_batch_sha256: Option<String>,
    /// Complete original native observation identity.
    pub native_batch_sha256: String,
    /// True only for a complete known source failure with confirmed component cleanup.
    pub source_failed: bool,
    /// Compact known control facts, never a fabricated sensor.
    pub control: ControlReceipt,
    /// Every declared source outcome in prepared request order.
    pub slots: Vec<SourceOutcome>,
}

/// Synchronous application-owned native operations, implemented by one actual Bun process.
pub trait EnginePort {
    /// Construct actual engines after complete native and application capacity admission.
    fn prepare(
        &mut self,
        run: &str,
        source: &str,
        prepare: &Prepare,
    ) -> Result<EnginePrepared, EngineError>;
    /// Advance once and retain a complete observation or a known source-failure observation.
    fn advance(
        &mut self,
        command: &Advance,
        previous: Option<&str>,
    ) -> Result<EngineBatch, EngineError>;
    /// Copy one exact contiguous source chunk from the current native lease.
    fn read_chunk(
        &mut self,
        batch: &str,
        request: &str,
        digest: &str,
        offset: usize,
        count: usize,
    ) -> Result<Vec<u8>, EngineError>;
    /// Release the native lease only after every original has joined the application arena.
    fn release(&mut self, batch: &str) -> Result<(), EngineError>;
    /// Require native cleanup and normal direct-child exit; unresolved remains unresolved.
    fn retire(&mut self) -> Result<(), EngineError>;
}

/// Share the one engine with the containing process-lifetime guard, without duplication.
pub struct SharedEngine<E: EnginePort>(Rc<RefCell<E>>);
impl<E: EnginePort> SharedEngine<E> {
    /// Own one engine instance and its lifetime.
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
    fn advance(&mut self, c: &Advance, previous: Option<&str>) -> Result<EngineBatch, EngineError> {
        self.0
            .try_borrow_mut()
            .map_err(|_| EngineError)?
            .advance(c, previous)
    }
    fn read_chunk(
        &mut self,
        batch: &str,
        request: &str,
        digest: &str,
        offset: usize,
        count: usize,
    ) -> Result<Vec<u8>, EngineError> {
        self.0
            .try_borrow_mut()
            .map_err(|_| EngineError)?
            .read_chunk(batch, request, digest, offset, count)
    }
    fn release(&mut self, batch: &str) -> Result<(), EngineError> {
        self.0
            .try_borrow_mut()
            .map_err(|_| EngineError)?
            .release(batch)
    }
    fn retire(&mut self) -> Result<(), EngineError> {
        self.0.try_borrow_mut().map_err(|_| EngineError)?.retire()
    }
}

/// Preserve exact continuous binary64 values in private integer-only JSON.
pub fn bridge_value(value: &impl Serialize) -> Result<Value, EngineError> {
    fn convert(value: Value) -> Result<Value, EngineError> {
        Ok(match value {
            Value::Number(n) if n.is_f64() => {
                let value = n.as_f64().filter(|n| n.is_finite()).ok_or(EngineError)?;
                json!({"f64":format!("{:016x}",value.to_bits())})
            }
            Value::Array(a) => Value::Array(a.into_iter().map(convert).collect::<Result<_, _>>()?),
            Value::Object(o) => Value::Object(
                o.into_iter()
                    .map(|(k, v)| Ok((k, convert(v)?)))
                    .collect::<Result<_, EngineError>>()?,
            ),
            other => other,
        })
    }
    convert(serde_json::to_value(value).map_err(|_| EngineError)?)
}

/// Pure exact private preparation projection, reused during admission and actual dispatch.
pub fn prepare_command(run: &str, source: &str, p: &Prepare) -> Result<Value, EngineError> {
    Ok(json!({"kind":"prepare","run_id":run,"source_identity":source,"prepare":bridge_value(p)?}))
}
/// Pure compact control command; the bridge resolves indices against the frozen roster.
pub fn advance_command(c: &Advance, previous: Option<&str>) -> Result<Value, EngineError> {
    Ok(
        json!({"kind":"advance","tick":c.tick,"rows":bridge_value(&c.rows)?,"previous_native_batch_sha256":previous}),
    )
}
/// Preflight with maximum sequence spelling before effects; no I/O or reservation occurs here.
pub fn preflight(command: &Value) -> Result<(), EngineError> {
    let bytes = frame(
        "ffffffff-ffff-4fff-bfff-ffffffffffff",
        9_007_199_254_740_991,
        command,
    )?;
    private_value(&bytes).map(|_| ())
}
fn frame(generation: &str, sequence: u64, command: &Value) -> Result<Vec<u8>, EngineError> {
    let bytes=serde_json::to_vec(&json!({"schema":"crebain.city-engine-request.v1","generation":generation,"sequence":sequence,"command":command})).map_err(|_|EngineError)?;
    if bytes.len() > 65536 {
        Err(EngineError)
    } else {
        Ok(bytes)
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
    Prepared { data: EnginePrepared },
    #[serde(rename = "advanced")]
    Advanced { batch: EngineBatch },
    #[serde(rename = "chunk")]
    Chunk {
        native_batch_sha256: String,
        request_id: String,
        original_sha256: String,
        offset: usize,
        bytes_base64: String,
        chunk_sha256: String,
    },
    #[serde(rename = "released")]
    Released { native_batch_sha256: String },
    #[serde(rename = "retired")]
    Retired { cleanup_confirmed: bool },
}

/// One directly owned Bun child and a private socket pair with absolute deadlines.
pub struct EngineProcess {
    child: Child,
    stream: UnixStream,
    generation: String,
    sequence: u64,
    broken: bool,
    retired: bool,
    retirement_attempted: bool,
    transfer_deadline: Option<Instant>,
}
impl EngineProcess {
    /// Launch only trusted absolute construction paths before exposing the public channel.
    pub fn spawn(
        bun: &Path,
        node: Option<&Path>,
        bridge: &Path,
        generation: String,
    ) -> Result<Self, EngineError> {
        if !bun.is_absolute()
            || node.is_some_and(|n| !n.is_absolute())
            || !bridge.is_absolute()
            || !contract::valid_uuid(&generation)
        {
            return Err(EngineError);
        }
        let (stream, child_stream) = UnixStream::pair().map_err(|_| EngineError)?;
        let input = child_stream.try_clone().map_err(|_| EngineError)?;
        let mut command = Command::new(bun);
        command.arg("run").arg(bridge);
        if let Some(node) = node {
            command.arg("--node").arg(node);
        }
        let child = command
            .arg("--generation")
            .arg(&generation)
            .stdin(Stdio::from(OwnedFd::from(input)))
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
            retirement_attempted: false,
            transfer_deadline: None,
        })
    }
    fn request(&mut self, command: Value, deadline: Instant) -> Result<ResponseBody, EngineError> {
        if self.broken || self.retired {
            return Err(EngineError);
        }
        let result = (|| {
            let sequence = self
                .sequence
                .checked_add(1)
                .filter(|n| *n <= 9_007_199_254_740_991)
                .ok_or(EngineError)?;
            let bytes = frame(&self.generation, sequence, &command)?;
            self.sequence = sequence;
            write_until(
                &mut self.stream,
                &(bytes.len() as u32).to_be_bytes(),
                deadline,
            )?;
            write_until(&mut self.stream, &bytes, deadline)?;
            let mut prefix = [0; 4];
            read_until(&mut self.stream, &mut prefix, deadline)?;
            let length = u32::from_be_bytes(prefix) as usize;
            if length == 0 || length > 65536 {
                return Err(EngineError);
            }
            let mut bytes = vec![0; length];
            read_until(&mut self.stream, &mut bytes, deadline)?;
            let response: Response =
                serde_json::from_value(private_value(&bytes)?).map_err(|_| EngineError)?;
            if response.schema != "crebain.city-engine-response.v1"
                || response.generation != self.generation
                || response.sequence != sequence
            {
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
    fn transfer(&mut self, command: Value) -> Result<ResponseBody, EngineError> {
        let deadline = self.transfer_deadline.ok_or(EngineError)?;
        self.request(command, deadline)
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
impl EnginePort for EngineProcess {
    fn prepare(
        &mut self,
        run: &str,
        source: &str,
        p: &Prepare,
    ) -> Result<EnginePrepared, EngineError> {
        match self.request(
            prepare_command(run, source, p)?,
            Instant::now() + Duration::from_secs(60),
        )? {
            ResponseBody::Prepared { data }
                if contract::valid_uuid(&data.owner_id)
                    && modular_wire::valid_digest(&data.native_plan_sha256)
                    && modular_wire::valid_digest(&data.scene_sha256) =>
            {
                Ok(data)
            }
            _ => Err(EngineError),
        }
    }
    fn advance(&mut self, c: &Advance, previous: Option<&str>) -> Result<EngineBatch, EngineError> {
        if self.transfer_deadline.is_some() {
            return Err(EngineError);
        }
        self.transfer_deadline = Some(Instant::now() + Duration::from_secs(60));
        match self.transfer(advance_command(c, previous)?)? {
            ResponseBody::Advanced { batch } => Ok(batch),
            _ => Err(EngineError),
        }
    }
    fn read_chunk(
        &mut self,
        batch: &str,
        request: &str,
        digest: &str,
        offset: usize,
        count: usize,
    ) -> Result<Vec<u8>, EngineError> {
        match self.transfer(json!({"kind":"read_chunk","native_batch_sha256":batch,"request_id":request,"original_sha256":digest,"offset":offset}))?{
            ResponseBody::Chunk{native_batch_sha256,request_id,original_sha256,offset:o,bytes_base64,chunk_sha256}
                if native_batch_sha256==batch&&request_id==request&&original_sha256==digest&&o==offset=>{
                let bytes=decode_chunk(&bytes_base64).map_err(|_|EngineError)?;
                if bytes.len()!=count||format!("{:x}",Sha256::digest(&bytes))!=chunk_sha256{return Err(EngineError);}
                Ok(bytes)
            },_=>Err(EngineError)
        }
    }
    fn release(&mut self, batch: &str) -> Result<(), EngineError> {
        match self.transfer(json!({"kind":"release","native_batch_sha256":batch}))? {
            ResponseBody::Released {
                native_batch_sha256,
            } if native_batch_sha256 == batch => {
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
        if self.retirement_attempted {
            return Err(EngineError);
        }
        self.retirement_attempted = true;
        let deadline = Instant::now() + Duration::from_secs(45);
        if self.broken {
            let _closed = self.stream.shutdown(Shutdown::Both);
            let _exit = self.wait_exit(deadline);
            return Err(EngineError);
        }
        let confirmed = matches!(
            self.request(json!({"kind":"retire"}), deadline),
            Ok(ResponseBody::Retired {
                cleanup_confirmed: true
            })
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
            // Sole direct-child waiter: an unreaped child still owns this PID.
            if matches!(self.child.try_wait(), Ok(None)) {
                let _kill = self.child.kill();
            }
            if self
                .wait_exit(Instant::now() + Duration::from_secs(5))
                .is_err()
            {
                eprintln!(
                    "City direct-child exit unresolved; native process cleanup is not confirmed"
                );
            }
        }
    }
}
fn remaining(deadline: Instant) -> Result<Duration, EngineError> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|d| !d.is_zero())
        .ok_or(EngineError)
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
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => return Err(EngineError),
        }
    }
    Ok(())
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
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => return Err(EngineError),
        }
    }
    Ok(())
}
fn private_value(bytes: &[u8]) -> Result<Value, EngineError> {
    let value = modular_wire::parse_value(bytes).map_err(|_| EngineError)?;
    let mut stack = vec![(&value, 0)];
    let mut nodes = 0;
    while let Some((item, depth)) = stack.pop() {
        nodes += 1;
        if nodes > 16384 || depth > 24 {
            return Err(EngineError);
        }
        match item {
            Value::Number(n) if n.as_u64().is_none_or(|n| n > 9_007_199_254_740_991) => {
                return Err(EngineError)
            }
            Value::String(s) if !s.is_ascii() => return Err(EngineError),
            Value::Array(a) => stack.extend(a.iter().map(|item| (item, depth + 1))),
            Value::Object(o) => stack.extend(o.values().map(|item| (item, depth + 1))),
            _ => {}
        }
    }
    // Object order carries no authority. Every individual string token must be canonical.
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'"' {
            let start = at;
            at += 1;
            let mut escaped = false;
            while at < bytes.len() {
                let b = bytes[at];
                at += 1;
                if escaped {
                    escaped = false;
                } else if b == b'\\' {
                    escaped = true;
                } else if b == b'"' {
                    break;
                }
            }
            let text: String =
                serde_json::from_slice(&bytes[start..at]).map_err(|_| EngineError)?;
            if serde_json::to_vec(&text).map_err(|_| EngineError)? != bytes[start..at] {
                return Err(EngineError);
            }
        } else {
            if bytes[at].is_ascii_whitespace() {
                return Err(EngineError);
            }
            at += 1;
        }
    }
    Ok(value)
}
