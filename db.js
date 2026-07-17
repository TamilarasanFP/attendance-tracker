'use strict';

// Data-access layer backed by Supabase (Postgres + Storage).
// The server uses the service_role key, so it bypasses RLS. Keep that key secret.

const { createClient } = require('@supabase/supabase-js');

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = process.env.SUPABASE_BUCKET || 'attendance-photos';

let supabase = null;
if (URL && KEY) supabase = createClient(URL, KEY, { auth: { persistSession: false } });

function client() {
  if (!supabase) {
    throw new Error('Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in your .env file.');
  }
  return supabase;
}
const isConfigured = () => !!supabase;

// ---------- row <-> app-object mapping ----------
const recToRow = r => ({
  id: r.id, emp_id: r.empId, name: r.name, type: r.type,
  date: r.date, time: r.time, captured_at: r.capturedAt, server_time: r.serverTime, photo: r.photo,
  lat: (r.lat === undefined ? null : r.lat), lng: (r.lng === undefined ? null : r.lng)
});
const rowToRec = r => ({
  id: r.id, empId: r.emp_id, name: r.name, type: r.type,
  date: r.date, time: r.time, capturedAt: r.captured_at, serverTime: r.server_time, photo: r.photo,
  lat: r.lat, lng: r.lng
});

// ---------- employees ----------
const empRow = e => ({ empId: e.emp_id, name: e.name, businessUnit: e.business_unit || '', team: e.team || '', campus: e.campus || '', exited: !!e.exited });
const COLS = 'emp_id,name,business_unit,team,campus,exited';

// ---- in-memory caches (single-instance server) ----
let empCache = null, empCacheAt = 0;
const EMP_TTL = 30000;                     // roster changes rarely; 30s TTL + explicit invalidation
function invalidateEmp() { empCache = null; }
const photoCache = new Map();              // file -> Buffer (bounded)
const PHOTO_CACHE_MAX = 200;

async function listEmployees() { // active (non-exited) only, cached
  if (empCache && Date.now() - empCacheAt < EMP_TTL) return empCache;
  const { data, error } = await client().from('employees').select(COLS).eq('exited', false).order('name');
  if (error) throw error;
  empCache = data.map(empRow); empCacheAt = Date.now();
  return empCache;
}
async function listExited() {
  const { data, error } = await client().from('employees').select(COLS).eq('exited', true).order('name');
  if (error) throw error;
  return data.map(empRow);
}
async function setExited(empId, exited) {
  const { error } = await client().from('employees')
    .update({ exited: !!exited, exited_at: exited ? new Date().toISOString() : null }).eq('emp_id', empId);
  if (error) throw error;
  invalidateEmp();
}
async function findEmployee(empId) {
  const id = String(empId || '').trim();
  if (!id) return null;
  const list = await listEmployees();      // served from cache when warm
  return list.find(e => e.empId === id) || null;
}
async function upsertEmployee(empId, name, businessUnit, team, campus) {
  const { error } = await client().from('employees')
    .upsert({ emp_id: empId, name, business_unit: businessUnit || null, team: team || null, campus: campus || null }, { onConflict: 'emp_id' });
  if (error) throw error;
  invalidateEmp();
}
async function upsertEmployees(rows) { // rows: [{empId, name, businessUnit, team, campus}]
  if (!rows.length) return;
  const payload = rows.map(r => ({ emp_id: r.empId, name: r.name, business_unit: r.businessUnit || null, team: r.team || null, campus: r.campus || null }));
  const { error } = await client().from('employees').upsert(payload, { onConflict: 'emp_id' });
  if (error) throw error;
  invalidateEmp();
}
async function updateEmployee(empId, fields) {
  const patch = {};
  if (fields.name !== undefined) patch.name = fields.name;
  if (fields.businessUnit !== undefined) patch.business_unit = fields.businessUnit || null;
  if (fields.team !== undefined) patch.team = fields.team || null;
  if (fields.campus !== undefined) patch.campus = fields.campus || null;
  const { error } = await client().from('employees').update(patch).eq('emp_id', empId);
  if (error) throw error;
  invalidateEmp();
}
async function deleteEmployee(empId) {
  const { error } = await client().from('employees').delete().eq('emp_id', empId);
  if (error) throw error;
  invalidateEmp();
}
async function clearEmployees() {
  const { error } = await client().from('employees').delete().neq('emp_id', '');
  if (error) throw error;
  invalidateEmp();
}

