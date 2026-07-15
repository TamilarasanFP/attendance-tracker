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
const empRow = e => ({ empId: e.emp_id, name: e.name, businessUnit: e.business_unit || '', team: e.team || '', campus: e.campus || '' });
const COLS = 'emp_id,name,business_unit,team,campus';

async function listEmployees() {
  const { data, error } = await client().from('employees').select(COLS).order('name');
  if (error) throw error;
  return data.map(empRow);
}
async function findEmployee(empId) {
  const id = String(empId || '').trim();
  if (!id) return null;
  const { data, error } = await client().from('employees').select(COLS).eq('emp_id', id).maybeSingle();
  if (error) throw error;
  return data ? empRow(data) : null;
}
async function upsertEmployee(empId, name, businessUnit, team, campus) {
  const { error } = await client().from('employees')
    .upsert({ emp_id: empId, name, business_unit: businessUnit || null, team: team || null, campus: campus || null }, { onConflict: 'emp_id' });
  if (error) throw error;
}
async function upsertEmployees(rows) { // rows: [{empId, name, businessUnit, team, campus}]
  if (!rows.length) return;
  const payload = rows.map(r => ({ emp_id: r.empId, name: r.name, business_unit: r.businessUnit || null, team: r.team || null, campus: r.campus || null }));
  const { error } = await client().from('employees').upsert(payload, { onConflict: 'emp_id' });
  if (error) throw error;
}
async function updateEmployee(empId, fields) {
  const patch = {};
  if (fields.name !== undefined) patch.name = fields.name;
  if (fields.businessUnit !== undefined) patch.business_unit = fields.businessUnit || null;
  if (fields.team !== undefined) patch.team = fields.team || null;
  if (fields.campus !== undefined) patch.campus = fields.campus || null;
  const { error } = await client().from('employees').update(patch).eq('emp_id', empId);
  if (error) throw error;
}
async function deleteEmployee(empId) {
  const { error } = await client().from('employees').delete().eq('emp_id', empId);
  if (error) throw error;
}
async function clearEmployees() {
  const { error } = await client().from('employees').delete().neq('emp_id', '');
  if (error) throw error;
}

// ---------- records ----------
async function insertRecord(rec) {
  const { error } = await client().from('records').upsert(recToRow(rec), { onConflict: 'id' });
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
  if (rec && rec.photo) { try { await client().storage.from(BUCKET).remove([rec.photo]); } catch (e) {} }
  const { error } = await client().from('records').delete().eq('id', id);
  if (error) throw error;
}
async function clearRecords() {
  const recs = await listRecords();
  const files = recs.map(r => r.photo).filter(Boolean);
  if (files.length) await client().storage.from(BUCKET).remove(files); // best-effort
  const { error } = await client().from('records').delete().neq('id', '');
  if (error) throw error;
}

// ---------- photos (Supabase Storage) ----------
async function uploadPhoto(file, buffer) {
  const { error } = await client().storage.from(BUCKET).upload(file, buffer, {
    contentType: 'image/jpeg', upsert: true
  });
  if (error) throw error;
}
async function downloadPhoto(file) {
  const { data, error } = await client().storage.from(BUCKET).download(file);
  if (error || !data) return null;
  const ab = await data.arrayBuffer();
  return Buffer.from(ab);
}

// ---------- health check ----------
async function ping() {
  const { error } = await client().from('employees').select('emp_id').limit(1);
  if (error) throw error;
  return true;
}

module.exports = {
  isConfigured, BUCKET,
  listEmployees, findEmployee, upsertEmployee, upsertEmployees, updateEmployee, deleteEmployee, clearEmployees,
  insertRecord, listRecords, recordsByDate, getRecord, updateRecord, deleteRecord, clearRecords,
  uploadPhoto, downloadPhoto, ping
};
