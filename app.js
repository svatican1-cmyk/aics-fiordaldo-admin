const SUPABASE_URL = "https://jigwyvlnepbjirlzbggv.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImppZ3d5dmxuZXBiamlybHpiZ2d2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAyMzY3MDgsImV4cCI6MjA5NTgxMjcwOH0._58DCoXeQcoDcDEkeVjH4IQdOhBbb50nP7LMImpEYWo";

const client = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let html5QrCode = null;
let currentUser = null;
let activitiesCache = [];
let allImagesCache = [];
let selectedActivityIdForMedia = "";
let showArchivedBookings = false;

const $ = (id) => document.getElementById(id);

function show(el) { if (el) el.classList.remove("hidden"); }
function hide(el) { if (el) el.classList.add("hidden"); }
function money(value) { return `${Number(value || 0).toFixed(2).replace(".00", "")}€`; }
function escapeHtml(str = "") {
  return String(str).replace(/[&<>'"]/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  }[c]));
}
function setMessage(el, type, text) {
  if (!el) return;
  el.className = `message ${type === "ok" ? "ok" : "bad"}`;
  el.textContent = text;
  show(el);
}
function clearMessage(el) { if (el) { el.textContent = ""; hide(el); } }
function setLoginLoading(isLoading) {
  const btn = $("loginBtn");
  if (!btn) return;
  btn.disabled = isLoading;
  btn.textContent = isLoading ? "Accesso in corso..." : "Accedi";
}
function setButtonLoading(btn, isLoading, idleText, loadingText) {
  if (!btn) return;
  btn.disabled = isLoading;
  btn.textContent = isLoading ? loadingText : idleText;
}
function toLocalDateTimeInputValue(dateValue) {
  if (!dateValue) return "";
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return escapeHtml(value);
  return date.toLocaleString("it-IT");
}
function parsePossibleEventDate(value) {
  if (!value) return null;
  const text = String(value);
  const direct = new Date(text);
  if (!Number.isNaN(direct.getTime())) return direct;

  const isoMatch = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return new Date(`${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}T00:00:00`);

  const itMatch = text.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if (itMatch) {
    const y = itMatch[3].length === 2 ? `20${itMatch[3]}` : itMatch[3];
    return new Date(`${y}-${String(itMatch[2]).padStart(2, "0")}-${String(itMatch[1]).padStart(2, "0")}T00:00:00`);
  }

  return null;
}
function isRedeemedAndExpired(booking) {
  const ticket = booking.tickets?.[0];
  if (!ticket?.checked_in) return false;
  const eventDate = parsePossibleEventDate(booking.activity_date);
  if (!eventDate) return false;
  const midnightAfter = new Date(eventDate);
  midnightAfter.setDate(midnightAfter.getDate() + 1);
  midnightAfter.setHours(0, 0, 0, 0);
  return new Date() >= midnightAfter;
}
function filenameFromPublicUrl(url) {
  try {
    const parsed = new URL(url);
    const marker = "/storage/v1/object/public/activities/";
    const index = parsed.pathname.indexOf(marker);
    if (index >= 0) return decodeURIComponent(parsed.pathname.slice(index + marker.length));
  } catch {}
  const parts = String(url || "").split("/activities/");
  return parts.length > 1 ? decodeURIComponent(parts.pop()) : "";
}

async function requireAdmin() {
  try {
    const { data: userData, error: userError } = await client.auth.getUser();
    if (userError || !userData?.user) {
      currentUser = null;
      return false;
    }

    currentUser = userData.user;
    const { data: profile, error: profileError } = await client
      .from("profiles")
      .select("role")
      .eq("id", currentUser.id)
      .single();

    if (profileError || !profile || !["admin", "staff"].includes(profile.role)) {
      await client.auth.signOut();
      currentUser = null;
      return false;
    }

    return true;
  } catch (error) {
    console.error("requireAdmin error:", error);
    currentUser = null;
    return false;
  }
}

async function init() {
  bindEvents();
  const ok = await requireAdmin();
  if (ok) {
    await enterAdmin();
  } else {
    show($("loginView"));
    hide($("adminView"));
    hide($("logoutBtn"));
  }
}

function bindEvents() {
  $("loginBtn")?.addEventListener("click", login);
  $("logoutBtn")?.addEventListener("click", logout);
  $("startScannerBtn")?.addEventListener("click", startScanner);
  $("stopScannerBtn")?.addEventListener("click", stopScanner);
  $("verifyManualBtn")?.addEventListener("click", () => verifyInput($("manualCode").value));
  $("saveActivityBtn")?.addEventListener("click", saveActivity);
  $("resetActivityBtn")?.addEventListener("click", resetActivityForm);
  $("refreshActivitiesBtn")?.addEventListener("click", async () => { await loadActivities(); await loadImageLibrary(); });
  $("saveDateBtn")?.addEventListener("click", saveDate);
  $("resetDateBtn")?.addEventListener("click", resetDateForm);
  $("refreshBookingsBtn")?.addEventListener("click", loadBookings);
  $("bookingSearchEmail")?.addEventListener("input", debounce(loadBookings, 350));
  $("showArchivedBookings")?.addEventListener("change", (e) => { showArchivedBookings = e.target.checked; loadBookings(); });
  $("refreshImagesBtn")?.addEventListener("click", loadImageLibrary);

  document.querySelectorAll(".tab").forEach(btn => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  $("loginPassword")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") login();
  });
}
function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

async function login() {
  const msg = $("loginMessage");
  clearMessage(msg);
  const email = $("loginEmail").value.trim().toLowerCase();
  const password = $("loginPassword").value.trim();
  if (!email || !password) return setMessage(msg, "bad", "Inserisci email e password.");

  setLoginLoading(true);
  try {
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) return setMessage(msg, "bad", "Accesso non riuscito: " + error.message);
    const ok = await requireAdmin();
    if (!ok) return setMessage(msg, "bad", "Account valido, ma non autorizzato come admin/staff.");
    setMessage(msg, "ok", "Accesso effettuato.");
    await enterAdmin();
  } catch (error) {
    console.error("login error:", error);
    setMessage(msg, "bad", "Errore durante il login. Controlla la console.");
  } finally {
    setLoginLoading(false);
  }
}
async function logout() {
  await stopScanner();
  await client.auth.signOut();
  currentUser = null;
  hide($("adminView"));
  show($("loginView"));
  hide($("logoutBtn"));
}
async function enterAdmin() {
  hide($("loginView"));
  show($("adminView"));
  show($("logoutBtn"));
  switchTab("scanner");
  await Promise.all([loadActivities(), loadBookings(), loadImageLibrary()]);
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
  await loadBookings();
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
    console.error("scanner error:", e);
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
  const safeName = file.name.replace(/[^a-z0-9._-]/gi, "_").toLowerCase();
  const path = `${activityId}/${Date.now()}-${safeName || `image.${ext}`}`;
  const { error: uploadError } = await client.storage.from("activities").upload(path, file, { upsert: true });
  if (uploadError) throw uploadError;
  const { data } = client.storage.from("activities").getPublicUrl(path);
  return { publicUrl: data.publicUrl, path };
}

