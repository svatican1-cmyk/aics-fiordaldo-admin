const SUPABASE_URL = "INCOLLA_QUI_PROJECT_URL";
const SUPABASE_ANON_KEY = "INCOLLA_QUI_ANON_KEY";

const client = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
let html5QrCode = null;
let currentUser = null;
let activitiesCache = [];

const $ = (id) => document.getElementById(id);

function show(el) { el.classList.remove("hidden"); }
function hide(el) { el.classList.add("hidden"); }
function money(value) { return `${Number(value || 0).toFixed(2).replace(".00", "")}€`; }
function escapeHtml(str = "") {
  return String(str).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}
function setMessage(el, type, text) {
  el.className = `message ${type === "ok" ? "ok" : "bad"}`;
  el.textContent = text;
  show(el);
}
function clearMessage(el) { el.textContent = ""; hide(el); }

async function requireAdmin() {
  const { data: { user } } = await client.auth.getUser();
  if (!user) return false;
  currentUser = user;
  const { data, error } = await client.from("profiles").select("role").eq("id", user.id).single();
  if (error || !data || !["admin", "staff"].includes(data.role)) {
    await client.auth.signOut();
    return false;
  }
  return true;
}

async function init() {
  const ok = await requireAdmin();
  if (ok) await enterAdmin();
  bindEvents();
}

function bindEvents() {
  $("loginBtn").addEventListener("click", login);
  $("logoutBtn").addEventListener("click", logout);
  $("startScannerBtn").addEventListener("click", startScanner);
  $("stopScannerBtn").addEventListener("click", stopScanner);
  $("verifyManualBtn").addEventListener("click", () => verifyInput($("manualCode").value));
  $("saveActivityBtn").addEventListener("click", saveActivity);
  $("resetActivityBtn").addEventListener("click", resetActivityForm);
  $("refreshActivitiesBtn").addEventListener("click", loadActivities);
  $("saveDateBtn").addEventListener("click", saveDate);
  $("refreshBookingsBtn").addEventListener("click", loadBookings);

  document.querySelectorAll(".tab").forEach(btn => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });
}

async function login() {
  clearMessage($("loginMessage"));
  const email = $("loginEmail").value.trim().toLowerCase();
  const password = $("loginPassword").value.trim();
  if (!email || !password) return setMessage($("loginMessage"), "bad", "Inserisci email e password.");
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) return setMessage($("loginMessage"), "bad", "Accesso non riuscito: " + error.message);
  const ok = await requireAdmin();
  if (!ok) return setMessage($("loginMessage"), "bad", "Questo account non è admin/staff.");
  await enterAdmin();
}

async function logout() {
  await stopScanner();
  await client.auth.signOut();
  currentUser = null;
  hide($("adminView")); show($("loginView")); hide($("logoutBtn"));
}

async function enterAdmin() {
  hide($("loginView")); show($("adminView")); show($("logoutBtn"));
  await loadActivities();
  await loadBookings();
}

function switchTab(tab) {
  document.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  ["scanner", "activities", "bookings"].forEach(name => {
    const el = $(`${name}Tab`);
    name === tab ? show(el) : hide(el);
  });
}

function parseTicketInput(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  try {
    const json = JSON.parse(text);
    return json.code || json.ticket_code || json.ticketCode || null;
  } catch {
    return text;
  }
}

async function verifyInput(raw) {
  const code = parseTicketInput(raw);
  if (!code) return renderTicketError("Inserisci un codice valido.");
  await verifyTicket(code);
}

async function verifyTicket(code) {
  const { data: ticket, error } = await client
    .from("tickets")
    .select("id, ticket_code, status, checked_in, checked_in_at, booking_id, bookings(*)")
    .eq("ticket_code", code)
    .single();

  if (error || !ticket) return renderTicketError("Biglietto non trovato.");
  renderTicket(ticket);
}

function renderTicketError(text) {
  const box = $("ticketResult");
  box.className = "result bad";
  box.innerHTML = `<strong>${escapeHtml(text)}</strong>`;
  show(box);
}

function renderTicket(ticket) {
  const b = ticket.bookings || {};
  const box = $("ticketResult");
  const used = !!ticket.checked_in;
  box.className = `result ${used ? "bad" : "ok"}`;
  box.innerHTML = `
    <h3>${used ? "Biglietto già utilizzato" : "Biglietto valido"}</h3>
    <p><strong>Codice:</strong> ${escapeHtml(ticket.ticket_code)}</p>
    <p><strong>Attività:</strong> ${escapeHtml(b.activity_title || "-")}</p>
    <p><strong>Data:</strong> ${escapeHtml(b.activity_date || "-")}</p>
    <p><strong>Prenotante:</strong> ${escapeHtml(b.participant_name || "-")}</p>
    <p><strong>Email:</strong> ${escapeHtml(b.participant_email || "-")}</p>
    <p><strong>Telefono:</strong> ${escapeHtml(b.participant_phone || "-")}</p>
    <p><strong>Posti:</strong> ${escapeHtml(b.participants || "-")}</p>
    ${used ? `<p><strong>Riscattato il:</strong> ${new Date(ticket.checked_in_at).toLocaleString("it-IT")}</p>` : ""}
    <div class="row">
      <button class="primary" ${used ? "disabled" : ""} onclick="checkInTicket('${ticket.id}')">Convalida ingresso</button>
    </div>
  `;
  show(box);
}

