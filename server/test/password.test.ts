import { afterEach, describe, expect, it } from "vitest";
import type { Harness } from "./helpers.js";
import { accountLogin, makeHarness } from "./helpers.js";

let h: Harness;
afterEach(async () => {
  await h.close();
});

const post = (base: string, path: string, opts: { body?: unknown; cookie?: string; csrf?: string } = {}) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(opts.cookie ? { cookie: opts.cookie } : {}), ...(opts.csrf ? { "x-csrf-token": opts.csrf } : {}) },
    body: JSON.stringify(opts.body ?? {}),
  });
const get = (base: string, path: string, cookie: string) => fetch(`${base}${path}`, { headers: { cookie } });

async function adminLogin(username: string, password: string) {
  const r = await post(h.adminUrl, "/api/login", { body: { username, password } });
  if (r.status !== 200) throw new Error(`admin login failed ${r.status}`);
  return { cookie: (r.headers.get("set-cookie") ?? "").split(";")[0]!, csrf: ((await r.json()) as { csrfToken: string }).csrfToken };
}
const NEW = "a-brand-new-password-1";

describe("password change from /account", () => {
  it("checks CSRF, the current password and the new one; then keeps this session and ends every other one", async () => {
    h = await makeHarness();
    const a = await accountLogin(h, h.username, h.password);
    const b = await accountLogin(h, h.username, h.password);
    const admin = await adminLogin(h.username, h.password);
    const url = `${h.publicUrl}`;
    const body = { currentPassword: h.password, newPassword: NEW, confirmPassword: NEW };

    expect((await post(url, "/account/api/password", { cookie: a.cookie, body })).status).toBe(403); // no CSRF token
    expect((await post(url, "/account/api/password", { body, csrf: a.csrf })).status).toBe(401); // no session
    const wrong = await post(url, "/account/api/password", { cookie: a.cookie, csrf: a.csrf, body: { ...body, currentPassword: "not-the-password" } });
    expect(wrong.status).toBe(403);
    expect(((await wrong.json()) as { error: { message: string } }).error.message).toMatch(/hiện tại/);
    expect((await post(url, "/account/api/password", { cookie: a.cookie, csrf: a.csrf, body: { ...body, newPassword: "short" } })).status).toBe(400);
    expect((await post(url, "/account/api/password", { cookie: a.cookie, csrf: a.csrf, body: { ...body, confirmPassword: NEW + "x" } })).status).toBe(400);
    // nothing changed so far: every session still lives
    expect((await get(url, "/account/api/connections", b.cookie)).status).toBe(200);

    expect((await post(url, "/account/api/password", { cookie: a.cookie, csrf: a.csrf, body })).status).toBe(200);
    expect((await get(url, "/account/api/connections", a.cookie)).status).toBe(200); // the current session stays
    expect((await get(url, "/account/api/connections", b.cookie)).status).toBe(401); // other public session is gone
    expect((await get(h.adminUrl, "/api/status", admin.cookie)).status).toBe(401); // and so is the admin UI session
    await expect(accountLogin(h, h.username, h.password)).rejects.toThrow(/401/);
    await expect(accountLogin(h, h.username, NEW)).resolves.toBeTruthy();
    expect(JSON.stringify(h.store.state)).not.toContain(NEW);
  });
});

describe("password change from the admin UI", () => {
  it("needs the CSRF token and the current password; ends other admin and public sessions, keeps this one", async () => {
    h = await makeHarness();
    const x = await adminLogin(h.username, h.password);
    const y = await adminLogin(h.username, h.password);
    const pub = await accountLogin(h, h.username, h.password);
    const body = { currentPassword: h.password, newPassword: NEW, confirmPassword: NEW };

    expect((await post(h.adminUrl, "/api/password", { cookie: x.cookie, body })).status).toBe(403);
    expect((await post(h.adminUrl, "/api/password", { body, csrf: x.csrf })).status).toBe(401);
    expect((await post(h.adminUrl, "/api/password", { cookie: x.cookie, csrf: x.csrf, body: { ...body, currentPassword: "nope-nope-nope" } })).status).toBe(403);
    expect((await get(h.adminUrl, "/api/status", y.cookie)).status).toBe(200);

    expect((await post(h.adminUrl, "/api/password", { cookie: x.cookie, csrf: x.csrf, body })).status).toBe(200);
    expect((await get(h.adminUrl, "/api/status", x.cookie)).status).toBe(200);
    expect((await get(h.adminUrl, "/api/status", y.cookie)).status).toBe(401);
    expect((await get(h.publicUrl, "/account/api/connections", pub.cookie)).status).toBe(401);
    expect((await post(h.adminUrl, "/api/login", { body: { username: h.username, password: h.password } })).status).toBe(401);
    expect((await post(h.adminUrl, "/api/login", { body: { username: h.username, password: NEW } })).status).toBe(200);
  });

  it("is rate limited like login: repeated wrong current passwords end in 429", async () => {
    h = await makeHarness();
    const x = await adminLogin(h.username, h.password); // the login itself forgave its failure
    const bad = { currentPassword: "nope-nope-nope", newPassword: NEW, confirmPassword: NEW };
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await post(h.adminUrl, "/api/password", { cookie: x.cookie, csrf: x.csrf, body: bad })).status);
    expect(codes).toEqual([403, 403, 403, 403, 403, 429, 429]);
    expect((await post(h.adminUrl, "/api/password", { cookie: x.cookie, csrf: x.csrf, body: { ...bad, currentPassword: h.password } })).status).toBe(429);
  });
});
