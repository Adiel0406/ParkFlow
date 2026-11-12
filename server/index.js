"use strict";

require("dotenv").config();

const express = require("express");
const path = require("node:path");
const crypto = require("node:crypto");
const { Pool } = require("pg");
const nodemailer = require("nodemailer");
const PDFDocument = require("pdfkit");

const app = express();
const port = Number(process.env.PORT || 3000);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const publicDirectory = path.resolve(__dirname, "..");
const SESSION_COOKIE = "parkflow_session";
const SESSION_DURATION_MS = 12 * 60 * 60 * 1000;

app.use(express.json({ limit: "4mb" }));

function normalizedEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function text(value, maximum = 160) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function validEmail(value) {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function passwordHash(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

function verifyPassword(password, storedHash) {
  const [algorithm, saltHex, hashHex] = String(storedHash || "").split("$");
  if (algorithm !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function readCookie(request, name) {
  const entry = (request.headers.cookie || "").split(";").map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return entry ? decodeURIComponent(entry.slice(name.length + 1)) : "";
}

function sessionCookie(token) {
  const secure = process.env.COOKIE_SECURE === "true" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DURATION_MS / 1000}${secure}`;
}

function clearSessionCookie(response) {
  response.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function createSession(database, account) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);
  await database.query(
    "INSERT INTO auth_sessions (token_hash, parking_lot_id, account_id, expires_at) VALUES ($1, $2, $3, $4)",
    [hashToken(token), account.parking_lot_id, account.id, expiresAt],
  );
  return token;
}

function safeUser(row) {
  return {
    id: row.id,
    parkingLotId: row.parking_lot_id,
    parkingLotName: row.parking_lot_name,
    firstName: row.first_name,
    lastName: row.last_name,
    identityDocument: row.identity_document,
    phone: row.phone,
    email: row.email,
    role: row.role,
  };
}

async function requireSession(request, response, next) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) {
    response.status(401).json({ error: "Authentication required." });
    return;
  }

  try {
    const result = await pool.query(`
      SELECT a.id, a.parking_lot_id, p.name AS parking_lot_name,
        a.first_name, a.last_name, a.identity_document, a.phone, a.email, a.role
      FROM auth_sessions s
      JOIN accounts a ON a.id = s.account_id AND a.parking_lot_id = s.parking_lot_id
      JOIN parking_lots p ON p.id = a.parking_lot_id
      WHERE s.token_hash = $1 AND s.expires_at > now() AND a.is_active = true
    `, [hashToken(token)]);
    if (!result.rowCount) {
      clearSessionCookie(response);
      response.status(401).json({ error: "Session expired." });
      return;
    }
    request.auth = safeUser(result.rows[0]);
    request.sessionTokenHash = hashToken(token);
    next();
  } catch (error) {
    console.error("Session verification failed:", error.message);
    response.status(503).json({ error: "Authentication service unavailable." });
  }
}

function requireAdmin(request, response, next) {
  if (request.auth.role !== "admin") {
    response.status(403).json({ error: "Administrator role required." });
    return;
  }
  next();
}

function validatedPerson(body) {
  return {
    firstName: text(body.firstName, 80),
    lastName: text(body.lastName, 100),
    identityDocument: text(body.identityDocument, 40),
    phone: text(body.phone, 40),
    email: normalizedEmail(body.email),
    password: typeof body.password === "string" ? body.password : "",
  };
}

function validPerson(person) {
  return person.firstName.length >= 2
    && person.lastName.length >= 2
    && person.phone.length >= 6
    && validEmail(person.email)
    && person.password.length >= 8
    && person.password.length <= 128;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function validLayout(layout) {
  const tileTypes = new Set(["parking", "aisle", "entrance", "ramp", "circularRamp", "empty"]);
  return layout && Array.isArray(layout.floors) && layout.floors.length > 0 && layout.floors.length <= 15
    && layout.floors.every((floor) => floor
      && typeof floor.id === "string"
      && Number.isInteger(floor.rows) && floor.rows > 0 && floor.rows <= 20
      && Number.isInteger(floor.columns) && floor.columns > 0 && floor.columns <= 20
      && Array.isArray(floor.cells)
      && floor.cells.length === floor.rows * floor.columns
      && floor.cells.every((cell) => tileTypes.has(cell)))
    && layout.floors.some((floor) => floor.id === "PB")
    && new Set(layout.floors.map((floor) => floor.id)).size === layout.floors.length;
}

function validIntervals(intervals) {
  if (!Array.isArray(intervals) || intervals.length === 0 || intervals.length > 100) return false;
  return intervals.every((interval, index) => {
    if (!interval?.from || !interval?.to
      || !Number.isFinite(interval.from.value) || !Number.isFinite(interval.to.value)
      || !["minutes", "hours"].includes(interval.from.unit)
      || !["minutes", "hours"].includes(interval.to.unit)
      || !Number.isFinite(interval.amount) || interval.amount < 0) return false;
    const start = interval.from.value * (interval.from.unit === "hours" ? 60 : 1);
    const end = interval.to.value * (interval.to.unit === "hours" ? 60 : 1);
    if (start < 0 || end <= start) return false;
    if (index === 0) return start === 0;
    const previous = intervals[index - 1].to;
    return Math.abs(start - previous.value * (previous.unit === "hours" ? 60 : 1)) < 1e-9;
  });
}

app.post("/api/auth/register-parking", async (request, response) => {
  const body = request.body || {};
  const parking = {
    name: text(body.parkingName, 120),
    address: text(body.parkingAddress, 240),
    phone: text(body.parkingPhone, 40),
  };
  const admin = validatedPerson(body);
  if (parking.name.length < 2 || parking.address.length < 4 || parking.phone.length < 6 || !validPerson(admin)) {
    response.status(400).json({ error: "Completa los datos del parqueo y del administrador. La contraseña requiere al menos 8 caracteres." });
    return;
  }

  const layout = {
    floors: [{ id: "PB", label: "Planta baja", rows: 3, columns: 4, cells: Array(12).fill("parking") }],
  };
  const billingIntervals = [
    { from: { value: 0, unit: "minutes" }, to: { value: 30, unit: "minutes" }, amount: 2.5 },
    { from: { value: 30, unit: "minutes" }, to: { value: 60, unit: "minutes" }, amount: 2.5 },
    { from: { value: 60, unit: "minutes" }, to: { value: 120, unit: "minutes" }, amount: 5 },
  ];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lotResult = await client.query(
      "INSERT INTO parking_lots (name, address, contact_phone) VALUES ($1, $2, $3) RETURNING id, name",
      [parking.name, parking.address, parking.phone],
    );
    const lot = lotResult.rows[0];
    await client.query(
      "INSERT INTO parking_settings (parking_lot_id, layout, billing_intervals) VALUES ($1, $2::jsonb, $3::jsonb)",
      [lot.id, JSON.stringify(layout), JSON.stringify(billingIntervals)],
    );
    const accountResult = await client.query(`
      INSERT INTO accounts (parking_lot_id, first_name, last_name, identity_document, phone, email, password_hash, role)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'admin')
      RETURNING id, parking_lot_id, first_name, last_name, identity_document, phone, email, role
    `, [lot.id, admin.firstName, admin.lastName, admin.identityDocument, admin.phone, admin.email, passwordHash(admin.password)]);
    const account = { ...accountResult.rows[0], parking_lot_name: lot.name };
    const token = await createSession(client, account);
    await client.query(`
      INSERT INTO parking_events (parking_lot_id, account_id, event_type, message, detail, metadata)
      VALUES ($1, $2, 'parking_registered', 'Se registró el parqueo', $3, $4::jsonb)
    `, [lot.id, account.id, parking.address, JSON.stringify({ actorRole: "admin", parking, administrator: { firstName: admin.firstName, lastName: admin.lastName, email: admin.email } })]);
    await client.query("COMMIT");
    response.setHeader("Set-Cookie", sessionCookie(token));
    response.status(201).json({ user: safeUser(account) });
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") {
      response.status(409).json({ error: "Ya existe una cuenta con ese correo en este parqueo." });
      return;
    }
    console.error("Parking registration failed:", error.message);
    response.status(500).json({ error: "No se pudo registrar el parqueo." });
  } finally {
    client.release();
  }
});

app.post("/api/auth/login", async (request, response) => {
  const email = normalizedEmail(request.body?.email);
  const password = typeof request.body?.password === "string" ? request.body.password : "";
  const parkingLotId = text(request.body?.parkingLotId, 50);
  if (!validEmail(email) || password.length === 0) {
    response.status(400).json({ error: "Ingresa un correo y contraseña válidos." });
    return;
  }

  try {
    const result = await pool.query(`
      SELECT a.id, a.parking_lot_id, p.name AS parking_lot_name, a.first_name,
        a.last_name, a.identity_document, a.phone, a.email, a.role, a.password_hash
      FROM accounts a
      JOIN parking_lots p ON p.id = a.parking_lot_id
      WHERE lower(a.email) = $1 AND a.is_active = true
    `, [email]);
    const matches = result.rows.filter((account) => verifyPassword(password, account.password_hash));
    if (!matches.length) {
      response.status(401).json({ error: "Correo o contraseña incorrectos." });
      return;
    }
    if (matches.length > 1 && !parkingLotId) {
      response.json({
        selectParkingLot: true,
        parkingLots: matches.map((account) => ({ id: account.parking_lot_id, name: account.parking_lot_name })),
      });
      return;
    }
    const account = matches.find((item) => item.parking_lot_id === parkingLotId) || (matches.length === 1 ? matches[0] : null);
    if (!account) {
      response.status(401).json({ error: "Selecciona uno de los parqueos asociados a esta cuenta." });
      return;
    }
    const token = await createSession(pool, account);
    await pool.query(`
      INSERT INTO parking_events (parking_lot_id, account_id, event_type, message, detail, metadata)
      VALUES ($1, $2, 'login', 'Inicio de sesión', $3, $4::jsonb)
    `, [account.parking_lot_id, account.id, `Acceso al parqueo ${account.parking_lot_name}`, JSON.stringify({ actorRole: account.role })]);
    response.setHeader("Set-Cookie", sessionCookie(token));
    response.json({ user: safeUser(account) });
  } catch (error) {
    console.error("Login failed:", error.message);
    response.status(503).json({ error: "No se pudo validar el acceso." });
  }
});

app.get("/api/auth/me", requireSession, (request, response) => {
  response.json({ user: request.auth });
});

app.post("/api/auth/logout", requireSession, async (request, response) => {
  await pool.query(`
    INSERT INTO parking_events (parking_lot_id, account_id, event_type, message, detail, metadata)
    VALUES ($1, $2, 'logout', 'Cierre de sesión', $3, $4::jsonb)
  `, [request.auth.parkingLotId, request.auth.id, `Salida del parqueo ${request.auth.parkingLotName}`, JSON.stringify({ actorRole: request.auth.role })]);
  await pool.query("DELETE FROM auth_sessions WHERE token_hash = $1", [request.sessionTokenHash]);
  clearSessionCookie(response);
  response.status(204).end();
});

app.get("/api/accounts", requireSession, requireAdmin, async (request, response) => {
  const result = await pool.query(`
    SELECT id, first_name, last_name, identity_document, phone, email, role
    FROM accounts WHERE parking_lot_id = $1 AND role <> 'admin' AND is_active = true
    ORDER BY last_name, first_name, email
  `, [request.auth.parkingLotId]);
  response.json({ accounts: result.rows });
});

app.post("/api/accounts", requireSession, requireAdmin, async (request, response) => {
  const person = validatedPerson(request.body || {});
  const role = text(request.body?.role, 20);
  if (!validPerson(person) || !["supervisor", "employee"].includes(role)) {
    response.status(400).json({ error: "Completa los datos personales, correo, contraseña y cargo." });
    return;
  }
  try {
    const result = await pool.query(`
      INSERT INTO accounts (parking_lot_id, first_name, last_name, identity_document, phone, email, password_hash, role)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, first_name, last_name, identity_document, phone, email, role
    `, [request.auth.parkingLotId, person.firstName, person.lastName, person.identityDocument, person.phone, person.email, passwordHash(person.password), role]);
    await pool.query(`
      INSERT INTO parking_events (parking_lot_id, account_id, event_type, message, detail, metadata)
      VALUES ($1, $2, 'account_created', 'Se creó una cuenta del equipo', $3, $4::jsonb)
    `, [request.auth.parkingLotId, request.auth.id, `${result.rows[0].first_name} ${result.rows[0].last_name} · ${role}`, JSON.stringify({ actorRole: request.auth.role, account: result.rows[0] })]);
    response.status(201).json({ account: result.rows[0] });
  } catch (error) {
    if (error.code === "23505") {
      response.status(409).json({ error: "Ya existe una cuenta con ese correo en este parqueo." });
      return;
    }
    console.error("Account creation failed:", error.message);
    response.status(500).json({ error: "No se pudo crear la cuenta." });
  }
});

app.patch("/api/accounts/:id/role", requireSession, requireAdmin, async (request, response) => {
  const role = text(request.body?.role, 20);
  if (!["supervisor", "employee"].includes(role)) {
    response.status(400).json({ error: "Cargo inválido." });
    return;
  }
  const result = await pool.query(`
    UPDATE accounts SET role = $1
    WHERE id = $2 AND parking_lot_id = $3 AND role <> 'admin' AND is_active = true
    RETURNING id, first_name, last_name, email, role
  `, [role, request.params.id, request.auth.parkingLotId]);
  if (!result.rowCount) {
    response.status(404).json({ error: "No se encontró la cuenta." });
    return;
  }
  await pool.query(`
    INSERT INTO parking_events (parking_lot_id, account_id, event_type, message, detail, metadata)
    VALUES ($1, $2, 'account_role_changed', 'Se cambió el cargo de una cuenta', $3, $4::jsonb)
  `, [request.auth.parkingLotId, request.auth.id, `${result.rows[0].first_name} ${result.rows[0].last_name} · ${role}`, JSON.stringify({ actorRole: request.auth.role, account: result.rows[0] })]);
  response.json({ account: result.rows[0] });
});

app.delete("/api/accounts/:id", requireSession, requireAdmin, async (request, response) => {
  const result = await pool.query(`
    UPDATE accounts SET is_active = false
    WHERE id = $1 AND parking_lot_id = $2 AND role <> 'admin' AND is_active = true
    RETURNING id, first_name, last_name, email, role
  `, [request.params.id, request.auth.parkingLotId]);
  if (!result.rowCount) {
    response.status(404).json({ error: "No se encontró la cuenta." });
    return;
  }
  await pool.query("DELETE FROM auth_sessions WHERE account_id = $1", [request.params.id]);
  await pool.query(`
    INSERT INTO parking_events (parking_lot_id, account_id, event_type, message, detail, metadata)
    VALUES ($1, $2, 'account_deactivated', 'Se retiró el acceso a una cuenta', $3, $4::jsonb)
  `, [request.auth.parkingLotId, request.auth.id, `${result.rows[0].first_name} ${result.rows[0].last_name} · ${result.rows[0].role}`, JSON.stringify({ actorRole: request.auth.role, account: result.rows[0] })]);
  response.status(204).end();
});

app.get("/api/parking/state", requireSession, async (request, response) => {
  try {
    const result = await pool.query(`
      SELECT layout, billing_intervals, application_state
      FROM parking_settings WHERE parking_lot_id = $1
    `, [request.auth.parkingLotId]);
    if (!result.rowCount) {
      response.status(404).json({ error: "No se encontró la configuración del parqueo." });
      return;
    }
    const settings = result.rows[0];
    response.json({
      state: {
        ...settings.application_state,
        layout: settings.layout,
        billingIntervals: settings.billing_intervals,
      },
    });
  } catch (error) {
    console.error("Parking state read failed:", error.message);
    response.status(503).json({ error: "No se pudo cargar el estado del parqueo." });
  }
});

app.put("/api/parking/state", requireSession, async (request, response) => {
  const state = request.body || {};
  const validArrays = Array.isArray(state.vehicles) && state.vehicles.length <= 6000
    && state.vehicles.every((vehicle) => vehicle && typeof vehicle.id === "string" && typeof vehicle.plate === "string")
    && Array.isArray(state.exitStack) && state.exitStack.length <= 6000
    && Array.isArray(state.historyEvents) && state.historyEvents.length <= 50
    && Array.isArray(state.auditEvents) && state.auditEvents.length <= 100
    && state.auditEvents.every((event) => event
      && typeof event.eventType === "string" && /^[a-zA-Z0-9_-]{1,40}$/.test(event.eventType)
      && typeof event.message === "string" && event.message.length <= 500
      && typeof event.detail === "string" && event.detail.length <= 4000
      && event.metadata && typeof event.metadata === "object" && !Array.isArray(event.metadata)
      && Buffer.byteLength(JSON.stringify(event.metadata)) <= 24000);
  if (!validArrays || !validLayout(state.layout) || !validIntervals(state.billingIntervals)) {
    response.status(400).json({ error: "El estado del parqueo no tiene un formato válido." });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const currentResult = await client.query(`
      SELECT layout, billing_intervals
      FROM parking_settings WHERE parking_lot_id = $1 FOR UPDATE
    `, [request.auth.parkingLotId]);
    if (!currentResult.rowCount) {
      await client.query("ROLLBACK");
      response.status(404).json({ error: "No se encontró la configuración del parqueo." });
      return;
    }
    const current = currentResult.rows[0];
    const layoutChanged = stableJson(state.layout) !== stableJson(current.layout);
    const intervalsChanged = stableJson(state.billingIntervals) !== stableJson(current.billing_intervals);
    if (layoutChanged && request.auth.role !== "admin") {
      await client.query("ROLLBACK");
      response.status(403).json({ error: "Solo el administrador puede modificar el plano." });
      return;
    }
    if (intervalsChanged && request.auth.role === "employee") {
      await client.query("ROLLBACK");
      response.status(403).json({ error: "Tu cargo no permite modificar el tarifario." });
      return;
    }

    await client.query(`
      UPDATE parking_settings
      SET layout = $1::jsonb,
        billing_intervals = $2::jsonb,
        application_state = $3::jsonb,
        updated_at = now()
      WHERE parking_lot_id = $4
    `, [
      JSON.stringify(state.layout),
      JSON.stringify(state.billingIntervals),
      JSON.stringify({ vehicles: state.vehicles, exitStack: state.exitStack, historyEvents: state.historyEvents }),
      request.auth.parkingLotId,
    ]);
    for (const event of state.auditEvents) {
      await client.query(`
        INSERT INTO parking_events (parking_lot_id, account_id, event_type, message, detail, metadata)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      `, [request.auth.parkingLotId, request.auth.id, event.eventType, event.message, event.detail, JSON.stringify({ ...event.metadata, actorRole: request.auth.role })]);
    }
    await client.query("COMMIT");
    response.json({ saved: true });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Parking state save failed:", error.message);
    response.status(500).json({ error: "No se pudo guardar el estado del parqueo." });
  } finally {
    client.release();
  }
});

app.get("/api/parking/audit.pdf", requireSession, requireAdmin, async (request, response) => {
  try {
    const [parkingResult, accountsResult, eventsResult] = await Promise.all([
      pool.query(`
        SELECT p.name, p.address, p.contact_phone, p.created_at,
          s.layout, s.billing_intervals, s.application_state, s.updated_at
        FROM parking_lots p
        JOIN parking_settings s ON s.parking_lot_id = p.id
        WHERE p.id = $1
      `, [request.auth.parkingLotId]),
      pool.query(`
        SELECT first_name, last_name, identity_document, phone, email, role, is_active, created_at
        FROM accounts WHERE parking_lot_id = $1 ORDER BY created_at, last_name, first_name
      `, [request.auth.parkingLotId]),
      pool.query(`
        SELECT e.event_type, e.message, e.detail, e.metadata, e.created_at,
          a.first_name, a.last_name, a.email, a.role
        FROM parking_events e
        LEFT JOIN accounts a ON a.id = e.account_id AND a.parking_lot_id = e.parking_lot_id
        WHERE e.parking_lot_id = $1
        ORDER BY e.created_at, e.id
      `, [request.auth.parkingLotId]),
    ]);
    if (!parkingResult.rowCount) {
      response.status(404).json({ error: "No se encontraron datos para este parqueo." });
      return;
    }

    const parking = parkingResult.rows[0];
    const state = parking.application_state || {};
    const filename = parking.name.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "parqueo";
    response.status(200);
    response.setHeader("Content-Type", "application/pdf");
    response.setHeader("Content-Disposition", `attachment; filename="auditoria_${filename}.pdf"`);
    response.setHeader("Cache-Control", "no-store");

    const document = new PDFDocument({ size: "A4", margin: 48, info: { Title: `Auditoría - ${parking.name}`, Author: "ParkFlow" } });
    document.on("error", (error) => {
      console.error("Audit PDF generation failed:", error.message);
      if (!response.headersSent) response.status(500).end();
      else response.destroy(error);
    });
    document.pipe(response);

    const bottom = () => document.page.height - document.page.margins.bottom;
    const ensureSpace = (height = 48) => {
      if (document.y + height > bottom()) document.addPage();
    };
    const formatDate = (value) => {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? "No disponible" : date.toLocaleString("es-BO", { timeZone: "America/La_Paz" });
    };
    const heading = (title) => {
      ensureSpace(44);
      document.moveDown(0.7).font("Helvetica-Bold").fontSize(13).fillColor("#17324d").text(title);
      document.moveDown(0.25).font("Helvetica").fontSize(9).fillColor("#1b2430");
    };
    const field = (label, value) => {
      ensureSpace(24);
      document.font("Helvetica-Bold").text(`${label}: `, { continued: true });
      document.font("Helvetica").text(value === undefined || value === null || value === "" ? "-" : String(value), { lineGap: 2 });
    };
    const block = (title, lines) => {
      ensureSpace(54);
      document.font("Helvetica-Bold").fontSize(10).text(title, { lineGap: 2 });
      document.font("Helvetica").fontSize(9).text(lines.join("\n"), { lineGap: 2 });
      document.moveDown(0.45);
    };
    const jsonText = (value) => JSON.stringify(value ?? {}, null, 2);

    document.font("Helvetica-Bold").fontSize(20).fillColor("#17324d").text("REPORTE DE AUDITORÍA");
    document.moveDown(0.3).font("Helvetica").fontSize(10).fillColor("#1b2430")
      .text(`Parqueo: ${parking.name}`)
      .text(`Generado: ${formatDate(new Date())}`)
      .text(`Generado por: ${request.auth.firstName} ${request.auth.lastName} (${request.auth.email})`)
      .text(`Identificador del parqueo: ${request.auth.parkingLotId}`);

    heading("Datos del parqueo");
    field("Nombre", parking.name);
    field("Dirección", parking.address);
    field("Teléfono de contacto", parking.contact_phone);
    field("Registrado", formatDate(parking.created_at));
    field("Última actualización de configuración", formatDate(parking.updated_at));

    heading(`Cuentas y cargos (${accountsResult.rowCount})`);
    accountsResult.rows.forEach((account) => block(`${account.first_name} ${account.last_name} - ${account.role === "admin" ? "Administrador" : account.role === "supervisor" ? "Supervisor" : "Empleado"}`, [
      `Correo: ${account.email}`,
      `Documento: ${account.identity_document || "-"}`,
      `Teléfono: ${account.phone}`,
      `Estado: ${account.is_active ? "Activo" : "Inactivo"}`,
      `Creado: ${formatDate(account.created_at)}`,
    ]));

    heading(`Vehículos activos (${(state.vehicles || []).length})`);
    (state.vehicles || []).forEach((vehicle) => block(`${vehicle.plate} - ${vehicle.make} ${vehicle.type}`, [
      `Color: ${vehicle.color || "-"}`,
      `Espacio: ${vehicle.floorId || "-"} / P-${vehicle.slot ?? "-"}`,
      `Ingreso: ${formatDate(vehicle.enteredAt)}`,
      `Pago: ${vehicle.paidAt ? `Bs ${Number(vehicle.paidAmount || 0).toFixed(2)} el ${formatDate(vehicle.paidAt)}` : "Pendiente"}`,
      `Cliente factura: ${vehicle.invoiceCustomer?.name || "-"} | NIT: ${vehicle.invoiceCustomer?.nit || "-"} | Correo: ${vehicle.invoiceCustomer?.email || "-"}`,
    ]));

    heading(`Salidas recientes disponibles para deshacer (${(state.exitStack || []).length})`);
    (state.exitStack || []).forEach((vehicle) => block(`${vehicle.plate} - ${vehicle.make} ${vehicle.type}`, [
      `Ingreso: ${formatDate(vehicle.enteredAt)}`,
      `Pago: Bs ${Number(vehicle.paidAmount || 0).toFixed(2)} el ${formatDate(vehicle.paidAt)}`,
      `Salida: ${formatDate(vehicle.exitedAt)}`,
      `Espacio: ${vehicle.floorId || "-"} / P-${vehicle.slot ?? "-"}`,
    ]));

    heading("Tarifario vigente");
    (parking.billing_intervals || []).forEach((interval, index) => {
      block(`Intervalo ${index + 1}`, [
        `Desde: ${interval.from.value} ${interval.from.unit}`,
        `Hasta: ${interval.to.value} ${interval.to.unit}`,
        `Monto: Bs ${Number(interval.amount).toFixed(2)}`,
      ]);
    });

    heading("Diseño del parqueo");
    block("Plano guardado", [jsonText(parking.layout)]);

    heading(`Registro completo de movimientos (${eventsResult.rowCount})`);
    if (!eventsResult.rowCount) {
      document.font("Helvetica").fontSize(9).text("No se registraron movimientos desde la activación del historial de auditoría.");
    }
    eventsResult.rows.forEach((event, index) => {
      block(`${index + 1}. ${event.message}`, [
        `Fecha del servidor: ${formatDate(event.created_at)}`,
        `Tipo: ${event.event_type}`,
        `Responsable: ${event.first_name ? `${event.first_name} ${event.last_name} (${event.email}) · Cargo al momento: ${event.metadata.actorRole || event.role}` : "Cuenta retirada"}`,
        `Detalle: ${event.detail || "-"}`,
        `Datos asociados: ${jsonText(event.metadata)}`,
      ]);
    });

    document.end();
  } catch (error) {
    console.error("Audit report query failed:", error.message);
    if (!response.headersSent) response.status(500).json({ error: "No se pudo generar el reporte de auditoría." });
  }
});

app.get("/api/health", async (_request, response) => {
  try {
    await pool.query("SELECT 1");
    response.json({ status: "ok", database: "connected" });
  } catch (error) {
    response.status(503).json({ status: "error", database: "unavailable" });
  }
});

app.post("/api/invoices/email-details", requireSession, async (request, response) => {
  const { to, invoice, customer = {} } = request.body || {};
  const validEmail = typeof to === "string"
    && to.length <= 254
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to);
  const validInvoice = invoice
    && typeof invoice.plate === "string"
    && typeof invoice.make === "string"
    && typeof invoice.type === "string"
    && Number.isFinite(invoice.total)
    && invoice.total >= 0
    && Array.isArray(invoice.intervalCharges)
    && invoice.intervalCharges.length <= 20
    && invoice.intervalCharges.every((charge) =>
      charge && typeof charge.label === "string"
      && Number.isFinite(charge.amount) && charge.amount >= 0);

  if (!validEmail || !validInvoice) {
    response.status(400).json({ error: "Invalid invoice details or recipient email." });
    return;
  }

  const { SMTP_HOST, SMTP_USER, SMTP_PASSWORD, SMTP_FROM } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASSWORD || !SMTP_FROM) {
    response.status(503).json({ error: "Email delivery is not configured." });
    return;
  }

  const date = new Date(invoice.enteredAt);
  const invoiceLines = [
    "Detalle de factura ParkFlow",
    "",
    `Placa: ${invoice.plate}`,
    `Vehículo: ${invoice.make} ${invoice.type}${invoice.color ? ` · ${invoice.color}` : ""}`,
    `Ingreso: ${Number.isNaN(date.getTime()) ? "No disponible" : date.toLocaleString("es-BO")}`,
    `Tiempo facturado: ${Number(invoice.billableMinutes).toFixed(1)} min`,
    ...(customer.name ? [`Cliente: ${String(customer.name).slice(0, 120)}`] : []),
    ...(customer.nit ? [`NIT: ${String(customer.nit).slice(0, 32)}`] : []),
    "",
    "Conceptos:",
    ...invoice.intervalCharges.map((charge) => `- ${charge.label}: Bs ${charge.amount.toFixed(2)}`),
    "",
    `Total pagado: Bs ${invoice.total.toFixed(2)}`,
  ];

  try {
    const transport = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === "true",
      auth: { user: SMTP_USER, pass: SMTP_PASSWORD },
    });
    await transport.sendMail({
      from: SMTP_FROM,
      to,
      subject: `Detalle de factura ParkFlow · ${invoice.plate}`,
      text: invoiceLines.join("\n"),
    });
    await pool.query(`
      INSERT INTO parking_events (parking_lot_id, account_id, event_type, message, detail, metadata)
      VALUES ($1, $2, 'invoice_email', 'Se enviaron los detalles de una factura', $3, $4::jsonb)
    `, [request.auth.parkingLotId, request.auth.id, `Placa ${invoice.plate} · ${to}`, JSON.stringify({ actorRole: request.auth.role, plate: invoice.plate, total: invoice.total, recipient: to })]);
    response.json({ sent: true });
  } catch (error) {
    console.error("Invoice email delivery failed:", error.message);
    response.status(502).json({ error: "Could not deliver the invoice details." });
  }
});

app.get("/", (_request, response) => {
  response.redirect("/login.html");
});

app.use(express.static(publicDirectory));

const server = app.listen(port, "0.0.0.0", () => {
  console.log(`ParkFlow listening on port ${port}`);
});

function shutdown() {
  server.close(() => {
    pool.end().finally(() => process.exit(0));
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);