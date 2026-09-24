//! Unsupported metadata/cleanup leaves must reject without blocking the core.
mod common;

use common::{CoreProcess, TempFixture, identity_json, wait_for_path};
use serde_json::json;
use std::ffi::CString;
use std::fs;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{FileTypeExt, PermissionsExt};
use std::path::Path;
use std::time::Duration;

const DEADLINE: Duration = Duration::from_secs(5);

fn fifo(path: &Path) {
    let name = CString::new(path.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
}

#[test]
fn generation_fifo_rejects_and_core_can_capture_after_repair() {
    let fixture = TempFixture::new("generation-fifo");
    let home = fixture.join("home");
    let source = fixture.join("source");
    let store = fixture.join("store");
    fs::create_dir(&home).unwrap();
    git2::Repository::init(&source).unwrap();
    fs::write(source.join("file"), b"healthy").unwrap();
    let mut core = CoreProcess::spawn(&home, fixture.path());
    let mut payload = json!({"storeDir": store, "sourceGitDir": source.join(".git"),
        "sourceRoot": source, "objectFormat": "sha1"});
    let created = core
        .request_ok("store-create", payload.clone(), DEADLINE)
        .unwrap();
    for (key, value) in created.as_object().unwrap() {
        if key.starts_with("store") {
            payload[key] = value.clone();
        }
    }
    let marker = store.join("termina-store-generation");
    let bytes = fs::read(&marker).unwrap();
    fs::remove_file(&marker).unwrap();
    fifo(&marker);
    let rejected = core.request("capture", payload.clone(), DEADLINE).unwrap();
    assert_eq!(rejected["ok"], false, "{rejected}");
    assert!(
        rejected["error"]
            .as_str()
            .unwrap()
            .contains("not a regular 64-byte file")
    );
    assert!(fs::symlink_metadata(&marker).unwrap().file_type().is_fifo());
    fs::remove_file(&marker).unwrap();
    fs::write(&marker, bytes).unwrap();
    core.request_ok("capture", payload, DEADLINE).unwrap();
    core.shutdown();
}

#[test]
fn cleanup_fifo_rejects_without_mutation_and_core_stays_usable() {
    let fixture = TempFixture::new("cleanup-fifo");
    let home = fixture.join("home");
    let root = fixture.join("root");
    fs::create_dir(&home).unwrap();
    fs::create_dir(&root).unwrap();
    let victim = root.join("fifo");
    fifo(&victim);
    let mut core = CoreProcess::spawn(&home, fixture.path());
    let rejected = core
        .request(
            "promotion-bound-remove-tree",
            json!({
                "root": root, "rootIdentity": identity_json(&root), "components": ["fifo"],
                "parentIdentity": identity_json(&root), "expectedIdentity": identity_json(&victim),
            }),
            DEADLINE,
        )
        .unwrap();
    assert_eq!(rejected["ok"], false, "{rejected}");
    assert!(
        rejected["error"]
            .as_str()
            .unwrap()
            .contains("unsupported file type")
    );
    assert!(fs::symlink_metadata(&victim).unwrap().file_type().is_fifo());
    core.request_ok(
        "promotion-bound-open-directory",
        json!({
            "path": root, "expectedIdentity": identity_json(&root),
        }),
        DEADLINE,
    )
    .unwrap();
    core.shutdown();
}

#[test]
fn cleanup_regular_file_replaced_with_fifo_before_open_rejects_without_blocking() {
    let fixture = TempFixture::new("cleanup-fifo-race");
    let home = fixture.join("home");
    let root = fixture.join("root");
    fs::create_dir(&home).unwrap();
    fs::create_dir(&root).unwrap();
    let victim = root.join("file");
    fs::write(&victim, b"original").unwrap();
    let ready = fixture.join("ready");
    let release = fixture.join("release");
    let mut core = CoreProcess::spawn(&home, fixture.path());
    let request = core.send("promotion-bound-remove-tree", json!({
        "root": root, "rootIdentity": identity_json(&root), "components": ["file"],
        "parentIdentity": identity_json(&root), "expectedIdentity": identity_json(&victim),
        "testHook": {"stage": "promotion-cleanup-root-observed", "readyPath": ready, "releasePath": release},
    })).unwrap();
    wait_for_path(&ready, DEADLINE);
    fs::rename(&victim, root.join("original")).unwrap();
    fifo(&victim);
    fs::write(&release, b"release").unwrap();
    let rejected = core.recv(&request, DEADLINE).unwrap();
    assert_eq!(rejected["ok"], false, "{rejected}");
    assert!(
        rejected["error"]
            .as_str()
            .unwrap()
            .contains("identity mismatch"),
        "{rejected}"
    );
    assert!(fs::symlink_metadata(&victim).unwrap().file_type().is_fifo());
    assert_eq!(fs::read(root.join("original")).unwrap(), b"original");
    core.request_ok(
        "promotion-bound-open-directory",
        json!({
            "path": root, "expectedIdentity": identity_json(&root),
        }),
        DEADLINE,
    )
    .unwrap();
    core.shutdown();
}

#[test]
fn retained_state_and_temporary_fifos_reject_then_allow_healthy_binding() {
    for name in ["binding.state", "binding.state.tmp", "binding.tmp"] {
        let fixture = TempFixture::new("retained-fifo");
        let home = fixture.join("home");
        let parent = fixture.join("parent");
        let provenance = fixture.join("provenance");
        for dir in [&home, &parent, &provenance] {
            fs::create_dir(dir).unwrap();
            fs::set_permissions(dir, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let payload = json!({"path": parent.join("root"),
            "trustedParent": {"path": parent, "identity": identity_json(&parent), "name": "root"},
            "provenance": {"name": "binding", "parent": {"path": provenance, "identity": identity_json(&provenance)}},
        });
        let victim = provenance.join(name);
        fifo(&victim);
        let mut core = CoreProcess::spawn(&home, fixture.path());
        let rejected = core
            .request(
                "promotion-bound-ensure-directory",
                payload.clone(),
                DEADLINE,
            )
            .unwrap();
        assert_eq!(rejected["ok"], false, "{name}: {rejected}");
        assert!(
            rejected["error"]
                .as_str()
                .unwrap()
                .contains("bounded private"),
            "{rejected}"
        );
        assert!(fs::symlink_metadata(&victim).unwrap().file_type().is_fifo());
        fs::remove_file(&victim).unwrap();
        core.request_ok("promotion-bound-ensure-directory", payload, DEADLINE)
            .unwrap();
        core.shutdown();
    }
}
