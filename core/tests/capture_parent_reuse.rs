//! A capture that names an indexed parent reuses that state when the
//! worktree is unchanged, and records only the paths that actually changed.

mod common;

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use base64::Engine;
use serde_json::{Value, json};

use common::{CoreProcess, TempFixture};

const DEADLINE: Duration = Duration::from_secs(10);

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
    fixture: TempFixture,
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
            fixture,
            source,
            base,
            core,
        }
    }

    fn git(&self, args: &[&str]) {
        let status = Command::new("git")
            .args(["-C"])
            .arg(&self.source)
            .args(args)
            .envs(git_env(&self.fixture.join("home"), self.fixture.path()))
            .status()
            .expect("run git");
        assert!(status.success(), "git {args:?} failed");
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
            .expect("capture")
            .get("state")
            .cloned()
            .expect("capture state")
    }

    fn blob(&mut self, commit: &str, rel_path: &str) -> Vec<u8> {
        let content = self
            .core
            .request_ok(
                "read-blob",
                self.payload(json!({
                    "stateId": commit,
                    "relPath": rel_path,
                })),
                DEADLINE,
            )
            .expect("read-blob")
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or_else(|| panic!("missing blob {rel_path}"))
            .to_string();
        base64::engine::general_purpose::STANDARD
            .decode(content)
            .expect("decode blob")
    }
}

fn state_str(state: &Value, key: &str) -> String {
    state
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("state is missing {key}: {state}"))
        .to_string()
}

fn state_u64(state: &Value, key: &str) -> u64 {
    state
        .get(key)
        .and_then(Value::as_u64)
        .unwrap_or_else(|| panic!("state is missing {key}: {state}"))
}

#[test]
fn unchanged_parent_capture_reuses_the_indexed_state() {
    let mut harness = CaptureHarness::with_files(
        "parent-reuse-same",
        &[("keep.txt", "keep\n"), ("src/a.txt", "alpha\n")],
    );
    let baseline = harness.capture(None);
    let baseline_commit = state_str(&baseline, "commit");
    let again = harness.capture(Some(&baseline_commit));
    assert_eq!(state_str(&again, "commit"), baseline_commit);
    assert_eq!(state_str(&again, "tree"), state_str(&baseline, "tree"));
    assert_eq!(state_u64(&again, "newBlobBytes"), 0);
    assert_eq!(state_u64(&again, "pathCount"), 2);
    assert_eq!(harness.blob(&baseline_commit, "src/a.txt"), b"alpha\n");
}

#[test]
fn parent_capture_records_only_the_changed_file() {
    let mut harness = CaptureHarness::with_files(
        "parent-reuse-edit",
        &[("keep.txt", "keep\n"), ("src/a.txt", "alpha\n")],
    );
    let baseline = harness.capture(None);
    let baseline_commit = state_str(&baseline, "commit");
    fs::write(harness.source.join("src/a.txt"), "beta\n").expect("rewrite src/a.txt");
    let edited = harness.capture(Some(&baseline_commit));
    let edited_commit = state_str(&edited, "commit");
    assert_ne!(edited_commit, baseline_commit);
    assert_ne!(state_str(&edited, "tree"), state_str(&baseline, "tree"));
    assert_eq!(state_u64(&edited, "pathCount"), 2);
    assert!(state_u64(&edited, "newBlobBytes") > 0);
    assert_eq!(harness.blob(&edited_commit, "src/a.txt"), b"beta\n");
    assert_eq!(harness.blob(&edited_commit, "keep.txt"), b"keep\n");
}

#[test]
fn parent_capture_adds_untracked_and_drops_deleted_files() {
    let mut harness = CaptureHarness::with_files(
        "parent-reuse-domain",
        &[("keep.txt", "keep\n"), ("src/a.txt", "alpha\n")],
    );
    let baseline = harness.capture(None);
    let baseline_commit = state_str(&baseline, "commit");
    fs::write(harness.source.join("extra.txt"), "extra\n").expect("write extra");
    fs::remove_file(harness.source.join("keep.txt")).expect("delete keep");
    let next = harness.capture(Some(&baseline_commit));
    let next_commit = state_str(&next, "commit");
    assert_ne!(next_commit, baseline_commit);
    assert_eq!(harness.blob(&next_commit, "extra.txt"), b"extra\n");
    assert_eq!(harness.blob(&next_commit, "src/a.txt"), b"alpha\n");
    let missing = harness
        .core
        .request_ok(
            "read-blob",
            harness.payload(json!({
                "stateId": next_commit,
                "relPath": "keep.txt",
            })),
            DEADLINE,
        )
        .expect("read deleted blob");
    assert!(missing.get("content").unwrap().is_null());
}

