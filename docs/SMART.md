# SMART on FHIR sign-in

fireboat can sign in to a FHIR server as a SMART on FHIR client. Two flows are supported:

- **Standalone patient launch.** You sign in once in your browser with `fireboat login`. fireboat uses the authorization
  code flow with PKCE and keeps the token in a file only you can read.
- **Backend Services.** fireboat signs in by itself with a private key (a signed JWT client assertion). No browser is
  involved.

Both flows are tested against a local SMART Launcher in front of HAPI FHIR, on loopback, with synthetic data
(`npm run test:smart`). That is the whole of the evidence. fireboat is not SMART certified, and no vendor's SMART server has
been tested.

## What does not change

SMART sign-in decides whether the FHIR server will answer fireboat. It does not change what fireboat will send to the agent.

- **One patient, fixed by configuration.** `patientId` in the config is still the only patient fireboat serves. A token whose
  patient context names someone else is refused at sign-in, and nothing is stored or sent. A token never selects a patient.
- **Read-only.** fireboat requests read and search scopes only. If the server grants any write permission, fireboat refuses
  the whole grant.
- **Local servers only.** Discovery, authorization and token endpoints must be on `127.0.0.1` or `[::1]`, like the FHIR
  server itself. Remote servers are not supported in this version.
- **Every record is still checked.** Patient confinement, withholding and exact decimals work as described in
  [the security model](SECURITY-MODEL.md), whatever the token allows.

## How it works

1. **Discovery.** fireboat reads `<baseUrl>/.well-known/smart-configuration`. The authorization and token endpoints must
   be on the same origin as `baseUrl`, unless you pin a different loopback origin under `endpoints`; discovery must then
   agree with the pin. Redirects are refused.
2. **Scopes.** fireboat asks for read and search on the resource types it serves: `patient/<Type>.rs` for a patient launch,
   `system/<Type>.rs` for Backend Services (SMART v2 syntax). Set `scopeSyntax: "v1"` for servers that only understand
   `patient/<Type>.read`. A patient launch also asks for `launch/patient`, so the server reports which patient was chosen.
3. **Granted scopes.** The server may grant less than asked. `fhir_read` needs read (`r`) on the type and `fhir_search`
   needs search (`s`). A call on a type that was not granted is refused with `POLICY_DENIED` before any FHIR request is
   sent, so a missing scope is never reported as "no records". The same check applies to the searches fireboat makes on its
   own to confirm that a referenced record belongs to the patient. Scopes with query filters (`?category=...`) count as not granted,
   because fireboat cannot check the filter on every record. A broader read-only grant is accepted with a warning.
   By default fireboat asks for every type it serves, including `Practitioner`, `CodeSystem` and `ValueSet`; if a strict
   server rejects that request (`invalid_scope`), list the scopes you want under `scopes`.
