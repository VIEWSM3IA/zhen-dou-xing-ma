const api = require("../../lib/api");

function proposalStorageKey(id) {
  return "proposal:" + id;
}

const STATUS_COPY = {
  WAITING: {
    label: "等待中",
    title: "还需要更多人确认",
    copy: "为了避免小群体中通过结果猜到具体是谁，至少需要 4 人完成匿名确认。",
    tone: "waiting",
  },
  PASS: {
    label: "可以推进",
    title: "当前方案可以推进",
    copy: "目前没有需要你修改方案的行动信号。你可以把这一版确认为最终方案。",
    tone: "pass",
  },
  ADJUST: {
    label: "建议调整",
    title: "这版方案需要调整",
    copy: "存在执行困难。修订后会生成新版本，所有人需要按新版本重新确认。",
    tone: "adjust",
  },
  BLOCKED: {
    label: "存在阻塞",
    title: "先处理阻塞，再继续",
    copy: "当前方案存在无法执行的情况。建议直接修改方案，而不是继续等待。",
    tone: "blocked",
  },
  CONFIRMED: {
    label: "已确认",
    title: "这版已经成为最终方案",
    copy: "确认已完成，不再接受新的回答。",
    tone: "confirmed",
  },
  EXPIRED: {
    label: "已过期",
    title: "这个方案已经过期",
    copy: "已停止收集回答，也不再展示过期前的行动信号。",
    tone: "expired",
  },
};

Page({
  data: {
    proposalId: "",
    content: "",
    revisionId: "",
    version: 0,
    status: "",
    statusMeta: null,
    shareToken: "",
    loading: true,
    confirming: false,
    error: "",
  },

  onLoad(options) {
    const proposalId =
      (options && options.id ? String(options.id) : "") ||
      wx.getStorageSync("currentProposalId") ||
      "";

    if (!proposalId) {
      this.setData({
        loading: false,
        error: "还没有可查看的方案。",
      });
      return;
    }

    const cached = wx.getStorageSync(proposalStorageKey(proposalId)) || {};
    this.setData({
      proposalId,
      shareToken: cached.shareToken || "",
    });

    this.loadResult().catch(() => {});
  },

  onShow() {
    if (this.data.proposalId && !this.data.loading) {
      this.loadResult().catch(() => {});
    }
  },

  onPullDownRefresh() {
    this.loadResult().then(
      () => wx.stopPullDownRefresh(),
      () => wx.stopPullDownRefresh(),
    );
  },

  applyTerminalLifecycle(share) {
    if (
      !share ||
      (share.lifecycle !== "CONFIRMED" && share.lifecycle !== "EXPIRED")
    ) {
      return false;
    }

    const status = share.lifecycle;
    this.setData({
      content: status === "EXPIRED" ? "" : share.content || "",
      revisionId: share.revisionId || "",
      version: Number(share.version) || 0,
      status,
      statusMeta: STATUS_COPY[status],
      loading: false,
      error: "",
    });

    return true;
  },

  cacheProposal(body) {
    const cached =
      wx.getStorageSync(proposalStorageKey(this.data.proposalId)) || {};
    const updated = {
      id: this.data.proposalId,
      revisionId: body.revisionId || cached.revisionId || "",
      shareToken: cached.shareToken || this.data.shareToken || "",
      version: Number(body.version) || cached.version || 1,
      content: body.content || cached.content || "",
    };

    wx.setStorageSync(proposalStorageKey(this.data.proposalId), updated);
    this.setData({ shareToken: updated.shareToken });
  },

  loadResult() {
    if (!this.data.proposalId) {
      return Promise.reject(new Error("缺少方案 ID"));
    }

    this.setData({ loading: true, error: "" });

    const checkLifecycle = this.data.shareToken
      ? api.getShare(this.data.shareToken).catch(() => null)
      : Promise.resolve(null);

    return checkLifecycle
      .then((share) => {
        if (this.applyTerminalLifecycle(share)) {
          if (share) {
            this.cacheProposal(share);
          }
          return null;
        }

        return api.getResult(this.data.proposalId).then((body) => {
          const status =
            body.lifecycle === "CONFIRMED" ? "CONFIRMED" : body.status || "";
          this.cacheProposal(body);
          this.setData({
            content: body.content || "",
            revisionId: body.revisionId || "",
            version: Number(body.version) || 0,
            status,
            statusMeta: STATUS_COPY[status] || null,
            loading: false,
            error: "",
          });
          return null;
        });
      })
      .catch((error) => {
        if (error && error.code === "EXPIRED") {
          this.setData({
            content: "",
            revisionId: "",
            status: "EXPIRED",
            statusMeta: STATUS_COPY.EXPIRED,
            loading: false,
            error: "",
          });
          return null;
        }
        this.setData({
          loading: false,
          error:
            error && error.message ? error.message : "结果加载失败，请稍后重试",
        });
        throw error;
      });
  },

  confirm() {
    if (this.data.confirming || this.data.status !== "PASS") {
      return;
    }

    this.setData({ confirming: true, error: "" });

    api
      .confirmProposal(this.data.proposalId)
      .then((body) => {
        this.cacheProposal(body);
        this.setData({
          content: body.content || this.data.content,
          revisionId: body.revisionId || this.data.revisionId,
          version: Number(body.version) || this.data.version,
          status: "CONFIRMED",
          statusMeta: STATUS_COPY.CONFIRMED,
          confirming: false,
          error: "",
        });
      })
      .catch((error) => {
        this.setData({
          confirming: false,
          error:
            error && error.message ? error.message : "确认失败，请刷新后重试",
        });
      });
  },

  revise() {
    wx.navigateTo({
      url:
        "/pages/create/index?proposalId=" +
        encodeURIComponent(this.data.proposalId),
    });
  },

  retry() {
    this.loadResult().catch(() => {});
  },

  onShareAppMessage() {
    if (!this.data.shareToken) {
      return {
        title: "真都行吗？",
        path: "/pages/create/index",
      };
    }

    const compact = String(this.data.content || "")
      .trim()
      .replace(/\s+/g, " ");
    const text = compact.length > 28 ? compact.slice(0, 28) + "…" : compact;

    return {
      title: text
        ? (this.data.status === "CONFIRMED" ? "已确认：「" : "真都行吗？「") +
          text +
          "」"
        : "真都行吗？",
      path:
        "/pages/answer/index?t=" +
        encodeURIComponent(this.data.shareToken) +
        "&v=" +
        encodeURIComponent(this.data.version),
    };
  },
});