#[test]
fn dirty_file_stays_in_the_snapshot_until_it_changes() {
    let mut harness = CaptureHarness::with_files(
        "parent-reuse-dirty",
        &[("keep.txt", "keep\n"), ("a.txt", "alpha\n")],
    );
    fs::write(harness.source.join("a.txt"), "dirty\n").expect("dirty a.txt");
    let baseline = harness.capture(None);
    let baseline_commit = state_str(&baseline, "commit");
    assert_eq!(harness.blob(&baseline_commit, "a.txt"), b"dirty\n");

    let again = harness.capture(Some(&baseline_commit));
    assert_eq!(state_str(&again, "commit"), baseline_commit);
    assert_eq!(harness.blob(&baseline_commit, "a.txt"), b"dirty\n");
    assert_eq!(harness.blob(&baseline_commit, "keep.txt"), b"keep\n");

    fs::write(harness.source.join("a.txt"), "dirtier\n").expect("edit dirty file");
    let edited = harness.capture(Some(&baseline_commit));
    let edited_commit = state_str(&edited, "commit");
    assert_ne!(edited_commit, baseline_commit);
    assert_eq!(harness.blob(&edited_commit, "a.txt"), b"dirtier\n");
    assert_eq!(harness.blob(&edited_commit, "keep.txt"), b"keep\n");
}

#[test]
fn clean_index_update_moves_the_snapshot_without_a_worktree_drift() {
    let mut harness = CaptureHarness::with_files("parent-reuse-add", &[("a.txt", "alpha\n")]);
    let baseline = harness.capture(None);
    let baseline_commit = state_str(&baseline, "commit");
    fs::write(harness.source.join("a.txt"), "beta\n").expect("stage new bytes");
    harness.git(&["add", "a.txt"]);
    let added = harness.capture(Some(&baseline_commit));
    let added_commit = state_str(&added, "commit");
    assert_ne!(added_commit, baseline_commit);
    assert_eq!(harness.blob(&added_commit, "a.txt"), b"beta\n");
}

/// A parent capture must name the same tree a full capture of the same
/// worktree names, whatever flags the index carries.
fn assert_matches_full_capture(harness: &mut CaptureHarness, parent: &str) -> Value {
    let delta = harness.capture(Some(parent));
    let full = harness.capture(None);
    assert_eq!(
        state_str(&delta, "tree"),
        state_str(&full, "tree"),
        "parent capture diverged from a full capture"
    );
    delta
}

#[test]
fn skip_worktree_file_removed_from_disk_leaves_the_snapshot() {
    let mut harness = CaptureHarness::with_files(
        "parent-reuse-skip-worktree",
        &[("keep.txt", "keep\n"), ("sparse.txt", "sparse\n")],
    );
    let baseline = harness.capture(None);
    let baseline_commit = state_str(&baseline, "commit");
    harness.git(&["update-index", "--skip-worktree", "sparse.txt"]);
    fs::remove_file(harness.source.join("sparse.txt")).expect("remove sparse file");
    let next = assert_matches_full_capture(&mut harness, &baseline_commit);
    assert_eq!(state_u64(&next, "pathCount"), 1);
    // Absent at the parent too: the next capture must not fail on it.
    let next_commit = state_str(&next, "commit");
    assert_matches_full_capture(&mut harness, &next_commit);
}

#[test]
fn assume_unchanged_edit_still_reaches_the_snapshot() {
    let mut harness = CaptureHarness::with_files(
        "parent-reuse-assume-unchanged",
        &[("keep.txt", "keep\n"), ("a.txt", "alpha\n")],
    );
    let baseline = harness.capture(None);
    let baseline_commit = state_str(&baseline, "commit");
    harness.git(&["update-index", "--assume-unchanged", "a.txt"]);
    fs::write(harness.source.join("a.txt"), "beta and more\n").expect("edit a.txt");
    let next = assert_matches_full_capture(&mut harness, &baseline_commit);
    assert_eq!(
        harness.blob(&state_str(&next, "commit"), "a.txt"),
        b"beta and more\n"
    );
}

#[test]
fn assume_unchanged_file_removed_from_disk_leaves_the_snapshot() {
    let mut harness = CaptureHarness::with_files(
        "parent-reuse-assume-unchanged-rm",
        &[("keep.txt", "keep\n"), ("a.txt", "alpha\n")],
    );
    let baseline = harness.capture(None);
    let baseline_commit = state_str(&baseline, "commit");
    harness.git(&["update-index", "--assume-unchanged", "a.txt"]);
    fs::remove_file(harness.source.join("a.txt")).expect("remove a.txt");
    let next = assert_matches_full_capture(&mut harness, &baseline_commit);
    assert_eq!(state_u64(&next, "pathCount"), 1);
}
