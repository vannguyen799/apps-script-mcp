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
- First start with no admin password: server generates a one-time **setup token** (random 24 bytes, b64url),
  prints it to stdout once (`Setup token: ...`), keeps only its hash. The UI asks for it + a new password (min 10 chars).
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
instanceId, admin password hash, setup-token hash, publicBaseUrl, Apps Script link `{url, secret, account, pairedAt}`,
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
