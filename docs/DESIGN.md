# apps-script-mcp — Design & Wire Contract

Claude / MCP client → **Docker MCP server** (`server/`) → **Google Apps Script** (`apps-script/`) → Google Sheets.

The Docker side never holds a Google credential. Apps Script runs as the user's Google account and is the
only component that touches Sheets. This document is the contract both sides implement; if code and this
file disagree, fix one of them in the same change.

## 1. Components and responsibilities

| Component | Owns | Never does |
|---|---|---|
| MCP server (Docker) | MCP protocol, MCP client auth (OAuth 2.1 / PAT), business tools, request validation, signing requests to Apps Script, admin UI | Hold Google credentials; execute arbitrary code |
| Apps Script | Google authorization, spreadsheet allowlist (source of truth), re-validation, Sheets execution | Trust the MCP blindly; expose anything to anonymous callers without HMAC |
| Tunnel (cloudflared / ngrok) | Public HTTPS to port 8787 only | Anything business-related; the server does not know a tunnel exists |

The business layer depends on a `SheetsGateway` port. `AppsScriptGateway` is one adapter; a future
`GoogleApiGateway` (OAuth / Service Account) must be drop-in without changing tools or `SheetsService`.

## 2. Network surface

- Port **8787** — public app: `/mcp`, OAuth endpoints, `/.well-known/*`, `/healthz`. The only port a tunnel may target.
- Port **8788** — admin UI + admin JSON API. Compose publishes it as `127.0.0.1:8788:8788` (never public).

## 3. Authentication layers (independent credentials)

### 3.1 Admin UI (port 8788)
- First start with no owner: the server creates one (§10.3): a default `admin` account with a random password printed
  once to stdout. There is no setup token and no first-run form. Change the password in the UI (§9.1).
- Password stored as scrypt (N=2^15, r=8, p=1, 16-byte salt, 64-byte key).
- Session: random 32-byte id, cookie `asmcp_admin` `HttpOnly; SameSite=Strict; Path=/` (+`Secure` when request is https),
  12 h idle expiry, in-memory store.
- Every state-changing admin request: `Content-Type: application/json` + header `X-CSRF-Token` equal to the
  session's CSRF token.
- Host allowlist on port 8788: `localhost`, `127.0.0.1`, `[::1]` (+ `ADMIN_ALLOWED_HOSTS`). Other Host → 421. If
  `Origin` present on POST it must match the Host.
- Login rate limit: 5 failures / 15 min per IP, then 429.

### 3.2 MCP client → MCP server (port 8787, public)
MCP Authorization spec (OAuth 2.1). Use the SDK's `mcpAuthRouter` + `requireBearerAuth` with our own
`OAuthServerProvider` implementation.
- Issuer / resource base = `PUBLIC_BASE_URL` (env) or the value saved in the admin UI. When neither is set,
  `/mcp` still works with PATs; OAuth metadata endpoints return 503 `public_base_url_not_configured`.
- Dynamic Client Registration enabled (public clients, PKCE S256 required). Redirect URIs must be `https://…` or
  `http://localhost|127.0.0.1[:port]/…`.
- `/authorize` renders a consent page (public page!) showing client name and redirect host, requested scopes,
  and a password field. Approve requires the **admin password**. Rate limit shared with admin login counter
  (per IP). Consent form carries a per-render CSRF nonce.
- Auth code: 60 s TTL, single use, bound to client_id + redirect_uri + code_challenge.
- Access token: opaque 32 bytes b64url, TTL 1 h. Refresh token: opaque, TTL 30 days, **rotated** on every use
  (old one invalidated; reuse of a rotated token revokes the whole grant). Only SHA-256 hashes persisted.
- Scopes: `sheets.read`, `sheets.write`. Default requested if omitted: both. Read tools need `sheets.read`,
  write tools need `sheets.write`.
- **Personal Access Tokens** (for Claude Code / Desktop via header): created in admin UI with chosen scopes and a label,
  prefix `asmcp_pat_`, shown **once**, stored hashed, revocable, `lastUsedAt` tracked.
- No token in URL paths or query strings, ever.
- Unauthenticated `/mcp` → 401 with `WWW-Authenticate: Bearer resource_metadata="<base>/.well-known/oauth-protected-resource"`.
- Rate limit `/mcp`: 120 req/min per token.

### 3.3 MCP server → Apps Script (HMAC, established by pairing)
See §4. The Claude-facing tokens never reach Apps Script; the HMAC secret never reaches Claude or the UI.

## 4. Apps Script wire protocol

Apps Script web app deployed **Execute as: Me**, **Who has access: Anyone** (needed so the server can POST
without Google login). All security therefore lives in the payload. Apps Script cannot read request headers,
so auth fields are in the JSON body.

