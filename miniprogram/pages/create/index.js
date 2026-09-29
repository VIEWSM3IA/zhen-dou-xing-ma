const api = require("../../lib/api");

const MAX_LENGTH = 80;

function proposalStorageKey(id) {
  return "proposal:" + id;
}

function trimContent(value) {
  return String(value || "").trim();
}

function shareTitle(content) {
  const compact = trimContent(content).replace(/\s+/g, " ");
  const text = compact.length > 28 ? compact.slice(0, 28) + "…" : compact;
  return text ? "真都行吗？「" + text + "」" : "真都行吗？";
}

Page({
  data: {
    mode: "create",
    proposalId: "",
    revisionId: "",
    shareToken: "",
    version: 1,
    content: "",
    draft: "",
    charCount: 0,
    submitting: false,
    loading: false,
    created: false,
    error: "",
    missingLocalShareInfo: false,
  },

  onLoad(options) {
    const proposalId =
      options && options.proposalId ? String(options.proposalId) : "";
    if (!proposalId) {
      return;
    }

    const cached = wx.getStorageSync(proposalStorageKey(proposalId));
    if (!cached || !cached.shareToken) {
      this.setData({
        mode: "revise",
        proposalId,
        missingLocalShareInfo: true,
        error:
          "这台设备没有保存该方案的分享令牌，无法安全发布新版本。请从原发起设备继续修订。",
      });
      return;
    }

    const content = trimContent(cached.content);
    this.setData({
      mode: "revise",
      proposalId,
      revisionId: cached.revisionId || "",
      shareToken: cached.shareToken,
      version: Number(cached.version) || 1,
      content,
      draft: content,
      charCount: content.length,
    });
  },

  onInput(event) {
    const draft = event.detail.value || "";
    this.setData({
      draft,
      charCount: draft.length,
      error: "",
    });
  },

  submit() {
    if (this.data.submitting || this.data.missingLocalShareInfo) {
      return;
    }

    const content = trimContent(this.data.draft);
    if (!content) {
      this.setData({ error: "先写下一个具体方案。" });
      return;
    }

    if (content.length > MAX_LENGTH) {
      this.setData({ error: "方案最多 80 个字。" });
      return;
    }

    this.setData({ submitting: true, error: "" });

    const operation =
      this.data.mode === "revise"
        ? api.reviseProposal(this.data.proposalId, content)
        : api.createProposal(content);

    operation
      .then((body) => {
        const proposalId = body.id || this.data.proposalId;
        const shareToken = body.shareToken || this.data.shareToken;

        if (!proposalId || !body.revisionId || !shareToken) {
          throw new Error("服务端响应缺少必要字段");
        }

        const version =
          Number(body.version) ||
          (this.data.mode === "revise" ? this.data.version + 1 : 1);
        const record = {
          id: proposalId,
          revisionId: body.revisionId,
          shareToken,
          version,
          content: body.content || content,
        };

        wx.setStorageSync(proposalStorageKey(proposalId), record);
        wx.setStorageSync("currentProposalId", proposalId);

        this.setData({
          proposalId,
          revisionId: record.revisionId,
          shareToken,
          version,
          content: record.content,
          draft: record.content,
          charCount: record.content.length,
          created: true,
          submitting: false,
          error: "",
        });
      })
      .catch((error) => {
        this.setData({
          submitting: false,
          error:
            error && error.message ? error.message : "提交失败，请稍后重试",
        });
      });
  },

  editAgain() {
    this.setData({
      created: false,
      mode: "revise",
      error: "",
    });
  },

  goResult() {
    if (!this.data.proposalId) {
      return;
    }
    wx.navigateTo({
      url: "/pages/result/index?id=" + encodeURIComponent(this.data.proposalId),
    });
  },

  onShareAppMessage() {
    if (!this.data.shareToken) {
      return {
        title: "真都行吗？",
        path: "/pages/create/index",
      };
    }

    return {
      title: shareTitle(this.data.content),
      path:
        "/pages/answer/index?t=" +
        encodeURIComponent(this.data.shareToken) +
        "&v=" +
        encodeURIComponent(this.data.version),
    };
  },
});
