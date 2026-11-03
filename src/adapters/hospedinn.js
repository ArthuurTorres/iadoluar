const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { error: logError } = require('../utils/logger');

const LOGS_DIR = path.join(__dirname, '..', '..', 'logs');
const HOSPEDINN_LOG_FILE = path.join(LOGS_DIR, 'hospedinn.log');

// Token cache
let cachedToken = null;
let tokenExpiresAt = 0;

function ensureLogsDir() {
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
}

function logHospedinnError(message, context) {
  ensureLogsDir();
  const timestamp = new Date().toISOString();
  let ctx = '';
  if (context) {
    try {
      // Sanitize sensitive data
      const str = typeof context === 'string' ? context : JSON.stringify(context);
      ctx = ' ' + str
        .replace(/(\d{2})\d+(\d{4})/g, '$1*****$2')
        .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer ***REDACTED***')
        .replace(/(client_secret|token)["']?\s*[:=]\s*["']?[A-Za-z0-9\-._~+/]+/gi, '$1=***REDACTED***');
    } catch {
      ctx = '';
    }
  }
  const line = `[${timestamp}] ${message}${ctx}\n`;
  try {
    fs.appendFileSync(HOSPEDINN_LOG_FILE, line, 'utf-8');
  } catch {
    console.error('[hospedinn] Failed to write log:', line);
  }
}

/**
 * Get OAuth2 access token using client_credentials grant.
 * Caches token in memory; renews when expired (with 60s margin).
 */
async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt) {
    return cachedToken;
  }

  const clientId = process.env.HOSPEDINN_CLIENT_ID;
  const clientSecret = process.env.HOSPEDINN_CLIENT_SECRET;
  const authUrl = process.env.HOSPEDINN_AUTH_URL || 'https://pms.hospedin.com/oauth/token';

  if (!clientId || !clientSecret) {
    const msg = 'HOSPEDINN_CLIENT_ID or HOSPEDINN_CLIENT_SECRET not configured';
    logHospedinnError(msg);
    logError(msg);
    return null;
  }

  try {
    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('client_id', clientId);
    params.append('client_secret', clientSecret);

    const response = await axios.post(authUrl, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000,
    });

    const data = response.data;
    if (!data.access_token) {
      const msg = 'HospedInn auth response missing access_token';
      logHospedinnError(msg, data);
      logError(msg);
      return null;
    }

    cachedToken = data.access_token;
    // expires_in is in seconds; renew 60s before actual expiry
    const expiresInMs = (data.expires_in || 3600) * 1000;
    tokenExpiresAt = now + expiresInMs - 60000;

    return cachedToken;
  } catch (err) {
    const detail = err.response
      ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`
      : err.message;
    logHospedinnError(`getAccessToken failed: ${detail}`);
    logError(`HospedInn getAccessToken failed: ${detail}`);
    return null;
  }
}

/**
 * Generate array of dates between checkIn (inclusive) and checkOut (exclusive).
 */
function getDateRange(checkIn, checkOut) {
  const dates = [];
  const current = new Date(checkIn + 'T00:00:00');
  const end = new Date(checkOut + 'T00:00:00');
  while (current < end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

/**
 * Check room availability for a date range.
 * Cross-references /availabilities (real availability per date) with /rooms (names).
 * @param {string} checkIn - YYYY-MM-DD
 * @param {string} checkOut - YYYY-MM-DD
 * @param {number} [guests] - Total number of guests (adults + children)
 * @returns {{ available: boolean|null, nights: Array, roomCount?: number, availableRooms?: string[], error?: string }}
 */
async function checkAvailability(checkIn, checkOut, guests) {
  const token = await getAccessToken();
  if (!token) {
    return { available: null, nights: [], error: 'Não foi possível autenticar no sistema de reservas.' };
  }

  const baseUrl = process.env.HOSPEDINN_BASE_URL || 'https://pms.hospedin.com';
  const apiHeaders = { Authorization: `Bearer ${token}`, Accept: 'application/json' };

  try {
    // Step 1: Get real availability per place_type_id per date
    const availParams = { check_in: checkIn, check_out: checkOut };
    if (guests && Number.isInteger(guests) && guests > 0) {
      availParams.guests = guests;
    }

    const availResponse = await axios.get(`${baseUrl}/api/v3/availabilities`, {
      params: availParams,
      headers: apiHeaders,
      timeout: 15000,
    });

    const availData = availResponse.data?.data || [];
    const requiredDates = getDateRange(checkIn, checkOut);

    // Group availability by place_type_id: count how many dates have availability > 0
    const typeAvailability = {};
    for (const entry of availData) {
      const attrs = entry.attributes || entry;
      const typeId = String(attrs.place_type_id);
      if (!typeAvailability[typeId]) {
        typeAvailability[typeId] = { totalDates: 0, availableDates: 0 };
      }
      typeAvailability[typeId].totalDates += 1;
      if ((attrs.availability || 0) > 0) {
        typeAvailability[typeId].availableDates += 1;
      }
    }

    // Only keep place_type_ids that have availability > 0 on ALL required dates
    const availableTypeIds = Object.entries(typeAvailability)
      .filter(([_, counts]) => counts.availableDates >= requiredDates.length)
      .map(([typeId]) => typeId);

    if (availableTypeIds.length === 0) {
      return { available: false, nights: [], roomCount: 0, availableRooms: [] };
    }

    // Step 2: Get all rooms and filter by available place_type_ids
    const roomsResponse = await axios.get(`${baseUrl}/api/v3/rooms`, {
      headers: apiHeaders,
      timeout: 15000,
    });

    const roomsData = roomsResponse.data?.data || roomsResponse.data || [];
    const availableRooms = [];

    for (const room of roomsData) {
      const attrs = room.attributes || room;
      const typeId = String(attrs.place_type_id);
      if (availableTypeIds.includes(typeId)) {
        const name = attrs.title || attrs.name || attrs.room_name || null;
        if (name) availableRooms.push(name);
      }
    }

    const roomCount = availableRooms.length;

    return { available: roomCount > 0, nights: [], roomCount, availableRooms };
  } catch (err) {
    const detail = err.response
      ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`
      : err.message;
    logHospedinnError(`checkAvailability failed (${checkIn} → ${checkOut}): ${detail}`);
    logError(`HospedInn checkAvailability failed: ${detail}`);
    return { available: null, nights: [], error: 'Erro ao consultar disponibilidade. Tente novamente em instantes.' };
  }
}

/**
 * Get room types from HospedInn.
 * @returns {Array} Array of room type objects, or empty array on error.
 */
async function getRoomTypes() {
  const token = await getAccessToken();
  if (!token) {
    logError('HospedInn getRoomTypes: no token');
    return [];
  }

  const baseUrl = process.env.HOSPEDINN_BASE_URL || 'https://pms.hospedin.com';

  try {
    const response = await axios.get(`${baseUrl}/api/v3/room_types`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      timeout: 15000,
    });

    const data = response.data;

    // Handle JSON:API or plain array
    if (Array.isArray(data?.data)) {
      return data.data.map((item) => item.attributes || item);
    }
    if (Array.isArray(data)) {
      return data;
    }

    return [];
  } catch (err) {
    const detail = err.response
      ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`
      : err.message;
    logHospedinnError(`getRoomTypes failed: ${detail}`);
    logError(`HospedInn getRoomTypes failed: ${detail}`);
    return [];
  }
}

module.exports = { getAccessToken, checkAvailability, getRoomTypes };