// ---- user auth (per-employee password) ----
async function getEmployeeAuth(empId) {
  const id = String(empId || '').trim();
  if (!id) return null;
  const { data, error } = await client().from('employees')
    .select('emp_id,name,business_unit,team,campus,exited,password_hash,must_change_password')
    .eq('emp_id', id).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    empId: data.emp_id, name: data.name, businessUnit: data.business_unit || '', team: data.team || '',
    campus: data.campus || '', exited: !!data.exited,
    passwordHash: data.password_hash || null, mustChange: data.must_change_password !== false
  };
}
async function setEmployeePassword(empId, hash) {
  const { error } = await client().from('employees')
    .update({ password_hash: hash, must_change_password: false }).eq('emp_id', empId);
  if (error) throw error;
}
async function resetEmployeePassword(empId) {
  const { error } = await client().from('employees')
    .update({ password_hash: null, must_change_password: true }).eq('emp_id', empId);
  if (error) throw error;
}

// ---- helpdesk tickets ----
const ticketRow = t => ({
  id: t.id, empId: t.emp_id, name: t.name || '', subject: t.subject, message: t.message,
  category: t.category || '', priority: t.priority || '',
  status: t.status, adminReply: t.admin_reply || '', createdAt: t.created_at, repliedAt: t.replied_at
});
async function createTicket({ empId, name, subject, message, category, priority }) {
  const { error } = await client().from('helpdesk').insert({ emp_id: empId, name, subject, message, category: category || null, priority: priority || null });
  if (error) throw error;
}
function attachMessages(tickets, msgs) {
  const byT = {};
  for (const m of (msgs || [])) (byT[m.ticket_id] = byT[m.ticket_id] || []).push({ sender: m.sender, message: m.message, createdAt: m.created_at });
  return tickets.map(t => ({ ...ticketRow(t), messages: byT[t.id] || [] }));
}
async function listMyTickets(empId) {
  const { data: tks, error } = await client().from('helpdesk').select('*').eq('emp_id', empId).order('created_at', { ascending: false });
  if (error) throw error;
  const ids = tks.map(t => t.id);
  let msgs = [];
  if (ids.length) { const { data, error: e2 } = await client().from('helpdesk_messages').select('*').in('ticket_id', ids).order('created_at', { ascending: true }); if (e2) throw e2; msgs = data || []; }
  return attachMessages(tks, msgs);
}
async function listAllTickets() {
  const { data: tks, error } = await client().from('helpdesk').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  const { data: msgs, error: e2 } = await client().from('helpdesk_messages').select('*').order('created_at', { ascending: true });
  if (e2) throw e2;
  return attachMessages(tks, msgs);
}
// server-side paginated ticket list (admin). status: 'all'|'open'|'on_hold'|'resolved'
async function listTicketsPage({ page = 1, pageSize = 10, status = 'all' } = {}) {
  const size = Math.min(100, Math.max(1, Number(pageSize) || 10));
  const pg = Math.max(1, Number(page) || 1);
  const from = (pg - 1) * size, to = from + size - 1;
  let q = client().from('helpdesk').select('*', { count: 'exact' }).order('created_at', { ascending: false }).range(from, to);
  if (status && status !== 'all') q = q.eq('status', status);
  const { data: tks, error, count } = await q;
  if (error) throw error;
  const ids = (tks || []).map(t => t.id);
  let msgs = [];
  if (ids.length) { const { data, error: e2 } = await client().from('helpdesk_messages').select('*').in('ticket_id', ids).order('created_at', { ascending: true }); if (e2) throw e2; msgs = data || []; }
  return { tickets: attachMessages(tks || [], msgs), total: count || 0, page: pg, pageSize: size };
}
async function getTicket(id) {
  const { data, error } = await client().from('helpdesk').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data ? ticketRow(data) : null;
}
async function addMessage(ticketId, sender, message) {
  const { error } = await client().from('helpdesk_messages').insert({ ticket_id: ticketId, sender, message });
  if (error) throw error;
}
async function attendanceByMonth() {
  const { data, error } = await client().rpc('attendance_by_month');
  if (error) throw error;
  return data || [];
}
async function ticketsByMonth() {
  const { data, error } = await client().rpc('tickets_by_month');
  if (error) throw error;
  return data || [];
}
async function ticketStatusCounts() {
  const { data, error } = await client().from('helpdesk').select('status');
  if (error) throw error;
  const c = { total: data.length, open: 0, on_hold: 0, resolved: 0 };
  for (const r of data) if (c[r.status] !== undefined) c[r.status]++;
  return c;
}
async function ticketMeta() { // created_at + status, for monthly breakdowns
  const { data, error } = await client().from('helpdesk').select('created_at,status');
  if (error) throw error;
  return data;
}
async function setTicketStatus(ticketId, status) {
  const patch = { status };
  if (status === 'resolved') patch.replied_at = new Date().toISOString();
  const { error } = await client().from('helpdesk').update(patch).eq('id', ticketId);
  if (error) throw error;
}

