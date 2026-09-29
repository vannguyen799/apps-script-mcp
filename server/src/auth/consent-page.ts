export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

const SCOPE_TEXT: Record<string, string> = {
  "sheets.read": "Đọc dữ liệu các bảng tính đã được cấp quyền",
  "sheets.write": "Ghi / thêm / xoá dữ liệu trong các bảng tính có quyền ghi",
  "script.eval": "Chạy mã Apps Script tùy ý bằng tài khoản Google của bạn",
};

/** Shown in red when the client asks for script.eval (DESIGN.md section 8.2). */
const EVAL_WARNING =
  "Cảnh báo: quyền script.eval cho phép ứng dụng này chạy mã tùy ý bằng tài khoản Google của bạn (Drive, Gmail, Lịch... tùy các scope trong appsscript.json). " +
  "Danh sách bảng tính được phép KHÔNG áp dụng cho mã này, và nội dung bảng tính hay email có thể chứa lệnh ẩn (prompt injection) khiến nó chạy mã ngoài ý muốn. " +
  "Chỉ đồng ý nếu bạn hiểu rủi ro. Ngoài ra chủ sở hữu còn phải tự bật tính năng này trong trang quản trị Apps Script.";

export interface ConsentConnection {
  id: string;
  label: string;
  account: string;
  state: "connected" | "error";
}

export interface ConsentView {
  clientName: string;
  redirectHost: string;
  scopes: string[];
  nonce: string;
  /** CSP nonce for the inline stylesheet. */
  styleNonce: string;
  error?: string;
  action: string;
  /** Present when the visitor is not logged in: the inline login form (DESIGN.md 9.4 step 1). */
  login?: { username?: string };
  /** Present when logged in: the connection picker (step 2). */
  picker?: {
    username: string;
    csrf: string;
    connections: ConsentConnection[];
    selectedId: string | null;
    /** Opens the pending-connection flow in the same tab and returns to this consent. */
    addUrl: string;
  };
}

const STATE_TEXT: Record<string, string> = { connected: "hoạt động", error: "lỗi" };

function loginForm(v: ConsentView): string {
  return `<h2>Đăng nhập</h2>
<label for="u">Tên đăng nhập</label>
<input id="u" name="username" value="${escapeHtml(v.login?.username ?? "")}" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus>
<label for="pw">Mật khẩu</label>
<input id="pw" type="password" name="password" autocomplete="current-password" required>
<div class="row"><button type="submit" name="action" value="deny" formnovalidate>Từ chối</button><button class="primary" type="submit" name="action" value="login">Đăng nhập</button></div>`;
}

function pickerForm(v: ConsentView): string {
  const p = v.picker!;
  const list = p.connections
    .map((c) => {
      const checked = c.id === p.selectedId ? " checked" : "";
      return `<label class="opt"><input type="radio" name="connectionId" value="${escapeHtml(c.id)}"${checked} required><span><strong>${escapeHtml(c.label)}</strong><br><span class="muted">${escapeHtml(c.account)} · ${escapeHtml(STATE_TEXT[c.state] ?? c.state)}</span></span></label>`;
    })
    .join("");
  return `<input type="hidden" name="csrf" value="${escapeHtml(p.csrf)}">
<p class="muted">Đăng nhập với tên <strong>${escapeHtml(p.username)}</strong>.</p>
<h2>Chọn Apps Script để dùng</h2>
${list}
<p><a href="${escapeHtml(p.addUrl)}">Thêm Apps Script mới</a></p>
<div class="row"><button type="submit" name="action" value="deny" formnovalidate>Từ chối</button><button class="primary" type="submit" name="action" value="approve">Cho phép</button></div>`;
}

export function renderConsentPage(v: ConsentView): string {
  const scopes = v.scopes.map((s) => `<li><code>${escapeHtml(s)}</code> — ${escapeHtml(SCOPE_TEXT[s] ?? s)}</li>`).join("");
  return `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cấp quyền truy cập</title>
<style nonce="${escapeHtml(v.styleNonce)}">
body{font:16px/1.5 system-ui,sans-serif;background:#f4f5f7;color:#1c1e21;margin:0;display:grid;place-items:center;min-height:100vh}
main{background:#fff;max-width:460px;width:calc(100% - 32px);padding:28px;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.1);margin:16px 0}
h1{font-size:20px;margin:0 0 12px}h2{font-size:16px;margin:18px 0 6px}ul{padding-left:20px}code{background:#eef;padding:1px 5px;border-radius:4px}
label{display:block;margin:12px 0 4px;font-weight:600}input:not([type=radio]):not([type=hidden]){width:100%;box-sizing:border-box;padding:10px;font-size:16px;border:1px solid #9aa0a6;border-radius:6px}
label.opt{display:flex;gap:10px;align-items:flex-start;font-weight:400;border:1px solid #dadce0;border-radius:8px;padding:8px 10px;margin:6px 0}.muted{color:#5f6368;font-size:14px}
.row{display:flex;gap:10px;margin-top:18px}button{flex:1;padding:10px;font-size:16px;border-radius:6px;border:1px solid #9aa0a6;background:#fff;cursor:pointer}
button.primary{background:#1a73e8;color:#fff;border-color:#1a73e8}.danger{background:#fdecea;border:1px solid #b3261e;color:#b3261e;border-radius:6px;padding:10px 12px;margin:12px 0;font-weight:600}.err{color:#b3261e;margin-top:10px}.host{font-weight:700}
</style></head><body><main>
<h1>Cấp quyền cho ứng dụng</h1>
<p>Ứng dụng <strong>${escapeHtml(v.clientName)}</strong> muốn truy cập Google Sheets của bạn qua apps-script-mcp.</p>
<p>Sau khi đồng ý, bạn sẽ được chuyển về: <span class="host">${escapeHtml(v.redirectHost)}</span></p>
<p>Quyền được yêu cầu:</p><ul>${scopes}</ul>
${v.scopes.includes("script.eval") ? `<div class="danger" role="alert">${escapeHtml(EVAL_WARNING)}</div>` : ""}
<form method="post" action="${escapeHtml(v.action)}" autocomplete="off">
<input type="hidden" name="nonce" value="${escapeHtml(v.nonce)}">
${v.picker ? pickerForm(v) : loginForm(v)}
${v.error ? `<div class="err" role="alert">${escapeHtml(v.error)}</div>` : ""}
</form></main></body></html>`;
}

export function renderMessagePage(title: string, message: string): string {
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f4f5f7}main{background:#fff;padding:28px;border-radius:12px;max-width:440px}</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body></html>`;
}