Transport: `POST <webAppUrl>` (`https://script.google.com/macros/s/<id>/exec`), body = JSON text,
`Content-Type: text/plain;charset=utf-8`. Google answers 302 → client follows with GET (Node `fetch` default).
Response body is JSON text. Timeout 30 s.

### 4.1 Encoding rules
- `secret`: 32 random bytes, base64url without padding (43 chars). The HMAC **key is the UTF-8 bytes of that
  string** (not the decoded bytes) on both sides.
- HMAC = HMAC-SHA256, output lowercase hex (64 chars). Message = UTF-8 bytes.
- `ts` = integer milliseconds since epoch. `nonce` = 16 random bytes base64url (22 chars), regex `^[A-Za-z0-9_-]{16,64}$`.
- Comparison of MACs / code hashes is constant-time on both sides.

### 4.2 Pairing
Pairing code: 8 chars from `23456789ABCDEFGHJKMNPQRSTUVWXYZ`, displayed `XXXX-XXXX`. Normalization on both sides:
uppercase, remove every char not in `[A-Z0-9]`. Code TTL 10 min on the server side.

1. Admin (Docker UI) enters the Apps Script web app URL (must match `^https://script\.google\.com/macros/s/[A-Za-z0-9_-]+/exec$`)
   and clicks *Pair*. Server creates `pending = {code, secret (fresh), expiresAt}` and state `pairing_pending`.
2. User opens the Apps Script admin page (`doGet`, owner-only, §5.1), types the code. Apps Script stores
   `pairing.pending = {codeHash: sha256hex("asmcp-pair-v1:" + normalizedCode), expiresAt: now+10min, attempts: 0}`.
3. Server polls every 4 s (until its code expires) with:
   ```json
   {"v":1,"kind":"pair","instanceId":"<uuid>","instanceLabel":"<string ≤ 64>","pairingCode":"<normalized>","secret":"<b64url>","ts":1234}
   ```
4. Apps Script, under `LockService.getScriptLock()`:
   - no pending or expired → `{"ok":false,"error":{"code":"PAIRING_NOT_READY"}}` (no attempt counted)
   - hash mismatch → `attempts++`; at 5 delete pending; → `PAIRING_INVALID`
   - match → store `pairing = {instanceId, instanceLabel, secret, pairedAt}` (replaces any previous pairing), delete
     pending, respond
     ```json
     {"ok":true,"result":{"account":"<effective user email>","proof":"<hex HMAC(secret, 'v1\npair-ack\n'+instanceId+'\n'+ts)>"}}
     ```
     where `ts` is the request's ts.
5. Server verifies `proof`; on success persists `{appsScriptUrl, secret, account, pairedAt}`, discards the code →
   state `connected`. Wrong proof → `error`, secret discarded.

The code is only a one-time binding proof; it is never used after step 4.

### 4.3 Authenticated call
Request:
```json
{"v":1,"kind":"call","instanceId":"<uuid>","ts":1234,"nonce":"<b64url>","payload":"<JSON string>","sig":"<hex>"}
```
`payload` is a JSON **string** `{"action":"<name>","params":{...}}`.
`sig = HMAC(secret, "v1\ncall\n" + instanceId + "\n" + ts + "\n" + nonce + "\n" + payload)`.

Apps Script verification order (any failure → error, nothing executed):
1. Shape check (types, lengths; payload ≤ 5 MB) → `BAD_REQUEST`.
2. Pairing exists and `instanceId` matches → else `UNAUTHENTICATED` (same message for all auth failures).
3. `|now - ts| ≤ 300000` → else `REQUEST_EXPIRED`.
4. Constant-time sig check → else `UNAUTHENTICATED`.
5. Replay: under script lock, `CacheService.getScriptCache()` key `n:<nonce>`; present → `REPLAYED`; else put with TTL 600 s.
6. Parse payload, action must be in the whitelist (§4.5) → else `UNKNOWN_ACTION`.

Response (always HTTP 200; body):
```json
{"body":"<JSON string: {\"ok\":true,\"result\":...} or {\"ok\":false,\"error\":{\"code\":\"...\",\"message\":\"...\"}}>","sig":"<hex>"}
```
`sig = HMAC(secret, "v1\nresp\n" + nonce + "\n" + body)` — present when steps 1–4 passed. Before that the
response is unsigned: `{"body":"...","sig":null}`. The server **must** reject any unsigned or badly signed
response as data; unsigned responses are only surfaced as error codes.

