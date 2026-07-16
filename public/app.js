/* Dashboard client: poll /api/summary and render "time since" cards. */

const REFRESH_MS = 60_000;
let currentCid = null;

const el = (field) => document.querySelector(`[data-field="${field}"]`);
const errorEl = document.getElementById("error");

/** Human "time ago" from epoch seconds. */
function ago(startSeconds) {
  if (!startSeconds) return "—";
  const diff = Math.max(0, Date.now() / 1000 - startSeconds);
  const m = Math.floor(diff / 60);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h < 24) return rem ? `${h}h ${rem}m ago` : `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h ago`;
}

/** Format a clock time from epoch seconds. */
function clock(startSeconds) {
  if (!startSeconds) return "";
  return new Date(startSeconds * 1000).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function durationText(seconds) {
  if (!seconds) return "";
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function render(summary) {
  document.getElementById("child-name").textContent =
    summary.child?.name || "Baby";

  // Feed
  if (summary.feedInProgress) {
    el("feed-ago").textContent = "Feeding now";
    el("feed-detail").textContent = "in progress";
  } else if (summary.lastFeed) {
    el("feed-ago").textContent = ago(summary.lastFeed.start);
    const bits = [`at ${clock(summary.lastFeed.start)}`, summary.lastFeed.kind];
    if (summary.lastFeed.detail) bits.push(`· ${summary.lastFeed.detail}`);
    el("feed-detail").textContent = bits.join(" ");
  } else {
    el("feed-ago").textContent = "—";
    el("feed-detail").textContent = "no feeds recorded";
  }

  // Sleep
  if (summary.sleepInProgress) {
    el("sleep-ago").textContent = "Sleeping now";
    el("sleep-detail").textContent = "in progress";
  } else if (summary.lastSleep) {
    el("sleep-ago").textContent = ago(summary.lastSleep.start);
    const dur = durationText(summary.lastSleep.duration);
    el("sleep-detail").textContent =
      `at ${clock(summary.lastSleep.start)}` + (dur ? ` · slept ${dur}` : "");
  } else {
    el("sleep-ago").textContent = "—";
    el("sleep-detail").textContent = "no naps recorded";
  }

  // Diaper
  if (summary.lastDiaper) {
    el("diaper-ago").textContent = ago(summary.lastDiaper.start);
    el("diaper-detail").textContent =
      `at ${clock(summary.lastDiaper.start)}` +
      (summary.lastDiaper.mode ? ` · ${summary.lastDiaper.mode}` : "");
  } else {
    el("diaper-ago").textContent = "—";
    el("diaper-detail").textContent = "no changes recorded";
  }

  // Pump
  if (summary.lastPump) {
    el("pump-ago").textContent = ago(summary.lastPump.start);
    const dur = durationText(summary.lastPump.duration);
    el("pump-detail").textContent =
      `at ${clock(summary.lastPump.start)}` + (dur ? ` · ${dur}` : "");
  } else {
    el("pump-ago").textContent = "—";
    el("pump-detail").textContent = "no sessions recorded";
  }

  document.getElementById("updated").textContent =
    "updated " + new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

async function loadSummary() {
  try {
    const url = currentCid
      ? `/api/summary?cid=${encodeURIComponent(currentCid)}`
      : "/api/summary";
    const res = await fetch(url);
    if (res.status === 401) {
      window.location.href = "/login";
      return;
    }
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "Failed to load");
    errorEl.hidden = true;
    render(json);
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  }
}

async function loadChildren() {
  try {
    const res = await fetch("/api/children");
    if (!res.ok) return;
    const { children, defaultCid } = await res.json();
    currentCid = defaultCid || (children[0] && children[0].cid) || null;
    const select = document.getElementById("child-select");
    if (children.length > 1) {
      select.innerHTML = "";
      for (const ch of children) {
        const opt = document.createElement("option");
        opt.value = ch.cid;
        opt.textContent = ch.name || ch.cid;
        if (ch.cid === currentCid) opt.selected = true;
        select.appendChild(opt);
      }
      select.hidden = false;
      select.addEventListener("change", () => {
        currentCid = select.value;
        loadSummary();
        loadFoods();
      });
    }
  } catch {
    /* non-fatal */
  }
}

document.getElementById("logout").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  window.location.href = "/login";
});

// --- quick log (all events) ---
const qlStatus = document.getElementById("ql-status");
const qlPlan = document.getElementById("ql-plan");
const dryRunEl = document.getElementById("dry-run");

/** Flash a status message under the quick-log panel. */
function showStatus(message, ok) {
  if (!qlStatus) return;
  qlStatus.textContent = message;
  qlStatus.className = "small " + (ok ? "ok" : "bad");
  qlStatus.hidden = false;
}

