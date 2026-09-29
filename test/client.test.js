import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadPage(relativePath, api, wx) {
  const source = fs.readFileSync(path.join(ROOT, relativePath), "utf8");
  let definition = null;

  vm.runInNewContext(
    source,
    {
      Page(value) {
        definition = value;
      },
      wx,
      require(id) {
        if (id === "../../lib/api") {
          return api;
        }
        throw new Error("Unexpected require: " + id);
      },
      console,
    },
    {
      filename: relativePath,
    },
  );

  assert.ok(definition, "Page() should be called");

  return {
    ...definition,
    data: structuredClone(definition.data),
    setData(patch) {
      Object.assign(this.data, patch);
    },
  };
}

function createWx(initial = {}) {
  const storage = new Map(Object.entries(initial));

  return {
    storage,
    getStorageSync(key) {
      return storage.has(key) ? storage.get(key) : "";
    },
    setStorageSync(key, value) {
      storage.set(key, value);
    },
    removeStorageSync(key) {
      storage.delete(key);
    },
    navigateTo() {},
    navigateBack() {},
    stopPullDownRefresh() {},
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate, message = "condition was not reached") {
  for (let i = 0; i < 50; i += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

function apiError(code, statusCode = 410) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

test("create: successful creation enters share state and persists share token", async () => {
  const wx = createWx();
  const calls = [];

  const api = {
    createProposal(content) {
      calls.push(content);
      return Promise.resolve({
        id: "proposal-1",
        revisionId: "revision-1",
        shareToken: "share-secret",
        version: 1,
        content,
      });
    },
  };

  const page = loadPage("miniprogram/pages/create/index.js", api, wx);
  page.setData({ draft: "周六 18:30 吃饭" });

  page.submit();

  await waitFor(() => page.data.created === true);

  assert.deepEqual(calls, ["周六 18:30 吃饭"]);
  assert.equal(page.data.proposalId, "proposal-1");
  assert.equal(page.data.revisionId, "revision-1");
  assert.equal(page.data.shareToken, "share-secret");
  assert.equal(page.data.created, true);

  assert.equal(wx.storage.get("currentProposalId"), "proposal-1");
  assert.deepEqual(
    JSON.parse(JSON.stringify(wx.storage.get("proposal:proposal-1"))),
    {
      id: "proposal-1",
      revisionId: "revision-1",
      shareToken: "share-secret",
      version: 1,
      content: "周六 18:30 吃饭",
    },
  );
});

test("answer: selected answer is submitted once and refreshes into ANSWERED", async () => {
  const wx = createWx();
  const responseGate = deferred();
  let respondCalls = 0;
  let shareCalls = 0;

  const api = {
    respond(token, revisionId, response) {
      respondCalls += 1;
      assert.equal(token, "share-1");
      assert.equal(revisionId, "revision-1");
      assert.equal(response, "DIFFICULT");
      return responseGate.promise;
    },
    getShare(token) {
      shareCalls += 1;
      assert.equal(token, "share-1");
      return Promise.resolve({
        proposalId: "proposal-1",
        revisionId: "revision-1",
        content: "周六 18:30 吃饭",
        version: 1,
        lifecycle: "ANSWERED",
        submitted: true,
      });
    },
  };

  const page = loadPage("miniprogram/pages/answer/index.js", api, wx);
  page.setData({
    shareToken: "share-1",
    revisionId: "revision-1",
    content: "周六 18:30 吃饭",
    version: 1,
    lifecycle: "OPEN",
    submitted: false,
  });

  page.choose({
    currentTarget: {
      dataset: { value: "DIFFICULT" },
    },
  });

  assert.equal(page.data.selected, "DIFFICULT");

  page.submit();
  page.submit();

  assert.equal(respondCalls, 1);
  assert.equal(page.data.submitting, true);

  responseGate.resolve({ ok: true });

  await waitFor(() => page.data.submitting === false);

  assert.equal(respondCalls, 1);
  assert.equal(shareCalls, 1);
  assert.equal(page.data.lifecycle, "ANSWERED");
  assert.equal(page.data.submitted, true);
  assert.equal(page.data.selected, "");
});

test("result: confirm is ignored unless PASS and successful confirm becomes CONFIRMED", async () => {
  const wx = createWx({
    "proposal:proposal-1": {
      id: "proposal-1",
      revisionId: "revision-1",
      shareToken: "share-1",
      version: 1,
      content: "旧方案",
    },
  });

  let confirmCalls = 0;

  const api = {
    confirmProposal(proposalId) {
      confirmCalls += 1;
      assert.equal(proposalId, "proposal-1");
      return Promise.resolve({
        id: "proposal-1",
        revisionId: "revision-1",
        version: 1,
        content: "周六 18:30 吃饭",
        lifecycle: "CONFIRMED",
      });
    },
  };

  const page = loadPage("miniprogram/pages/result/index.js", api, wx);
  page.setData({
    proposalId: "proposal-1",
    revisionId: "revision-1",
    shareToken: "share-1",
    content: "周六 18:30 吃饭",
    version: 1,
    status: "WAITING",
    loading: false,
  });

  page.confirm();
  assert.equal(confirmCalls, 0);

  page.setData({ status: "ADJUST" });
  page.confirm();
  assert.equal(confirmCalls, 0);

  page.setData({ status: "BLOCKED" });
  page.confirm();
  assert.equal(confirmCalls, 0);

  page.setData({ status: "PASS" });
  page.confirm();
  page.confirm();

  assert.equal(confirmCalls, 1);

  await waitFor(() => page.data.status === "CONFIRMED");

  assert.equal(page.data.confirming, false);
  assert.equal(page.data.status, "CONFIRMED");
  assert.equal(page.data.statusMeta.label, "已确认");
  assert.equal(page.data.content, "周六 18:30 吃饭");
});

test("result: 410 EXPIRED clears previously visible content and exposes no historical result", async () => {
  const wx = createWx();

  let resultCalls = 0;
  const api = {
    getResult(proposalId) {
      resultCalls += 1;
      assert.equal(proposalId, "proposal-1");
      return Promise.reject(apiError("EXPIRED", 410));
    },
  };

  const page = loadPage("miniprogram/pages/result/index.js", api, wx);
  page.setData({
    proposalId: "proposal-1",
    content: "不应继续显示的旧正文",
    revisionId: "old-revision",
    version: 3,
    status: "BLOCKED",
    loading: false,
  });

  await page.loadResult();

  assert.equal(resultCalls, 1);
  assert.equal(page.data.status, "EXPIRED");
  assert.equal(page.data.statusMeta.label, "已过期");
  assert.equal(page.data.content, "");
  assert.equal(page.data.revisionId, "");
  assert.equal(page.data.loading, false);
  assert.equal(page.data.error, "");
  assert.equal(
    JSON.stringify(page.data).includes("不应继续显示的旧正文"),
    false,
  );
});
