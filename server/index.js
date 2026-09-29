import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from "node:crypto";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const PROPOSAL_TTL_MS = 48 * HOUR_MS;
const SESSION_TTL_DEFAULT_MS = 30 * DAY_MS;
const ANSWER_RETENTION_MS = 24 * HOUR_MS;
const GUARD_RETENTION_MS = 7 * DAY_MS;
const MAX_BODY_BYTES = 16 * 1024;

const RESPONSE_VALUES = new Set(["OK", "DIFFICULT", "BLOCKED"]);

class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function asEnv(env) {
  return env && typeof env === "object" ? env : process.env;
}

function envString(env, name) {
  const value = env[name];
  return typeof value === "string" ? value : "";
}

function requiredProductionEnv(env, names) {
  if (envString(env, "NODE_ENV") !== "production") return;
  for (const name of names) {
    if (!envString(env, name)) {
      throw new Error(`Missing required environment variable: ${name}`);
    }
  }
}

function secretBytes(env, name) {
  const value = envString(env, name);
  if (value) {
    return createHash("sha256").update(value, "utf8").digest();
  }
  return randomBytes(32);
}

function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

function randomId() {
  return randomBytes(16).toString("base64url");
}

function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hmacHex(key, value) {
  return createHmac("sha256", key).update(value, "utf8").digest("hex");
}

function encryptOpenid(key, openid) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(openid, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return { nonce, ciphertext, tag };
}

function decryptOpenid(key, nonce, ciphertext, tag) {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new HttpError(401, "UNAUTHORIZED");
  }
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function assertExactKeys(object, required, optional = []) {
  if (!isPlainObject(object)) {
    throw new HttpError(400, "INVALID_BODY");
  }

  const keys = Object.keys(object);
  const allowed = new Set([...required, ...optional]);

  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(object, key)) {
      throw new HttpError(400, "INVALID_BODY");
    }
  }

  for (const key of keys) {
    if (!allowed.has(key)) {
      throw new HttpError(400, "INVALID_BODY");
    }
  }
}

function assertContent(content) {
  if (typeof content !== "string") {
    throw new HttpError(400, "INVALID_CONTENT");
  }

  const length = Array.from(content).length;
  if (length < 1 || length > 80 || content.trim().length === 0) {
    throw new HttpError(400, "INVALID_CONTENT");
  }

  return content;
}

function assertNonEmptyString(value, maxLength, code = "INVALID_BODY") {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    value.trim().length === 0
  ) {
    throw new HttpError(400, code);
  }
  return value;
}

function nowMs(now) {
  const value = typeof now === "function" ? now() : Date.now();
  if (!Number.isFinite(value)) {
    throw new Error("now() must return a finite millisecond timestamp");
  }
  return Math.trunc(value);
}

function json(res, status, body, extraHeaders = undefined) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    ...(extraHeaders || {}),
  });
  res.end(payload);
}

function empty(res, status) {
  res.writeHead(status, {
    "cache-control": "no-store",
    "content-length": "0",
  });
  res.end();
}

async function readJson(req, { allowEmpty = false } = {}) {
  const contentType = String(req.headers["content-type"] || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();

  if (contentType !== "application/json") {
    throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE");
  }

  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      throw new HttpError(413, "BODY_TOO_LARGE");
    }
    chunks.push(chunk);
  }

  if (total === 0) {
    if (allowEmpty) return {};
    throw new HttpError(400, "INVALID_JSON");
  }

  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "INVALID_JSON");
  }

  if (!isPlainObject(value)) {
    throw new HttpError(400, "INVALID_BODY");
  }

  return value;
}

function getBearer(req) {
  const header = req.headers.authorization;
  if (typeof header !== "string") {
    throw new HttpError(401, "UNAUTHORIZED");
  }

  const match = /^Bearer ([A-Za-z0-9_-]{20,256})$/.exec(header);
  if (!match) {
    throw new HttpError(401, "UNAUTHORIZED");
  }

  return match[1];
}