window.checkInTicket = async function(ticketId) {
  const { error } = await client
    .from("tickets")
    .update({ checked_in: true, checked_in_at: new Date().toISOString(), checked_in_by: currentUser?.id || null })
    .eq("id", ticketId)
    .eq("checked_in", false);
  if (error) return renderTicketError("Errore durante la convalida: " + error.message);
  $("ticketResult").className = "result ok";
  $("ticketResult").innerHTML = `<h3>Ingresso convalidato</h3><p>Biglietto riscattato correttamente.</p>`;
};

async function startScanner() {
  if (html5QrCode) return;
  html5QrCode = new Html5Qrcode("reader");
  try {
    await html5QrCode.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: { width: 250, height: 250 } },
      async decodedText => {
        await stopScanner();
        $("manualCode").value = decodedText;
        await verifyInput(decodedText);
      }
    );
  } catch (e) {
    html5QrCode = null;
    renderTicketError("Scanner non disponibile. Usa inserimento manuale o autorizza la camera.");
  }
}

async function stopScanner() {
  if (!html5QrCode) return;
  try { await html5QrCode.stop(); } catch {}
  try { await html5QrCode.clear(); } catch {}
  html5QrCode = null;
}

async function uploadActivityImage(activityId, file) {
  if (!file) return null;
  const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
  const path = `${activityId}/${Date.now()}.${ext}`;
  const { error: uploadError } = await client.storage.from("activities").upload(path, file, { upsert: true });
  if (uploadError) throw uploadError;
  const { data } = client.storage.from("activities").getPublicUrl(path);
  return data.publicUrl;
}

async function saveActivity() {
  const msg = $("activityMessage"); clearMessage(msg);
  const id = $("activityId").value;
  const payload = {
    title: $("activityTitle").value.trim(),
    category: $("activityCategory").value,
    short_description: $("activityShortDescription").value.trim(),
    description: $("activityDescription").value.trim(),
    location_name: $("activityLocation").value.trim(),
    address: $("activityAddress").value.trim(),
    price_from: Number($("activityPrice").value || 0),
    sort_order: Number($("activitySort").value || 0),
    is_active: $("activityActive").value === "true",
    booking_enabled: true,
    share_enabled: true,
  };
  if (!payload.title || !payload.category) return setMessage(msg, "bad", "Titolo e categoria sono obbligatori.");
  try {
    let activity;
    if (id) {
      const { data, error } = await client.from("activities").update(payload).eq("id", id).select().single();
      if (error) throw error;
      activity = data;
    } else {
      const { data, error } = await client.from("activities").insert(payload).select().single();
      if (error) throw error;
      activity = data;
    }

    const file = $("activityImageFile").files[0];
    if (file) {
      const url = await uploadActivityImage(activity.id, file);
      await client.from("activity_images").insert({ activity_id: activity.id, image_url: url, sort_order: 0 });
      await client.from("activities").update({ cover_image: url }).eq("id", activity.id);
    }
    setMessage(msg, "ok", "Attività salvata.");
    resetActivityForm(false);
    await loadActivities();
  } catch (e) {
    setMessage(msg, "bad", "Errore salvataggio: " + e.message);
  }
}

async function loadActivities() {
  const { data, error } = await client
    .from("activities")
    .select("*, activity_images(*), activity_dates(*)")
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: false });
  if (error) return;
  activitiesCache = data || [];
  renderActivities();
}

function renderActivities() {
  const list = $("activitiesList");
  if (!activitiesCache.length) {
    list.innerHTML = `<div class="list-item"><p class="muted">Nessuna attività presente.</p></div>`;
    return;
  }
  list.innerHTML = activitiesCache.map(a => {
    const img = a.cover_image || a.activity_images?.[0]?.image_url || "";
    return `
      <div class="list-item">
        <div class="item-head">
          ${img ? `<img class="preview-img" src="${escapeHtml(img)}" />` : `<div class="preview-img"></div>`}
          <div>
            <h3>${escapeHtml(a.title)}</h3>
            <div><span class="badge">${escapeHtml(a.category)}</span>${a.is_active ? `<span class="badge">Attiva</span>` : `<span class="badge danger">Nascosta</span>`}</div>
            <p class="meta">${escapeHtml(a.location_name || "")} · ${money(a.price_from)}</p>
          </div>
        </div>
        <div class="item-actions">
          <button class="ghost small" onclick="editActivity('${a.id}')">Modifica</button>
          <button class="ghost small" onclick="selectActivityForDate('${a.id}')">Date/Posti</button>
          <button class="danger small" onclick="deleteActivity('${a.id}')">Elimina</button>
        </div>
      </div>
    `;
  }).join("");
}