### 4.4 Error codes
`BAD_REQUEST, UNAUTHENTICATED, REQUEST_EXPIRED, REPLAYED, UNKNOWN_ACTION, PAIRING_NOT_READY, PAIRING_INVALID,
SPREADSHEET_NOT_AUTHORIZED, WRITE_NOT_ALLOWED, SHEET_NOT_FOUND, INVALID_RANGE, RANGE_SIZE_MISMATCH,
LIMIT_EXCEEDED, FORMULA_NOT_ALLOWED, INVALID_VALUE, INTERNAL`.
`INTERNAL` messages must not include cell data or stack traces.

### 4.5 Actions
All `spreadsheetId` params must be in the Apps Script allowlist → else `SPREADSHEET_NOT_AUTHORIZED`
(checked before opening the file). Write actions require allowlist entry `access: "write"` → else `WRITE_NOT_ALLOWED`.

A1 ranges **must include the sheet name**: `Sheet1!A1:F100`, `'My Sheet'!A:C`, `Sales!B2`. Sheet must exist
(never auto-created) → `SHEET_NOT_FOUND`. Accepted forms: `A1`, `A1:B2`, `A:C`, `2:5`.

Cell values: `string | number | boolean | null` (null → empty). String ≤ 50 000 chars. A string starting with `=`
is a formula → rejected with `FORMULA_NOT_ALLOWED` unless `allowFormulas: true`. Values arrays must be
rectangular and non-empty; ragged rows are rejected (`INVALID_VALUE`), never padded.

