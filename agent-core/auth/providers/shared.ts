export function bearerHeaders(token: string): Record<string, string> {
  return { "content-type": "application/json", authorization: `Bearer ${token}`, "user-agent": "termina-agent-core/1" };
}

export function openCodeHeaders(token: string): Record<string, string> {
  return { ...bearerHeaders(token), "x-api-key": token, "anthropic-version": "2023-06-01" };
}
