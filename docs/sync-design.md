# Nora Sync: Design

Status: draft for review, revised after two architecture reviews. Nothing here is implemented.

Base branch: `release/4.0.0-alpha.6` (upstream `Sandakan/Nora`, tip `e6b7b052`). Upstream is
`github.com/Sandakan/Nora`; `github.com/Owie6789/Nora` is the fork and the only push target.

---

## 1. Problem

Nora cannot move app data between machines on its own. `exportAppData.ts` and `importAppData.ts`
give the user a manual SQL dump to a folder they pick. That is a backup primitive rather than a sync
system: no conflict handling, no stable cross-device identity, no scheduling, no transport.

The goal is bidirectional sync of user data across devices, over providers the user chooses, with an
explicit protocol underneath instead of three provider-specific upload scripts.

## 2. The constraint that shapes everything

Nora has no stable cross-device identity for any entity.

Every table uses `integer('id').primaryKey().generatedAlwaysAsIdentity()`. A grep across `src/` and
`resources/` turns up zero persisted stable identifiers. `musicbrainz`, `mbid`, `fingerprint`,
`contentHash` and `sha1` appear only in API response type declarations, never in stored data, and
`src/types/musicbrainz_artist_data_api.d.ts` is dead, referenced by nothing.

Song rows are not stable even locally. `checkFolderForUnknownContentModifications.ts:47` calls
`removeSongsFromLibrary(...)`, and re-added files get fresh identity-generated ids, so a library
resync invalidates any ledger keyed on `songs.id`.

No name-bearing table has a unique constraint. Verified across `schema.ts`:

| Table          | Natural key          | Unique? | Case-insensitive column |
| -------------- | -------------------- | ------- | ----------------------- |
| `artists`      | `name` varchar(1024) | no      | `name_ci`, generated    |
| `albums`       | `title` varchar(255) | no      | `title_ci`, generated   |
| `genres`       | `name` varchar(255)  | no      | `name_ci`, generated    |
| `playlists`    | `name` varchar(255)  | no      | `name_ci`, generated    |
| `musicFolders` | `path`               | yes     | none                    |

Each of those `*_ci` columns is generated from the name, so it always shows the current name and can
never record the previous one. Nora already permits two artists called "The Weeknd". Name works as a
bootstrap heuristic and nothing more. See §6.

## 3. Scope of the first shippable slice

This slice is identity-independent data shipped on top of the identity foundation in §6. It is not
"identity-free": playlists, artists, albums and genres receive `syncId`s in this same slice. The
wording matters so a future reader does not wonder why a supposedly identity-free release already
carries a ledger.

### Syncs

| Entity                            | Source                              | Notes                                                                               |
| --------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------- |
| Preferences                       | `userSettings`                      | `language`, `theme`, `recentSearches`, `zoomFactor`, the three Last.fm send toggles |
| Keyboard shortcuts                | `userKeyboardShortcuts`             | no song references                                                                  |
| Equalizer preset                  | `userEqualizerPreset`               | no song references                                                                  |
| Sorting states                    | localStorage `sortingStates`        |                                                                                     |
| Lyrics editor settings            | localStorage `lyricsEditorSettings` |                                                                                     |
| Playlist metadata                 | `playlists`                         | name only, no artwork, no membership                                                |
| Artist, album and genre favorites | `artists`, `albums`, `genres`       | `syncId`-keyed after bootstrap                                                      |

Playlist artwork is excluded because it is not metadata. `artworks.path` is `notNull` local
filesystem text, `source` is `LOCAL | REMOTE`, and `artworks_playlists(playlist_id, artwork_id)` is a
composite local-integer junction. Artwork identity is a local integer plus a local file path, so
syncing it means shipping image bytes and re-deriving row identities. That is an image replication
system wearing a lightweight-sync label. The protocol reserves attachments (§5).

### Never syncs

| Excluded                                                                  | Reason                                              |
| ------------------------------------------------------------------------- | --------------------------------------------------- |
| `songs.path`, `folder_id`, all `musicFolders` rows                        | absolute paths mean nothing on another machine      |
| `customLrcFilesSaveLocation`                                              | a filesystem path, same objection as `musicFolders` |
| `playlistsSongs`, `playHistory`, `playEvents`, `seekEvents`, `skipEvents` | local integer song ids                              |
| `ignoredDuplicateMetadata`                                                | carries `songId`                                    |
| Song and folder blacklist                                                 | song id or folder path                              |
| `artworks`, `artworksPlaylists`                                           | local paths and local ids                           |
| `lastFmSessionName`, `lastFmSessionKey`                                   | credentials, not data                               |
| `windowX/Y/Width/Height`, `windowState`                                   | device geometry                                     |
| localStorage `queue`, most of `playback`                                  | reference song ids                                  |

### Deferred, not rejected

Song favorites, playlist membership, blacklist state, listening statistics, custom playlist artwork,
and every Last.fm feature. All of them need song identity (§13, slices 8 and 9).

## 4. Architecture

```
sync/protocol/      pure: Zod schemas, canonical serialization, versioning
sync/merge/         pure: HLC ordering, resolution, additive sets, tombstones
sync/providers/     transport only; knows nothing about playlists or artists
sync/ledger/        identity: bootstrap resolution, binding, HLC, tombstones
sync/localStore.ts  the only code that reads or writes syncable PGlite state
sync/engine.ts      state machine and scheduler; orchestrates, issues no SQL
```

