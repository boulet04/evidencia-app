// pages/api/chat.js
import { createClient } from "@supabase/supabase-js";
import { Mistral } from "@mistralai/mistralai";
import agentPrompts from "../../lib/agentPrompts";

function safeStr(v) {
  return (v ?? "").toString();
}

function getBearerToken(req) {
  const h = req.headers?.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : "";
}

function nowIso() {
  return new Date().toISOString();
}

function isExpired(expiresAt) {
  if (!expiresAt) return false;
  const t = new Date(expiresAt).getTime();
  return Number.isFinite(t) && t < Date.now();
}

function titleFromMessage(message) {
  const s = safeStr(message).trim().replace(/\s+/g, " ");
  if (!s) return "Nouvelle conversation";
  return s.length > 60 ? s.slice(0, 60) + "…" : s;
}

function looksLikeEmail(s) {
  const v = safeStr(s).trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

function extractEmails(text) {
  const s = safeStr(text);
  const re = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  const m = s.match(re);
  return Array.from(new Set((m || []).map((x) => x.trim())));
}

function isConfirmSend(text) {
  const t = safeStr(text).trim().toLowerCase();
  if (!t) return false;
  return (
    t === "ok envoie" ||
    t === "ok envoi" ||
    t === "ok, envoie" ||
    t === "ok, envoi" ||
    t === "envoie" ||
    t === "envoye" ||
    t === "envoyer" ||
    t === "oui envoie" ||
    t === "oui, envoie" ||
    t === "valide" ||
    t === "je confirme"
  );
}

async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`Timeout: ${label} (${ms}ms)`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function buildMemoryTag(content) {
  return `MEMORY:\n${content}`;
}

function stripMemoryTag(content) {
  const t = safeStr(content);
  return t.startsWith("MEMORY:\n") ? t.slice("MEMORY:\n".length) : t;
}

function buildPendingEmailTag(obj) {
  return `PENDING_EMAIL:\n${JSON.stringify(obj)}`;
}

function parsePendingEmailTag(content) {
  const t = safeStr(content);
  if (!t.startsWith("PENDING_EMAIL:\n")) return null;
  const raw = t.slice("PENDING_EMAIL:\n".length).trim();
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    return null;
  }
}

/**
 * Extrait un objet JSON d’un texte même si :
 * - enveloppé dans ```json ... ```
 * - enveloppé dans ``` ... ```
 * - précédé/suivi de texte
 * - ou si le modèle renvoie { ... } au milieu
 */
function extractFirstJsonObject(text) {
  const raw = safeStr(text).trim();
  if (!raw) return null;

  const fenceJson = new RegExp("```\\s*json\\s*([\\s\\S]*?)```", "i");
  const mJson = raw.match(fenceJson);
  if (mJson?.[1]) {
    const inside = mJson[1].trim();
    const parsed = tryParseJson(inside);
    if (parsed) return parsed;
  }

  const fenceAny = new RegExp("```\\s*([\\s\\S]*?)```", "i");
  const mAny = raw.match(fenceAny);
  if (mAny?.[1]) {
    const inside = mAny[1].trim();
    const parsed = tryParseJson(inside);
    if (parsed) return parsed;
  }

  const scanned = scanFirstBalancedObject(raw);
  if (scanned) {
    const parsed = tryParse
      ught: you must provide citations"? no. No web.
  }
}
