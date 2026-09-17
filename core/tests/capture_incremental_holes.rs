//! #258: incremental capture must reject unsafe hints and keep
//! reconcile-only new files.

mod common;

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use serde_json::{json, Value};

use common::{CoreProcess, TempFixture};

const DEADLINE: Duration = Duration::from_secs(10);
const EMPTY_BLOB: &str = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";

fn git_env(home: &Path, tmp: &Path) -> Vec<(String, String)> {
    vec![
        (
            "PATH".to_string(),
            "/usr/bin:/bin:/usr/sbin:/sbin".to_string(),
        ),
        ("HOME".to_string(), home.to_str().unwrap().to_string()),
        ("TMPDIR".to_string(), tmp.to_str().unwrap().to_string()),
        ("GIT_CONFIG_NOSYSTEM".to_string(), "1".to_string()),
        ("GIT_TERMINAL_PROMPT".to_string(), "0".to_string()),
        ("LANG".to_string(), "C".to_string()),
        ("LC_ALL".to_string(), "C".to_string()),
    ]
}

fn git_init_and_add(source: &Path, home: &Path, tmp: &Path) {
    let env = git_env(home, tmp);
    let status = Command::new("git")
        .args(["init", "--quiet"])
        .arg(source)
        .envs(env.iter().cloned())
        .status()
        .expect("run git init");
    assert!(status.success(), "git init failed");
    let status = Command::new("git")
        .args(["-C"])
        .arg(source)
        .args(["add", "--all"])
        .envs(git_env(home, tmp))
        .status()
        .expect("run git add");
    assert!(status.success(), "git add failed");
}

struct CaptureHarness {
    _fixture: TempFixture,
    source: PathBuf,
    base: Value,
    core: CoreProcess,
}

impl CaptureHarness {
    fn with_files(prefix: &str, files: &[(&str, &str)]) -> Self {
        let fixture = TempFixture::new(prefix);
        let home = fixture.join("home");
        fs::create_dir_all(&home).expect("create home");
        let source = fixture.join("source");
        fs::create_dir_all(&source).expect("create source");
        for (rel, content) in files {
            let path = source.join(rel);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).expect("create source parent");
            }
            fs::write(&path, content).expect("write source file");
        }
        git_init_and_add(&source, &home, fixture.path());
        let mut core = CoreProcess::spawn(&home, fixture.path());
        let store_dir = fixture.join("store");
        let created = core
            .request_ok(
                "store-create",
                json!({
                    "storeDir": store_dir.to_str().unwrap(),
                    "sourceGitDir": source.join(".git").to_str().unwrap(),
                    "objectFormat": "sha1",
                }),
                DEADLINE,
            )
            .expect("store-create");
        let mut base = json!({
            "storeDir": store_dir.to_str().unwrap(),
            "sourceRoot": source.to_str().unwrap(),
            "sourceGitDir": source.join(".git").to_str().unwrap(),
            "objectFormat": "sha1",
        });
        for (key, value) in created.as_object().expect("store-create object") {
            if key.starts_with("store") {
                base[key] = value.clone();
            }
        }
        Self {
            _fixture: fixture,
            source,
            base,
            core,
        }
    }

    fn payload(&self, extra: Value) -> Value {
        let mut merged = self.base.as_object().cloned().expect("base object");
        for (key, value) in extra.as_object().expect("extra object") {
            merged.insert(key.clone(), value.clone());
        }
        Value::Object(merged)
    }

    fn capture(&mut self, parent: Option<&str>) -> Value {
        self.core
            .request_ok(
                "capture",
                self.payload(json!({
                    "head": Value::Null,
                    "parentCommit": parent,
                })),
                DEADLINE,
            )
            .expect("full capture")
            .get("state")
            .cloned()
            .expect("capture state")
    }

    fn incremental(
        &mut self,
        parent: &str,
        hints: &[&str],
        reconcile: Value,
    ) -> Result<Value, String> {
        let response = self.core.request(
            "capture-incremental",
            self.payload(json!({
                "parentCommit": parent,
                "hints": hints,
                "reconcile": reconcile,
            })),
            DEADLINE,
        )?;
        if response.get("ok").and_then(Value::as_bool) != Some(true) {
            return Err(response
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("unknown error")
                .to_string());
        }
        Ok(response.get("state").cloned().expect("incremental state"))
    }

    fn paths(&mut self, commit: &str) -> HashSet<String> {
        self.core
            .request_ok(
                "tree-paths",
                self.payload(json!({ "stateId": commit })),
                DEADLINE,
            )
            .expect("tree-paths")
            .get("paths")
            .and_then(Value::as_array)
            .expect("paths array")
            .iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect()
    }

    fn shutdown(&mut self) {
        self.core.shutdown();
    }
}