Side effects live at the edges. Merging, diffing, normalization, validation, serialization and state
transitions are pure functions.

`localStore.ts` owns reading syncable state, applying merged state, recording ledger changes, and
write transactions. `engine.ts` sequences provider, protocol, merge and localStore. Without that
split `engine.ts` becomes the file where every sync concern ends up, and nothing in it can be tested
without a database.

The provider boundary is bytes, and the type system enforces it:

```ts
interface SyncProvider {
  readonly id: string;
  readonly status: ProviderStatus; // includes 'notConfigured'
  get(): Promise<{ blob: Uint8Array; revision: ProviderRevision }>;
  put(blob: Uint8Array, expected: ProviderRevision | null): Promise<{ revision: ProviderRevision }>;
}
```

The provider stores and retrieves opaque bytes. Decoding is `sync/protocol/`'s job, domain rules are
`sync/merge/`'s job. A provider cannot see a playlist, because it cannot see anything but a byte
array.

`get` and `put` rather than a cursor-and-change-feed shape, because no provider offers a change
stream here. See §8 for why `ProviderRevision` and the logical digest are separate things.

## 5. Protocol and versioning

### 5.1 Key hierarchy

```
passphrase
  -> KDF, argon2id where available, else scrypt (§5.6)
  -> KEK0
  -> HKDF-SHA256(ikm=KEK0, info=canonical(kdfParams || envelopeVersion), 32)
  -> KEK
  -> RFC 3394 AES key unwrap, aes-kw-256
  -> payloadKey
  -> AES-256-GCM
  -> canonical sync payload
```

Locally, `payloadKey` is protected by Electron `safeStorage`. Routine sync never needs the
passphrase.

There is no separate data-encryption key. V1 has one payload-encryption key and one recovery
mechanism, and a DEK would provide no required cryptographic function. Introducing one would add a
second wrap, a second nonce, a second tag and a second lifecycle to get wrong, in exchange for key
separation and rotation semantics that v1 does not use. Revisit when a real requirement appears, such
as multiple data-encryption keys or independent rotation.

`safeStorage` protects `payloadKey` because it is a local credential-storage problem. The passphrase
protects `payloadKey` because it is a cross-device recovery problem. The GitHub token authorises the
provider and does neither. Three separate concerns, three separate secrets, never interchangeable.

### 5.2 Envelope

```ts
interface SyncEnvelope {
  envelopeVersion: 1;
  keyWrap: {
    kdf: { algorithm: 'argon2id' | 'scrypt'; params: KdfParams; salt: string };
    cipher: 'aes-kw-256';
    wrappedPayloadKey: string; // base64
  };
  payload: {
    cipher: 'aes-256-gcm';
    nonce: string; // 12 bytes, base64
    tag: string; // 16 bytes, base64
    ciphertext: string;
  };
  attachments: ManifestAttachment[]; // reserved, empty in v1
}
```

The KDF sits under `keyWrap.kdf` and the wrapping cipher under `keyWrap.cipher`. Conflating them
was wrong: scrypt derives a key, it does not wrap one. `algorithm` is a union because the KDF is
feature-detected (§5.6) and a reader must know which one produced a given key rather than assume.

`salt` is 16 random bytes per wrapping, base64. For argon2id it is passed as Node's `nonce`
argument; see §5.6 for why that name matters.

### 5.3 Payload

```ts
interface SyncPayload {
  schemaVersion: 1;
  deviceId: string;
  generatedAt: string; // ISO-8601 UTC, display only
  payloadDigest: string; // SHA-256 of canonical payload with this field omitted
  records: Record<string, SyncRecord>;
  tombstones: Tombstone[];
}
```

`payloadDigest` lives inside the ciphertext. An earlier draft put a keyed digest in the clear, on the
theory that HMAC would fix the leak. It would not. An observer seeing the same digest on two devices
still learns those devices hold identical logical state, because HMAC provides authenticity rather
than secrecy. GCM already authenticates the plaintext, so a second MAC inside buys nothing.

The cost is that Nora cannot compare logical state without fetching and decrypting first. That is
the right trade. Decryption is local and cheap; the network fetch is the expensive part, and it
happens anyway.

Two encryptions of identical state produce different ciphertext because the nonce differs. Only the
canonical plaintext is byte-stable.

The digest is computed over the canonical payload with `payloadDigest` itself omitted, then inserted,
then encrypted. Canonicalising a payload that still contains its own digest is circular and would
never terminate, so the omission is part of the format definition rather than an implementation
detail.

The digest is not a security primitive. It exists to answer "do these two devices already hold the
same logical state" after decryption.

### 5.4 What is authenticated

GCM authenticates only its own ciphertext. Everything in the envelope outside it is attacker-visible,
and the envelope arrives from a provider the user chose, not from Nora.

The key-wrap step happens before decryption, so the payload's GCM tag cannot protect the KDF
parameters. And RFC 3394 AES-KW takes no associated data. Binding the parameters has to happen during
key derivation, so that altered parameters yield a different KEK:

```
KEK = HKDF-SHA256(ikm=scrypt(...), info=canonical({kdfParams, envelopeVersion}), 32)
```

Change `params`, `salt` or `envelopeVersion` and the KEK changes, so the RFC 3394 integrity check
value fails and the wrap is rejected. That is the binding.

