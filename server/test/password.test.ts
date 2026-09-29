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

const NEW = "a-brand-new-password-1";

describe("password change from /account", () => {
  it("checks CSRF, the current password and the new one; then keeps this session and ends every other one", async () => {
    h = await makeHarness();
    const a = await accountLogin(h, h.username, h.password);
    const b = await accountLogin(h, h.username, h.password);
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
    await expect(accountLogin(h, h.username, h.password)).rejects.toThrow(/401/);
    await expect(accountLogin(h, h.username, NEW)).resolves.toBeTruthy();
    expect(JSON.stringify(h.store.state)).not.toContain(NEW);
  });
});

describe("password change rate limit", () => {
  it("is rate limited like login: repeated wrong current passwords end in 429", async () => {
    h = await makeHarness();
    const x = await accountLogin(h, h.username, h.password); // the login itself forgave its failure
    const bad = { currentPassword: "nope-nope-nope", newPassword: NEW, confirmPassword: NEW };
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await post(h.publicUrl, "/account/api/password", { cookie: x.cookie, csrf: x.csrf, body: bad })).status);
    expect(codes).toEqual([403, 403, 403, 403, 403, 429, 429]);
    expect((await post(h.publicUrl, "/account/api/password", { cookie: x.cookie, csrf: x.csrf, body: { ...bad, currentPassword: h.password } })).status).toBe(429);
  });
});