function proposalResultStatus(db, revisionId) {
  const counts = db
    .prepare(
      `
  SELECT COUNT(*) AS total,
    SUM(CASE WHEN response = 'BLOCKED' THEN 1 ELSE 0 END) AS blocked,
    SUM(CASE WHEN response = 'DIFFICULT' THEN 1 ELSE 0 END) AS difficult
  FROM anonymous_response WHERE revision_id = ?
`,
    )
    .get(revisionId);

  if (counts.total < 4) return "WAITING";
  if (counts.blocked >= 1) return "BLOCKED";
  if (counts.difficult >= 2) return "ADJUST";
  return "PASS";
}

function begin(db) {
  db.exec("BEGIN IMMEDIATE");
}

function commit(db) {
  db.exec("COMMIT");
}

function rollback(db) {
  try {
    db.exec("ROLLBACK");
  } catch {
    // Ignore rollback failure after a failed transaction.
  }
}

function withTransaction(db, fn) {
  begin(db);
  try {
    const result = fn();
    commit(db);
    return result;
  } catch (error) {
    rollback(db);
    throw error;
  }
}

function createSchema(db) {
  db.exec(`
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  openid_nonce BLOB NOT NULL,
  openid_ciphertext BLOB NOT NULL,
  openid_tag BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS sessions_expires_at_idx
  ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  creator_hmac TEXT NOT NULL,
  share_token_hash TEXT NOT NULL UNIQUE,
  current_revision_id TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('OPEN', 'CONFIRMED', 'EXPIRED')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  confirmed_at INTEGER
) STRICT;

CREATE INDEX IF NOT EXISTS proposals_creator_hmac_idx
  ON proposals(creator_hmac);

CREATE INDEX IF NOT EXISTS proposals_expires_at_idx
  ON proposals(expires_at);

CREATE TABLE IF NOT EXISTS revisions (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  content TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('OPEN', 'SUPERSEDED', 'CONFIRMED')),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (proposal_id) REFERENCES proposals(id) ON DELETE CASCADE,
  UNIQUE (proposal_id, version)
) STRICT;

CREATE INDEX IF NOT EXISTS revisions_proposal_id_idx
  ON revisions(proposal_id);

CREATE UNIQUE INDEX IF NOT EXISTS revisions_one_open_per_proposal_idx
  ON revisions(proposal_id) WHERE status = 'OPEN';

CREATE TABLE IF NOT EXISTS response_guard (
  guard_hmac TEXT PRIMARY KEY,
  submitted_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS response_guard_submitted_at_idx
  ON response_guard(submitted_at);

CREATE TABLE IF NOT EXISTS anonymous_response (
  revision_id TEXT NOT NULL,
  response TEXT NOT NULL
    CHECK (response IN ('OK', 'DIFFICULT', 'BLOCKED')),
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS anonymous_response_revision_id_idx
  ON anonymous_response(revision_id);

`);
}

function createSession(db, aesKey, openid, ts, sessionTtlMs) {
  const token = randomToken(32);
  const tokenHash = sha256Hex(token);
  const encrypted = encryptOpenid(aesKey, openid);
  const expiresAt = ts + sessionTtlMs;

  db.prepare(
    "INSERT INTO sessions (token_hash, openid_nonce, openid_ciphertext, openid_tag, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    tokenHash,
    encrypted.nonce,
    encrypted.ciphertext,
    encrypted.tag,
    ts,
    expiresAt,
  );

  return { token, expiresAt };
}