The payload's own GCM associated data is `canonical({envelopeVersion, schemaVersion, deviceId,
generatedAt})`. Those fields cannot be altered without the tag failing.

### 5.5 Nonces

The payload nonce is 12 bytes from a CSPRNG, fresh on every encryption, and never reused under the
same `payloadKey`. GCM nonce reuse under a repeated key leaks the XOR of plaintexts and allows
forgery, so it is the one failure that must be structurally impossible rather than merely unlikely.
Random 96-bit nonces put the birthday bound near 2^32 encryptions for a single key, which is far
beyond any realistic sync count.

Do not derive nonces from a counter that resets to zero on restart. Either draw randomly, or persist
the counter alongside the HLC state.

RFC 3394 AES-KW is deterministic and takes no nonce. Wrapping the same `payloadKey` under the same
KEK yields identical bytes, which is why a passphrase change that rewraps without re-encrypting is
safe.

### 5.6 The KDF

The wrapped key sits in provider storage, where anyone can attempt an offline guess. The cost factor
is therefore the entire defence, and a per-installation random salt is what makes each guess
independent and expensive. Not a bare `SHA-256(password)`, and not a salt-free KDF.

**Argon2id is preferred, scrypt is the fallback, chosen by feature detection.**

Verified directly against Node 24.21.0 on this machine:

| Check                                     | Result                             |
| ----------------------------------------- | ---------------------------------- |
| `crypto.argon2Sync` present               | yes, added in Node v24.7.0         |
| name of the salt argument                 | **`nonce`**                        |
| varying `nonce`                           | changes the derived key            |
| repeating `nonce`                         | reproduces the derived key exactly |
| passing `salt` instead                    | **silently ignored, no throw**     |
| passing an unknown key such as `bogusKey` | **silently ignored, no throw**     |
| minimum `nonce` length                    | 8 bytes                            |

Argon2 has no "nonce" in the specification, so Node's `nonce` is the salt slot under a misleading
name. That matters more than it sounds: passing `salt` produces a KDF with **no salt at all** and
raises nothing, which would mean every Nora installation derived the same key from the same
passphrase. The implementation passes only the exact documented key names, and a unit test asserts
that two different `nonce` values derive different keys, so a future upstream rename cannot silently
remove the salt.

Measured on this 8 GiB-capped machine, at OWASP's recommended configurations:

| KDF      | Parameters                       | Time   |
| -------- | -------------------------------- | ------ |
| argon2id | `m=19456` (19 MiB), `t=2`, `p=1` | 24 ms  |
| argon2id | `m=47104` (46 MiB), `t=1`, `p=1` | 33 ms  |
| argon2id | `m=7168` (7 MiB), `t=5`, `p=1`   | 14 ms  |
| scrypt   | `N=2^14`, `r=8`, `p=5` (16 MiB)  | 117 ms |

Argon2id is both the stronger primitive and the faster one here, so scrypt is a fallback for runtimes
that lack it, not a considered choice.

Unverified: whether Electron 44's bundled Node exposes `crypto.argon2Sync`. The Electron binary was
never downloaded in this environment, so it could not be checked locally, and
`releases.electronjs.org` is unreachable. Feature detection removes the need to resolve it: both
branches are unit tested, and the KDF actually used is recorded in the envelope so a reader can tell
which one produced a given key.

There is therefore no case for shipping an Argon2 dependency. Where the native API exists it is
already stronger and faster; where it does not, scrypt is present and adequate.

### 5.7 KDF parameters are validated before derivation

The envelope is untrusted input. Bounds are enforced during parse, before any expensive derivation.

For scrypt:

| Parameter             | Accepted range  | Rationale                                         |
| --------------------- | --------------- | ------------------------------------------------- |
| `N`                   | 2^14 to 2^20    | below 2^14 is too weak to resist offline guessing |
| `r`                   | 8 to 32         |                                                   |
| `p`                   | 1 to 16         |                                                   |
| derived `N * r * 128` | at most 256 MiB | memory ceiling                                    |

For argon2id, `memory` at most 65536 KiB (64 MiB) and at least 8 KiB, `passes` 1 to 10, `parallelism`
1 to 16, `tagLength` exactly 32.

Out-of-range values cause rejection. Nora does not silently clamp, because a clamp would let a
genuinely older Nora sync with a newer one that raised the cost without telling anyone, and it would
turn a tampering attempt into a quiet success.

The error message cannot promise to distinguish causes. A modified KDF parameter and a wrong
passphrase both produce a failed unwrap, and neither is distinguishable before `payloadKey` is
recovered. The message says so:

> Unable to unlock sync data. The passphrase may be incorrect, or the sync envelope may have been
> modified.

Only once `payloadKey` is recovered and GCM authentication fails is there stronger evidence of
envelope tampering. Nora does not claim to distinguish the two cases earlier than that.

### 5.8 Passphrase change does not rotate the key

```
old passphrase -> old KEK -> unwrap payloadKey
new passphrase -> new KEK -> wrap the same payloadKey
```

The payload ciphertext is untouched. Because AES-KW is deterministic, only `wrappedPayloadKey` and
the KDF salt and parameters change in the envelope.

Changing the passphrase and rotating `payloadKey` are different operations. Rotating `payloadKey`
requires re-encrypting the payload. The UI must not conflate them.

### 5.9 OS-wrapped storage is a convenience, never the only path

`safeStorage` holds a local copy of `payloadKey` so routine sync never needs the passphrase. It is
documented as unreliable in this project's macOS configuration, so the passphrase path stays
authoritative and `safeStorage` is only ever an accelerator.

Verified in this repository: macOS builds from CI are **unsigned**. `build.yml` runs
`electron-builder --mac` with no `CSC_LINK`, no `APPLE_ID` and no `APPLE_TEAM_ID`; `electron-builder.yml`
sets `hardenedRuntime: true` and `entitlementsInherit` but declares no signing `identity` and sets
`notarize: false`; and no signing script exists under `scripts/` or `build/`.

Electron's documentation states that on macOS an app "should be code signed for `safeStorage` to behave
consistently", and that without a valid, consistent signature macOS may not recognise different builds
as the same application, "which can cause the Keychain to re-prompt the user for permission on every
update".

Two consequences, both design requirements rather than warnings:

- Every macOS user may be re-prompted for Keychain access on each update. The UI must present that as
  expected behaviour rather than as a fault, and must not loop.
- A wrapped key can become unreadable across updates. On `safeStorage` decrypt failure, or
  `shouldReEncrypt` repeatedly failing, Nora falls back to prompting for the recovery passphrase and
  unwraps `payloadKey` from the envelope. It never treats an OS-keychain failure as data loss, because
  the envelope always carries a passphrase-wrapped copy.

Two further platform facts apply. On Linux, `getSelectedStorageBackend()` returning `basic_text` means
the OS provides no protection at all, since data is then "encrypted via hardcoded plaintext password";
Nora detects that and warns rather than claiming protection it does not have. And this repository has
no existing use of Electron's `safeStorage` at all, since the Last.fm session key goes through Nora's
own `safeStorage.ts`, which is a different and weaker thing (§9.1). This is new ground.

### 5.10 No device revocation in v1

Once a second device has unwrapped `payloadKey`, changing the passphrase does not remove its ability
to decrypt data it already holds. Revoking a provider token stops future provider access and does not
invalidate a `payloadKey` that has already left the device.

V1 has no cryptographic device revocation. This is stated so that trusted-device management, when it
arrives, has a clear starting point: it needs real `payloadKey` rotation across devices, which v1
deliberately does not do.

## 6. Identity

### Lifecycle

```
unbound local entity
  -> bootstrap resolution (§6.1)
  -> assigned syncId
  -> syncId is authoritative during normal sync
