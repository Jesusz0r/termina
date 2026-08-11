# Releasing Termina

This runbook covers the whole release path: the signing certificates,
the CI secrets, the release steps, and the failures we hit so the next
release does not repeat them.

## The release command

```bash
# 1. Bump the version in package.json (electron-builder publishes under
#    the package.json version, NOT the git tag — they must match).
# 2. Commit and push. 3. Tag and push:
git tag v0.1.2
git push origin v0.1.2
```

GitHub Actions builds macOS arm64/x64 and Linux x64 bundles, signs and
notarizes the macOS ones, and publishes everything to the release plus
the raw `termina-core-<platform>-<arch>` binaries.

Verify with:

```bash
gh run list --limit 1
gh release view v0.1.2
```

The macOS job log must show `signing ... identityName=Developer ID
Application` and `notarization successful`.

## Prerequisites

### The signing certificate

Apple's notary service rejects real binaries signed with an **Apple
Distribution** certificate, even though codesign accepts it locally
(verified empirically; the certificate profile is the difference). You
must sign with a **Developer ID Application** certificate:

1. Generate a CSR (`openssl req -new -newkey rsa:2048 -nodes ...`).
2. https://developer.apple.com/account/resources/certificates/list →
   **+** → **Developer ID** → **Developer ID Application** → upload the
   CSR.
3. Download and install the certificate; pair it with the private key in
   the login keychain (an openssl-generated key imports via a legacy
   PKCS#12: `openssl pkcs12 -export -legacy ...` + `security import`).

Locally, `CSC_NAME="Developer ID Application"` selects the identity
from the keychain.

### The CI secrets

Repo secrets (https://github.com/Jesusz0r/termina/settings/secrets/actions):

| Secret | Value |
|---|---|
| `CSC_LINK` | base64 of the exported `.p12` identity (see below) |
| `CSC_KEY_PASSWORD` | the p12 export password |
| `CSC_NAME` | `Developer ID Application` |
| `APPLE_ID` | the Apple account email |
| `APPLE_APP_SPECIFIC_PASSWORD` | an app-specific password from https://appleid.apple.com |
| `APPLE_TEAM_ID` | `UWK965RX2N` |

Export the identity: in Keychain Access, right-click the certificate
(with its private key) → Export → Personal Information Exchange (.p12).
The `.p12` option is greyed out when the selected item has no paired
private key. Add the secret without showing the value:

```bash
base64 -i ~/Desktop/termina-dev-id.p12 | gh secret set CSC_LINK
gh secret set CSC_KEY_PASSWORD   # hidden prompt
```

Keep the `.p12` and its password safe. If either leaks, revoke the
certificate at developer.apple.com and rotate the app-specific password.

The workflow signs and notarizes only when the secrets exist; without
them the builds stay unsigned.

## The icon

`build/icon.svg` is the source; regenerate the icns with
`scripts/make-icon.sh` (macOS built-ins only). Commit the generated
`build/icon.icns` and `build/icon.png`.

## Known failures (do not repeat)

1. **Tag/version mismatch.** electron-builder publishes under the
   package.json version, not the git tag. A tag `v0.1.1` with version
   `0.1.0` in package.json publishes to the v0.1.0 release and the
   `gh release upload` for the new tag fails with "release not found".
   Keep them in lockstep.
2. **Draft vs release publish conflict.** With multiple platform jobs
   publishing to one release, the first job creates the release and the
   others skip with "existing type not compatible" when their publishing
   type is `draft`. `electron-builder.yml` pins `publish.releaseType:
   release`; do not change it back.
3. **macOS x64 runners are scarce.** The macos-13 job can queue for
   hours. Its artifacts publish automatically when it runs; do not
   cancel it and retag to "speed things up" unless the workflow changed.
4. **The bundled node and core must be signed for notarization.** The
   notary reports every unsigned nested binary ("not signed with a valid
   Developer ID certificate"). electron-builder signs the app, but
   `resources/` files are copied in as-is — if the error ever returns
   for `resources/node` or `resources/termina-core`, ad-hoc sign them
   (`codesign -s -`) in `scripts/prepare-resources.mjs`.
5. **The Apple Distribution cert trap.** The notary rejects it for real
   binaries while a shell-script-only test app passes — do not trust a
   minimal test that contains no compiled binary.

## Distribution channels

- **End users:** the `.dmg` (macOS) and `.AppImage` (Linux) on the
  GitHub release. No other installation is needed; users run `/login`
  in the terminal to configure their model provider.
- **From source:** `scripts/install.sh` downloads the prebuilt core and
  runs `npm install`; no cargo and no git required.
