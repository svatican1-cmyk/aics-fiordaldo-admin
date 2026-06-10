const SUPABASE_URL = "https://jigwyvlnepbjirlzbggv.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImppZ3d5dmxuZXBiamlybHpiZ2d2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAyMzY3MDgsImV4cCI6MjA5NTgxMjcwOH0._58DCoXeQcoDcDEkeVjH4IQdOhBbb50nP7LMImpEYWo";

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let html5QrCode = null;
let currentTicket = null;
let currentBooking = null;
let currentUser = null;

const el = (id) => document.getElementById(id);

const loginCard = el("loginCard");
const adminPanel = el("adminPanel");
const sessionBadge = el("sessionBadge");
const loginMessage = el("loginMessage");
const resultCard = el("resultCard");
const resultMessage = el("resultMessage");
const ticketDetails = el("ticketDetails");
const ticketStatusBadge = el("ticketStatusBadge");
const checkinBtn = el("checkinBtn");

function setMessage(node, text, type = "") {
  node.textContent = text || "";
  node.className = `message ${type}`.trim();
}

function parseQrInput(raw) {
  const value = String(raw || "").trim();
  if (!value) return { code: "" };

  try {
    const parsed = JSON.parse(value);
    return {
      code: parsed.code || parsed.ticket_code || "",
      ticketId: parsed.ticket_id || parsed.id || "",
    };
  } catch {
    return { code: value };
  }
}

async function loadSession() {
  const { data } = await sb.auth.getUser();
  currentUser = data.user || null;

  if (!currentUser) {
    loginCard.classList.remove("hidden");
    adminPanel.classList.add("hidden");
    sessionBadge.textContent = "Non connesso";
    sessionBadge.className = "badge muted";
    return;
  }

  const { data: profile, error } = await sb
    .from("profiles")
    .select("role, first_name, last_name")
    .eq("id", currentUser.id)
    .single();

  if (error || !profile || !["admin", "staff"].includes(profile.role)) {
    await sb.auth.signOut();
    currentUser = null;
    loginCard.classList.remove("hidden");
    adminPanel.classList.add("hidden");
    sessionBadge.textContent = "Accesso negato";
    sessionBadge.className = "badge bad";
    setMessage(loginMessage, "Questo account non è staff/admin.", "error");
    return;
  }

  loginCard.classList.add("hidden");
  adminPanel.classList.remove("hidden");
  sessionBadge.textContent = `${profile.first_name || "Staff"} · ${profile.role}`;
  sessionBadge.className = "badge ok";
}

async function login() {
  setMessage(loginMessage, "Accesso in corso...");
  const email = el("emailInput").value.trim().toLowerCase();
  const password = el("passwordInput").value.trim();

  if (!email || !password) {
    setMessage(loginMessage, "Inserisci email e password.", "error");
    return;
  }

  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) {
    setMessage(loginMessage, "Email o password non corretti.", "error");
    return;
  }

  setMessage(loginMessage, "");
  await loadSession();
}

async function logout() {
  await stopScanner();
  await sb.auth.signOut();
  currentUser = null;
  currentTicket = null;
  currentBooking = null;
  resultCard.classList.add("hidden");
  await loadSession();
}

async function startScanner() {
  setMessage(resultMessage, "");
  if (html5QrCode) return;

  html5QrCode = new Html5Qrcode("reader");

  try {
    await html5QrCode.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: { width: 250, height: 250 } },
      async (decodedText) => {
        await stopScanner();
        await verifyTicket(decodedText);
      }
    );
  } catch (err) {
    console.error(err);
    html5QrCode = null;
    setMessage(resultMessage, "Non riesco ad aprire la fotocamera. Usa il codice manuale.", "error");
    resultCard.classList.remove("hidden");
  }
}

async function stopScanner() {
  if (!html5QrCode) return;
  try {
    await html5QrCode.stop();
    await html5QrCode.clear();
  } catch {}
  html5QrCode = null;
}