// ---- key/value settings ----
async function getSetting(key) {
  const { data, error } = await client().from('settings').select('value').eq('key', key).maybeSingle();
  if (error) throw error;
  return data ? data.value : null;
}
async function setSetting(key, value) {
  const { error } = await client().from('settings').upsert({ key, value }, { onConflict: 'key' });
  if (error) throw error;
}

// ---- campus geofencing ----
function geoRow(r) { return { campus: r.campus, lat: r.lat, lng: r.lng, radiusM: r.radius_m }; }
async function listCampusGeo() {
  const { data, error } = await client().from('campus_geo').select('*').order('campus');
  if (error) throw error;
  return (data || []).map(geoRow);
}
async function getCampusGeo(campus) {
  const { data, error } = await client().from('campus_geo').select('*').eq('campus', campus).maybeSingle();
  if (error) throw error;
  return data ? geoRow(data) : null;
}
async function setCampusGeo(campus, lat, lng, radiusM) {
  const { error } = await client().from('campus_geo')
    .upsert({ campus, lat, lng, radius_m: radiusM, updated_at: new Date().toISOString() }, { onConflict: 'campus' });
  if (error) throw error;
}

// ---- dropdown option lists (business_unit | team | campus) ----
async function listOptions() {
  const { data, error } = await client().from('options').select('category,value').order('value');
  if (error) throw error;
  const g = { business_unit: [], team: [], campus: [] };
  for (const r of data) if (g[r.category]) g[r.category].push(r.value);
  return g;
}
async function addOptions(pairs) { // [{category, value}]
  const clean = pairs.filter(p => p.value && p.value.trim())
    .map(p => ({ category: p.category, value: p.value.trim() }));
  if (!clean.length) return;
  const { error } = await client().from('options').upsert(clean, { onConflict: 'category,value' });
  if (error) throw error;
}
async function removeOption(category, value) {
  const { error } = await client().from('options').delete().eq('category', category).eq('value', value);
  if (error) throw error;
}