function cleanup(db, ts) {
  withTransaction(db, () => {
    db.prepare(
      "UPDATE proposals SET status = 'EXPIRED' WHERE status IN ('OPEN', 'CONFIRMED') AND expires_at <= ?",
    ).run(ts);

    db.prepare(
      `
  UPDATE revisions
  SET status = 'SUPERSEDED'
  WHERE status = 'OPEN'
    AND id IN (
      SELECT current_revision_id
      FROM proposals
      WHERE status = 'EXPIRED'
    )
`,
    ).run();

    const answerCutoff = ts - ANSWER_RETENTION_MS;

    db.prepare(
      `
  DELETE FROM anonymous_response
  WHERE revision_id IN (
    SELECT r.id
    FROM revisions AS r
    JOIN proposals AS p
      ON p.id = r.proposal_id
    WHERE
      (
        r.status = 'CONFIRMED'
        AND p.confirmed_at IS NOT NULL
        AND p.confirmed_at <= ?
      )
      OR
      (
        r.status = 'SUPERSEDED'
        AND (
          (
            r.id = p.current_revision_id
            AND p.status = 'EXPIRED'
            AND p.expires_at <= ?
          )
          OR EXISTS (
            SELECT 1
            FROM revisions AS next_r
            WHERE next_r.proposal_id = r.proposal_id
              AND next_r.version = r.version + 1
              AND next_r.created_at <= ?
          )
        )
      )
  )
`,
    ).run(answerCutoff, answerCutoff, answerCutoff);

    db.prepare(
      `
  DELETE FROM response_guard
  WHERE submitted_at <= ?
`,
    ).run(ts - GUARD_RETENTION_MS);

    db.prepare(
      `
  DELETE FROM sessions
  WHERE expires_at <= ?
`,
    ).run(ts);
  });
}

function authenticate(db, aesKey, req, ts) {
  const token = getBearer(req);
  const tokenHash = sha256Hex(token);

  const session = db
    .prepare(
      "SELECT openid_nonce, openid_ciphertext, openid_tag, expires_at FROM sessions WHERE token_hash = ?",
    )
    .get(tokenHash);

  if (!session || session.expires_at <= ts) {
    throw new HttpError(401, "UNAUTHORIZED");
  }

  return decryptOpenid(
    aesKey,
    session.openid_nonce,
    session.openid_ciphertext,
    session.openid_tag,
  );
}

function requireCreator(proposal, creatorKey, openid) {
  if (!proposal) {
    throw new HttpError(404, "NOT_FOUND");
  }

  const expected = hmacHex(creatorKey, openid);
  if (proposal.creator_hmac !== expected) {
    throw new HttpError(403, "FORBIDDEN");
  }
}

function getProposalWithCurrentRevision(db, proposalId) {
  return db
    .prepare(
      "SELECT p.id, p.creator_hmac, p.share_token_hash, p.current_revision_id, p.status AS proposal_status, p.created_at AS proposal_created_at, p.expires_at, p.confirmed_at, r.id AS revision_id, r.version, r.content, r.status AS revision_status, r.created_at AS revision_created_at FROM proposals AS p JOIN revisions AS r ON r.id = p.current_revision_id WHERE p.id = ?",
    )
    .get(proposalId);
}

function getSharedProposal(db, token) {
  return db
    .prepare(
      "SELECT p.id, p.current_revision_id, p.status AS proposal_status, p.expires_at, p.confirmed_at, r.id AS revision_id, r.version, r.content, r.status AS revision_status FROM proposals AS p JOIN revisions AS r ON r.id = p.current_revision_id WHERE p.share_token_hash = ?",
    )
    .get(sha256Hex(token));
}

function guardHmac(guardKey, openid, revisionId) {
  return hmacHex(guardKey, `${openid}\0${revisionId}`);
}

function shareLifecycle(db, guardKey, openid, proposal) {
  if (proposal.proposal_status === "CONFIRMED") {
    return "CONFIRMED";
  }

  if (proposal.proposal_status === "EXPIRED") {
    return "EXPIRED";
  }

  const guard = guardHmac(guardKey, openid, proposal.revision_id);
  const submitted = Boolean(
    db.prepare("SELECT 1 FROM response_guard WHERE guard_hmac = ?").get(guard),
  );

  return submitted ? "ANSWERED" : "OPEN";
}