async function saveActivity() {
  const msg = $("activityMessage");
  clearMessage(msg);
  const btn = $("saveActivityBtn");
  setButtonLoading(btn, true, "Salva attività", "Salvataggio...");

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

  if (!payload.title || !payload.category) {
    setButtonLoading(btn, false, "Salva attività", "Salvataggio...");
    return setMessage(msg, "bad", "Titolo e categoria sono obbligatori.");
  }

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
      $("activityId").value = activity.id;
      selectedActivityIdForMedia = activity.id;
    }

    const files = Array.from($("activityImageFiles").files || []);
    let firstUploadedUrl = null;
    for (const file of files) {
      const uploaded = await uploadActivityImage(activity.id, file);
      if (!uploaded?.publicUrl) continue;
      if (!firstUploadedUrl) firstUploadedUrl = uploaded.publicUrl;
      await client.from("activity_images").insert({ activity_id: activity.id, image_url: uploaded.publicUrl, sort_order: 0 });
    }

    if (firstUploadedUrl && !activity.cover_image) {
      await client.from("activities").update({ cover_image: firstUploadedUrl }).eq("id", activity.id);
    }

    $("activityImageFiles").value = "";
    setMessage(msg, "ok", files.length ? "Attività salvata e immagini caricate." : "Attività salvata.");
    await loadActivities();
    await loadImageLibrary();
    renderSelectedActivityMedia(activity.id);
  } catch (e) {
    console.error("saveActivity error:", e);
    setMessage(msg, "bad", "Errore salvataggio: " + (e.message || e));
  } finally {
    setButtonLoading(btn, false, "Salva attività", "Salvataggio...");
  }
}

