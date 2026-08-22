async function rpc(type, payload = {}) {
  try {
    return await chrome.runtime.sendMessage({ type, ...payload });
  } catch {
    return {};
  }
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function fmt(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${pad(m)}:${pad(sec)}`;
}

// Load JSON from extension assets
async function loadJSON(path) {
  const res = await fetch(chrome.runtime.getURL(path));
  if (!res.ok) return null;
  return await res.json();
}

// Simple hash → index
function hashToIndex(str, len) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) >>> 0;
  }
  return len ? h % len : 0;
}

async function setupQuoteAndRiddle() {
  const quoteEl = document.getElementById("quote");
  const riddleEl = document.getElementById("riddle");

  const quotesData = await loadJSON("assets/quotes.json");
  const puzzlesData = await loadJSON("assets/puzzles.json");

  const quotes = (quotesData && quotesData.quotes) || [];
  const riddles = (puzzlesData && puzzlesData.riddles) || [];

  // Random quote
  if (quotes.length) {
    const q = quotes[Math.floor(Math.random() * quotes.length)];
    quoteEl.textContent = q;
  } else {
    quoteEl.textContent = "Stay focused. Future you is watching.";
  }

  // Domain-based riddle
  let domain = "default";
  try {
    if (document.referrer) {
      const u = new URL(document.referrer);
      domain = u.hostname.replace(/^www\./, "");
    }
  } catch {
    // ignore
  }

  if (riddles.length) {
    const idx = hashToIndex(domain, riddles.length);
    const r = riddles[idx];
    riddleEl.textContent = r && r.q ? r.q : "Solve this later — first, study!";
  } else {
    riddleEl.textContent =
      "I speak without a mouth and hear without ears. What am I?";
  }
}

// Live countdown
async function renderTimer() {
  const s = await rpc("getState");
  let ms = 0;

  if (s.status === "focus" || s.status === "break") {
    ms = s.endsAt - Date.now();
  } else if (s.status === "paused") {
    ms = s.endsAt;
  }

  const t = fmt(ms);
  document.title = `Focus ends in ${t}`;

  let el = document.getElementById("countdown");
  if (!el) {
    el = document.createElement("div");
    el.id = "countdown";
    el.style = "font-size:42px;margin:10px 0;text-align:center;";
    const card = document.querySelector(".card");
    const quoteEl = document.getElementById("quote");
    card.insertBefore(el, quoteEl);
  }
  el.textContent = t;
}

(async () => {
  await setupQuoteAndRiddle();
  renderTimer();
  setInterval(renderTimer, 1000);
})();