async function fetchWechatOpenid(env, code) {
  const appid = envString(env, "WECHAT_APPID");
  const secret = envString(env, "WECHAT_APP_SECRET");

  if (!appid || !secret) {
    throw new HttpError(503, "AUTH_UNAVAILABLE");
  }

  const url = new URL("https://api.weixin.qq.com/sns/jscode2session");
  url.searchParams.set("appid", appid);
  url.searchParams.set("secret", secret);
  url.searchParams.set("js_code", code);
  url.searchParams.set("grant_type", "authorization_code");

  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        accept: "application/json",
      },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new HttpError(502, "AUTH_UPSTREAM_ERROR");
  }

  if (!response.ok) {
    throw new HttpError(502, "AUTH_UPSTREAM_ERROR");
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new HttpError(502, "AUTH_UPSTREAM_ERROR");
  }

  if (
    !isPlainObject(payload) ||
    typeof payload.openid !== "string" ||
    payload.openid.length < 1 ||
    payload.openid.length > 256
  ) {
    if (payload && typeof payload.errcode === "number") {
      throw new HttpError(401, "AUTH_FAILED");
    }
    throw new HttpError(502, "AUTH_UPSTREAM_ERROR");
  }

  return payload.openid;
}

function parsePath(urlString) {
  let url;
  try {
    url = new URL(urlString || "/", "http://localhost");
  } catch {
    throw new HttpError(400, "INVALID_URL");
  }

  if (url.search !== "") {
    throw new HttpError(400, "QUERY_NOT_ALLOWED");
  }

  return url.pathname;
}

