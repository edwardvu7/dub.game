// Tuning panel: lists characters and lets you change their voices.

const SLIDERS = ["stability", "similarity_boost", "style", "speed"];
let voices = [];
const cards = new Map(); // character name -> card element

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status}`);
  return res.json();
}

function voiceName(id) {
  const v = voices.find((v) => v.voice_id === id);
  return v ? v.name : id;
}

function fillVoiceSelect(select, current) {
  select.innerHTML = "";
  const list = voices.length ? voices : [{ voice_id: current, name: current }];
  for (const v of list) {
    const opt = document.createElement("option");
    opt.value = v.voice_id;
    const labels = Object.values(v.labels || {}).join(", ");
    opt.textContent = labels ? `${v.name} (${labels})` : v.name;
    select.appendChild(opt);
  }
  select.value = current;
}

function createCard(name) {
  const card = document.getElementById("card").content.firstElementChild.cloneNode(true);
  card.querySelector(".name").textContent = name;
  const enc = encodeURIComponent(name);

  for (const key of SLIDERS) {
    const input = card.querySelector(`.${key}`);
    input.addEventListener("input", () => (input.nextElementSibling.value = input.value));
    input.addEventListener("change", () =>
      api("PUT", `/characters/${enc}`, { settings: { [key]: Number(input.value) } }));
  }
  card.querySelector(".voice").addEventListener("change", (e) =>
    api("PUT", `/characters/${enc}`, { voice_id: e.target.value }));
  card.querySelector(".mute").addEventListener("change", (e) =>
    api("PUT", `/characters/${enc}`, { muted: e.target.checked }));
  card.querySelector(".preview").addEventListener("click", () =>
    api("POST", `/characters/${enc}/preview`, {}));
  card.querySelector(".recast").addEventListener("click", () =>
    api("POST", `/characters/${enc}/recast`));
  return card;
}

function updateCard(card, char) {
  const busy = card.contains(document.activeElement); // don't fight the user's edits
  card.querySelector(".badge").textContent = char.locked
    ? "tuned"
    : char.profile ? "cast by AI" : "casting…";
  card.querySelector(".desc").textContent = char.profile?.description || "";
  if (busy) return;
  fillVoiceSelect(card.querySelector(".voice"), char.voice_id);
  for (const key of SLIDERS) {
    const input = card.querySelector(`.${key}`);
    input.value = char.settings[key];
    input.nextElementSibling.value = input.value;
  }
  card.querySelector(".mute").checked = !!char.muted;
}

async function refresh() {
  let data;
  try {
    data = await api("GET", "/characters");
  } catch {
    return; // no game yet
  }
  document.getElementById("game").textContent = data.game;
  const main = document.getElementById("characters");
  if (cards.size === 0) main.innerHTML = "";
  for (const [name, char] of Object.entries(data.characters)) {
    if (!cards.has(name)) {
      const card = createCard(name);
      cards.set(name, card);
      main.appendChild(card);
    }
    updateCard(cards.get(name), char);
  }
}

document.getElementById("enabled").addEventListener("change", (e) =>
  api("PUT", `/player?enabled=${e.target.checked}`));
document.getElementById("volume").addEventListener("change", (e) =>
  api("PUT", `/player?volume=${e.target.value}`));

(async () => {
  try {
    voices = await api("GET", "/voices");
  } catch (err) {
    console.warn("Voices unavailable:", err);
  }
  refresh();
  setInterval(refresh, 2000);
})();