fn state_str(state: &Value, key: &str) -> String {
    state
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("state is missing {key}: {state}"))
        .to_string()
}

#[test]
fn unsafe_hint_fails_loudly() {
    let mut harness = CaptureHarness::with_files("inc-unsafe-hint", &[("keep.txt", "keep\n")]);
    let baseline = harness.capture(None);
    let baseline_commit = state_str(&baseline, "commit");
    let err = harness
        .incremental(&baseline_commit, &["../escape"], json!([]))
        .expect_err("unsafe hint must fail closed");
    assert!(
        err.contains("unsafe capture hint"),
        "unsafe hint must not be skipped: {err}"
    );
    let nested = harness
        .incremental(&baseline_commit, &[".git/HEAD"], json!([]))
        .expect_err("nested-repo hint must fail closed");
    assert!(
        nested.contains("unsafe capture hint"),
        "nested repository hint must not be skipped: {nested}"
    );
    harness.shutdown();
}

#[test]
fn unsafe_reconcile_fails_loudly() {
    let mut harness = CaptureHarness::with_files("inc-unsafe-reconcile", &[("keep.txt", "keep\n")]);
    let baseline = harness.capture(None);
    let baseline_commit = state_str(&baseline, "commit");
    let err = harness
        .incremental(
            &baseline_commit,
            &[],
            json!([{ "relPath": "../escape", "oid": EMPTY_BLOB }]),
        )
        .expect_err("unsafe reconcile must fail closed");
    assert!(
        err.contains("unsafe capture hint"),
        "unsafe reconcile must not be skipped: {err}"
    );
    let nested = harness
        .incremental(
            &baseline_commit,
            &[],
            json!([{ "relPath": ".git/HEAD", "oid": EMPTY_BLOB }]),
        )
        .expect_err("nested-repo reconcile must fail closed");
    assert!(
        nested.contains("unsafe capture hint"),
        "nested repository reconcile must not be skipped: {nested}"
    );
    harness.shutdown();
}

#[test]
fn malformed_reconcile_fails_loudly() {
    let mut harness = CaptureHarness::with_files("inc-bad-reconcile", &[("keep.txt", "keep\n")]);
    let baseline = harness.capture(None);
    let baseline_commit = state_str(&baseline, "commit");
    let missing_oid = harness
        .incremental(&baseline_commit, &[], json!([{ "relPath": "../escape" }]))
        .expect_err("reconcile without oid must fail closed");
    assert!(
        missing_oid.contains("relPath is missing") || missing_oid.contains("oid is missing"),
        "malformed reconcile must not be skipped: {missing_oid}"
    );
    let not_array = harness
        .core
        .request(
            "capture-incremental",
            harness.payload(json!({
                "parentCommit": baseline_commit,
                "hints": [],
                "reconcile": { "relPath": "keep.txt", "oid": EMPTY_BLOB },
            })),
            DEADLINE,
        )
        .expect("capture-incremental response");
    assert_eq!(
        not_array.get("ok").and_then(Value::as_bool),
        Some(false),
        "non-array reconcile must fail closed: {not_array}"
    );
    let error = not_array
        .get("error")
        .and_then(Value::as_str)
        .expect("error");
    assert!(
        error.contains("reconcile must be an array"),
        "expected array error, got {error}"
    );
    harness.shutdown();
}

#[test]
fn reconcile_only_new_file_enters_the_snapshot() {
    let mut harness = CaptureHarness::with_files("inc-reconcile-new", &[("keep.txt", "keep\n")]);
    let baseline = harness.capture(None);
    let baseline_commit = state_str(&baseline, "commit");
    fs::write(harness.source.join("added.txt"), "new file\n").expect("write new file");
    let incremental = harness
        .incremental(
            &baseline_commit,
            &[],
            json!([{ "relPath": "added.txt", "oid": EMPTY_BLOB }]),
        )
        .expect("reconcile-only new file must capture");
    let commit = state_str(&incremental, "commit");
    let paths = harness.paths(&commit);
    assert!(
        paths.contains("added.txt"),
        "reconcile-only new file is missing from the snapshot: {paths:?}"
    );
    assert!(paths.contains("keep.txt"));
    harness.shutdown();
}
