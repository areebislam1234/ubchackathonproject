// Tiny API client. Signs requests with the session token; a 401 sends you back to the title.
// The token lives in sessionStorage: a refresh keeps you signed in, closing the tab or browser
// signs you out. Tokens from older builds (kept in localStorage) are cleared.
const store = (() => {
  try {
    localStorage.removeItem("stakeclash.token");
    return sessionStorage;
  } catch {
    return null;
  }
})();
export const saveToken = (t) => {
  try {
    t ? store?.setItem("stakeclash.token", t) : store?.removeItem("stakeclash.token");
  } catch {
    /* storage blocked: the session lasts until the page closes */
  }
};
let initial = null;
try {
  initial = store?.getItem("stakeclash.token") ?? null;
} catch {
  initial = null;
}
export const session = {
  token: initial,
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
    saveToken(null);
    session.onLogout();
  }
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}
