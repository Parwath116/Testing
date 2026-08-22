// background.js — focus logic + badges + Gemini summaries via proxy API

const SUMMARY_API_URL = "https://YOUR_VERCEL_DOMAIN.vercel.app/api/summary";

const DEFAULTS = {
  focusMinutes: 1,
  shortBreak: 0.33,
  longBreak: 0.66,
  autoLoop: false,

  blocked: [],

  status: "idle",
  endsAt: 0,

  xp: 0,
  sessions: 0,
  streakDays: 0,
  lastFocusDate: null,
  badges: [],

  studySubject: "",
  studyTopic: "",
  summaryPending: false
};

const RULE_BASE = 7000;

function buildRule(id, domain) {
  return {
    id,
    priority: 1,
    action: { type: "redirect", redirect: { extensionPath: "/blocked.html" } },
    condition: { urlFilter: `||${domain}^`, resourceTypes: ["main_frame"] }
  };
}

async function getState() {
  const s = await chrome.storage.local.get(DEFAULTS);
  return Object.assign({}, DEFAULTS, s);
}

async function setState(patch) {
  await chrome.storage.local.set(patch);
  chrome.runtime.sendMessage({ type: "state", patch }).catch(() => {});
}

async function syncRules() {
  const s = await getState();
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const ours = existing
    .filter((r) => r.id >= RULE_BASE && r.id < RULE_BASE + 5000)
    .map((r) => r.id);

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: ours,
    addRules: []
  });

  if (s.status === "focus" && (s.blocked || []).length) {
    const toAdd = (s.blocked || []).map((d, i) => buildRule(RULE_BASE + i, d));
    await chrome.declarativeNetRequest.updateDynamicRules({ addRules: toAdd });
  }
}

function notify(title, message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "assets/logo.png", // ✔ FIXED PATH
    title,
    message
  });
}

// ---------- Badges ----------
async function awardBadge(name) {
  const s = await getState();
  const set = new Set(s.badges || []);
  if (!set.has(name)) {
    set.add(name);
    await setState({ badges: Array.from(set) });
    notify("New badge unlocked!", name);
  }
}

async function checkBadges() {
  const s = await getState();
  if ((s.sessions || 0) >= 1) await awardBadge("First Focus");
  if ((s.sessions || 0) >= 5) await awardBadge("5 Sessions");
  if ((s.streakDays || 0) >= 3) await awardBadge("3-Day Streak");
  if ((s.xp || 0) >= 300) await awardBadge("300 XP");
}

// ---------- End focus ----------
async function endFocus() {
  const s = await getState();
  const gained = s.focusMinutes;
  const sessions = (s.sessions || 0) + 1;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const last = s.lastFocusDate ? new Date(s.lastFocusDate) : null;
  let streak = s.streakDays || 0;

  if (!last) streak = 1;
  else {
    last.setHours(0, 0, 0, 0);
    const diff = today - last;
    if (diff === 86400000) streak += 1;
    else if (diff > 86400000) streak = 1;
  }

  const hasStudyMeta = !!(s.studySubject && s.studyTopic);

  await setState({
    xp: (s.xp || 0) + gained,
    sessions,
    streakDays: streak,
    lastFocusDate: today.getTime(),
    summaryPending: hasStudyMeta
  });

  await checkBadges();
}

// ---------- Gemini Summary via Proxy ----------
async function generateGeminiSummary(subject, topic) {
  const payload = { subject, topic };

  const res = await fetch(SUMMARY_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!res.ok) throw new Error("Proxy API error " + res.status);

  const data = await res.json();
  if (!data.ok || !data.summary) throw new Error(data.error || "Summary failed");

  return data.summary;
}

// ---------- Alarms ----------
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "tick") return;

  const s = await getState();

  if (s.status === "focus" || s.status === "break") {
    if (Date.now() >= s.endsAt) {
      if (s.status === "focus") {
        await endFocus();
        if (s.autoLoop) {
          await setState({
            status: "break",
            endsAt: Date.now() + s.shortBreak * 60000
          });
          notify("Focus finished", "Short break started.");
        } else {
          await setState({ status: "idle", endsAt: 0 });
          notify("Focus finished", "Great job!");
        }
        await syncRules();
      } else if (s.status === "break") {
        if (s.autoLoop) {
          await setState({
            status: "focus",
            endsAt: Date.now() + s.focusMinutes * 60000
          });
          notify("Break over", "Back to focus!");
          await syncRules();
        } else {
          await setState({ status: "idle", endsAt: 0 });
          await syncRules();
        }
      }
    }
    chrome.alarms.create("tick", { when: Date.now() + 1000 });
  }
});

// ---------- Messages ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const s = await getState();

    if (msg.type === "getState") return sendResponse(await getState());

    if (msg.type === "start") {
      await setState({
        status: "focus",
        endsAt: Date.now() + s.focusMinutes * 60000
      });
      chrome.alarms.create("tick", { when: Date.now() + 1000 });
      await syncRules();
      notify("Focus started", "Stay sharp!");
    }

    if (msg.type === "pause") {
      if (s.status === "focus" || s.status === "break") {
        await setState({
          status: "paused",
          endsAt: Math.max(0, s.endsAt - Date.now())
        });
        await syncRules();
      }
    }

    if (msg.type === "resume") {
      if (s.status === "paused") {
        await setState({
          status: "focus",
          endsAt: Date.now() + (s.endsAt || 0)
        });
        chrome.alarms.create("tick", { when: Date.now() + 1000 });
        await syncRules();
      }
    }

    if (msg.type === "reset") {
      await setState({ status: "idle", endsAt: 0, summaryPending: false });
      await syncRules();
    }

    if (msg.type === "updateSettings") {
      await setState(msg.patch || {});
      await syncRules();
    }

    if (msg.type === "addBlocked") {
      const domain = msg.domain.trim();
      if (domain.length) {
        const updated = new Set([...(s.blocked || []), domain]);
        await setState({ blocked: [...updated] });
        await syncRules();
      }
    }

    if (msg.type === "removeBlocked") {
      const updated = (s.blocked || []).filter((d) => d !== msg.domain);
      await setState({ blocked: updated });
      await syncRules();
    }

    if (msg.type === "setBlockedList") {
      await setState({ blocked: msg.blocked || [] });
      await syncRules();
    }

    if (msg.type === "generateSummary") {
      try {
        const text = await generateGeminiSummary(
          msg.subject || "",
          msg.topic || ""
        );
        sendResponse({ ok: true, summary: text });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
      return;
    }

    sendResponse(await getState());
  })();

  return true;
});

// Initial sync
(async () => {
  await syncRules();
})();