export function createServer({
  env = process.env,
  dbPath = ":memory:",
  now = Date.now,
} = {}) {
  env = asEnv(env);

  const production = envString(env, "NODE_ENV") === "production";
  if (production && envString(env, "DEV_AUTH_ENABLED") === "1") {
    throw new Error("DEV_AUTH_ENABLED must not be enabled in production");
  }

  requiredProductionEnv(env, [
    "WECHAT_APPID",
    "WECHAT_APP_SECRET",
    "SESSION_AES_KEY",
    "CREATOR_HMAC_KEY",
    "GUARD_HMAC_KEY",
  ]);

  if (production) {
    for (const name of [
      "SESSION_AES_KEY",
      "CREATOR_HMAC_KEY",
      "GUARD_HMAC_KEY",
    ]) {
      if (envString(env, name).length < 32) {
        throw new Error(`${name} must be at least 32 characters`);
      }
    }
    if (env.CREATOR_HMAC_KEY === env.GUARD_HMAC_KEY) {
      throw new Error("Creator and guard HMAC keys must differ");
    }
  }

  const aesKey = secretBytes(env, "SESSION_AES_KEY");
  const creatorKey = secretBytes(env, "CREATOR_HMAC_KEY");
  const guardKey = secretBytes(env, "GUARD_HMAC_KEY");

  const sessionTtlSecondsRaw = envString(env, "SESSION_TTL_SECONDS");
  let sessionTtlMs = SESSION_TTL_DEFAULT_MS;

  if (sessionTtlSecondsRaw) {
    const seconds = Number(sessionTtlSecondsRaw);
    if (
      !Number.isSafeInteger(seconds) ||
      seconds < 60 ||
      seconds > 365 * 24 * 60 * 60
    ) {
      throw new Error("SESSION_TTL_SECONDS is invalid");
    }
    sessionTtlMs = seconds * 1000;
  }

  const db = new DatabaseSync(dbPath);
  createSchema(db);

  const cleanupTimer = setInterval(() => {
    try {
      cleanup(db, nowMs(now));
    } catch {
      // A later request or timer tick retries without exposing private data.
    }
  }, HOUR_MS);
  cleanupTimer.unref();

  let dbClosed = false;

  const server = http.createServer(async (req, res) => {
    try {
      const ts = nowMs(now);
      cleanup(db, ts);

      const method = String(req.method || "").toUpperCase();
      const path = parsePath(req.url);

      if (method === "GET" && path === "/healthz") {
        json(res, 200, { ok: true });
        return;
      }

      if (method === "POST" && path === "/v1/auth/wechat") {
        const body = await readJson(req);
        assertExactKeys(body, ["code"]);
        const code = assertNonEmptyString(body.code, 512, "INVALID_CODE");

        const openid = await fetchWechatOpenid(env, code);
        const session = createSession(db, aesKey, openid, ts, sessionTtlMs);

        json(res, 200, {
          token: session.token,
          expiresAt: session.expiresAt,
        });
        return;
      }

      if (method === "POST" && path === "/__dev/auth") {
        if (production || envString(env, "DEV_AUTH_ENABLED") !== "1") {
          throw new HttpError(404, "NOT_FOUND");
        }

        const body = await readJson(req);
        assertExactKeys(body, ["subject"]);
        const subject = assertNonEmptyString(
          body.subject,
          256,
          "INVALID_SUBJECT",
        );

        const session = createSession(
          db,
          aesKey,
          `dev:${subject}`,
          ts,
          sessionTtlMs,
        );

        json(res, 200, {
          token: session.token,
          expiresAt: session.expiresAt,
        });
        return;
      }

      const openid = authenticate(db, aesKey, req, ts);

      if (method === "POST" && path === "/v1/proposals") {
        const body = await readJson(req);
        assertExactKeys(body, ["content"]);
        const content = assertContent(body.content);

        const proposalId = randomId();
        const revisionId = randomId();
        const shareToken = randomToken(32);
        const shareTokenHash = sha256Hex(shareToken);
        const creator = hmacHex(creatorKey, openid);
        const expiresAt = ts + PROPOSAL_TTL_MS;

        withTransaction(db, () => {
          db.prepare(
            `
        INSERT INTO proposals (
          id,
          creator_hmac,
          share_token_hash,
          current_revision_id,
          status,
          created_at,
          expires_at,
          confirmed_at
        ) VALUES (?, ?, ?, ?, 'OPEN', ?, ?, NULL)
      `,
          ).run(proposalId, creator, shareTokenHash, revisionId, ts, expiresAt);

          db.prepare(
            `
        INSERT INTO revisions (
          id,
          proposal_id,
          version,
          content,
          status,
          created_at
        ) VALUES (?, ?, 1, ?, 'OPEN', ?)
      `,
          ).run(revisionId, proposalId, content, ts);
        });

        json(res, 201, {
          id: proposalId,
          revisionId,
          shareToken,
        });
        return;
      }

      const shareMatch = /^\/v1\/share\/([A-Za-z0-9_-]{20,256})$/.exec(path);

      if (method === "GET" && shareMatch) {
        const shareToken = shareMatch[1];
        const proposal = getSharedProposal(db, shareToken);

        if (!proposal) {
          throw new HttpError(404, "NOT_FOUND");
        }

        if (
          proposal.proposal_status === "EXPIRED" ||
          proposal.expires_at <= ts
        ) {
          throw new HttpError(410, "EXPIRED");
        }

        const lifecycle = shareLifecycle(db, guardKey, openid, proposal);
        const submitted =
          lifecycle === "ANSWERED" ||
          Boolean(
            db
              .prepare(
                `
          SELECT 1
          FROM response_guard
          WHERE guard_hmac = ?
        `,
              )
              .get(guardHmac(guardKey, openid, proposal.revision_id)),
          );

        json(res, 200, {
          proposalId: proposal.id,
          revisionId: proposal.revision_id,
          content: proposal.content,
          version: proposal.version,
          lifecycle,
          submitted,
        });
        return;
      }

      const respondMatch =
        /^\/v1\/share\/([A-Za-z0-9_-]{20,256})\/respond$/.exec(path);

      if (method === "POST" && respondMatch) {
        const body = await readJson(req);
        assertExactKeys(body, ["revisionId", "response"]);

        const revisionId = assertNonEmptyString(
          body.revisionId,
          128,
          "INVALID_REVISION",
        );

        if (
          typeof body.response !== "string" ||
          !RESPONSE_VALUES.has(body.response)
        ) {
          throw new HttpError(400, "INVALID_RESPONSE");
        }

        const shareToken = respondMatch[1];
        const shareTokenHash = sha256Hex(shareToken);
        const guard = guardHmac(guardKey, openid, revisionId);

        withTransaction(db, () => {
          const proposal = db
            .prepare(
              `
        SELECT
          p.id,
          p.current_revision_id,
          p.status AS proposal_status,
          p.expires_at,
          r.id AS revision_id,
          r.status AS revision_status
        FROM proposals AS p
        JOIN revisions AS r
          ON r.id = p.current_revision_id
        WHERE p.share_token_hash = ?
      `,
            )
            .get(shareTokenHash);

          if (!proposal) {
            throw new HttpError(404, "NOT_FOUND");
          }

          if (
            proposal.proposal_status !== "OPEN" ||
            proposal.expires_at <= ts ||
            proposal.revision_status !== "OPEN"
          ) {
            throw new HttpError(409, "NOT_OPEN");
          }

          if (
            revisionId !== proposal.current_revision_id ||
            revisionId !== proposal.revision_id
          ) {
            throw new HttpError(409, "REVISION_MISMATCH");
          }

          const existing = db
            .prepare(
              `
        SELECT 1
        FROM response_guard
        WHERE guard_hmac = ?
      `,
            )
            .get(guard);

          if (existing) {
            throw new HttpError(409, "ALREADY_SUBMITTED");
          }

          db.prepare(
            `
        INSERT INTO response_guard (
          guard_hmac,
          submitted_at
        ) VALUES (?, ?)
      `,
          ).run(guard, ts);

          const coarseCreatedAt = Math.floor(ts / DAY_MS) * DAY_MS;

          db.prepare(
            `
        INSERT INTO anonymous_response (
          revision_id,
          response,
          created_at
        ) VALUES (?, ?, ?)
      `,
          ).run(revisionId, body.response, coarseCreatedAt);
        });

        json(res, 200, { ok: true });
        return;
      }

      const revisionCreateMatch =
        /^\/v1\/proposals\/([A-Za-z0-9_-]{10,128})\/revisions$/.exec(path);

      if (method === "POST" && revisionCreateMatch) {
        const body = await readJson(req);
        assertExactKeys(body, ["content"]);
        const content = assertContent(body.content);
        const proposalId = revisionCreateMatch[1];

        const created = withTransaction(db, () => {
          const proposal = getProposalWithCurrentRevision(db, proposalId);
          requireCreator(proposal, creatorKey, openid);

          if (
            proposal.proposal_status !== "OPEN" ||
            proposal.expires_at <= ts ||
            proposal.revision_status !== "OPEN"
          ) {
            throw new HttpError(409, "NOT_OPEN");
          }

          const newRevisionId = randomId();
          const newVersion = proposal.version + 1;

          const changed = db
            .prepare(
              `
        UPDATE revisions
        SET status = 'SUPERSEDED'
        WHERE id = ?
          AND status = 'OPEN'
      `,
            )
            .run(proposal.revision_id);

          if (changed.changes !== 1) {
            throw new HttpError(409, "CONFLICT");
          }

          db.prepare(
            `
        INSERT INTO revisions (
          id,
          proposal_id,
          version,
          content,
          status,
          created_at
        ) VALUES (?, ?, ?, ?, 'OPEN', ?)
      `,
          ).run(newRevisionId, proposalId, newVersion, content, ts);

          const updated = db
            .prepare(
              `
        UPDATE proposals
        SET current_revision_id = ?
        WHERE id = ?
          AND current_revision_id = ?
          AND status = 'OPEN'
      `,
            )
            .run(newRevisionId, proposalId, proposal.revision_id);

          if (updated.changes !== 1) {
            throw new HttpError(409, "CONFLICT");
          }

          return {
            id: proposalId,
            revisionId: newRevisionId,
            version: newVersion,
            content,
          };
        });

        json(res, 201, created);
        return;
      }

      const resultMatch =
        /^\/v1\/proposals\/([A-Za-z0-9_-]{10,128})\/result$/.exec(path);

      if (method === "GET" && resultMatch) {
        const proposalId = resultMatch[1];
        const proposal = getProposalWithCurrentRevision(db, proposalId);

        requireCreator(proposal, creatorKey, openid);

        if (
          proposal.proposal_status === "EXPIRED" ||
          proposal.expires_at <= ts
        ) {
          throw new HttpError(410, "EXPIRED");
        }

        const lifecycle =
          proposal.proposal_status === "CONFIRMED" ? "CONFIRMED" : "OPEN";
        const status =
          lifecycle === "CONFIRMED"
            ? "PASS"
            : proposalResultStatus(db, proposal.revision_id);

        json(res, 200, {
          content: proposal.content,
          revisionId: proposal.revision_id,
          version: proposal.version,
          lifecycle,
          status,
        });
        return;
      }

      const confirmMatch =
        /^\/v1\/proposals\/([A-Za-z0-9_-]{10,128})\/confirm$/.exec(path);

      if (method === "POST" && confirmMatch) {
        const body = await readJson(req, { allowEmpty: true });
        assertExactKeys(body, []);

        const proposalId = confirmMatch[1];

        const card = withTransaction(db, () => {
          const proposal = getProposalWithCurrentRevision(db, proposalId);
          requireCreator(proposal, creatorKey, openid);

          if (
            proposal.proposal_status !== "OPEN" ||
            proposal.expires_at <= ts ||
            proposal.revision_status !== "OPEN"
          ) {
            throw new HttpError(409, "NOT_OPEN");
          }

          const resultStatus = proposalResultStatus(db, proposal.revision_id);

          if (resultStatus !== "PASS") {
            throw new HttpError(409, "NOT_PASS");
          }

          const proposalUpdate = db
            .prepare(
              `
        UPDATE proposals
        SET
          status = 'CONFIRMED',
          confirmed_at = ?
        WHERE id = ?
          AND status = 'OPEN'
          AND current_revision_id = ?
      `,
            )
            .run(ts, proposalId, proposal.revision_id);

          if (proposalUpdate.changes !== 1) {
            throw new HttpError(409, "CONFLICT");
          }

          const revisionUpdate = db
            .prepare(
              `
        UPDATE revisions
        SET status = 'CONFIRMED'
        WHERE id = ?
          AND status = 'OPEN'
      `,
            )
            .run(proposal.revision_id);

          if (revisionUpdate.changes !== 1) {
            throw new HttpError(409, "CONFLICT");
          }

          return {
            proposalId,
            revisionId: proposal.revision_id,
            content: proposal.content,
            version: proposal.version,
            status: "CONFIRMED",
          };
        });

        json(res, 200, card);
        return;
      }

      throw new HttpError(404, "NOT_FOUND");
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }

      if (error instanceof HttpError) {
        json(res, error.status, { error: error.code });
        return;
      }

      json(res, 500, { error: "INTERNAL_ERROR" });
    }
  });

  server.on("close", () => {
    clearInterval(cleanupTimer);
    if (!dbClosed) {
      dbClosed = true;
      try {
        db.close();
      } catch {
        // Ignore close errors.
      }
    }
  });

  return server;
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === new URL(`file://${process.argv[1]}`).href;
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  const env = process.env;
  const production = env.NODE_ENV === "production";

  if (production && env.DEV_AUTH_ENABLED === "1") {
    throw new Error("DEV_AUTH_ENABLED must not be enabled in production");
  }

  const server = createServer({
    env,
    dbPath: env.DB_PATH || "./data.sqlite",
    now: Date.now,
  });

  const portRaw = env.PORT || "3000";
  const port = Number(portRaw);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT is invalid");
  }

  const host = env.HOST || "127.0.0.1";

  server.listen(port, host);
}
