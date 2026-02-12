const Head = require("next/head");
const React = require("react");
const { useRouter } = require("next/router");
const { useEffect, useMemo, useState } = React;

async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
  }
  if (!res.ok) {
    throw new Error(data?.error || `Request failed (${res.status})`);
  }
  return data;
}

function AuthorityPage() {
  const router = useRouter();

  const [loadingSession, setLoadingSession] = useState(true);
  const [session, setSession] = useState(null);
  const [guilds, setGuilds] = useState([]);
  const [selectedGuildId, setSelectedGuildId] = useState("");
  const [loadingGuilds, setLoadingGuilds] = useState(false);
  const [loadingSigner, setLoadingSigner] = useState(false);
  const [currentSigner, setCurrentSigner] = useState(null);
  const [currentDaoId, setCurrentDaoId] = useState(null);

  const [authoritySecret, setAuthoritySecret] = useState("");
  const [payerSecret, setPayerSecret] = useState("");
  const [rpcUrl, setRpcUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);

  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const msgByCode = {
      oauth_denied: "Login was cancelled.",
      oauth_missing_code: "OAuth callback was missing required values.",
      oauth_state_invalid: "OAuth login state expired or was invalid.",
      oauth_callback_failed: "OAuth login failed. Try again.",
    };

    const code = router.query?.error;
    if (code && msgByCode[code]) {
      setError(msgByCode[code]);
    }
  }, [router.query]);

  useEffect(() => {
    let cancelled = false;

    async function loadSession() {
      try {
        setLoadingSession(true);
        const data = await fetchJson("/api/web/session");
        if (cancelled) return;
        setSession(data.authenticated ? data.user : null);
      } catch (e) {
        if (!cancelled) setError(e.message);
      } finally {
        if (!cancelled) setLoadingSession(false);
      }
    }

    loadSession();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadGuilds() {
      if (!session) {
        setGuilds([]);
        return;
      }

      try {
        setLoadingGuilds(true);
        const data = await fetchJson("/api/web/guilds");
        if (cancelled) return;
        const nextGuilds = data.guilds || [];
        setGuilds(nextGuilds);

        const queryGuildId = router.query?.guildId ? String(router.query.guildId) : "";
        const preferredGuildId =
          queryGuildId && nextGuilds.some((g) => String(g.id) === queryGuildId)
            ? queryGuildId
            : nextGuilds[0]?.id || "";

        setSelectedGuildId(preferredGuildId ? String(preferredGuildId) : "");
      } catch (e) {
        if (!cancelled) setError(e.message);
      } finally {
        if (!cancelled) setLoadingGuilds(false);
      }
    }

    loadGuilds();
    return () => {
      cancelled = true;
    };
  }, [session, router.query]);

  useEffect(() => {
    let cancelled = false;

    async function loadSigner() {
      if (!session || !selectedGuildId) {
        setCurrentSigner(null);
        setCurrentDaoId(null);
        return;
      }

      try {
        setLoadingSigner(true);
        const data = await fetchJson(
          `/api/web/signer?guildId=${encodeURIComponent(selectedGuildId)}`
        );
        if (cancelled) return;
        setCurrentSigner(data.signer || null);
        setCurrentDaoId(data.daoId || null);
      } catch (e) {
        if (!cancelled) setError(e.message);
      } finally {
        if (!cancelled) setLoadingSigner(false);
      }
    }

    loadSigner();
    return () => {
      cancelled = true;
    };
  }, [session, selectedGuildId]);

  const selectedGuild = useMemo(
    () => guilds.find((g) => String(g.id) === String(selectedGuildId)) || null,
    [guilds, selectedGuildId]
  );

  const loginUrl = useMemo(() => {
    const params = new URLSearchParams();
    if (selectedGuildId) params.set("guildId", String(selectedGuildId));
    const returnTo = `/authority${params.toString() ? `?${params.toString()}` : ""}`;

    return `/api/web/discord/login?returnTo=${encodeURIComponent(returnTo)}`;
  }, [selectedGuildId]);

  async function handleLogout() {
    try {
      await fetchJson("/api/web/logout", { method: "POST" });
      setSession(null);
      setGuilds([]);
      setSelectedGuildId("");
      setCurrentSigner(null);
      setStatus("Logged out.");
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }

  async function handleSave(e) {
    e.preventDefault();
    setStatus("");
    setError("");

    if (!selectedGuildId) {
      setError("Select a guild first.");
      return;
    }
    if (!authoritySecret.trim()) {
      setError("Authority secret is required.");
      return;
    }

    try {
      setSaving(true);
      const data = await fetchJson("/api/web/signer", {
        method: "POST",
        body: JSON.stringify({
          guildId: selectedGuildId,
          authoritySecret: authoritySecret.trim(),
          payerSecret: payerSecret.trim() || null,
          rpcUrl: rpcUrl.trim() || null,
        }),
      });

      setCurrentSigner(data.signer || null);
      setAuthoritySecret("");
      setPayerSecret("");
      setStatus("Signer saved successfully.");
    } catch (e2) {
      setError(e2.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleClear() {
    setStatus("");
    setError("");

    if (!selectedGuildId) {
      setError("Select a guild first.");
      return;
    }

    const ok = window.confirm(
      "Clear signer config for this guild? Awards will fall back to env-based signer settings."
    );
    if (!ok) return;

    try {
      setClearing(true);
      await fetchJson("/api/web/signer", {
        method: "DELETE",
        body: JSON.stringify({ guildId: selectedGuildId }),
      });
      setCurrentSigner(null);
      setStatus("Signer config cleared.");
    } catch (e) {
      setError(e.message);
    } finally {
      setClearing(false);
    }
  }

  return (
    <>
      <Head>
        <title>OG Reputation Spaces Authority Setup</title>
        <link rel="stylesheet" href="/authority.css" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <link rel="icon" type="image/png" href="/apple-touch-icon.png" />
      </Head>

      <main className="page">
        <section className="card">
          <div className="header">
            <div className="brand">
              <img
                className="brandLogo"
                src="/apple-touch-icon.png"
                alt="OG Reputation Spaces logo"
                width="56"
                height="56"
              />
              <div>
                <p className="kicker">OG Reputation Spaces Bot</p>
                <h1>Authority Setup Panel</h1>
                <p className="sub">
                  Configure per-guild Solana authority keys without posting secrets in Discord.
                </p>
              </div>
            </div>
            <div className="actions">
              {!loadingSession && !session ? (
                <a className="btn primary" href={loginUrl}>
                  Login With Discord
                </a>
              ) : null}
              {!loadingSession && session ? (
                <button className="btn" onClick={handleLogout} type="button">
                  Logout
                </button>
              ) : null}
            </div>
          </div>

          {loadingSession ? <p>Loading session…</p> : null}

          {!loadingSession && session ? (
            <p className="sessionLine">
              Signed in as{" "}
              <strong>{session.global_name || session.username || session.id}</strong>
            </p>
          ) : null}

          {!loadingSession && !session ? (
            <p className="note">
              Login first, then pick a server where you have <strong>Manage Server</strong> or{" "}
              <strong>Administrator</strong>.
            </p>
          ) : null}

          {session ? (
            <>
              <div className="row">
                <label htmlFor="guild">Server</label>
                <select
                  id="guild"
                  value={selectedGuildId}
                  onChange={(e) => setSelectedGuildId(e.target.value)}
                  disabled={loadingGuilds || !guilds.length}
                >
                  {!guilds.length ? <option value="">No manageable servers found</option> : null}
                  {guilds.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
              </div>

              {selectedGuild ? (
                <div className="meta">
                  <p>
                    <span>Guild ID:</span> <code>{selectedGuild.id}</code>
                  </p>
                  <p>
                    <span>DAO:</span>{" "}
                    {currentDaoId ? <code>{currentDaoId}</code> : <em>Not set yet (`/setspace`)</em>}
                  </p>
                </div>
              ) : null}

              <div className="current">
                <h2>Current Signer</h2>
                {loadingSigner ? <p>Loading signer config…</p> : null}
                {!loadingSigner && !currentSigner ? (
                  <p>No signer is configured in KV for this guild.</p>
                ) : null}
                {!loadingSigner && currentSigner ? (
                  <div className="meta">
                    <p>
                      <span>Authority:</span> <code>{currentSigner.authorityPublicKey || "unknown"}</code>
                    </p>
                    <p>
                      <span>Payer:</span> <code>{currentSigner.payerPublicKey || "unknown"}</code>
                    </p>
                    <p>
                      <span>RPC:</span>{" "}
                      {currentSigner.rpcUrl ? (
                        <code>{currentSigner.rpcUrl}</code>
                      ) : (
                        <em>Default (`SOLANA_RPC_URL`)</em>
                      )}
                    </p>
                    <p>
                      <span>Updated:</span> {currentSigner.updatedAt || "unknown"}
                    </p>
                  </div>
                ) : null}
              </div>

              <form className="form" onSubmit={handleSave}>
                <h2>Set / Rotate Signer</h2>
                <label htmlFor="authoritySecret">Authority Secret</label>
                <textarea
                  id="authoritySecret"
                  value={authoritySecret}
                  onChange={(e) => setAuthoritySecret(e.target.value)}
                  placeholder="base58 / base64 / [json secret array]"
                  rows={4}
                  autoComplete="off"
                />

                <label htmlFor="payerSecret">Payer Secret (optional)</label>
                <textarea
                  id="payerSecret"
                  value={payerSecret}
                  onChange={(e) => setPayerSecret(e.target.value)}
                  placeholder="Leave blank to use authority as payer"
                  rows={3}
                  autoComplete="off"
                />

                <label htmlFor="rpcUrl">RPC URL (optional)</label>
                <input
                  id="rpcUrl"
                  value={rpcUrl}
                  onChange={(e) => setRpcUrl(e.target.value)}
                  placeholder="https://..."
                  autoComplete="off"
                />

                <div className="actions">
                  <button className="btn primary" disabled={saving || !selectedGuildId} type="submit">
                    {saving ? "Saving…" : "Save Signer"}
                  </button>
                  <button
                    className="btn danger"
                    disabled={clearing || !selectedGuildId}
                    onClick={handleClear}
                    type="button"
                  >
                    {clearing ? "Clearing…" : "Clear Signer"}
                  </button>
                </div>
              </form>
            </>
          ) : null}

          {status ? <p className="ok">{status}</p> : null}
          {error ? <p className="err">{error}</p> : null}
        </section>
      </main>

    </>
  );
}

module.exports = AuthorityPage;