window.editActivity = function(id) {
  const a = activitiesCache.find(x => x.id === id);
  if (!a) return;
  $("activityFormTitle").textContent = "Modifica attività";
  $("activityId").value = a.id;
  $("activityTitle").value = a.title || "";
  $("activityCategory").value = a.category || "Eventi";
  $("activityShortDescription").value = a.short_description || "";
  $("activityDescription").value = a.description || "";
  $("activityLocation").value = a.location_name || "";
  $("activityAddress").value = a.address || "";
  $("activityPrice").value = a.price_from || 0;
  $("activitySort").value = a.sort_order || 0;
  $("activityActive").value = String(!!a.is_active);
  selectActivityForDate(id);
  window.scrollTo({ top: 0, behavior: "smooth" });
};

window.deleteActivity = async function(id) {
  if (!confirm("Eliminare questa attività?")) return;
  const { error } = await client.from("activities").delete().eq("id", id);
  if (error) return alert("Errore eliminazione: " + error.message);
  await loadActivities();
};

function resetActivityForm(clearMsg = true) {
  if (clearMsg) clearMessage($("activityMessage"));
  $("activityFormTitle").textContent = "Nuova attività";
  ["activityId","activityTitle","activityShortDescription","activityDescription","activityLocation","activityAddress","activityPrice"].forEach(id => $(id).value = "");
  $("activityCategory").value = "Escursioni";
  $("activitySort").value = 0;
  $("activityActive").value = "true";
  $("activityImageFile").value = "";
}

window.selectActivityForDate = async function(id) {
  const a = activitiesCache.find(x => x.id === id);
  if (!a) return;
  $("dateActivityId").value = id;
  $("selectedActivityLabel").textContent = a.title;
  await loadDates(id);
};

async function saveDate() {
  const activityId = $("dateActivityId").value;
  if (!activityId) return alert("Seleziona prima una attività.");
  const start = $("dateStart").value;
  if (!start) return alert("Inserisci data e ora di inizio.");
  const payload = {
    activity_id: activityId,
    start_datetime: new Date(start).toISOString(),
    end_datetime: $("dateEnd").value ? new Date($("dateEnd").value).toISOString() : null,
    price: Number($("datePrice").value || 0),
    available_seats: Number($("dateSeats").value || 0),
    status: "active",
  };
  const { error } = await client.from("activity_dates").insert(payload);
  if (error) return alert("Errore data: " + error.message);
  ["dateStart","dateEnd","datePrice","dateSeats"].forEach(id => $(id).value = "");
  await loadDates(activityId);
  await loadActivities();
}

async function loadDates(activityId) {
  const { data, error } = await client.from("activity_dates").select("*").eq("activity_id", activityId).order("start_datetime");
  if (error) return;
  const list = $("datesList");
  if (!data.length) return list.innerHTML = `<p class="muted">Nessuna data.</p>`;
  list.innerHTML = data.map(d => `
    <div class="list-item">
      <strong>${new Date(d.start_datetime).toLocaleString("it-IT")}</strong>
      <p class="meta">Prezzo ${money(d.price)} · Posti ${d.available_seats} · ${escapeHtml(d.status)}</p>
      <button class="danger small" onclick="deleteDate('${d.id}')">Elimina data</button>
    </div>
  `).join("");
}

window.deleteDate = async function(id) {
  if (!confirm("Eliminare questa data?")) return;
  await client.from("activity_dates").delete().eq("id", id);
  const activityId = $("dateActivityId").value;
  if (activityId) await loadDates(activityId);
};

async function loadBookings() {
  const { data, error } = await client
    .from("bookings")
    .select("*, tickets(*)")
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) return $("bookingsList").innerHTML = `<div class="list-item"><p class="muted">Errore caricamento prenotazioni.</p></div>`;
  const list = $("bookingsList");
  if (!data.length) return list.innerHTML = `<div class="list-item"><p class="muted">Nessuna prenotazione.</p></div>`;
  list.innerHTML = data.map(b => {
    const t = b.tickets?.[0];
    return `
      <div class="list-item">
        <h3>${escapeHtml(b.activity_title)}</h3>
        <p class="meta">${escapeHtml(b.activity_date)} · ${escapeHtml(b.participant_name)} · ${b.participants} posti · ${money(b.total_amount)}</p>
        <p class="meta">${escapeHtml(b.participant_email)} · ${escapeHtml(b.participant_phone)}</p>
        ${t ? `<span class="badge">${escapeHtml(t.ticket_code)}</span>${t.checked_in ? `<span class="badge danger">Riscattato</span>` : `<span class="badge">Valido</span>`}` : `<span class="badge danger">Nessun ticket</span>`}
      </div>
    `;
  }).join("");
}

init();
