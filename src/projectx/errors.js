export const LOGIN_ERROR_CODES = {
  0: "Success",
  1: "ApiKeyAuthenticationDisabled",
  2: "ApiSubscriptionNotFound",
  3: "InvalidCredentials",
  4: "UserNotFound",
};

export function describeProjectXError(body, fallback = "ProjectX request failed") {
  if (!body || typeof body !== "object") {
    return fallback;
  }
  const code = body.errorCode;
  const label = LOGIN_ERROR_CODES[code];
  if (label) {
    if (code === 3) {
      return "Invalid ProjectX credentials (errorCode 3). Try your TopstepX login email as userName, confirm the API key is active, and regenerate it if needed.";
    }
    if (code === 2) {
      return "ProjectX API subscription not found (errorCode 2). Activate API access in the TopstepX / ProjectX dashboard.";
    }
    return `ProjectX error ${code}: ${label}`;
  }
  return body.errorMessage || fallback;
}
