//! #256 (trees) and #260 (store-create): fail closed on unreadable
//! merge conflicts and stale-ref deletes.

mod common;

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use serde_json::{json, Value};

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

struct StoreHarness {
    _fixture: TempFixture,
    source: PathBuf,
    base: Value,
    core: CoreProcess,
}

impl StoreHarness {
    fn new(prefix: &str) -> Self {
        let fixture = TempFixture::new(prefix);
        let home = fixture.join("home");
        fs::create_dir_all(&home).expect("create home");
        let source = fixture.join("source");
        fs::create_dir_all(&source).expect("create source");
        fs::write(source.join("conflict.txt"), "base\n").expect("write base");
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

    fn capture(&mut self, parent: Option<&str>) -> String {
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
            .and_then(|state| state.get("commit"))
            .and_then(Value::as_str)
            .expect("commit")
            .to_string()
    }

    fn shutdown(&mut self) {
        self.core.shutdown();
    }
}

#[test]
fn merge3_reports_conflict_paths() {
    let mut harness = StoreHarness::new("merge-conflicts");
    let base = harness.capture(None);
    fs::write(harness.source.join("conflict.txt"), "ours\n").expect("write ours");
    let ours = harness.capture(Some(&base));
    fs::write(harness.source.join("conflict.txt"), "theirs\n").expect("write theirs");
    let theirs = harness.capture(Some(&base));
    let response = harness
        .core
        .request_ok(
            "merge3",
            harness.payload(json!({ "ours": ours, "theirs": theirs })),
            DEADLINE,
        )
        .expect("merge3");
    let result = response.get("result").expect("merge result");
    assert_eq!(result.get("ok").and_then(Value::as_bool), Some(false));
    let conflicts = result
        .get("conflicts")
        .and_then(Value::as_array)
        .expect("conflicts");
    assert!(
        conflicts.iter().any(|c| c.as_str() == Some("conflict.txt")),
        "merge must surface the conflict path: {conflicts:?}"
    );
    harness.shutdown();
}

#[test]
fn store_create_fails_when_stale_ref_cannot_be_deleted() {
    let mut harness = StoreHarness::new("stale-ref-delete");
    let store_dir = PathBuf::from(harness.base["storeDir"].as_str().expect("storeDir"));
    let state_dir = store_dir
        .join("git")
        .join("refs")
        .join("termina")
        .join("state");
    fs::create_dir_all(&state_dir).expect("create stale ref dir");
    fs::write(
        state_dir.join("dead"),
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
    )
    .expect("write stale ref");
    let mut permissions = fs::metadata(&state_dir)
        .expect("stat state refs")
        .permissions();
    permissions.set_mode(0o555);
    fs::set_permissions(&state_dir, permissions).expect("chmod state refs");
    let response = harness
        .core
        .request("store-create", harness.payload(json!({})), DEADLINE)
        .expect("store-create response");
    let mut restore = fs::metadata(&state_dir)
        .ok()
        .map(|meta| meta.permissions())
        .unwrap_or_else(|| {
            let mut p = fs::Permissions::from_mode(0o755);
            p.set_mode(0o755);
            p
        });
    restore.set_mode(0o755);
    let _ = fs::set_permissions(&state_dir, restore);
    assert_eq!(
        response.get("ok").and_then(Value::as_bool),
        Some(false),
        "stale-ref delete failure must fail closed: {response}"
    );
    let error = response
        .get("error")
        .and_then(Value::as_str)
        .expect("error");
    assert!(
        error.contains("delete stale store ref"),
        "expected delete error, got {error}"
    );
    harness.shutdown();
}

#[test]
fn store_create_fails_when_stale_ref_name_is_not_utf8() {
    let mut harness = StoreHarness::new("stale-ref-utf8");
    let store_dir = PathBuf::from(harness.base["storeDir"].as_str().expect("storeDir"));
    let git_dir = store_dir.join("git");
    fs::create_dir_all(git_dir.join("refs").join("termina").join("state"))
        .expect("create stale ref dir");
    // APFS rejects non-UTF-8 filenames. A packed-refs line can still name a
    // termina ref with invalid UTF-8 without creating that leaf.
    let mut packed = b"# pack-refs with: peeled fully-peeled sorted\n".to_vec();
    packed.extend_from_slice(b"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa refs/termina/state/");
    packed.extend_from_slice(b"dead\xff\n");
    fs::write(git_dir.join("packed-refs"), packed).expect("write packed-refs");
    let response = harness
        .core
        .request("store-create", harness.payload(json!({})), DEADLINE)
        .expect("store-create response");
    assert_eq!(
        response.get("ok").and_then(Value::as_bool),
        Some(false),
        "non-UTF-8 stale ref name must fail closed: {response}"
    );
    let error = response
        .get("error")
        .and_then(Value::as_str)
        .expect("error");
    assert!(
        error.contains("stale store ref name is not valid UTF-8")
            || error.contains("stale store ref is unreadable")
            || error.contains("list stale store refs failed"),
        "expected unreadable/non-UTF-8 ref error, got {error}"
    );
    harness.shutdown();
}
