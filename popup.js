// popup.js — solo + group mode with Firebase + Gemini summarizer + stats + leaderboard

const DB_URL = "https://blockme-5c871-default-rtdb.firebaseio.com";

function pad(n) {
  return String(n).padStart(2, "0");
}

function fmt(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${pad(m)}:${pad(sec)}`;
}

async function rpc(type, payload = {}) {
  return await chrome.runtime.sendMessage({ type, ...payload });
}

// --- Firebase REST helpers ---
async function dbGet(path) {
  const res = await fetch(`${DB_URL}${path}.json`);
  if (!res.ok) return null;
  return await res.json();
}
async function dbPut(path, data) {
  await fetch(`${DB_URL}${path}.json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });
}
async function dbPatch(path, data) {
  await fetch(`${DB_URL}${path}.json`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });
}
async function dbPost(path, data) {
  await fetch(`${DB_URL}${path}.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });
}
async function dbDelete(path) {
  await fetch(`${DB_URL}${path}.json`, { method: "DELETE" });
}

// --- DOM refs ---
const timerEl = document.getElementById("timer");
const statusEl = document.getElementById("status");
const statusDotEl = document.getElementById("statusDot");
const modeLabelEl = document.getElementById("modeLabel");
const xpEl = document.getElementById("statXP");
const sessionsEl = document.getElementById("statSessions");
const streakEl = document.getElementById("statStreak");
const totalEl = document.getElementById("statTotal");

const focusInput = document.getElementById("focus");
const shortInput = document.getElementById("short");
const longInput = document.getElementById("long");
const autoLoopInput = document.getElementById("autoloop");
const domainInput = document.getElementById("domain");
const listEl = document.getElementById("list");
const badgesEl = document.getElementById("badges");

// Study DOM
const subjectInput = document.getElementById("subject");
const topicInput = document.getElementById("topic");

// Group DOM
const modeRadios = document.querySelectorAll('input[name="mode"]');
const groupModeLabel = document.getElementById("groupModeLabel");
const displayNameInput = document.getElementById("displayName");
const createRoomBtn = document.getElementById("createRoom");
const joinRoomBtn = document.getElementById("joinRoom");
const joinCodeInput = document.getElementById("joinCode");
const roomCodeLabel = document.getElementById("roomCodeLabel");
const roleLabel = document.getElementById("roleLabel");
const membersEl = document.getElementById("members");
const leaderboardEl = document.getElementById("leaderboard");
const chatBoxEl = document.getElementById("chatBox");
const chatInputEl = document.getElementById("chatInput");
const sendChatBtn = document.getElementById("sendChat");
const endRoomBtn = document.getElementById("endRoom");
const leaveRoomBtn = document.getElementById("leaveRoom");

// Summary DOM
const summaryOverlay = document.getElementById("summaryOverlay");
const summaryMetaEl = document.getElementById("summaryMeta");
const summaryBodyEl = document.getElementById("summaryBody");
const summaryStatusEl = document.getElementById("summaryStatus");
const summaryCopyBtn = document.getElementById("summaryCopy");
const summaryCloseBtn = document.getElementById("summaryClose");

// --- Emoji badges ---
const BADGE_EMOJIS = {
  "First Focus": "🌱",
  "5 Sessions": "💪",
  "3-Day Streak": "📅",
  "300 XP": "🔥"
};

// --- Summary / AI state ---
let summaryActive = false;

// --- Persistent meta (user + group) ---
let userId = null;
let groupMeta = {
  mode: "alone", // "alone" | "group"
  roomCode: "",
  isHost: false,
  displayName: ""
};

let pollInterval = null;

// Load userId + group meta
chrome.storage.local.get(
  {
    userId: null,
    groupMode: "alone",
    roomCode: "",
    isHost: false,
    displayName: ""
  },
  (res) => {
    if (!res.userId) {
      res.userId = "u_" + Math.random().toString(36).slice(2, 10);
      chrome.storage.local.set({ userId: res.userId });
    }
    userId = res.userId;
    groupMeta.mode = res.groupMode;
    groupMeta.roomCode = res.roomCode;
    groupMeta.isHost = res.isHost;
    groupMeta.displayName = res.displayName || "";
    if (groupMeta.displayName) {
      displayNameInput.value = groupMeta.displayName;
    }
    modeRadios.forEach((r) => {
      r.checked = r.value === groupMeta.mode;
    });
    updateGroupModeLabel();
    updateRoomLabels();
    startGroupPolling();
  }
);

// --- UI helpers ---
function updateGroupModeLabel() {
  groupModeLabel.textContent =
    groupMeta.mode === "group" ? "Mode: Group" : "Mode: Alone";
  modeLabelEl.textContent = groupMeta.mode === "group" ? "Group" : "Solo";
}

function updateRoomLabels() {
  roomCodeLabel.textContent = groupMeta.roomCode || "—";
  roleLabel.textContent =
    groupMeta.mode === "group"
      ? groupMeta.isHost
        ? "Host"
        : "Guest"
      : "—";
}

function formatTotalMinutes(xp) {
  const totalMin = xp || 0;
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (m === 0) return `${h} h`;
  return `${h} h ${m} min`;
}

// --- Gemini Summary via background RPC ---
async function showSummary(subject, topic) {
  summaryActive = true;
  summaryOverlay.classList.remove("hidden");

  const subj = (subject || "").trim() || "General";
  const top = (topic || "").trim() || "This topic";

  summaryMetaEl.textContent = `Subject: ${subj} · Topic: ${top}`;
  summaryBodyEl.textContent = "";
  summaryStatusEl.textContent = "Generating summary…";

  try {
    const res = await rpc("generateSummary", { subject: subj, topic: top });
    if (!res || !res.ok || !res.summary) {
      summaryStatusEl.textContent =
        (res && res.error
          ? `Couldn't generate summary: ${res.error}`
          : "Couldn't generate summary right now. Try again later.");
      return;
    }
    summaryBodyEl.textContent = res.summary;
    summaryStatusEl.textContent = "";
  } catch (err) {
    summaryStatusEl.textContent =
      "Couldn't generate summary due to a network/API error.";
  }
}

