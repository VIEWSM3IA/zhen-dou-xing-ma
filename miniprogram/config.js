const DEV_BASE_URL = "http://127.0.0.1:3000";
const RELEASE_BASE_URL = "https://api.example.com";

function getEnvVersion() {
  try {
    const info = wx.getAccountInfoSync();
    return info && info.miniProgram && info.miniProgram.envVersion
      ? info.miniProgram.envVersion
      : "develop";
  } catch (error) {
    return "develop";
  }
}

function getBaseURL() {
  return getEnvVersion() === "release" ? RELEASE_BASE_URL : DEV_BASE_URL;
}

module.exports = {
  DEV_BASE_URL,
  RELEASE_BASE_URL,
  getBaseURL,
};