/** Show or hide the dry-run plan preview. */
function showPlan(plan) {
  if (!qlPlan) return;
  if (!plan) {
    qlPlan.hidden = true;
    return;
  }
  qlPlan.textContent = JSON.stringify(plan, null, 2);
  qlPlan.hidden = false;
}

/** A finite number from a form value, or undefined. */
function numField(v) {
  if (v === "" || v === null || v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** {start,end} epoch-seconds range of the given length ending now. */
function rangeFromMinutes(min) {
  const end = Math.floor(Date.now() / 1000);
  return { start: end - Math.round(min * 60), end };
}

/**
 * POST a log action of `type` with `payload`. Honors the dry-run toggle: on a
 * dry run it shows the returned plan and skips the summary refresh; otherwise it
 * commits, clears any plan, and refreshes the dashboard.
 */
async function postLog(type, payload, successText) {
  const dry = !!(dryRunEl && dryRunEl.checked);
  const body = { ...payload, dryRun: dry };
  if (currentCid) body.cid = currentCid;
  const res = await fetch(`/api/log/${type}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    window.location.href = "/login";
    return;
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || "Failed to log");
  if (json.dryRun) {
    showStatus(`Dry run — nothing written. ${json.plan?.description ?? ""}`.trim(), true);
    showPlan(json.plan ?? null);
  } else {
    showStatus(successText, true);
    showPlan(null);
    loadSummary();
  }
}

/** Run a log action with button disabling + error reporting. */
async function withButton(btn, fn) {
  if (btn) btn.disabled = true;
  try {
    await fn();
  } catch (err) {
    showStatus(err.message, false);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Diaper + potty one-tap buttons.
for (const btn of document.querySelectorAll("[data-log-diaper]")) {
  btn.addEventListener("click", () => {
    const mode = btn.getAttribute("data-log-diaper");
    withButton(btn, () => postLog("diaper", { mode }, `Logged ${mode} diaper.`));
  });
}
for (const btn of document.querySelectorAll("[data-log-potty]")) {
  btn.addEventListener("click", () => {
    const howItHappened = btn.getAttribute("data-log-potty");
    withButton(btn, () =>
      postLog("potty", { mode: "pee", howItHappened }, "Logged potty event."),
    );
  });
}

/** Build the payload + success text for a given form type, or throw on bad input. */
function buildFormPayload(type, f) {
  switch (type) {
    case "bottle": {
      const amount = numField(f.amount.value);
      if (!amount || amount <= 0) throw new Error("Enter a bottle amount greater than 0.");
      return [
        { amount, units: f.units.value, bottleType: f.bottleType.value },
        `Logged ${amount} ${f.units.value} bottle.`,
      ];
    }
    case "nursing": {
      const min = numField(f.durationMin.value);
      if (!min || min <= 0) throw new Error("Enter nursing minutes greater than 0.");
      return [
        { ...rangeFromMinutes(min), side: f.side.value },
        `Logged ${min} min nursing (${f.side.value}).`,
      ];
    }
    case "sleep": {
      const min = numField(f.durationMin.value);
      if (!min || min <= 0) throw new Error("Enter sleep minutes greater than 0.");
      return [rangeFromMinutes(min), `Logged ${min} min of sleep.`];
    }
    case "pump": {
      const totalAmount = numField(f.totalAmount.value);
      if (!totalAmount || totalAmount <= 0) throw new Error("Enter a pump amount greater than 0.");
      return [
        { totalAmount, units: f.units.value },
        `Logged ${totalAmount} ${f.units.value} pump.`,
      ];
    }
    case "growth": {
      const weight = numField(f.weight.value);
      const height = numField(f.height.value);
      const head = numField(f.head.value);
      if (weight === undefined && height === undefined && head === undefined) {
        throw new Error("Enter at least one of weight, height, or head.");
      }
      return [
        { weight, height, head, units: f.units.value },
        "Logged growth measurement.",
      ];
    }
    case "activity": {
      const mode = f.mode.value;
      const min = numField(f.durationMin.value);
      const payload = { mode };
      if (min) payload.duration = Math.round(min * 60);
      return [payload, `Logged activity (${mode}).`];
    }
    case "solids": {
      if (!f.food.value) throw new Error("Pick a food to log.");
      const food = JSON.parse(f.food.value);
      const payload = { foods: [food] };
      if (f.reaction.value) payload.reaction = f.reaction.value;
      return [payload, `Logged solids (${food.name}).`];
    }
    default:
      throw new Error("Unknown log type.");
  }
}

for (const form of document.querySelectorAll("[data-log-form]")) {
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const type = form.getAttribute("data-log-form");
    const submit = form.querySelector("button[type=submit]");
    withButton(submit, async () => {
      const [payload, successText] = buildFormPayload(type, form.elements);
      await postLog(type, payload, successText);
      const num = form.querySelector("input[type=number]");
      if (num && type !== "growth") num.value = "";
    });
  });
}

/** Load the solids food catalog into the picker. */
async function loadFoods() {
  const select = document.getElementById("food-select");
  if (!select) return;
  try {
    const url = currentCid
      ? `/api/foods?cid=${encodeURIComponent(currentCid)}`
      : "/api/foods";
    const res = await fetch(url);
    if (!res.ok) return;
    const { foods } = await res.json();
    select.innerHTML = '<option value="">Select a food…</option>';
    for (const food of foods) {
      const opt = document.createElement("option");
      opt.value = JSON.stringify({ id: food.id, name: food.name, source: food.source });
      opt.textContent = food.source === "custom" ? `${food.name} (custom)` : food.name;
      select.appendChild(opt);
    }
  } catch {
    select.innerHTML = '<option value="">Could not load foods</option>';
  }
}

// --- access code panel ---
async function refreshTokenList() {
  const listEl = document.getElementById("token-list");
  if (!listEl) return;
  try {
    const res = await fetch("/api/tokens");
    if (!res.ok) return;
    const { tokens } = await res.json();
    if (!tokens.length) {
      listEl.textContent = "No active access codes.";
      return;
    }
    listEl.innerHTML = "<strong>Active access codes:</strong>";
    for (const t of tokens) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;gap:8px;align-items:center;margin-top:4px;";
      const created = t.createdAt
        ? new Date(t.createdAt).toLocaleDateString()
        : "";
      row.innerHTML = `<span>${t.masked}${created ? " · " + created : ""}</span>`;
      const btn = document.createElement("button");
      btn.className = "link";
      btn.textContent = "Revoke";
      btn.addEventListener("click", async () => {
        if (!confirm("Revoke this access code? Any app or client using it will immediately lose access.")) return;
        await fetch(`/api/tokens/${t.id}`, { method: "DELETE" });
        refreshTokenList();
      });
      row.appendChild(btn);
      listEl.appendChild(row);
    }
  } catch {
    /* non-fatal */
  }
}

const genBtn = document.getElementById("gen-token");
if (genBtn) {
  genBtn.addEventListener("click", async () => {
    genBtn.disabled = true;
    genBtn.textContent = "Generating…";
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const res = await fetch("/api/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tz }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed");
      const url = new URL(json.pollUrl);
      document.getElementById("tok-base").value = url.origin;
      document.getElementById("tok-value").value = json.token;
      document.getElementById("tok-cid").value = url.searchParams.get("cid") || "";
      document.getElementById("token-out").hidden = false;
      refreshTokenList();
    } catch (err) {
      alert("Could not generate token: " + err.message);
    } finally {
      genBtn.disabled = false;
      genBtn.textContent = "Generate another code";
    }
  });
}
refreshTokenList();

// --- Quick-log tabs (remembers the last open tab per group via localStorage) ---
function initTabs() {
  for (const tablist of document.querySelectorAll(".ql-tablist[data-tabs]")) {
    const group = tablist.getAttribute("data-tabs");
    const card = tablist.closest(".ql-cat");
    if (!card) continue;
    const tabs = [...tablist.querySelectorAll(".ql-tab")];
    const panels = [...card.querySelectorAll(".ql-tabpanel")];
    const storageKey = `ql-tab-${group}`;
    const activate = (name) => {
      const target = tabs.some((t) => t.dataset.tab === name)
        ? name
        : tabs[0]?.dataset.tab;
      for (const t of tabs) {
        const on = t.dataset.tab === target;
        t.classList.toggle("active", on);
        t.setAttribute("aria-selected", on ? "true" : "false");
      }
      for (const p of panels) {
        p.classList.toggle("active", p.dataset.panel === target);
      }
      try {
        localStorage.setItem(storageKey, target);
      } catch {
        /* storage unavailable — non-fatal */
      }
    };
    for (const t of tabs) {
      t.addEventListener("click", () => activate(t.dataset.tab));
    }
    let saved = null;
    try {
      saved = localStorage.getItem(storageKey);
    } catch {
      /* storage unavailable — non-fatal */
    }
    activate(saved || tabs[0]?.dataset.tab);
  }
}
initTabs();

// Refresh on load, on an interval, and when the display wakes / regains focus.
(async () => {
  await loadChildren();
  await loadSummary();
  loadFoods();
  setInterval(loadSummary, REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) loadSummary();
  });
})();