```

Name matching exists only for initial adoption. Once an entity carries a `syncId`, that `syncId` is
the identity and the name is payload.

Any entity whose sync state must survive a cross-device rename or a change in local ids receives a
`syncId`. In v1 that is playlists, artists, albums and genres. Adding or dropping one is a protocol
change, which is why the rule is stated as a property rather than as a list.

Why it matters, concretely. Device A has "The Weeknd" and renames it to "Abel". Device B still has
"The Weeknd" and has never synced. If B resolves by name it either binds to the wrong identity or
creates a second artist, and the library ends up holding both. Because none of these tables constrain
the name and the `*_ci` column is generated, nothing in the schema prevents it.

`syncId` is authoritative during normal sync and is never automatically rebound. Manual identity
repair may explicitly break and recreate a binding, because a bad merge, a duplicated entity, a
corrupted ledger or a restored old backup will eventually need one, and refusing to offer the escape
hatch would make a historical mistake permanent. Repair is an explicit user action, never a side
effect of a sync.

### 6.1 Bootstrap resolution

Separate from the steady-state resolver, because before a `syncId` exists the remote identity is
unknown.

The matching universe is every remote entity, not only unbound ones. A remote artist may be bound on
device A and unbound locally on device B, and B still has to match against it.

For each local entity lacking a binding:

1. Look at all remote entities. Prefer candidates that already carry a `syncId`, since those are
   identities other devices have committed to.
2. Exactly one surviving candidate on the natural key (`name_ci` or `title_ci` equality) binds the
   local entity to that candidate's existing `syncId`. Reported as `matched`.
3. No candidate mints a new `syncId`. Reported as `created`.
4. More than one surviving candidate is ambiguous. Nora does not guess. The entity goes to the
   unresolved queue with its candidate list, reported as `ambiguous`.

Trigram indexes exist on all four name columns, and fuzzy matching is not used for automatic binding.
Artist and album names collide too easily for a false positive to be acceptable, and a wrong binding
worse than an unresolved entry. Fuzzy matches may be suggested in the UI and never auto-applied.

When minting, the order matters:

```
mint syncId -> bind locally -> persist binding -> build snapshot -> push
```

A failure between mint and persist leaves a remote identity with no local binding, and the next sync
mints a second identity for the same entity. Mint, bind and persist happen in one transaction.

Every bootstrap decision is shown to the user as created, matched or ambiguous counts, with the
ambiguous set listed. Silent auto-binding is how identity mistakes become unrecoverable.

### 6.2 Songs need two identities

A playlist membership has to name a song on the receiving device, and that device's `songs.id` means
nothing to the sender. A portable song reference therefore has two parts:

- the portable identity, which is sync-layer only and never a `songs.id`
- the local binding, which is this device's `songs.id` for that portable identity, held in the ledger

They are separate columns for separate reasons. Collapsing them reproduces the `songs.id` bug in a new
place. Song identity itself, layered as MBID then ISRC then normalized metadata, is slice 8.

## 7. Ordering: hybrid logical clock

Wall-clock time is not the resolution authority. A device whose clock is three days fast would win
last-writer-wins permanently and silently.

```
hlc = { physicalMs: number, counter: number, nodeId: string }
```

### 7.1 Transitions

State is the last emitted `(l, c)`. `now` is the local wall clock.

**Local event**

```
if now > l:
    (physicalMs, counter) = (now, 0)
