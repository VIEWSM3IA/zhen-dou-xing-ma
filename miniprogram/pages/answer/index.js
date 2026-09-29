const api = require("../../lib/api");

const OPTIONS = [
  {
    value: "OK",
    label: "👍 都行",
    hint: "这个方案对我没问题",
  },
  {
    value: "DIFFICULT",
    label: "😅 有点难",
    hint: "会有些麻烦，但不是完全不行",
  },
  {
    value: "BLOCKED",
    label: "✋ 真的不行",
    hint: "我确实无法按这个方案执行",
  },
];

Page({
  data: {
    shareToken: "",
    requestedVersion: 0,
    proposalId: "",
    revisionId: "",
    content: "",
    version: 0,
    lifecycle: "",
    submitted: false,
    isUpdated: false,
    options: OPTIONS,
    selected: "",
    loading: true,
    submitting: false,
    error: "",
  },

  onLoad(options) {
    const shareToken = options && options.t ? String(options.t) : "";
    const requestedVersion = Number(options && options.v) || 0;

    if (!shareToken) {
      this.setData({
        loading: false,
        error: "分享链接不完整，请让发起人重新分享。",
      });
      return;
    }

    this.setData({
      shareToken,
      requestedVersion,
    });

    this.loadShare().catch(() => {});
  },

  onPullDownRefresh() {
    this.loadShare().then(
      () => wx.stopPullDownRefresh(),
      () => wx.stopPullDownRefresh(),
    );
  },

  loadShare() {
    if (!this.data.shareToken) {
      return Promise.reject(new Error("缺少分享令牌"));
    }

    this.setData({ loading: true, error: "" });

    return api
      .getShare(this.data.shareToken)
      .then((body) => {
        const version = Number(body.version) || 0;
        this.setData({
          proposalId: body.proposalId || "",
          revisionId: body.revisionId || "",
          content: body.content || "",
          version,
          lifecycle: body.lifecycle || "",
          submitted: Boolean(body.submitted),
          isUpdated: Boolean(
            this.data.requestedVersion &&
            version &&
            this.data.requestedVersion !== version,
          ),
          selected: "",
          loading: false,
          error: "",
        });
      })
      .catch((error) => {
        if (error && error.code === "EXPIRED") {
          this.setData({
            content: "",
            lifecycle: "EXPIRED",
            submitted: false,
            loading: false,
            error: "",
          });
          return null;
        }
        this.setData({
          loading: false,
          error:
            error && error.message ? error.message : "加载失败，请稍后重试",
        });
        throw error;
      });
  },

  choose(event) {
    if (
      this.data.lifecycle !== "OPEN" ||
      this.data.submitted ||
      this.data.submitting
    ) {
      return;
    }

    const selected = event.currentTarget.dataset.value;
    if (!OPTIONS.some((item) => item.value === selected)) {
      return;
    }

    this.setData({ selected, error: "" });
  },

  submit() {
    if (
      this.data.submitting ||
      this.data.lifecycle !== "OPEN" ||
      this.data.submitted ||
      !this.data.selected
    ) {
      return;
    }

    this.setData({ submitting: true, error: "" });

    api
      .respond(this.data.shareToken, this.data.revisionId, this.data.selected)
      .then(() => this.loadShare())
      .then(() => {
        this.setData({ submitting: false });
      })
      .catch((error) => {
        if (
          error &&
          ["ALREADY_SUBMITTED", "REVISION_MISMATCH", "NOT_OPEN"].includes(
            error.code,
          )
        ) {
          this.setData({ submitting: false });
          this.loadShare().catch(() => {});
          return;
        }
        this.setData({
          submitting: false,
          error:
            error && error.message ? error.message : "提交失败，请刷新后重试",
        });
      });
  },

  retry() {
    this.loadShare().catch(() => {});
  },

  goBack() {
    if (typeof wx.exitMiniProgram === "function") {
      wx.exitMiniProgram();
      return;
    }
    wx.navigateBack({ delta: 1 });
  },
});
