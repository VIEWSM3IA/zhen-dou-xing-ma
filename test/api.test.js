import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "../server/index.js";

const HOUR = 60 * 60 * 1000;
const START = Date.UTC(2026, 8, 29, 0, 0, 0);

function makeEnv(overrides = {}) {
  return {
    NODE_ENV: "development",
    DEV_AUTH_ENABLED: "1",
    WECHAT_APP_ID: "test-app-id",
    WECHAT_APP_SECRET: "test-app-secret",
    SESSION_ENCRYPTION_KEY_BASE64: randomBytes(32).toString("base64"),
    CREATOR_HMAC_SECRET: randomBytes(32).toString("hex"),
    GUARD_HMAC_SECRET: randomBytes(32).toString("hex"),
    ...overrides,
  };
}

async function harness(t) {
  const dir = await mkdtemp(join(tmpdir(), "proposal-api-"));
  const dbPath = join(dir, "test.sqlite");
  const clock = { value: START };
  const server = createServer({
    env: makeEnv(),
    dbPath,
    now: () => clock.value,
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });

  async function request(path, { method = "GET", token, body } = {}) {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";

    const res = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await res.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
    }
    return { status: res.status, body: json, headers: res.headers };
  }

  async function auth(subject) {
    const res = await request("/__dev/auth", {
      method: "POST",
      body: { subject },
    });
    assert.equal(res.status, 200);
    assert.equal(typeof res.body?.token, "string");
    assert.ok(res.body.token.length > 0);
    return res.body.token;
  }

  async function proposal(token, content = "周六晚上七点吃火锅") {
    const res = await request("/v1/proposals", {
      method: "POST",
      token,
      body: { content },
    });
    assert.equal(res.status, 201);
    assert.equal(typeof res.body?.id, "string");
    assert.equal(typeof res.body?.revisionId, "string");
    assert.equal(typeof res.body?.shareToken, "string");
    return res.body;
  }

  async function share(shareToken, token) {
    return request(`/v1/share/${encodeURIComponent(shareToken)}`, { token });
  }

  async function respond(shareToken, token, revisionId, response) {
    return request(`/v1/share/${encodeURIComponent(shareToken)}/respond`, {
      method: "POST",
      token,
      body: { revisionId, response },
    });
  }

  async function result(id, token) {
    return request(`/v1/proposals/${encodeURIComponent(id)}/result`, { token });
  }

  return { clock, dbPath, request, auth, proposal, share, respond, result };
}

async function addResponses(h, shareToken, revisionId, prefix, values) {
  for (let i = 0; i < values.length; i++) {
    const token = await h.auth(`${prefix}-${i}`);
    const res = await h.respond(shareToken, token, revisionId, values[i]);
    assert.equal(res.status, 200);
  }
}

test("result thresholds: <4 WAITING, PASS, ADJUST and BLOCKED", async (t) => {
  const h = await harness(t);
  const creator = await h.auth("creator-thresholds");

  const cases = [
    {
      name: "under-four",
      responses: ["OK", "BLOCKED", "OK"],
      expected: "WAITING",
    },
    {
      name: "pass",
      responses: ["OK", "OK", "OK", "DIFFICULT"],
      expected: "PASS",
    },
    {
      name: "adjust",
      responses: ["DIFFICULT", "OK", "DIFFICULT", "OK"],
      expected: "ADJUST",
    },
    {
      name: "blocked",
      responses: ["OK", "OK", "BLOCKED", "OK"],
      expected: "BLOCKED",
    },
  ];

  for (const c of cases) {
    const p = await h.proposal(creator, `方案-${c.name}`);
    await addResponses(h, p.shareToken, p.revisionId, c.name, c.responses);

    const res = await h.result(p.id, creator);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, c.expected);
    assert.equal(res.body.content, `方案-${c.name}`);
    assert.equal(res.body.revisionId, p.revisionId);
    assert.equal(res.body.version, 1);
  }
});

test("duplicate response is rejected with 409", async (t) => {
  const h = await harness(t);
  const creator = await h.auth("creator-duplicate");
  const voter = await h.auth("voter-duplicate");
  const p = await h.proposal(creator);

  const first = await h.respond(p.shareToken, voter, p.revisionId, "OK");
  assert.equal(first.status, 200);

  const duplicate = await h.respond(
    p.shareToken,
    voter,
    p.revisionId,
    "BLOCKED",
  );
  assert.equal(duplicate.status, 409);
});