else:
    (physicalMs, counter) = (l, c + 1)
```

The counter branch is required. With `counter = 0` on both paths, a local write during a millisecond
where `now <= l` produces a timestamp identical to the previous one, and two distinct changes become
indistinguishable.

**Receive event**, carrying remote `(rl, rc)`:

```
p = max(now, l, rl)
if p == l and p == rl:  counter = max(c, rc) + 1
if p == l and p != rl:  counter = c + 1
if p == rl and p != l:  counter = rc + 1
if p != l and p != rl:  counter = 0
physicalMs = p
```

**Merge**, used when resolving a stored remote record against local state: take the greater of the
two under the total order below, then run the receive transition on it.

**Total order.** `(physicalMs, counter, nodeId)`. `nodeId` breaks remaining ties, so every device
computes the same winner from the same set of records.

### 7.2 Persistence

`deviceId`, HLC state and `syncId`s are persistent. Restarting Nora must never regenerate the
`deviceId` or move the HLC backwards.

An emitted local change and the advancement of the HLC that stamped it become durable together, or
neither becomes observable. Generating an HLC, writing the entity, crashing before the HLC persists,
and restarting to mint the same HLC again is the failure this rules out. In practice the HLC advance
and the entity write commit in the same ledger transaction.

A bare per-device counter paired with `deviceId` is not usable. A monotonic counter alone is not
comparable across devices: 50 on A and 3 on B say nothing about order.

## 8. Concurrency: retry is not conflict

A compare-and-swap failure means the remote moved. It does not mean the user has a conflict:

```
Device A pulls revision R10
Device B pushes revision R11
Device A attempts put with expected R10  -> 409
```

That is routine when two devices sync near-simultaneously, and treating it as a user-facing conflict
produces spurious dialogs for something the engine can resolve:

```
put -> 409
    -> get newest remote
    -> decrypt, validate, resolve, merge
    -> retry put (bounded attempts, then surface an error)
```

`remote_changed` is internal and auto-retryable. `merge_conflict` is a distinct state reached only
when merging cannot produce a result, such as two devices renaming one entity to different values
with no ordering that resolves it. Only that reaches the user.

### 8.1 Two kinds of revision

They are related but not the same, and conflating them would make every future provider a special
case.

`ProviderRevision` is the exact remote object version observed, and is provider-specific. GitHub's is
the blob SHA. Drive has no equivalent, because Drive exposes an etag on a file it never hashes
itself.

The logical payload digest says whether the content changed. A GitHub blob SHA changes on every
re-encryption even when nothing logical changed, because the nonce differs. The two are therefore
stored and compared separately, and the provider contract names them differently on purpose.

## 9. Atomicity

A partially merged state is never visible to the user. The sequence is:

```
fetch -> authenticate and decrypt -> validate -> resolve -> build merged state
      -> commit locally, atomically -> publish resulting state
```

Never download, apply some records, hit a conflict, crash, and leave Nora holding half of device A
and half of device B. For a sync feature this is user-visible behaviour, not an internal detail.

The local commit is one transaction. A partial apply that survives a crash is a data-loss bug.

## 10. Providers

### 10.1 GitHub: GitHub App, flow chosen deliberately

Application type is a GitHub App. GitHub's guidance leads with the recommendation, citing finer-grained
permissions and short-lived tokens.

Flow is device flow, for the initial serverless desktop implementation. The reasoning runs both ways
and is recorded rather than presented as settled.

In favour: device flow needs no client secret. GitHub states that client secrets are required to
generate access tokens "unless your app uses the device flow", the authorization-code exchange
documents `client_secret` as required, and refresh documents it as required unless device flow was
used. Shipping a secret inside a distributed desktop binary defeats its own purpose.

Against: GitHub also warns that device flow requires no redirect URI, so an attacker can use it to
impersonate the app in a phishing attack, and advises against enabling it outside constrained
environments. The GitHub App documentation separately lists desktop applications as a device-flow
case, so the two pages genuinely disagree in emphasis.

Mitigation is required in the authorization UX. The UI shows which account is being authorized and
names the requesting app. It never implies the user can verify the request from inside Nora, because
with device flow they cannot. The displayed user code is the phishing surface.

Revisit authorization-code with PKCE if Nora gains a trusted backend able to hold a secret, or if
users report impersonation.

Device flow must be enabled in the app's settings at registration.

Token lifetime, confirmed against the GitHub App documentation: user access tokens expire after 8 hours
and refresh tokens after about 6 months. The refresh exchange needs a `client_secret` **unless the
original token came from device flow**, which is a second, independent reason device flow is the right
choice here. Refreshing rotates both tokens and invalidates the old refresh token, so a refresh failure
must not leave the engine holding a stale pair. Note that GitHub App user tokens do not use OAuth
scopes; they use fine-grained permissions, and the `scope` field is documented as always empty. There
is no `offline_access` equivalent to request.

Permissions are described honestly. Creating a repository for the authenticated user requires
repository administration or write capability, so if Nora creates the private repo on first sync the
initial authorization is broader than "only the sync repo", and the UI must say so. Pre-creating the
repo allows a narrower scope afterwards. The bootstrap scope is not presented as least-privilege
when it is not.

Transport is the Contents API against a single encrypted blob with compare-and-swap on the blob SHA,
which is the `ProviderRevision` of §8.1. One GET to fetch, one PUT to write. The Git Data API was
rejected: it gives atomic multi-file commits, and at one blob per sync that machinery buys nothing.

### 10.2 Google Drive: loopback with PKCE

Device flow is unusable. Verified empirically:

| Probe                                           | Result                                      |
| ----------------------------------------------- | ------------------------------------------- |
| `POST /device/code` with a fake client_id       | HTTP 401 `invalid_client`                   |
| `POST /device/definitelyNotARealPath` (control) | HTTP 404                                    |
| token exchange, device `grant_type`             | `Missing required parameter: client_secret` |

The endpoint exists, since a fake client yields 401 where a bogus path yields 404, but it requires a
`client_secret` on token exchange, which cannot ship. Drive uses RFC 8252 native app flow: loopback
`http://127.0.0.1:<random>/callback` with PKCE `S256`.