async function verifyTicket(rawValue) {
  const parsed = parseQrInput(rawValue);

  if (!parsed.code && !parsed.ticketId) {
    showErrorResult("QR/codice non valido.");
    return;
  }

  setMessage(resultMessage, "Verifica in corso...");
  resultCard.classList.remove("hidden");
  checkinBtn.classList.add("hidden");
  ticketDetails.innerHTML = "";

  let query = sb.from("tickets").select("*");

  if (parsed.ticketId) {
    query = query.eq("id", parsed.ticketId);
  } else {
    query = query.eq("ticket_code", parsed.code);
  }

  const { data: ticket, error: ticketError } = await query.single();

  if (ticketError || !ticket) {
    showErrorResult("Biglietto non trovato.");
    return;
  }

  const { data: booking, error: bookingError } = await sb
    .from("bookings")
    .select("*")
    .eq("id", ticket.booking_id)
    .single();

  if (bookingError || !booking) {
    showErrorResult("Prenotazione collegata non trovata.");
    return;
  }

  currentTicket = ticket;
  currentBooking = booking;

  renderTicket(ticket, booking);
}

function showErrorResult(text) {
  currentTicket = null;
  currentBooking = null;
  resultCard.classList.remove("hidden");
  ticketStatusBadge.textContent = "Errore";
  ticketStatusBadge.className = "badge bad";
  ticketDetails.innerHTML = "";
  checkinBtn.classList.add("hidden");
  setMessage(resultMessage, text, "error");
}

function row(label, value) {
  return `
    <div class="detail-row">
      <div class="detail-label">${label}</div>
      <div class="detail-value">${value || "-"}</div>
    </div>
  `;
}

function renderTicket(ticket, booking) {
  const alreadyUsed = Boolean(ticket.checked_in);

  ticketStatusBadge.textContent = alreadyUsed ? "Già usato" : "Valido";
  ticketStatusBadge.className = alreadyUsed ? "badge bad" : "badge ok";

  ticketDetails.innerHTML = [
    row("Codice", ticket.ticket_code),
    row("Attività", booking.activity_title),
    row("Data", booking.activity_date),
    row("Prenotante", booking.participant_name),
    row("Email", booking.participant_email),
    row("Telefono", booking.participant_phone),
    row("Posti", booking.participants),
    row("Totale", `${booking.total_amount}€`),
    row("Stato ticket", ticket.status),
    row("Check-in", alreadyUsed ? `Effettuato ${ticket.checked_in_at || ""}` : "Non effettuato"),
  ].join("");

  resultCard.classList.remove("hidden");
  setMessage(
    resultMessage,
    alreadyUsed ? "Attenzione: questo biglietto è già stato convalidato." : "Biglietto valido. Puoi convalidare l'ingresso.",
    alreadyUsed ? "error" : "success"
  );

  if (alreadyUsed) {
    checkinBtn.classList.add("hidden");
  } else {
    checkinBtn.classList.remove("hidden");
  }
}

async function checkinTicket() {
  if (!currentTicket || !currentUser) return;

  checkinBtn.disabled = true;
  setMessage(resultMessage, "Convalida in corso...");

  const { data, error } = await sb
    .from("tickets")
    .update({
      checked_in: true,
      checked_in_at: new Date().toISOString(),
      checked_in_by: currentUser.id,
    })
    .eq("id", currentTicket.id)
    .eq("checked_in", false)
    .select()
    .single();

  checkinBtn.disabled = false;

  if (error || !data) {
    setMessage(resultMessage, "Non posso convalidare: forse il biglietto è già stato usato.", "error");
    await verifyTicket(currentTicket.ticket_code);
    return;
  }

  currentTicket = data;
  renderTicket(currentTicket, currentBooking);
}

el("loginBtn").addEventListener("click", login);
el("logoutBtn").addEventListener("click", logout);
el("startScanBtn").addEventListener("click", startScanner);
el("stopScanBtn").addEventListener("click", stopScanner);
el("manualVerifyBtn").addEventListener("click", () => verifyTicket(el("manualCodeInput").value));
el("checkinBtn").addEventListener("click", checkinTicket);

loadSession();