test("new revision resets answers and rejects stale revisionId", async (t) => {
  const h = await harness(t);
  const creator = await h.auth("creator-revision");
  const voter = await h.auth("voter-revision");
  const p = await h.proposal(creator, "第一版方案");

  assert.equal(
    (await h.respond(p.shareToken, voter, p.revisionId, "BLOCKED")).status,
    200,
  );

  const revision = await h.request(`/v1/proposals/${p.id}/revisions`, {
    method: "POST",
    token: creator,
    body: { content: "第二版方案" },
  });
  assert.equal(revision.status, 201);

  const latest = await h.share(p.shareToken, voter);
  assert.equal(latest.status, 200);
  assert.equal(latest.body.proposalId, p.id);
  assert.notEqual(latest.body.revisionId, p.revisionId);
  assert.equal(latest.body.content, "第二版方案");
  assert.equal(latest.body.version, 2);
  assert.equal(latest.body.lifecycle, "OPEN");
  assert.equal(latest.body.submitted, false);

  const stale = await h.respond(p.shareToken, voter, p.revisionId, "OK");
  assert.equal(stale.status, 409);

  const result = await h.result(p.id, creator);
  assert.equal(result.status, 200);
  assert.equal(result.body.revisionId, latest.body.revisionId);
  assert.equal(result.body.version, 2);
  assert.equal(result.body.status, "WAITING");

  assert.equal(
    (await h.respond(p.shareToken, voter, latest.body.revisionId, "OK")).status,
    200,
  );
});

test("noncreator cannot read proposal result", async (t) => {
  const h = await harness(t);
  const creator = await h.auth("creator-private-result");
  const other = await h.auth("other-private-result");
  const p = await h.proposal(creator);

  const forbidden = await h.result(p.id, other);
  assert.equal(forbidden.status, 403);

  const revise = await h.request(`/v1/proposals/${p.id}/revisions`, {
    method: "POST",
    token: other,
    body: { content: "未经授权的修改" },
  });
  assert.equal(revise.status, 403);

  const confirm = await h.request(`/v1/proposals/${p.id}/confirm`, {
    method: "POST",
    token: other,
    body: {},
  });
  assert.equal(confirm.status, 403);
});

test("concurrent duplicate submission stores one anonymous answer", async (t) => {
  const h = await harness(t);
  const creator = await h.auth("creator-concurrent");
  const voter = await h.auth("voter-concurrent");
  const p = await h.proposal(creator);

  const responses = await Promise.all([
    h.respond(p.shareToken, voter, p.revisionId, "OK"),
    h.respond(p.shareToken, voter, p.revisionId, "BLOCKED"),
  ]);
  assert.deepEqual(responses.map((item) => item.status).sort(), [200, 409]);

  const db = new DatabaseSync(h.dbPath);
  t.after(() => db.close());
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM response_guard").get().n,
    1,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM anonymous_response").get().n,
    1,
  );
});

test("PASS can be confirmed and confirmed proposal rejects further responses", async (t) => {
  const h = await harness(t);
  const creator = await h.auth("creator-confirm");
  const p = await h.proposal(creator, "确认这个方案");

  await addResponses(h, p.shareToken, p.revisionId, "confirm-voter", [
    "OK",
    "OK",
    "OK",
    "OK",
  ]);

  const before = await h.result(p.id, creator);
  assert.equal(before.status, 200);
  assert.equal(before.body.status, "PASS");

  const confirm = await h.request(`/v1/proposals/${p.id}/confirm`, {
    method: "POST",
    token: creator,
    body: {},
  });
  assert.equal(confirm.status, 200);

  const viewer = await h.auth("viewer-after-confirm");
  const card = await h.share(p.shareToken, viewer);
  assert.equal(card.status, 200);
  assert.equal(card.body.lifecycle, "CONFIRMED");
  assert.equal(card.body.content, "确认这个方案");

  const rejected = await h.respond(
    p.shareToken,
    viewer,
    card.body.revisionId,
    "OK",
  );
  assert.equal(rejected.status, 409);
});

test("proposal expires after 48 hours", async (t) => {
  const h = await harness(t);
  const creator = await h.auth("creator-expiry");
  const voter = await h.auth("voter-expiry");
  const p = await h.proposal(creator, "48小时方案");

  h.clock.value += 48 * HOUR + 1;

  const expired = await h.share(p.shareToken, voter);
  assert.equal(expired.status, 410);
  assert.deepEqual(expired.body, { error: "EXPIRED" });

  const rejected = await h.respond(p.shareToken, voter, p.revisionId, "OK");
  assert.equal(rejected.status, 409);
});

test("strict request bodies reject client-supplied openid", async (t) => {
  const h = await harness(t);
  const creator = await h.auth("creator-strict-body");

  const create = await h.request("/v1/proposals", {
    method: "POST",
    token: creator,
    body: {
      content: "不能接受额外身份字段",
      openid: "attacker-controlled-openid",
    },
  });
  assert.equal(create.status, 400);

  const p = await h.proposal(creator);
  const voter = await h.auth("voter-strict-body");

  const response = await h.request(
    `/v1/share/${encodeURIComponent(p.shareToken)}/respond`,
    {
      method: "POST",
      token: voter,
      body: {
        revisionId: p.revisionId,
        response: "OK",
        openid: "attacker-controlled-openid",
      },
    },
  );
  assert.equal(response.status, 400);
});