The GitHub and Drive asymmetry is a property of the two providers, not an inconsistency here.

**Drive has no etag in API v3.** The v2-to-v3 mapping lists `etag` as `n/a`, so `file.etag` does not
exist and a design must not assume it. `files.version` and `files.headRevisionId` both exist and are
output-only; `version` is documented as monotonically increasing across every server-side change.
Neither is documented as usable as a conditional-write precondition, so Drive offers **no documented
compare-and-swap**. That is a real difference from GitHub and it changes what the engine can promise
per provider, so `SyncProvider` carries a capability rather than pretending every backend can do CAS.
Folder visibility, a visible `Nora Sync` folder against `appDataFolder`, is still undecided; it
changes both the OAuth scope and the user's mental model, so it stays a deliberate decision.

### 10.3 Last.fm: a reader, not a provider

Last.fm is not a `SyncProvider`. It has no snapshot semantics and no upload, and forcing it into that
interface would misrepresent what the API can do. It is a separate module with a typed fetch layer,
shaped like the files in `src/main/other/lastFm/`.

It also cannot ship before song identity. Nora's history tables point at local `songs.id`, and Last.fm
returns artist and track names, so a reader that ran earlier would be unable to write into the tables
it is meant to populate. That is why it is slice 9 rather than slice 8.

Parameters for `user.getRecentTracks`, confirmed against the method documentation:

| Parameter    | Value                                                               |
| ------------ | ------------------------------------------------------------------- |
| `limit`      | default 50, **maximum 200**                                         |
| `from`, `to` | UNIX timestamps in integer **seconds**, UTC                         |
| `page`       | page-based pagination; no cursor parameter is documented            |
| `user`       | **required**, even though the method itself needs no authentication |
| `extended`   | supported                                                           |

Response paths the reader depends on:

| Need                   | Path                                         |
| ---------------------- | -------------------------------------------- |
| now-playing marker     | `recenttracks.track[].@attr.nowplaying`      |
| machine timestamp      | `recenttracks.track[].date.uts` (seconds)    |
| artist / track / album | `artist["#text"]`, `.name`, `album["#text"]` |
| MusicBrainz IDs        | `artist.mbid`, `mbid`, `album.mbid`          |

Two things the reader must handle defensively, both from the documentation rather than assumption:

- **All three MBID fields can be empty.** The published example has a populated artist MBID and empty
  track and album MBIDs. They are nullable, never required to be valid.
- **`total` in `@attr` is not guaranteed.** The official XML example shows `user`, `page`, `perPage`
  and `totalPages` but not `total`, while JSON examples include it. The reader treats it as optional
  and does not depend on it for pagination, using `totalPages` and stopping on a short page instead.
- A now-playing entry may lack `date.uts`; there is an open regression on that, so a missing
  timestamp on the now-playing row is tolerated rather than treated as malformed.

No stable per-scrobble event id is documented. This is the central design consequence: the reader must
mint its own composite listen identity, and a composite of track identity plus timestamp is not
formally guaranteed collision-free because Last.fm documents no uniqueness constraint over those
fields. The composite therefore includes the listening device's own local song id, so a repeat import
of the same remote page cannot create a second row.

Write-side, for duplicate avoidance: `track.scrobble` and `track.updateNowPlaying` both accept an
optional `mbid` **alongside** required `artist` and `track`, so MBID supplements rather than replaces
them. `track.scrobble` batches at 50 per request. `track.love` and `track.unlove` have **no** documented
`mbid` parameter, which means love/unlove reconciliation stays keyed on artist and track names.

Error handling follows the documented code list rather than a guess:

- Retryable with backoff: **8** (backend failure), **11** (service offline), **16** (temporary service
  error), **29** (rate limited).
- Not retryable, because backoff cannot fix them: **2, 3, 5, 6, 7** (malformed request), **4, 9, 10, 13,
  14** (credential or signature problems, recoverable only by re-authenticating), **12, 17, 18**
  (account or subscription state), **20–25** (radio or content conditions), **26** (suspended key),
  **27** (deprecated). Codes **1** and **19** are documented as not existing.

Treating a bad session key as retryable is how a client ends up retrying invalid credentials forever,
so that classification is explicit rather than left to a generic 5xx rule.

