//! Shared integration-test helpers for termina-core.
//!
//! Owned temporary fixtures, a bounded core child speaking the JSON-lines
//! protocol, and promotion identity/state builders. Every helper keeps
//! blocking work bounded and reaps owned children before fixture removal.

#![allow(dead_code)]

use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde_json::Value;
use sha2::{Digest, Sha256};

static SEQ: AtomicU64 = AtomicU64::new(0);

/// Owned temporary directory. Removed on drop after owned children exit.
pub struct TempFixture {
    path: PathBuf,
}

impl TempFixture {
    pub fn new(prefix: &str) -> Self {
        loop {
            let candidate = std::env::temp_dir().join(format!(
                "termina-{}-{}-{}",
                prefix,
                std::process::id(),
                SEQ.fetch_add(1, Ordering::Relaxed)
            ));
            match fs::create_dir_all(&candidate) {
                Ok(()) => {
                    let canonical = fs::canonicalize(&candidate).unwrap_or(candidate);
                    return Self { path: canonical };
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => panic!("create test fixture: {e}"),
            }
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn join(&self, name: &str) -> PathBuf {
        self.path.join(name)
    }
}

impl Drop for TempFixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

/// A spawned core child with a background stdout reader. Responses are
/// received with an explicit deadline so a blocked core fails the test
/// instead of hanging it.
pub struct CoreProcess {
    child: Child,
    stdin: Option<ChildStdin>,
    responses: mpsc::Receiver<Result<String, String>>,
    _reader: JoinHandle<()>,
    seq: u64,
}

impl CoreProcess {
    pub fn spawn(home: &Path, tmp: &Path) -> Self {
        let bin = option_env!("CARGO_BIN_EXE_termina_core")
            .or(option_env!("CARGO_BIN_EXE_termina-core"))
            .expect("core test binary path is missing")
            .to_string();
        let mut cmd = Command::new(bin);
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .env("HOME", home)
            .env("TMPDIR", tmp)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("LANG", "C")
            .env("LC_ALL", "C")
            .env("TERMINA_CORE_TEST", "1");
        let mut child = cmd.spawn().expect("spawn termina-core");
        let stdin = child.stdin.take().expect("core stdin");
        let stdout = child.stdout.take().expect("core stdout");
        let (tx, rx) = mpsc::channel();
        let reader = thread::spawn(move || {
            let mut lines = BufReader::new(stdout);
            loop {
                let mut line = String::new();
                match lines.read_line(&mut line) {
                    Ok(0) => {
                        let _ = tx.send(Err("native core exited before replying".to_string()));
                        break;
                    }
                    Ok(_) => {
                        if tx.send(Ok(line)).is_err() {
                            break;
                        }
                    }
                    Err(e) => {
                        let _ = tx.send(Err(format!("read core stdout failed: {e}")));
                        break;
                    }
                }
            }
        });
        Self {
            child,
            stdin: Some(stdin),
            responses: rx,
            _reader: reader,
            seq: 0,
        }
    }

    fn next_id(&mut self) -> String {
        self.seq += 1;
        format!("test-{}", self.seq)
    }

    /// Send one request without waiting. Returns the request id for `recv`.
    pub fn send(&mut self, op: &str, payload: Value) -> Result<String, String> {
        let request_id = self.next_id();
        let mut req = payload.as_object().cloned().unwrap_or_default();
        req.insert("op".to_string(), Value::String(op.to_string()));
        req.insert("requestId".to_string(), Value::String(request_id.clone()));
        let wire = serde_json::to_string(&Value::Object(req)).map_err(|e| e.to_string())? + "\n";
        if wire.len() >= 1024 * 1024 {
            return Err("test request exceeds the bounded wire size".to_string());
        }
        let stdin = self.stdin.as_mut().ok_or("core stdin is closed")?;
        stdin
            .write_all(wire.as_bytes())
            .map_err(|e| format!("write core request failed: {e}"))?;
        stdin
            .flush()
            .map_err(|e| format!("flush core request failed: {e}"))?;
        Ok(request_id)
    }

    /// Receive the response for `request_id` within `timeout`.
    pub fn recv(&self, request_id: &str, timeout: Duration) -> Result<Value, String> {
        let line = self
            .responses
            .recv_timeout(timeout)
            .map_err(|_| "native request deadline exceeded".to_string())?
            .map_err(|e| e)?;
        if line.len() > 1024 * 1024 {
            return Err("core response exceeds the bounded size".to_string());
        }
        let response: Value =
            serde_json::from_str(&line).map_err(|e| format!("invalid core response: {e}"))?;
        if response.get("requestId").and_then(Value::as_str) != Some(request_id) {
            return Err(format!("core response requestId mismatch: {response}"));
        }
        Ok(response)
    }

    /// Send one request and wait for its response.
    pub fn request(
        &mut self,
        op: &str,
        payload: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        let request_id = self.send(op, payload)?;
        self.recv(&request_id, timeout)
    }

    /// Send one request and require `ok: true`.
    pub fn request_ok(
        &mut self,
        op: &str,
        payload: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        let response = self.request(op, payload, timeout)?;
        if response.get("ok").and_then(Value::as_bool) != Some(true) {
            return Err(format!(
                "core {op} failed: {}",
                response
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown error")
            ));
        }
        Ok(response)
    }

    /// Close stdin, wait for exit, and kill on deadline. Called explicitly
    /// before fixture removal and again on drop.
    pub fn shutdown(&mut self) {
        drop(self.stdin.take());
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            match self.child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) => {
                    if Instant::now() >= deadline {
                        let _ = self.child.kill();
                        let _ = self.child.wait();
                        break;
                    }
                    thread::sleep(Duration::from_millis(10));
                }
                Err(_) => break,
            }
        }
    }
}

impl Drop for CoreProcess {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Decimal device/inode identity for a path (no symlink following).
pub fn identity_json(path: &Path) -> Value {
    let metadata = fs::symlink_metadata(path)
        .unwrap_or_else(|e| panic!("stat test path {}: {e}", path.display()));
    serde_json::json!({
        "dev": metadata.dev().to_string(),
        "ino": metadata.ino().to_string(),
    })
}

/// Promotion `file` state for a regular file.
pub fn file_state_json(path: &Path) -> Value {
    let bytes = fs::read(path).unwrap_or_else(|e| panic!("read test file {}: {e}", path.display()));
    let metadata = fs::symlink_metadata(path)
        .unwrap_or_else(|e| panic!("stat test file {}: {e}", path.display()));
    assert!(
        metadata.file_type().is_file(),
        "test file {} is not regular",
        path.display()
    );
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let sha256 = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    serde_json::json!({
        "type": "file",
        "mode": metadata.mode() & 0o777,
        "size": bytes.len().to_string(),
        "sha256": sha256,
    })
}

pub fn expected_file_json(path: &Path) -> Value {
    serde_json::json!({
        "identity": identity_json(path),
        "state": file_state_json(path),
    })
}

/// Poll for a marker file created by the core pause seam.
pub fn wait_for_path(path: &Path, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if fs::symlink_metadata(path).is_ok() {
            return;
        }
        thread::sleep(Duration::from_millis(5));
    }
    panic!("timed out waiting for {}", path.display());
}