test("share and result responses expose only public privacy-safe fields", async (t) => {
  const h = await harness(t);
  const creator = await h.auth("creator-privacy");
  const voter = await h.auth("voter-privacy");
  const p = await h.proposal(creator, "隐私字段检查");

  let page = await h.share(p.shareToken, voter);
  assert.equal(page.status, 200);
  assert.deepEqual(
    Object.keys(page.body).sort(),
    [
      "proposalId",
      "revisionId",
      "content",
      "version",
      "lifecycle",
      "submitted",
    ].sort(),
  );
  assert.equal(page.body.submitted, false);

  assert.equal(
    (await h.respond(p.shareToken, voter, p.revisionId, "DIFFICULT")).status,
    200,
  );

  page = await h.share(p.shareToken, voter);
  assert.equal(page.status, 200);
  assert.deepEqual(
    Object.keys(page.body).sort(),
    [
      "proposalId",
      "revisionId",
      "content",
      "version",
      "lifecycle",
      "submitted",
    ].sort(),
  );
  assert.equal(page.body.lifecycle, "ANSWERED");
  assert.equal(page.body.submitted, true);

  const result = await h.result(p.id, creator);
  assert.equal(result.status, 200);
  assert.deepEqual(
    Object.keys(result.body).sort(),
    ["content", "revisionId", "version", "lifecycle", "status"].sort(),
  );
  assert.equal(result.body.status, "WAITING");

  const forbiddenKeys = [
    "responses",
    "answers",
    "counts",
    "total",
    "ok",
    "difficult",
    "blocked",
    "openid",
    "subject",
    "creator",
    "creatorId",
  ];

  for (const key of forbiddenKeys) {
    assert.equal(key in page.body, false);
    assert.equal(key in result.body, false);
  }
});

test("production refuses to start with dev auth enabled", () => {
  const dir = join(
    tmpdir(),
    `proposal-prod-${randomBytes(8).toString("hex")}.sqlite`,
  );
  assert.throws(() => {
    createServer({
      env: makeEnv({
        NODE_ENV: "production",
        DEV_AUTH_ENABLED: "1",
      }),
      dbPath: dir,
      now: () => START,
    });
  });
});

test("production never exposes development login", async (t) => {
  const server = createServer({
    env: {
      NODE_ENV: "production",
      DEV_AUTH_ENABLED: "0",
      WECHAT_APPID: "test-appid",
      WECHAT_APP_SECRET: "test-app-secret",
      SESSION_AES_KEY: "a".repeat(32),
      CREATOR_HMAC_KEY: "b".repeat(32),
      GUARD_HMAC_KEY: "c".repeat(32),
    },
    dbPath: ":memory:",
    now: () => START,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/__dev/auth`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subject: "attacker" }),
    },
  );
  assert.equal(response.status, 404);
});

test("guard and answers remain separate, and cleanup preserves confirmed card", async (t) => {
  const h = await harness(t);
  const creator = await h.auth("creator-cleanup");
  const p = await h.proposal(creator, "清理后的最终方案");
  await addResponses(h, p.shareToken, p.revisionId, "cleanup-voter", [
    "OK",
    "OK",
    "OK",
    "OK",
  ]);

  const db = new DatabaseSync(h.dbPath);
  t.after(() => db.close());
  const guardFields = db
    .prepare("PRAGMA table_info(response_guard)")
    .all()
    .map((row) => row.name);
  const answerFields = db
    .prepare("PRAGMA table_info(anonymous_response)")
    .all()
    .map((row) => row.name);
  assert.deepEqual(guardFields, ["guard_hmac", "submitted_at"]);
  assert.deepEqual(answerFields, ["revision_id", "response", "created_at"]);

  const confirmed = await h.request(`/v1/proposals/${p.id}/confirm`, {
    method: "POST",
    token: creator,
    body: {},
  });
  assert.equal(confirmed.status, 200);

  h.clock.value += 24 * HOUR + 1;
  const card = await h.result(p.id, creator);
  assert.equal(card.status, 200);
  assert.equal(card.body.lifecycle, "CONFIRMED");
  assert.equal(card.body.status, "PASS");
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM anonymous_response").get().n,
    0,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM response_guard").get().n,
    4,
  );

  h.clock.value += 24 * HOUR;
  const expiredCard = await h.share(p.shareToken, creator);
  assert.equal(expiredCard.status, 410);
  assert.deepEqual(expiredCard.body, { error: "EXPIRED" });

  h.clock.value += 6 * 24 * HOUR;
  await h.request("/healthz");
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM response_guard").get().n,
    0,
  );
});

test("expired result hides historical answer state", async (t) => {
  const h = await harness(t);
  const creator = await h.auth("creator-expired-result");
  const p = await h.proposal(creator);
  await addResponses(h, p.shareToken, p.revisionId, "expired-voter", [
    "OK",
    "OK",
    "OK",
    "OK",
  ]);
  assert.equal((await h.result(p.id, creator)).body.status, "PASS");
  h.clock.value += 48 * HOUR + 1;
  const result = await h.result(p.id, creator);
  assert.equal(result.status, 410);
  assert.deepEqual(result.body, { error: "EXPIRED" });
});
