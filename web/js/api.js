// Tiny API client. Signs requests with the session token; a 401 sends you back to the title.
export const session = {
  token: localStorage.getItem("stakeclash.token"),
  onLogout: () => {},
};

export async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method: body ? "POST" : method,
    headers: { "content-type": "application/json", ...(session.token ? { authorization: `Bearer ${session.token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401 && session.token) {
    session.token = null;
    localStorage.removeItem("stakeclash.token");
    session.onLogout();
  }
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}
