const { getBaseURL } = require("../config");

const TOKEN_KEY = "sessionToken";
let authPromise = null;

function createError(message, statusCode, code) {
  const error = new Error(message || "请求失败，请稍后重试");
  error.statusCode = statusCode || 0;
  error.code = code || "";
  return error;
}

function wxLogin() {
  return new Promise((resolve, reject) => {
    wx.login({
      success(result) {
        if (!result.code) {
          reject(createError("微信登录失败，请重试"));
          return;
        }
        resolve(result.code);
      },
      fail() {
        reject(createError("微信登录失败，请检查网络后重试"));
      },
    });
  });
}

function requestCore({
  path,
  method = "GET",
  data,
  auth = true,
  retryAuth = true,
}) {
  return new Promise((resolve, reject) => {
    const token = auth ? wx.getStorageSync(TOKEN_KEY) : "";
    const header = {
      "content-type": "application/json",
    };

    if (token) {
      header.Authorization = "Bearer " + token;
    }

    wx.request({
      url: getBaseURL() + path,
      method,
      data,
      header,
      success(result) {
        const statusCode = result.statusCode;
        const body = result.data || {};

        if (statusCode >= 200 && statusCode < 300) {
          resolve(body);
          return;
        }

        if (auth && retryAuth && statusCode === 401) {
          wx.removeStorageSync(TOKEN_KEY);
          ensureAuth()
            .then(() =>
              requestCore({ path, method, data, auth: true, retryAuth: false }),
            )
            .then(resolve, reject);
          return;
        }

        const messages = {
          ALREADY_SUBMITTED: "你已经匿名确认过这个方案了",
          REVISION_MISMATCH: "方案已更新，请重新选择",
          NOT_OPEN: "这次确认已经结束",
          EXPIRED: "这次确认已经结束",
        };
        const message =
          (body && (body.message || messages[body.error])) ||
          (statusCode === 403 ? "没有权限查看此内容" : "") ||
          (statusCode === 404 ? "内容不存在或已失效" : "") ||
          (statusCode === 409 ? "当前状态已变化，请刷新后重试" : "") ||
          "请求失败，请稍后重试";

        reject(createError(message, statusCode, body && body.error));
      },
      fail() {
        reject(createError("网络连接失败，请稍后重试"));
      },
    });
  });
}

function ensureAuth() {
  const existing = wx.getStorageSync(TOKEN_KEY);
  if (existing) {
    return Promise.resolve(existing);
  }

  if (authPromise) {
    return authPromise;
  }

  authPromise = wxLogin()
    .then((code) =>
      requestCore({
        path: "/v1/auth/wechat",
        method: "POST",
        data: { code },
        auth: false,
        retryAuth: false,
      }),
    )
    .then((body) => {
      if (!body || typeof body.token !== "string" || !body.token) {
        throw createError("登录响应无效，请重试");
      }
      wx.setStorageSync(TOKEN_KEY, body.token);
      return body.token;
    });

  authPromise.then(
    () => {
      authPromise = null;
    },
    () => {
      authPromise = null;
    },
  );

  return authPromise;
}

function authedRequest(options) {
  return ensureAuth().then(() => requestCore(options));
}

function encode(value) {
  return encodeURIComponent(String(value));
}

function createProposal(content) {
  return authedRequest({
    path: "/v1/proposals",
    method: "POST",
    data: { content },
  });
}

function getShare(shareToken) {
  return authedRequest({
    path: "/v1/share/" + encode(shareToken),
  });
}

function respond(shareToken, revisionId, response) {
  return authedRequest({
    path: "/v1/share/" + encode(shareToken) + "/respond",
    method: "POST",
    data: { revisionId, response },
  });
}

function getResult(proposalId) {
  return authedRequest({
    path: "/v1/proposals/" + encode(proposalId) + "/result",
  });
}

function reviseProposal(proposalId, content) {
  return authedRequest({
    path: "/v1/proposals/" + encode(proposalId) + "/revisions",
    method: "POST",
    data: { content },
  });
}

function confirmProposal(proposalId) {
  return authedRequest({
    path: "/v1/proposals/" + encode(proposalId) + "/confirm",
    method: "POST",
    data: {},
  });
}

module.exports = {
  ensureAuth,
  createProposal,
  getShare,
  respond,
  getResult,
  reviseProposal,
  confirmProposal,
};