// ---------- records ----------
async function insertRecord(rec) {
  const { error } = await client().from('records').upsert(recToRow(rec), { onConflict: 'id' });
  if (error) throw error;
}
async function insertRecords(recs) {
  if (!recs.length) return;
  const { error } = await client().from('records').upsert(recs.map(recToRow), { onConflict: 'id' });
  if (error) throw error;
}
async function listRecords() {
  const { data, error } = await client().from('records').select('*');
  if (error) throw error;
  return data.map(rowToRec);
}
async function recordsByDate(date) {
  const { data, error } = await client().from('records').select('*').eq('date', date);
  if (error) throw error;
  return data.map(rowToRec);
}
async function recordsByEmp(empId) {
  const { data, error } = await client().from('records').select('*').eq('emp_id', empId);
  if (error) throw error;
  return data.map(rowToRec);
}
async function statusByEmp(empId) {
  const { data, error } = await client().from('day_status').select('date,status').eq('emp_id', empId);
  if (error) throw error;
  const m = {};
  for (const r of data) m[r.date] = r.status;
  return m;
}
async function getRecord(id) {
  const { data, error } = await client().from('records').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data ? rowToRec(data) : null;
}
async function updateRecord(id, fields) {
  const patch = {};
  if (fields.time !== undefined) patch.time = fields.time;
  if (fields.capturedAt !== undefined) patch.captured_at = fields.capturedAt;
  if (fields.name !== undefined) patch.name = fields.name;
  const { error } = await client().from('records').update(patch).eq('id', id);
  if (error) throw error;
}
async function deleteRecord(id) {
  const rec = await getRecord(id);
  if (rec && rec.photo) { try { await client().storage.from(BUCKET).remove([rec.photo]); } catch (e) {} photoCache.delete(rec.photo); }
  const { error } = await client().from('records').delete().eq('id', id);
  if (error) throw error;
}
// ---- manual per-day status overrides (present | absent | permission) ----
async function statusByDate(date) {
  const { data, error } = await client().from('day_status').select('emp_id,status').eq('date', date);
  if (error) throw error;
  const m = {};
  for (const r of data) m[r.emp_id] = r.status;
  return m;
}
async function setStatus(empId, date, status) {
  const { error } = await client().from('day_status')
    .upsert({ emp_id: empId, date, status, updated_at: new Date().toISOString() }, { onConflict: 'emp_id,date' });
  if (error) throw error;
}
async function clearRecords() {
  const recs = await listRecords();
  const files = recs.map(r => r.photo).filter(Boolean);
  if (files.length) await client().storage.from(BUCKET).remove(files); // best-effort
  photoCache.clear();
  const { error } = await client().from('records').delete().neq('id', '');
  if (error) throw error;
}
async function clearRecordsByDate(date) {
  const recs = await recordsByDate(date);
  const files = recs.map(r => r.photo).filter(Boolean);
  if (files.length) { await client().storage.from(BUCKET).remove(files); for (const f of files) photoCache.delete(f); }
  const { error } = await client().from('records').delete().eq('date', date);
  if (error) throw error;
}

// ---------- photos (Supabase Storage) ----------
async function uploadPhoto(file, buffer) {
  const { error } = await client().storage.from(BUCKET).upload(file, buffer, {
    contentType: 'image/jpeg', upsert: true
  });
  if (error) throw error;
  photoCache.set(file, buffer);            // warm cache with what we just uploaded
}
async function downloadPhoto(file) {
  if (photoCache.has(file)) return photoCache.get(file);
  const { data, error } = await client().storage.from(BUCKET).download(file);
  if (error || !data) return null;
  const buf = Buffer.from(await data.arrayBuffer());
  if (photoCache.size >= PHOTO_CACHE_MAX) photoCache.delete(photoCache.keys().next().value); // evict oldest
  photoCache.set(file, buf);
  return buf;
}

// ---------- health check ----------
async function ping() {
  const { error } = await client().from('employees').select('emp_id').limit(1);
  if (error) throw error;
  return true;
}

module.exports = {
  isConfigured, BUCKET,
  listEmployees, listExited, setExited, findEmployee, upsertEmployee, upsertEmployees, updateEmployee, deleteEmployee, clearEmployees,
  insertRecord, insertRecords, listRecords, recordsByDate, recordsByEmp, statusByEmp, getRecord, updateRecord, deleteRecord, clearRecords, clearRecordsByDate,
  statusByDate, setStatus,
  listOptions, addOptions, removeOption,
  getEmployeeAuth, setEmployeePassword, resetEmployeePassword, getSetting, setSetting,
  listCampusGeo, getCampusGeo, setCampusGeo,
  createTicket, listMyTickets, listAllTickets, listTicketsPage, getTicket, addMessage, setTicketStatus, ticketStatusCounts, ticketMeta, attendanceByMonth, ticketsByMonth,
  uploadPhoto, downloadPhoto, ping
};