No numeric rate limit is documented. Error 29 is the only limiter Last.fm describes, and it attributes
throttling to the **IP address** rather than to an API key or account. The reader therefore never
hard-codes a requests-per-second figure, treats 29 as back-off-and-retry, and paces itself
conservatively.

Unverified: `user.getLibrary` has no current method page, so nothing in this design depends on it.
`library.gettracks` is also absent from current documentation; only `library.getArtists` is documented,
and it needs no authentication or special approval. Whether Electron exposes Argon2id is covered in
§5.6.

### 10.4 Pluggable client IDs

Both providers need only a public client ID.

```
MAIN_VITE_GITHUB_APP_CLIENT_ID
MAIN_VITE_GOOGLE_CLIENT_ID
```

An absent client ID is a first-class state, not an error path. The provider reports `notConfigured`,
the UI disables it with a clear message, and sync proceeds for any other provider. A build with no
client IDs must be a working Nora, and that is tested explicitly.

## 11. Sync state machine

```
idle -> connecting -> pulling -> merging -> pushing -> success
                   \           \          \
                    offline   conflict     error
```

`conflict` means semantic merge failure only. A CAS failure never enters it. See §8.

Local changes mark state dirty and a debounced flush coalesces many mutations into one sync. Nora
already ships an outbound queue-and-retry mechanism in `scrobble_queue.ts` and
`sendFavoritesDataToLastFM.ts`, and the scheduler follows that shape rather than inventing a second
one.

The engine publishes through the existing `dataUpdateEvent`, which is debounced 1000ms and merged by
dataType, so `useDataSync.tsx` invalidates React Query as it already does. No new renderer
notification path.

## 12. Verification

The local gate is deliberately stricter than CI:

```
npm run format-check && npm run typecheck && npm run lint --deny-warnings && npm test
```

Measured baseline on `e6b7b052`, Node 24.21.0, npm 11.19.0:

| Gate                                         | Result                               |
| -------------------------------------------- | ------------------------------------ |
| `npm run typecheck`                          | exit 0                               |
| `npm test`                                   | exit 0, 14 files, 358 tests          |
| `npx oxfmt --check` on src and test          | **exit 1**, 546 files                |
| `npx oxlint . --deny-warnings`               | **exit 1**, 43 pre-existing warnings |
| `npm run lint --deny-warnings` (the CI form) | **exit 0**                           |

Three findings here are repo-level, not caused by this feature, and each one weakens a gate that
looks like it is guarding something.

**Both `lint.yml` steps are dead.** `npm run lint --deny-warnings` exits 0 with 43 warnings present,
because npm consumes `--deny-warnings` as its own config rather than forwarding it to oxlint. Adding
the `--` separator, `npm run lint -- --deny-warnings`, exits 1. The second step runs
`npm run format`, and `"format": "oxfmt"` writes files and always exits 0; the failing `format-check`
script exists and is unused. Only `test` is a real gate in CI.

**`format-check` cannot pass at HEAD.** `.oxfmtrc.json` sets `endOfLine: crlf`, but git stores LF,
there is no `.gitattributes`, and `core.autocrlf` is unset, so a checkout is LF. Five of five sampled
committed files fail, and the full run reports 546. The failures are line endings only:
`git diff --ignore-cr-at-eol` against the formatted tree is empty. This is not a Linux artifact, it is
the whole repository not conforming to its own configuration. Converting the tree would be a 546-file
diff unrelated to sync, so this feature does not attempt it; new files are written LF to match every
other file in the repository, and the format gate is scoped to changed files.

**`typecheck` is absent from CI**, which is why the local gate keeps it.

Since the repository-wide format and lint gates are red before any change, "no new problems" is the
meaningful bar rather than "all four green": the baseline above is the reference, and each slice must
not increase the 546 or the 43.

### 12.1 Toolchain

`package.json` declares no `engines` and no `packageManager`, but it does declare `devEngines`, which
is the field that actually bites:

```json
"devEngines": { "packageManager": [ { "name": "npm", "version": "^11.6.2" } ] }
```

npm 10 refuses to run against this with `EBADDEVENGINES`, so `npm ci` fails before resolving a single
dependency. Checking only `engines` and `packageManager` misses it.

CI resolves `node-version: 'lts/*'`, which is currently Node 24.21.0, and that bundles npm 11.x.
That is why CI passes and a local npm 10 does not. Any local gate has to run npm 11 or newer.

Native modules add a second requirement. `postinstall` runs `electron-builder install-app-deps`, which
rebuilds against the local Node ABI, so a local run on Node 22 exercises a different binary than CI
builds on Node 24. Local gates therefore run under a side-by-side Node 24 at `/opt/node24` rather than
the system Node 22, so that `test/src/main/parseSong/*` results mean what CI will see.

One caveat recorded rather than hidden: the Electron rebuild cannot complete in this environment
because `electronjs.org` is unreachable. It only targets `register-scheme`, though, and both `sharp`
and `node-taglib-sharp` ship prebuilt binaries with no `gypfile`, so the 358-test baseline is
unaffected. What remains unverified is `npm run build` and any real Electron runtime, neither of which
can run here.

No existing test touches the database. All 14 test files under `test/` are pure or fully mocked.

**PGlite cannot run under this repo's vitest, and that constrains the design.** PGlite 0.5.8's
emscripten loader resolves `pglite.wasm` and `pglite.data` relative to `import.meta.url`, which
vitest's module pipeline does not preserve. Every instance fails identically with
`TypeError: Cannot read properties of undefined (reading 'pathname')` inside `loadPackage`, before any
query runs. Confirmed to reproduce under all seven of: the default config, `ssr.external`,
`pool: 'forks'`, `isolate: false`, `server.deps.inline`, importing the package's ESM entry by absolute
path, and `createRequire`.