function closeSummary() {
  summaryOverlay.classList.add("hidden");
  summaryActive = false;
}

// --- Apply extension state to UI ---
async function applyState() {
  const s = await rpc("getState");

  const activeEl = document.activeElement;
  const typingTimerInputs =
    activeEl === focusInput ||
    activeEl === shortInput ||
    activeEl === longInput;

  if (!typingTimerInputs) {
    focusInput.value = s.focusMinutes;
    shortInput.value = s.shortBreak;
    longInput.value = s.longBreak;
    autoLoopInput.checked = !!s.autoLoop;
  }

  if (activeEl !== subjectInput && activeEl !== topicInput) {
    subjectInput.value = s.studySubject || "";
    topicInput.value = s.studyTopic || "";
  }

  statusEl.textContent = s.status;
  xpEl.textContent = s.xp || 0;
  sessionsEl.textContent = s.sessions || 0;
  streakEl.textContent = `${s.streakDays || 0} days`;
  totalEl.textContent = formatTotalMinutes(s.xp || 0);

  if (s.status === "focus") statusDotEl.style.background = "#22c55e";
  else if (s.status === "break") statusDotEl.style.background = "#eab308";
  else if (s.status === "paused") statusDotEl.style.background = "#f97316";
  else statusDotEl.style.background = "#94a3b8";

  let ms = 0;
  if (s.status === "focus" || s.status === "break") {
    ms = s.endsAt - Date.now();
  } else if (s.status === "paused") {
    ms = s.endsAt;
  } else {
    ms = s.focusMinutes * 60 * 1000;
  }
  timerEl.textContent = fmt(ms);

  listEl.innerHTML = "";
  (s.blocked || []).forEach((d) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="pill">${d}</span>
      <button class="secondary small" data-d="${d}">Remove</button>`;
    listEl.appendChild(li);
  });

  badgesEl.innerHTML = "";
  (s.badges || []).forEach((b) => {
    const span = document.createElement("span");
    span.className = "badge";
    const emoji = BADGE_EMOJIS[b] || "🏅";
    span.textContent = `${emoji} ${b}`;
    badgesEl.appendChild(span);
  });

  // Auto-trigger summary after a finished focus session
  if (
    s.summaryPending &&
    !summaryActive &&
    s.status === "idle" &&
    (s.studySubject || "").trim() &&
    (s.studyTopic || "").trim()
  ) {
    rpc("updateSettings", { patch: { summaryPending: false } });
    showSummary(s.studySubject, s.studyTopic);
  }
}

setInterval(applyState, 600);
applyState();

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "state") {
    applyState();
  }
});

// --- Timer controls ---
document.getElementById("start").onclick = async () => {
  const subject = subjectInput.value.trim();
  const topic = topicInput.value.trim();

  await rpc("updateSettings", {
    patch: {
      studySubject: subject,
      studyTopic: topic,
      summaryPending: false
    }
  });

  await rpc("start");
};

document.getElementById("pause").onclick = async () => {
  const s = await rpc("getState");
  if (s.status === "paused") await rpc("resume");
  else await rpc("pause");
};

document.getElementById("reset").onclick = () => rpc("reset");

// --- Timer settings change ---
function clampMinutes(v) {
  const num = parseFloat(v);
  if (isNaN(num)) return 1;
  return Math.min(180, Math.max(1, num));
}

function updateSettingsFromInputs() {
  const patch = {
    focusMinutes: clampMinutes(focusInput.value),
    shortBreak: clampMinutes(shortInput.value),
    longBreak: clampMinutes(longInput.value),
    autoLoop: !!autoLoopInput.checked
  };

  focusInput.value = patch.focusMinutes;
  shortInput.value = patch.shortBreak;
  longInput.value = patch.longBreak;

  rpc("updateSettings", { patch });
}

[focusInput, shortInput, longInput].forEach((el) => {
  el.addEventListener("change", updateSettingsFromInputs);
  el.addEventListener("blur", updateSettingsFromInputs);
});
autoLoopInput.addEventListener("change", updateSettingsFromInputs);

// --- Blocklist controls ---
document.getElementById("add").onclick = () => {
  const domain = domainInput.value.trim();
  if (!domain) return;
  rpc("addBlocked", { domain }).then(() => {
    domainInput.value = "";
    applyState();
  });
};
listEl.addEventListener("click", (e) => {
  if (e.target.tagName === "BUTTON") {
    const d = e.target.dataset.d;
    rpc("removeBlocked", { domain: d }).then(applyState);
  }
});

// --- Mode switch ---
modeRadios.forEach((r) => {
  r.addEventListener("change", () => {
    if (!r.checked) return;
    groupMeta.mode = r.value;
    chrome.storage.local.set({ groupMode: groupMeta.mode });
    updateGroupModeLabel();
    startGroupPolling();
  });
});

// --- Group create/join ---
async function ensureName() {
  const name = displayNameInput.value.trim();
  if (!name) {
    alert("Enter your name first (for group)");
    return null;
  }
  groupMeta.displayName = name;
  chrome.storage.local.set({ displayName: name });
  return name;
}

function randomRoomCode() {
  return String(Math.floor(10000 + Math.random() * 90000));
}

function forceGroupMode() {
  groupMeta.mode = "group";
  chrome.storage.local.set({ groupMode: "group" });
  modeRadios.forEach((r) => {
    r.checked = r.value === "group";
  });
  updateGroupModeLabel();
  startGroupPolling();
}

createRoomBtn.onclick = async () => {
  const currentMode = [...modeRadios].find((r) => r.checked)?.value;
  if (currentMode !== "group") {
    alert("Switch to GROUP mode to create a room.");
    return;
  }

  forceGroupMode();

  const name = await ensureName();
  if (!name) return;

  const code = randomRoomCode();
  const state = await rpc("getState");
  const room = {
    hostId: userId,
    createdAt: Date.now(),
    settings: {
      focusMinutes: state.focusMinutes,
      shortBreak: state.shortBreak,
      longBreak: state.longBreak,
      autoLoop: state.autoLoop
    },
    blocked: state.blocked || [],
    members: {
      [userId]: {
        name,
        status: state.status,
        lastSeen: Date.now(),
        xp: state.xp || 0,
        sessions: state.sessions || 0
      }
    },
    chat: null
  };
  await dbPut(`/rooms/${code}`, room);

  groupMeta.roomCode = code;
  groupMeta.isHost = true;
  chrome.storage.local.set({
    roomCode: code,
    isHost: true
  });
  updateRoomLabels();
  startGroupPolling();
};

joinRoomBtn.onclick = async () => {
  const currentMode = [...modeRadios].find((r) => r.checked)?.value;
  if (currentMode !== "group") {
    alert("Switch to GROUP mode to join a room.");
    return;
  }

  forceGroupMode();

  const name = await ensureName();
  if (!name) return;

  const code = joinCodeInput.value.trim();
  if (!code || code.length !== 5) {
    alert("Enter a valid 5-digit code.");
    return;
  }

  const room = await dbGet(`/rooms/${code}`);
  if (!room) {
    alert("Room not found.");
    return;
  }

  await dbPatch(`/rooms/${code}/members/${userId}`, {
    name,
    status: "idle",
    lastSeen: Date.now(),
    xp: 0,
    sessions: 0
  });

  if (room.settings) {
    await rpc("updateSettings", { patch: room.settings });
  }
  if (room.blocked) {
    await rpc("setBlockedList", { blocked: room.blocked });
  }

  groupMeta.roomCode = code;
  groupMeta.isHost = false;
  chrome.storage.local.set({
    roomCode: code,
    isHost: false
  });
  updateRoomLabels();
  startGroupPolling();
};

// --- Group polling ---
async function groupPollTick() {
  if (groupMeta.mode !== "group" || !groupMeta.roomCode) return;

  const code = groupMeta.roomCode;
  const [room, state] = await Promise.all([
    dbGet(`/rooms/${code}`),
    rpc("getState")
  ]);

  if (!room || room.roomClosed) {
    groupMeta.roomCode = "";
    groupMeta.isHost = false;

    chrome.storage.local.set({
      roomCode: "",
      isHost: false
    });

    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }

    membersEl.innerHTML = "";
    chatBoxEl.innerHTML = "";
    leaderboardEl.innerHTML = "";
    updateRoomLabels();
    updateGroupModeLabel();
    alert("Host ended the room.");
    return;
  }

  await dbPatch(`/rooms/${code}/members/${userId}`, {
    name: groupMeta.displayName || "Anon",
    status: state.status,
    lastSeen: Date.now(),
    xp: state.xp || 0,
    sessions: state.sessions || 0
  });

  if (groupMeta.isHost) {
    await dbPatch(`/rooms/${code}`, {
      settings: {
        focusMinutes: state.focusMinutes,
        shortBreak: state.shortBreak,
        longBreak: state.longBreak,
        autoLoop: state.autoLoop
      },
      blocked: state.blocked || []
    });
  } else {
    if (room.settings) {
      await rpc("updateSettings", { patch: room.settings });
    }
    if (room.blocked) {
      await rpc("setBlockedList", { blocked: room.blocked });
    }
  }

  membersEl.innerHTML = "";
  const members = room.members || {};
  Object.entries(members).forEach(([id, info]) => {
    const div = document.createElement("div");
    const isSelf = id === userId;
    const status = info.status || "idle";
    const dot = status === "focus" ? "🟢" : status === "break" ? "🟡" : "⚪";
    const xpText = info.xp ? ` · ${info.xp} XP` : "";
    div.textContent = `${dot} ${info.name || "Anon"}${
      isSelf ? " (you)" : ""
    } — ${status}${xpText}`;
    membersEl.appendChild(div);
  });

  leaderboardEl.innerHTML = "";
  const leaders = Object.entries(members)
    .map(([id, info]) => ({
      id,
      name: info.name || "Anon",
      xp: info.xp || 0
    }))
    .sort((a, b) => (b.xp || 0) - (a.xp || 0))
    .slice(0, 3);

  if (!leaders.length) {
    leaderboardEl.textContent = "Start a focus session to appear here.";
  } else {
    leaders.forEach((m, idx) => {
      const row = document.createElement("div");
      row.className = "leader-row";
      const rank = ["🥇", "🥈", "🥉"][idx] || `${idx + 1}.`;
      row.innerHTML = `<span class="leader-rank">${rank} ${m.name}</span><span>${m.xp} XP</span>`;
      leaderboardEl.appendChild(row);
    });
  }

  chatBoxEl.innerHTML = "";
  const chatObj = room.chat || {};
  const msgs = Object.values(chatObj).sort(
    (a, b) => (a.ts || 0) - (b.ts || 0)
  );
  msgs.forEach((m) => {
    const line = document.createElement("div");
    line.className = "chat-msg";
    const who = document.createElement("span");
    who.className = "chat-author";
    who.textContent = (m.name || "Anon") + ":";
    const msg = document.createElement("span");
    msg.textContent = " " + (m.text || "");
    line.appendChild(who);
    line.appendChild(msg);
    chatBoxEl.appendChild(line);
  });
  chatBoxEl.scrollTop = chatBoxEl.scrollHeight;
}

function startGroupPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  updateRoomLabels();
  updateGroupModeLabel();
  if (groupMeta.mode === "group" && groupMeta.roomCode) {
    pollInterval = setInterval(groupPollTick, 3000);
    groupPollTick();
  }
}

// --- Chat send ---
sendChatBtn.onclick = async () => {
  if (groupMeta.mode !== "group" || !groupMeta.roomCode) return;
  const text = chatInputEl.value.trim();
  if (!text) return;
  const name = displayNameInput.value.trim() || "Anon";
  chatInputEl.value = "";
  await dbPost(`/rooms/${groupMeta.roomCode}/chat`, {
    userId,
    name,
    text,
    ts: Date.now()
  });
  groupPollTick();
};

chatInputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    sendChatBtn.click();
  }
});

// --- End room (host) ---
endRoomBtn.onclick = async () => {
  if (groupMeta.mode !== "group" || !groupMeta.roomCode || !groupMeta.isHost) {
    alert("Only the host of a room can end it.");
    return;
  }
  const code = groupMeta.roomCode;

  await dbPatch(`/rooms/${code}`, { roomClosed: true });

  setTimeout(async () => {
    await dbDelete(`/rooms/${code}`);
  }, 150);

  groupMeta.roomCode = "";
  groupMeta.isHost = false;

  chrome.storage.local.set({
    roomCode: "",
    isHost: false
  });

  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }

  membersEl.innerHTML = "";
  chatBoxEl.innerHTML = "";
  leaderboardEl.innerHTML = "";
  updateRoomLabels();
  updateGroupModeLabel();
  alert("Room ended.");
};

// --- Leave room ---
leaveRoomBtn.onclick = async () => {
  const code = groupMeta.roomCode;
  if (!code) return;

  await dbDelete(`/rooms/${code}/members/${userId}`);

  groupMeta.roomCode = "";
  groupMeta.isHost = false;

  chrome.storage.local.set({
    roomCode: "",
    isHost: false
  });

  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }

  membersEl.innerHTML = "";
  chatBoxEl.innerHTML = "";
  leaderboardEl.innerHTML = "";
  updateRoomLabels();
  updateGroupModeLabel();
};

// --- Summary buttons ---
summaryCloseBtn.onclick = () => {
  closeSummary();
};
summaryCopyBtn.onclick = () => {
  const text = summaryBodyEl.textContent || "";
  if (!text.trim()) return;
  navigator.clipboard.writeText(text).then(
    () => {
      summaryStatusEl.textContent = "Summary copied to clipboard.";
      setTimeout(() => {
        summaryStatusEl.textContent = "";
      }, 1500);
    },
    () => {
      summaryStatusEl.textContent = "Could not copy summary.";
    }
  );
};