async function loadActivities() {
  const { data, error } = await client
    .from("activities")
    .select("*, activity_images(*), activity_dates(*)")
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: false });
  if (error) {
    console.error("loadActivities error:", error);
    return;
  }
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
    const dateCount = a.activity_dates?.length || 0;
    const imageCount = a.activity_images?.length || 0;
    return `
      <div class="list-item ${selectedActivityIdForMedia === a.id ? "selected-item" : ""}">
        <div class="item-head">
          ${img ? `<img class="preview-img" src="${escapeHtml(img)}" />` : `<div class="preview-img"></div>`}
          <div>
            <h3>${escapeHtml(a.title)}</h3>
            <div>
              <span class="badge">${escapeHtml(a.category)}</span>
              ${a.is_active ? `<span class="badge">Attiva</span>` : `<span class="badge danger">Nascosta</span>`}
              <span class="badge">${dateCount} date</span>
              <span class="badge">${imageCount} foto</span>
            </div>
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
  selectedActivityIdForMedia = id;
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
  renderSelectedActivityMedia(id);
  renderActivities();
  window.scrollTo({ top: 0, behavior: "smooth" });
};
window.deleteActivity = async function(id) {
  if (!confirm("Eliminare questa attività? Verranno eliminate anche date e collegamenti immagini.")) return;
  const { error } = await client.from("activities").delete().eq("id", id);
  if (error) return alert("Errore eliminazione: " + error.message);
  if (selectedActivityIdForMedia === id) resetActivityForm();
  await loadActivities();
  await loadImageLibrary();
};
function resetActivityForm(clearMsg = true) {
  if (clearMsg) clearMessage($("activityMessage"));
  selectedActivityIdForMedia = "";
  $("activityFormTitle").textContent = "Nuova attività";
  ["activityId", "activityTitle", "activityShortDescription", "activityDescription", "activityLocation", "activityAddress", "activityPrice"].forEach(id => $(id).value = "");
  $("activityCategory").value = "Escursioni";
  $("activitySort").value = 0;
  $("activityActive").value = "true";
  $("activityImageFiles").value = "";
  resetDateForm();
  $("selectedActivityLabel").textContent = "Nessuna attività selezionata";
  $("datesList").innerHTML = `<p class="muted">Seleziona una attività per vedere le date.</p>`;
  $("selectedImagesList").innerHTML = `<p class="muted">Seleziona una attività per vedere le foto collegate.</p>`;
  renderActivities();
}

window.selectActivityForDate = async function(id) {
  const a = activitiesCache.find(x => x.id === id);
  if (!a) return;
  selectedActivityIdForMedia = id;
  $("dateActivityId").value = id;
  $("selectedActivityLabel").textContent = a.title;
  await loadDates(id);
  renderSelectedActivityMedia(id);
  renderActivities();
};
async function saveDate() {
  const activityId = $("dateActivityId").value || $("activityId").value;
  if (!activityId) return alert("Seleziona o salva prima una attività.");
  const start = $("dateStart").value;
  if (!start) return alert("Inserisci data e ora di inizio.");
  const payload = {
    activity_id: activityId,
    start_datetime: new Date(start).toISOString(),
    end_datetime: $("dateEnd").value ? new Date($("dateEnd").value).toISOString() : null,
    price: Number($("datePrice").value || 0),
    available_seats: Number($("dateSeats").value || 0),
    status: $("dateStatus").value || "active",
  };
  const dateId = $("dateId").value;
  const query = dateId
    ? client.from("activity_dates").update(payload).eq("id", dateId)
    : client.from("activity_dates").insert(payload);
  const { error } = await query;
  if (error) return alert("Errore data: " + error.message);
  resetDateForm();
  await loadDates(activityId);
  await loadActivities();
}
function resetDateForm() {
  $("dateId").value = "";
  ["dateStart", "dateEnd", "datePrice", "dateSeats"].forEach(id => $(id).value = "");
  $("dateStatus").value = "active";
  $("saveDateBtn").textContent = "Aggiungi data";
}
async function loadDates(activityId) {
  const { data, error } = await client.from("activity_dates").select("*").eq("activity_id", activityId).order("start_datetime");
  if (error) {
    console.error("loadDates error:", error);
    return;
  }
  const list = $("datesList");
  if (!data.length) {
    list.innerHTML = `<p class="muted">Nessuna data.</p>`;
    return;
  }
  list.innerHTML = data.map(d => `
    <div class="list-item date-item">
      <strong>${formatDateTime(d.start_datetime)}</strong>
      <p class="meta">Prezzo ${money(d.price)} · Posti ${d.available_seats} · ${escapeHtml(d.status)}</p>
      <div class="item-actions">
        <button class="ghost small" onclick="editDate('${d.id}')">Modifica</button>
        <button class="danger small" onclick="deleteDate('${d.id}')">Elimina data</button>
      </div>
    </div>
  `).join("");
}
window.editDate = function(id) {
  const activityId = $("dateActivityId").value || $("activityId").value;
  const a = activitiesCache.find(x => x.id === activityId);
  const d = a?.activity_dates?.find(x => x.id === id);
  if (!d) return;
  $("dateId").value = d.id;
  $("dateStart").value = toLocalDateTimeInputValue(d.start_datetime);
  $("dateEnd").value = toLocalDateTimeInputValue(d.end_datetime);
  $("datePrice").value = d.price || 0;
  $("dateSeats").value = d.available_seats || 0;
  $("dateStatus").value = d.status || "active";
  $("saveDateBtn").textContent = "Salva modifica data";
};
window.deleteDate = async function(id) {
  if (!confirm("Eliminare questa data?")) return;
  await client.from("activity_dates").delete().eq("id", id);
  const activityId = $("dateActivityId").value || $("activityId").value;
  if (activityId) await loadDates(activityId);
  await loadActivities();
};

async function loadImageLibrary() {
  const { data, error } = await client
    .from("activity_images")
    .select("*, activities(title)")
    .order("created_at", { ascending: false })
    .limit(300);
  if (error) {
    console.error("loadImageLibrary error:", error);
    return;
  }
  allImagesCache = data || [];
  renderImageLibrary();
  if (selectedActivityIdForMedia) renderSelectedActivityMedia(selectedActivityIdForMedia);
}
function renderSelectedActivityMedia(activityId) {
  const box = $("selectedImagesList");
  const activity = activitiesCache.find(a => a.id === activityId);
  if (!activity) {
    box.innerHTML = `<p class="muted">Seleziona una attività per vedere le foto collegate.</p>`;
    return;
  }
  const images = activity.activity_images || [];
  if (!images.length) {
    box.innerHTML = `<p class="muted">Nessuna foto collegata a questa attività.</p>`;
    return;
  }
  box.innerHTML = images.map(img => `
    <div class="image-tile">
      <img src="${escapeHtml(img.image_url)}" alt="Foto attività" />
      <div class="image-actions">
        <button class="ghost small" onclick="setCoverImage('${activityId}', '${escapeHtml(img.image_url)}')">Copertina</button>
        <button class="danger small" onclick="removeImageLink('${img.id}')">Scollega</button>
      </div>
    </div>
  `).join("");
}
function renderImageLibrary() {
  const box = $("imageLibraryList");
  if (!allImagesCache.length) {
    box.innerHTML = `<p class="muted">Nessuna immagine caricata.</p>`;
    return;
  }
  box.innerHTML = allImagesCache.map(img => {
    const activityName = img.activities?.title || "Non collegata";
    return `
      <div class="image-tile library-tile">
        <img src="${escapeHtml(img.image_url)}" alt="Immagine bucket" />
        <p class="meta">${escapeHtml(activityName)}</p>
        <div class="image-actions">
          <button class="ghost small" onclick="attachExistingImage('${img.id}')">Usa</button>
          <button class="danger small" onclick="deleteImageEverywhere('${img.id}')">Elimina</button>
        </div>
      </div>
    `;
  }).join("");
}
window.setCoverImage = async function(activityId, imageUrl) {
  const { error } = await client.from("activities").update({ cover_image: imageUrl }).eq("id", activityId);
  if (error) return alert("Errore copertina: " + error.message);
  await loadActivities();
};
window.removeImageLink = async function(imageId) {
  if (!confirm("Scollegare questa immagine dall'attività? Il file resterà nel bucket.")) return;
  const { error } = await client.from("activity_images").delete().eq("id", imageId);
  if (error) return alert("Errore: " + error.message);
  await loadActivities();
  await loadImageLibrary();
};
window.attachExistingImage = async function(imageId) {
  const activityId = selectedActivityIdForMedia || $("activityId").value;
  if (!activityId) return alert("Seleziona prima una attività.");
  const img = allImagesCache.find(x => x.id === imageId);
  if (!img) return;
  const { error } = await client.from("activity_images").insert({ activity_id: activityId, image_url: img.image_url, sort_order: 0 });
  if (error) return alert("Errore collegamento: " + error.message);
  await loadActivities();
};
window.deleteImageEverywhere = async function(imageId) {
  const img = allImagesCache.find(x => x.id === imageId);
  if (!img) return;
  if (!confirm("Eliminare questa immagine dal database e dal bucket?")) return;
  const path = filenameFromPublicUrl(img.image_url);
  await client.from("activity_images").delete().eq("image_url", img.image_url);
  if (path) {
    const { error } = await client.storage.from("activities").remove([path]);
    if (error) alert("Riga eliminata, ma file non eliminato dal bucket: " + error.message);
  }
  await loadActivities();
  await loadImageLibrary();
};

async function loadBookings() {
  const search = $("bookingSearchEmail")?.value.trim().toLowerCase() || "";
  let query = client
    .from("bookings")
    .select("*, tickets(*)")
    .order("created_at", { ascending: false })
    .limit(300);
  if (search) query = query.ilike("participant_email", `%${search}%`);
  const { data, error } = await query;
  if (error) {
    console.error("loadBookings error:", error);
    $("bookingsList").innerHTML = `<div class="list-item"><p class="muted">Errore caricamento prenotazioni.</p></div>`;
    return;
  }
  const list = $("bookingsList");
  const filtered = showArchivedBookings ? (data || []) : (data || []).filter(b => !isRedeemedAndExpired(b));
  if (!filtered.length) {
    list.innerHTML = `<div class="list-item"><p class="muted">Nessuna prenotazione trovata.</p></div>`;
    return;
  }
  list.innerHTML = filtered.map(b => {
    const t = b.tickets?.[0];
    const archived = isRedeemedAndExpired(b);
    return `
      <div class="list-item ${archived ? "archived" : ""}">
        <h3>${escapeHtml(b.activity_title)}</h3>
        <p class="meta">${escapeHtml(b.activity_date)} · ${escapeHtml(b.participant_name)} · ${b.participants} posti · ${money(b.total_amount)}</p>
        <p class="meta">${escapeHtml(b.participant_email)} · ${escapeHtml(b.participant_phone)}</p>
        ${t ? `<span class="badge">${escapeHtml(t.ticket_code)}</span>${t.checked_in ? `<span class="badge danger">Riscattato</span>` : `<span class="badge">Valido</span>`}` : `<span class="badge danger">Nessun ticket</span>`}
        ${t?.checked_in_at ? `<p class="meta">Riscattato il ${formatDateTime(t.checked_in_at)}</p>` : ""}
      </div>
    `;
  }).join("");
}

init();