PGlite itself is healthy: it reports PostgreSQL 18.3 under plain Node. The incompatibility is with the
test runner, not the database.

**Consequence, and it is architectural.** Database-touching tests cannot live in `npm test`.
`sync/localStore.ts` must therefore keep merging, normalisation and identity resolution in pure
functions over explicit state, and stay a thin adapter that translates between those values and rows.
The alternative, a sync engine whose rules are only reachable through a runner that cannot host the
database, is worse: those rules are the part that must be exhaustively tested, and they are the part
that can be tested without a database at all.

`scripts/verifyPglite.ts` is what exists instead, and it is a real gate that exits non-zero on
failure. It asserts, against the actual `resources/drizzle/` migrations: PGlite starts; `citext` and
`pg_trgm` register; all five migrations apply; the four `syncId`-bearing tables exist; citext gives
case-insensitive equality; a failed transaction rolls back completely; a successful one commits every
statement; and duplicate playlist names are permitted. That last check is the empirical justification
for §6 rather than an assertion about it. Run it with `node ./scripts/verifyPglite.ts`.

Two incidental facts worth keeping: drizzle records applied migrations as rows in
`drizzle.__drizzle_migrations`, not as one table per migration, and Node's ESM resolver requires the
explicit `.ts` extension on relative imports, which Vite does not need inside `src/`.

Merge and resolution get table-driven tests over fixture pairs, covering fresh, empty, both-changed,
corrupt, ambiguous bootstrap, duplicate-name and clock-skew cases, with no network. The HLC gets
its own suite for normal clock, clock behind, clock ahead, several events inside one millisecond,
receive-then-immediately-write, and concurrent writes. Providers are tested against an in-memory fake
implementing `SyncProvider`.

Crypto gets tests that the envelope rejects on: a flipped GCM tag, a flipped RFC 3394 integrity
check value, out-of-range KDF parameters, a truncated nonce, and a digest that does not match its
payload.

## 13. Slices

Each leaves the repo buildable, with no regression against the §12 baseline.

0. **Done.** Dependencies installed under Node 24.21.0 and npm 11.19.0; baseline recorded in §12;
   PGlite verified by `scripts/verifyPglite.ts`, which also settled that PGlite cannot run under
   vitest and therefore that `localStore.ts` must stay a thin adapter over pure functions; macOS
   signing checked and answered in §5.9.
1. `sync_ledger` migration: bootstrap resolution, binding, HLC, tombstones, unresolved queue, with
   `syncId`s for playlists, artists, albums and genres.
2. Protocol types, Zod schemas, canonical plaintext serialization, envelope, digest inside the
   ciphertext, attachments reserved.
3. Resolution engine: HLC ordering, retry versus conflict, additive sets, tombstones.
4. `localStore.ts`: read syncable state, apply merged state, record ledger, atomic writes.
5. GitHub provider: device flow, single blob, CAS on provider revision, rate-limit and offline
   classification.
6. Encryption: passphrase to KEK, AES-KW wrapping, GCM payload, `safeStorage` local copy including
   `shouldReEncrypt` and the Linux `basic_text` fallback.
7. Engine state machine, scheduler, IPC as `window.api.sync.*` alongside the 32 existing namespaces,
   Settings UI.
8. Song identity: portable id plus local binding, layered matching.
9. Last.fm reader.
10. Google Drive provider via loopback with PKCE, once a client ID exists. Note this one has no
    documented compare-and-swap, so the CAS capability flag is exercised here for the first time.

Push to the fork after review-worthy slices. Multi-round adversarial subagent review before every
push.

## 14. Open items

Resolved and no longer tracked: the Last.fm API surface, the GitHub token lifetime and refresh
semantics, and the Argon2id-versus-scrypt question.

Still open:

- Drive folder visibility, a visible folder against `appDataFolder`.
- Whether Electron 44's bundled Node exposes `crypto.argon2Sync`. Feature detection makes this
  non-blocking; it only decides which branch runs first.
- macOS code signing. Now answered: CI macOS builds are unsigned, so §5.9 makes the passphrase path
  authoritative and `safeStorage` an accelerator. Reopen only if signing is added, which would let
  `safeStorage` become the primary local path.
- Whether Drive's random loopback port needs pre-registering. Google documents both exact
  redirect-URI matching and random loopback ports without reconciling them.

Stale entries removed: Argon2id-versus-scrypt is resolved by feature detection (§5.6), the GitHub
`offline_access` question is resolved because GitHub App user tokens do not use OAuth scopes at all
(§10.1), and Last.fm's API surface is now documented (§10.3).

## 15. Unrelated defects found while reading

Reported separately, not fixed inside this feature.

1. `checkForNewSongs.ts` returns inside its folder loop, so a library resync processes only the first
   folder. This changes how much work a sync has to reconcile.
2. `manageLastFmAuth.ts:26` performs the session-key exchange over plain `http://`. Four other files,
   `fetchSongInfoFromLastFM.ts`, `getArtistInfoFromLastFM.ts`, `getSimilarTracks.ts` and
   `fetchSongMetadataFromInternet.ts`, also use `http://` for Last.fm reads.