Limits: read ≤ 100 000 cells (unbounded column/row ranges are clipped to the sheet's data extent first);
write ≤ 20 000 cells per operation, ≤ 50 000 cells per batch, ≤ 50 operations per batch; search limit ≤ 500.

| action | params | result |
|---|---|---|
| `ping` | — | `{account, scriptVersion, spreadsheetCount}` |
| `spreadsheets.list` | — | `{spreadsheets:[{id,name,alias,access,url}]}` (`name` = live file name, fallback to stored) |
| `spreadsheet.metadata` | `{spreadsheetId}` | `{id,name,url,locale,timeZone,sheets:[{sheetId,name,index,rowCount,columnCount,lastRow,lastColumn,frozenRows,frozenColumns,hidden}]}` |
| `range.read` | `{spreadsheetId, range, render?: "FORMATTED"\|"UNFORMATTED"\|"FORMULA"}` (default FORMATTED) | `{range, values}` (`range` = resolved A1 with sheet) |
| `range.write` | `{spreadsheetId, range, values, allowFormulas?}` | `{updatedRange, updatedRows, updatedColumns, updatedCells}` |
| `rows.append` | `{spreadsheetId, sheet, rows, allowFormulas?}` | `{updatedRange, appendedRows}` |
| `search` | `{spreadsheetId, query, sheet?, matchCase?, matchEntireCell?, limit?}` | `{matches:[{sheet,range,row,column,value}], truncated}` |
| `batch.update` | `{spreadsheetId, operations:[{type:"write",range,values}\|{type:"append",sheet,rows}\|{type:"clear",range}], allowFormulas?}` | `{results:[...per op result...]}` |

Write range semantics: if `range` is a single cell, it is the top-left anchor and the target expands to the
values' dimensions; otherwise the range dimensions must equal the values' dimensions exactly → else
`RANGE_SIZE_MISMATCH`. `batch.update` validates **every** operation before executing any (no partial run due
to a validation error; Sheets itself has no transactions — documented).

## 5. Apps Script admin

### 5.1 Owner gate
Every admin entry point (`doGet` and every `google.script.run`-callable function) calls `assertOwner_()`:
`Session.getActiveUser().getEmail()` must be non-empty and equal `Session.getEffectiveUser().getEmail()`.
Anonymous visitors and other accounts get an "access denied" page / error. All internal helpers end with `_`
so they are not callable from `google.script.run`.

### 5.2 Admin page features
- Status: paired instance label + pairedAt, or "not paired"; *Unpair* button.
- Enter pairing code (§4.2 step 2).
- Authorized spreadsheets: add by URL or ID (validated by opening it; stores `{id, name, alias, access}`),
  edit alias/access (`read`/`write`), remove.
- Shows its own web app URL (`ScriptApp.getService().getUrl()`) with a copy button.

Storage: `PropertiesService.getScriptProperties()` keys `asmcp.pairing`, `asmcp.pairing.pending`,
`asmcp.spreadsheets` (JSON). OAuth scopes (manifest): exactly `https://www.googleapis.com/auth/spreadsheets` and
`https://www.googleapis.com/auth/userinfo.email`. No Drive scope.

## 6. MCP server tools

Tools take a `spreadsheet` argument = alias, exact name, or ID; the server resolves it against
`spreadsheets.list` (cached 30 s; ambiguous name → error listing candidates). Apps Script re-enforces.

| tool | scope | annotations |
|---|---|---|
| `list_spreadsheets` | read | readOnly |
| `list_sheets` `{spreadsheet}` | read | readOnly |
| `get_metadata` `{spreadsheet}` | read | readOnly |
| `read_range` `{spreadsheet, range, render?}` | read | readOnly |
| `search` `{spreadsheet, query, sheet?, match_case?, match_entire_cell?, limit?}` | read | readOnly |
| `write_range` `{spreadsheet, range, values, allow_formulas?}` | write | destructive |
| `append_rows` `{spreadsheet, sheet, rows, allow_formulas?}` | write | not destructive |
| `batch_update` `{spreadsheet, operations, allow_formulas?}` | write | destructive |

The server validates the same limits/shapes as §4.5 before calling (fail fast with a clear message).
No tool evaluates code, except the opt-in `run_apps_script` of §8; the action whitelist is otherwise fixed.

## 7. Server state & logging

State file `DATA_DIR/state.json` (default `/data`), written atomically (tmp + rename), mode 0600. Holds:
instanceId, publicBaseUrl, Apps Script link `{url, secret, account, pairedAt}`,
pending pairing, OAuth clients, refresh-token/access-token hashes, PAT hashes.

Connection states: `not_connected`, `pairing_pending`, `connected`, `error` (last health ping failed; message kept).
Health ping every 5 min when connected, and on demand.

Logs: one JSON line per event. Never logged: secrets, tokens, passwords, pairing codes, request/response
bodies, cell values, search queries. Allowed: action, spreadsheetId, dimensions, duration, result code.

## 8. Script evaluation (opt-in, owner's responsibility)

A deliberate exception to "fixed actions only", for owners who want Claude to reach anything their Apps Script
can reach (Drive, Docs, Gmail, Calendar…). **Off by default.** The spreadsheet allowlist does NOT apply to
evaluated code; the only capability boundary is the OAuth scopes the owner puts in `appsscript.json`.

### 8.1 Apps Script side
- Script property `asmcp.eval` = `{"enabled": bool, "changedAt": iso}`. Only the owner admin page can change it
  (`admin_setEvalEnabled(bool)`, owner-gated). The MCP server cannot enable it.
- Action `script.eval` params `{code: string (≤ 100 000 chars), args?: any (JSON)}`:
  - disabled → `EVAL_DISABLED`.
  - runs `new Function('args', 'log', code)(args, log)`. `log(...parts)` appends a line (each part
    `String()`-ed or JSON-stringified, line ≤ 2 000 chars, ≤ 200 lines) to a buffer returned to the caller.
  - result → `{value, logs, durationMs}`; `value` is the return value passed through
    `JSON.parse(JSON.stringify(v))` (undefined → null; Date → ISO string by JSON). A value that cannot be
    serialized → `EVAL_ERROR` "Return value is not JSON-serializable". Serialized `value` > 4 MB → `LIMIT_EXCEEDED`.
  - a thrown error → `EVAL_ERROR` whose message is `name + ": " + message` (≤ 2 000 chars) and the logs so far are
    included as `error.logs`. This is the one error that may contain data, because the owner asked for it.
- Audit ring buffer in script property `asmcp.evalAudit`: last 50 entries `{at, codeSha256, ok, durationMs, errorName?}`.
  Never the code text, args or results. Shown on the admin page with the toggle.
- `ping` result gains `evalEnabled: boolean`.
- New error codes: `EVAL_DISABLED`, `EVAL_ERROR`. Only a signature-verified `EVAL_ERROR` may carry the long message and `logs`
  on the server side; the server truncates any other error to 300 characters and drops `logs`.
- Admin page: section "Chạy Apps Script (nâng cao)" with the toggle and a red warning (prompt injection; allowlist is
  bypassed; scopes in appsscript.json are the real boundary), and the audit table.
- `appsscript.full.example.json`: a manifest example that declares common scopes (spreadsheets, documents, drive,
  gmail.readonly, calendar, script.external_request, userinfo.email) with a comment in the README that owners
  should delete the scopes they don't want. Evaluated code can only call services whose scopes are declared.

### 8.2 Server side
- A `script.eval` call waits up to 6.5 minutes for the answer (Apps Script's own limit is 6); every other action keeps the 30 s timeout.
- New optional port `ScriptEvaluator { evaluate(code, args): Promise<{value, logs, durationMs}> }`. It is separate
  from `SheetsGateway`; a future Google-API backend simply does not provide it. `AppsScriptGateway` implements both.
- OAuth scope `script.eval`. It is **not** part of the default scopes; a client must request it explicitly. The consent
  page shows it with a red warning line. PAT creation offers it as an unchecked checkbox.
- The OAuth server only honours the `scope` of the authorization request: a client that sends none gets the defaults, and the
  `scope` a client registered with in DCR is ignored. Metadata (`scopes_supported`) advertises only the default scopes, because
  clients may request every advertised scope. Refresh cannot widen a grant, so tokens and PATs issued before never gain it.
- Tool `run_apps_script {code, args?}` needs scope `script.eval`. Annotations: `destructiveHint: true`,
  `openWorldHint: true`. It is registered only when an evaluator is available. The description says:
  - the code is a function body that is run with `args` and `log` and must `return` a JSON-serializable value;
  - there is a 6-minute Apps Script limit;
  - it errors when the owner has not enabled it on the Apps Script page.
  `EVAL_DISABLED` maps to a clear message telling the user where to enable it.
- The admin UI status shows "Chạy script: bật/tắt" from the last ping.
- Logs: action name, durationMs, resultCode only. Never code, args, values or eval error messages.

## 9. Accounts, multiple Apps Script connections, one-paste setup

Goals:
- Only the owner account of this server can connect Claude, even on a public host.
- One server can hold many Apps Script **connections** (each = one deployed script = one Google account).
- A connection is paired once and then **picked** on later OAuth connects, never re-paired.
- A new script can be installed by pasting one personalized file. The user types no codes.

This section supersedes the single-link parts of §3.1, §4.2, §5.2 and §7 where they conflict.

### 9.1 Accounts
- **One account.** The server is for personal use: there is exactly one account, the **owner**. There are no members and no
  invites. `users` keeps the shape `{id, username, passwordHash (scrypt as §3.1), role: "owner", createdAt}` and `userId`
  stays on connections, grants, tokens and PATs, so every ownership check keeps working. Usernames are
  `^[a-z0-9._-]{3,32}$`, stored lowercase.
- The owner is created at startup when none exists (§10.3): username `ADMIN_USERNAME` (default `admin`), password from
  `ADMIN_PASSWORD` or generated. There is no setup token or first-run form.
- **Password change** (`POST /account/api/password` on 8787, `POST /api/password` on 8788; needs a session and the CSRF
  token): `{currentPassword, newPassword (min 10), confirmPassword}`. Rate-limited exactly like login (the same per-IP and
  per-username counters). A wrong current password answers 403 `FORBIDDEN`, not 401, so the UIs do not read it as "logged
  out". On success every other session of the user ends (public sessions and admin UI sessions) and the current one stays.
- **Lost password:** `node dist/cli.js reset-password` loads the same config and store (file or PostgreSQL), sets a new
  random password for the owner, removes all sessions and prints `Admin login: …`. The server rewrites the whole stored
  document (also on shutdown), so it would overwrite the change: the command refuses to run when `127.0.0.1:PORT_PUBLIC/healthz`
  answers. Stop the container, run it in a one-off container on the same volume/database, start the container again.
- **Public session** (port 8787, needed for consent and `/account`):
  - cookie `asmcp_sess`: random 32 bytes; only the hash is persisted with `userId`, `createdAt`, `expiresAt` (30 days).
  - Flags: `HttpOnly; SameSite=Lax; Path=/`, plus `Secure` when the public base is https. Lax is required because the
    OAuth redirect from Claude is a cross-site top-level GET.
- **Public login.** `POST /account/login` with username + password.
  - Rate limit: 5 failures / 15 min per IP **and** per username.
  - Same error message for an unknown user and a wrong password; constant-time with a dummy scrypt for unknown users.
- **CSRF.** Every public POST form carries a per-session CSRF token field. `Origin`, when present, must equal the
  public base origin.
- `POST /account/logout` removes the session. "Đăng xuất mọi nơi" removes all of that user's sessions.

### 9.2 Connections (server side)
- `connections`: `{id, userId, label, url, instanceId, secret, account, pairedAt, lastOkAt, lastError, evalEnabled}`.
  - `instanceId` is a fresh UUID **per connection**. That lets one script pair with several servers and one server
    pair with several scripts.
  - Every connection belongs to a user (`userId`); a tool call only ever reaches the connection of its own token.
- **Pending connection**, created by "Thêm Apps Script":
  - fields: `{id, userId, instanceId, secret, setupToken, expiresAt: now+30min, code?, url?}`;
  - kept in memory plus state, pruned when expired.
- **Two ways to pair a pending connection:**
  1. **New script: one paste.**
     - The page offers "Tải / Copy Code.gs": the bundle with the line `var ASMCP_SETUP_ = null;` replaced by
       `var ASMCP_SETUP_ = {"server":"<publicBase or 'local'>","token":"<setupToken>","expiresAt":<ms>};`.
     - The page links to `https://script.new`, with the steps: paste → Deploy → Web app (Execute as Me, Access Anyone)
       → Authorize → copy the web app URL → paste it here.
     - The server then sends a **setup pair** request (§9.3) until success or expiry.
  2. **Already-installed script** (any version with §9.3 support). The user pastes the web app URL. The server shows
     an 8-char code as in §4.2, and the user enters it on the script's admin page. Polling as in §4.2.
- The Code.gs bundle ships inside the Docker image at `/app/apps-script/Code.gs`:
  - the Docker build context becomes the repo root;
  - `server/Dockerfile` copies `apps-script/Code.gs`;
  - the server reads it at startup via an injected config path.
  - If it is missing, option 1 is hidden.
- Health: per-connection ping every 5 min. Status per connection is `connected` or `error` (with a message).
- `/account` page (public, logged in):
  - my connections: label (editable), Google account, status, eval state, remove;
  - "Thêm Apps Script";
  - my PATs: create (choose connection + scopes, shown once), list, revoke;
  - logout / logout everywhere.
  Vietnamese UI, same visual style as the admin UI.
- Admin UI (8788, owner): server settings, connections (read, remove), grants and PATs (revoke), usage (§10.2), plus the
  same "Thêm Apps Script" flow. The old single-link pairing UI is removed.

### 9.3 Apps Script side
- Multiple pairings:
  - `asmcp.pairings` = `{<instanceId>: {instanceLabel, secret, pairedAt}}`, max 20; adding a 21st → `LIMIT_EXCEEDED`.
  - A legacy `asmcp.pairing` is migrated into the map on first read.
  - Call verification (§4.3 step 2) looks up the pairing by `instanceId`.
  - The admin page lists pairings, each with its own "Hủy ghép nối".
- Code pairing (§4.2) is unchanged except that success **adds** to the map. The same `instanceId` re-pairing replaces
  its own entry.
- **Setup pair.** Request:
  ```json
  {"v":1,"kind":"pair","mode":"setup","instanceId","instanceLabel","secret","ts","setupProof"}
  ```
  where `setupProof = HMAC(token, "v1\nsetup\n" + instanceId + "\n" + ts + "\n" + secret)`. The HMAC key is the UTF-8
  bytes of the token string, as in §4.1.
  Apps Script accepts it iff all of these hold:
  - `ASMCP_SETUP_` is a non-null object with a string `token` of 43 b64url chars;
  - `now < ASMCP_SETUP_.expiresAt`;
  - `|now - ts| ≤ 300000`;
  - `sha256hex("asmcp-setup-v1:" + token)` is not in `asmcp.setupConsumed` (a list, keep the last 20);
  - the proof matches in constant time.
  On success it stores the pairing, appends the token hash to `setupConsumed`, and responds exactly like §4.2
  (`{account, proof}`, `sig:null`). Failures:
  - `PAIRING_NOT_READY`: no setup block or expired;
  - `PAIRING_INVALID`: bad proof or consumed. Five invalid setup attempts → store the token hash as consumed (burned).
- `ASMCP_SETUP_` is declared once in the bundle header section as `var ASMCP_SETUP_ = null;`, exactly that text on its
  own line. `src/` gets a `Setup.js` holding that line, so tests can override the value.
- Admin page:
  - when `ASMCP_SETUP_` is present and not consumed, show "Script này đã sẵn sàng kết nối với <server>. Quay lại trang
    MCP và dán URL web app." with the URL and a copy button;
  - after it is consumed, show "Đã kết nối".

### 9.4 OAuth consent (replaces the admin-password consent of §3.2)
`/authorize` → consent page:
1. Not logged in → an inline login form (§9.1) → back to the same consent (nonce preserved).
2. Logged in:
   - a radio list of **my** connections (label, Google account, status). The last used one is preselected;
   - "Thêm Apps Script mới", which opens the pending-connection flow in the same tab and returns here. The consent
     nonce's TTL extends to 30 min while in that flow;
   - scopes, with the red eval warning when `script.eval` is requested;
   - Approve / Deny.
3. Approve re-checks that the connection belongs to the session user. The grant stores `{userId, connectionId}`.
   Access/refresh tokens inherit them.
- Zero connections → the page goes straight to "Thêm Apps Script".
- PATs store `{userId, connectionId, scopes}`.
- `AuthInfo.extra = {userId, connectionId}`. Every tool call resolves its Apps Script client and SheetsService **only**
  from `connectionId`, with per-connection caches. A connection that has been removed → the tool error "Kết nối Apps
  Script đã bị xóa, hãy kết nối lại".
- **Tenant isolation is a hard invariant.** No code path may take a connection id from tool input.

### 9.5 State migration
State gets `version: 2`. Migrating a v1 file:
- admin password → owner user `admin`;
- the single link → a connection owned by the owner (label = account email);
- existing grants and PATs → bound to that connection;
- a pending single-link pairing is dropped.

Files written by a version that still had members and invites: on load every invite and every user that is not the owner
is removed, together with their sessions, connections, pending connections, grants, tokens and PATs. The load logs
`users_pruned` with the number of users removed (nothing else) and writes the cleaned state back.

### 9.6 Identifying a script
Email is a display label, never a key: one Google account can own several scripts.
- Pair responses (code and setup) return `{account, scriptId, scriptName, proof}`.
  - `scriptId` is `ScriptApp.getScriptId()`, which is stable for the life of the project.
  - `scriptName` may be null.
- `ping` also returns `scriptId`.
- The server treats `(userId, scriptId)` as unique. When a pairing completes for a script the user already has, the
  existing connection is updated in place: `url`, `instanceId`, `secret`, `account`. The `connectionId` is kept, so
  grants, tokens and PATs keep working. This also covers a new deployment whose URL has changed.
- Different users may connect the same script.
- A migrated v1 connection gets its `scriptId` from the next ping.

### 9.7 Server implementation notes
Where the server refines §9 (behaviour is otherwise as written above):
- **Migration keeps the v1 `instanceId`** for the migrated connection (the script recorded its pairing under it), instead of a
  fresh UUID. New connections get a fresh one. The untouched v1 file is kept as `state.json.v1.bak`. With no link there is
  nothing to bind, so v1 grants, tokens and PATs are dropped.
- **Pending connection** also stores `mode` (`setup`|`code`) and `codeExpiresAt` (10 min inside the 30). Before a URL is
  pasted there is no mode. Polling covers both modes; a setup pair that answers `PAIRING_INVALID` is fatal (the script burns the
  token), `REQUEST_EXPIRED` is shown as a clock-skew note, `LIMIT_EXCEEDED` as "20 kết nối".
- **Sessions:** the per-session CSRF token is derived from the cookie value (`HMAC(cookie, "asmcp-csrf-v1")`), so nothing but
  the cookie hash is stored. Login (no session yet) relies on Origin plus JSON-only content type; the consent
  login form uses the consent nonce.
- **Origin check:** an `Origin` equal to the public base origin passes. Additionally it passes when no base is configured, or
  when the request's own Host is loopback and equals the Origin (using `/account` on localhost while the base is a tunnel URL).
- **Limits:** rate-limit counters are 5 failures / 15 min, per IP (`ip:` and `setup:` keys) and per username. A
  success resets only the username counter. At most 5 pending connections and 20 connections per user.
- **Consent:** `GET /oauth/consent?nonce=` re-renders the same step (used to come back from the add flow); the nonce is only
  consumed by Approve or Deny. Approve records `lastConnectionId` on the user (the preselected one next time).
- **Removal:** deleting a connection keeps its grants, tokens and PATs (tools answer with the removal message).
- **Personalised Code.gs:** read once at startup from `APPS_SCRIPT_BUNDLE_PATH` (default `/app/apps-script/Code.gs`). It must
  contain the line `var ASMCP_SETUP_ = null;` exactly once, otherwise option 1 is hidden and nothing is served (fail closed).

## 10. Storage, usage, owner bootstrap

### 10.1 Storage
- `DATABASE_URL` (a `postgres://` or `postgresql://` URL, optional) → PostgreSQL. Unset → local files in `DATA_DIR`
  (today's behaviour). TLS is whatever the URL says (`sslmode=...`); there is no separate switch.
- `StateStore` keeps its API: an in-memory document and a serialized `update(mutator)`. Persistence moves behind a port
  `StateBackend { load(): Promise<unknown | null>; save(doc): Promise<void>; close(): Promise<void> }`.
  - **Local:** the atomic JSON file `DATA_DIR/state.json`, mode 0600, as before.
  - **PostgreSQL** (driver `pg`, no ORM): one table, created on startup with `CREATE TABLE IF NOT EXISTS`:
    `asmcp_state(id smallint primary key check (id = 1), doc jsonb not null, updated_at timestamptz not null)`.
    `save` is an upsert of the single row. **Exactly one server instance may use a database:** nothing detects a second
    writer, and the last write wins.
- When the table is empty and `DATA_DIR/state.json` exists, the file is imported once (v1 → v2 migration still applies) and
  `state_imported_from_file` is logged. The file is left untouched; from then on the database is the only source.

### 10.2 Usage
- The tool wrapper counts every MCP tool call after it finishes: `state.usage[day][tool] = {calls, errors}`, where `day` is
  the UTC date `YYYY-MM-DD`. `errors` counts calls that failed for any reason (gateway error, refused scope, removed
  connection, crash).
- Nothing else is kept: no user, connection or token, no ranges, values, queries, code, args or error messages.
- Counters live in memory and are merged into the state every 60 s and on shutdown, so a busy server does not rewrite the
  state on every call. A crash loses at most the last minute. A failure to count or to write never affects a tool call.
- Days older than 30 (today and the 29 before it) are dropped whenever the counters are merged.
- Views: a plain day × tool table ("Lượt dùng 30 ngày") on `/account` (`GET /account/api/usage`) and on the admin UI
  (`GET /api/usage`). Both return `{usage: [{day, tool, calls, errors}]}`, newest day first.

### 10.3 Owner bootstrap from env
With no owner at startup, `ADMIN_USERNAME` (default `admin`) and `ADMIN_PASSWORD` (min 10 chars) create one. Without
`ADMIN_PASSWORD` a random 20-character password from `[A-Za-z0-9]` (`crypto.randomInt`) is generated and printed once, directly to
stdout and not through the logger:
`Admin login: <username> / <password>  (đổi mật khẩu trong /account)`. Only the scrypt hash is stored. An env password is
never printed. Later starts (an owner exists) ignore the variables and print nothing: they never overwrite a password. A
too-short password → startup error. The docs recommend changing the password in the UI and removing the env var afterwards.
The state no longer has a setup-token hash; loading drops a stored one.

## 11. Built-in tunnel (env-enabled)

The container can expose port 8787 publicly by itself, so no separate tunnel service is needed. `src/tunnel/` is
networking only. It starts a child process and reports the public URL through a callback. Business code never
imports it; only `main.ts` wires it.

| Env | Behaviour |
|---|---|
| unset / `TUNNEL=off` | No tunnel (default). |
| `TUNNEL=cloudflare` | Quick tunnel: `cloudflared tunnel --no-autoupdate --url http://127.0.0.1:8787`. The `https://*.trycloudflare.com` URL is read from cloudflared's output. It is random and **changes on every restart**, so it suits trying things out. |
| `TUNNEL=cloudflare` + `CLOUDFLARE_TUNNEL_TOKEN` | Named tunnel: `cloudflared tunnel --no-autoupdate run --token …`. The hostname is configured in the Cloudflare dashboard, so `PUBLIC_BASE_URL` must be set to it (startup error otherwise). |
| `TUNNEL=ngrok` + `NGROK_AUTHTOKEN` (+ `NGROK_DOMAIN`) | `ngrok http 127.0.0.1:8787 --log stdout --log-format json` (+ `--url https://<NGROK_DOMAIN>`). The URL is read from the JSON log line `url`. A free ngrok account includes one **static domain**: a stable URL at no cost, which is the recommended option. |

- **Public base URL precedence:** `PUBLIC_BASE_URL` env > URL reported by the tunnel > the value saved in the admin UI.
  The tunnel URL is a runtime value: it is not persisted, and the OAuth router is rebuilt when it changes. The admin UI
  and `/account` show it as the MCP endpoint, and the container log prints `Public URL: https://…/mcp` once it is known.
- **Proxy trust:** with a built-in tunnel, the proxy is local, so express trusts `X-Forwarded-For` only from loopback
  (`trust proxy = "loopback"`) unless `TRUST_PROXY` is set explicitly. Direct connections to 8787 cannot spoof their IP.
- **Supervision:** if the child exits, restart it with backoff (1 s, doubling to 60 s max). Its output goes to the log with
  the prefix `[tunnel]`, token values redacted. On shutdown the child is killed.
- **Secrets:** tokens are passed to the child via its environment (`TUNNEL_TOKEN`, `NGROK_AUTHTOKEN`), never as argv, so
  they do not show in `ps`.
- **Image:** the Dockerfile copies the `cloudflared` and `ngrok` binaries from the vendors' official multi-arch images,
  pinned by version tag (`cloudflare/cloudflared:<v>`, `ngrok/ngrok:<v>-alpine`), into `/usr/local/bin`. It runs a
  version check at build time.
- **Compose:** the separate `cloudflared` service is removed; `.env` carries the variables above.
- **Installers:** they pass `TUNNEL`, `CLOUDFLARE_TUNNEL_TOKEN`, `NGROK_AUTHTOKEN`, `NGROK_DOMAIN` and
  `PUBLIC_BASE_URL` through when they are set in the user's shell. They then print the public URL, polling the container
  log for `Public URL:` for up to 30 s.