4. **Tokens.** Access tokens are renewed before they expire. Backend Services tokens live in memory only. A patient launch
   stores its token in a file (see below) that the MCP server reads; when the access token expires it uses the refresh
   token if there is one, and otherwise asks you to run `fireboat login` again. Refreshes, sign-ins and `logout` are
   serialized with a lock file, so several fireboat processes can share one token file without overwriting each other's
   grant. A process that is still working keeps its lock; a lock left by a process that stopped is taken over after a
   minute. A tool call that is cancelled or reaches its deadline does not cut a refresh request already sent: the
   authorization server may already have replaced the refresh token, so the reply is stored when it arrives, and until that
   request ends (at most `limits.timeoutMs`) other calls wait for the lock. A server that shuts down (its input closes, or
   it gets SIGINT or SIGTERM) stops token work that has not sent its request yet. It gives a refresh request already sent
   up to about 1.5 seconds to be answered and stored, then cuts it and releases the lock; if the reply had not arrived, a
   refresh token the server replaced is lost and you need to run `fireboat login` again. The process exits within about
   2.5 seconds of the shutdown starting ([limits of that bound](CONFIGURATION.md#cli-and-configuration-path-precedence)).

## Standalone patient launch

```json
"source": {
  "alias": "local",
  "baseUrl": "http://127.0.0.1:18210/v/r4/sim/<sim>/fhir",
  "auth": { "type": "smart_standalone_launch", "clientId": "my-client" }
}
```

Then sign in:

```sh
fireboat login --config fireboat.config.json
```

- `login` opens your browser at the server's sign-in page and listens for the answer on `127.0.0.1` (a random port, or
  `redirectPort` if your server needs a fixed redirect URI). It accepts only the answer that carries its own sign-in state,
  ignores any other request, and stops when the sign-in finishes or after 5 minutes (`--timeout` changes this).
- `--no-browser` prints the sign-in address instead of opening a browser.
- The server must return the patient you configured. If it returns another patient, or none, `login` fails and stores
  nothing.
- The token file is written with mode `0600` in a `0700` folder, by default
  `${XDG_STATE_HOME:-~/.local/state}/fireboat/smart/<alias>.json` (set `tokenFile` to change it). The MCP server refuses a
  file that is a symbolic link, is readable by others, or was made for a different server, client or patient.
- If you set `tokenFile`, keep it in a folder only you can open (`0700`) on a local disk: the lock file needs hard links,
  which some network and FAT drives lack. `logout` refuses to delete the file if the folder has become readable by
  others; tighten the folder with `chmod 700` and run it again, or delete the file yourself.
- A refresh token is requested, stored and used only when you set `offlineAccess: true`. Without it, a refresh token the
  server sends anyway is discarded, and sign-in lasts as long as the access token, often about an hour.
- If a refresh response is malformed, fireboat refuses it; the server may already have replaced the refresh token, so run
  `fireboat login` again.
- `fireboat logout --config fireboat.config.json` deletes the token file, waiting first for any refresh in progress. It
  does not revoke the token at the server, and a running MCP server keeps using the access token it already holds until
  that token expires or is rejected.
- The MCP server never opens a browser or listens on a port: the redirect listener and the browser launcher are a
  separate module that only `fireboat login` loads. A running server picks up a new `login` when its current access
  token expires or is rejected, without a restart. Signing in with a different grant drops results kept from the old one.
- The token file and key file checks rely on POSIX file owners and modes. Without them (for example on Windows) fireboat
  refuses both files. Only macOS is verified.

Options: `clientAuth` (`"public"` by default, or `"private_key_jwt"` with `keyId` and a key as below), `redirectPort`,
`offlineAccess`, `tokenFile`, `scopes`, `scopeSyntax`, `endpoints`.

## Backend Services

```json
"auth": {
  "type": "smart_backend_services",
  "clientId": "my-service",
  "keyId": "key-1",
  "privateKeyEnv": "FIREBOAT_SMART_PRIVATE_KEY"
}
```

- The private key comes from the environment variable you name (PEM or JWK text), or from `privateKeyFile`: an absolute
  path to a file you own that nobody else can read. Exactly one of the two.
- Keys must be EC P-384 (signed with ES384) or RSA of at least 2048 bits (RS384). Other keys are refused.
- Each token request carries a fresh assertion: `iss` and `sub` are the client id, `aud` is the token endpoint, it expires
  after 2 minutes, and its `jti` is never reused.
- Register the matching public key with the server, including its `kid` and `alg`.
- Backend Services has no patient context. The configured patient is the only patient boundary, as with client
  credentials.

Options: `scopes`, `scopeSyntax`, `endpoints`.

## Errors

SMART adds no new error codes to tool results. Sign-in problems in the MCP server use the existing ones:

| What happened | Code |
| --- | --- |
| Not signed in, or the sign-in expired with no refresh token | `CONNECTION_REQUIRED` |
| Key or token file missing, unreadable or readable by others, or a stale lock file that cannot be cleared | `CREDENTIAL_UNAVAILABLE` |
| Discovery or token response malformed, or `scope` missing | `INVALID_TOKEN_RESPONSE` |
| A token naming another patient, a write-capable grant, or a type not granted | `POLICY_DENIED` |
| An endpoint not on loopback, or on another origin without a pin | `LOOPBACK_ONLY` |
| A refresh in this or another fireboat process held the token file's lock for more than 10 seconds | `TOKEN_TIMEOUT` (retryable) |

`fireboat login` prints `login: ok` on success, with how the granted scope compares with the request and how many
resource types it covers. On failure it prints one line, `fireboat: <code>`, and exits non-zero:

| Code | Meaning |
| --- | --- |
| `PATIENT_MISMATCH` | The server chose a different patient from the configured `patientId`. Nothing was stored. |
| `PATIENT_CONTEXT_MISSING` | The server did not say which patient was chosen. Nothing was stored. |
| `PKCE_UNSUPPORTED` | The server does not advertise PKCE with S256. |
| `AUTHORIZATION_DENIED` | The server returned an error instead of a code, for example because you declined. |
| `CALLBACK_INVALID` | The answer from the server was malformed. |
| `CALLBACK_TIMEOUT` | No valid answer arrived before the timeout. |
| `LISTENER_UNAVAILABLE` | The local port for the answer could not be opened (for example, `redirectPort` is in use). |
| `LOGIN_UNSUPPORTED` | The configuration's `source.auth` is not `smart_standalone_launch`. |
| `CONFIG_INVALID`, `ARGUMENTS_INVALID` | The configuration or the command line is wrong. |

Discovery and token problems print the same codes as the table above, such as `LOOPBACK_ONLY` or `TOKEN_ENDPOINT_ERROR`.
If the token file stays locked by another process, `login` prints `TOKEN_TIMEOUT`; if the new access token expired while
`login` waited for the lock, it prints `TOKEN_EXPIRED` and keeps any grant already stored.

`fireboat --doctor` reports discovery, PKCE support, whether a grant is stored, the patient match and how the granted scopes
compare with the request, as categories and counts only. Under SMART, the `recent-labs-v1` workflow counts as ready only
when the grant also permits reading Patient and searching Observation. Doctor signs in before it reads the metadata. If
that fails (before `fireboat login`, a grant that expired with no refresh token, SMART discovery or a token endpoint
that redirects, a discovered endpoint that the loopback rules refuse, or a token endpoint error), or the source answers
the metadata request with 401 (the token is rejected), doctor prints `metadata: not-checked` and the fault `SIGN_IN_UNAVAILABLE`: a failed sign-in is reported as the
sign-in, not as a metadata fault.

## Example configurations

`examples/smart-standalone.config.json` and `examples/smart-backend.config.json` are templates. They point at the bundled
synthetic server, which has no SMART sign-in, so change `baseUrl`, `clientId` and the key settings to match your SMART
server before you use them.

## Not supported

EHR launch, OpenID Connect sign-in (`openid`, `fhirUser`), client secrets for SMART, dynamic client registration, token
introspection and revocation, remote (non-loopback) servers, and authorization of the MCP connection itself.

## Testing

Unit tests run against a small SMART authorization server inside the test suite. It also enforces what a real server
should (single-use codes, PKCE, unique `jti`), so fireboat's own checks are tested.

`npm run test:smart` is a live check. It needs Docker and runs HAPI FHIR and the SMART Launcher
(`docker/compose.smart.yaml`, images pinned by digest, ports on `127.0.0.1` only) with synthetic data:

- a standalone patient launch through the real `fireboat login` command, with no human, then tool calls from an MCP client
  over stdio, a forced token refresh, and a wrong-patient sign-in that must fail;
- Backend Services with a key generated for the run, a grant narrower than requested, and a wrong-key assertion that must
  fail.

The SMART Launcher does not enforce scopes or patient context on its FHIR data, so the live check shows that fireboat signs
in correctly. It does not show that a server limits what it returns.
