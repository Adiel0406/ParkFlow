"use strict";

require("dotenv").config();

const express = require("express");
const path = require("node:path");
const { Pool } = require("pg");
const nodemailer = require("nodemailer");

const app = express();
const port = Number(process.env.PORT || 3000);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const publicDirectory = path.resolve(__dirname, "..");

app.use(express.json({ limit: "16kb" }));

app.get("/api/health", async (_request, response) => {
  try {
    await pool.query("SELECT 1");
    response.json({ status: "ok", database: "connected" });
  } catch (error) {
    response.status(503).json({ status: "error", database: "unavailable" });
  }
});

app.post("/api/invoices/email-details", async (request, response) => {
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
    response.json({ sent: true });
  } catch (error) {
    console.error("Invoice email delivery failed:", error.message);
    response.status(502).json({ error: "Could not deliver the invoice details." });
  }
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