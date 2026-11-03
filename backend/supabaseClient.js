const { createClient } = require('@supabase/supabase-js');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.resolve(__dirname, '.env') });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

let supabase = null;
if (supabaseUrl && supabaseKey) {
  try {
    supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false }
    });
    console.log('[Supabase] Initialized cloud mirror client successfully.');
  } catch (err) {
    console.error('[Supabase] Client init failed:', err.message);
  }
}

function isSupabaseConfigured() {
  return supabase !== null;
}

/**
 * Asynchronously mirror fridge state to Supabase
 */
async function mirrorFridgeState(fridge) {
  if (!supabase || !fridge) return;
  try {
    const { error } = await supabase
      .from('fridges')
      .upsert({
        id: fridge.id,
        name: fridge.name,
        target_min_temp: fridge.target_min_temp,
        target_max_temp: fridge.target_max_temp,
        current_temp: fridge.current_temp,
        compressor_state: fridge.compressor_state,
        compressor_last_switched: fridge.compressor_last_switched,
        door_state: fridge.door_state,
        door_last_opened: fridge.door_last_opened,
        power_source: fridge.power_source,
        red_led_latched: fridge.red_led_latched,
        last_seen: fridge.last_seen || Date.now()
      });
    if (error) console.error('[Supabase Mirror] Fridge update error:', error.message);
  } catch (err) {
    console.error('[Supabase Mirror] Fridge exception:', err.message);
  }
}

/**
 * Asynchronously mirror telemetry reading to Supabase
 */
async function mirrorTelemetryLog(log) {
  if (!supabase || !log) return;
  try {
    const { error } = await supabase
      .from('telemetry_logs')
      .insert({
        fridge_id: log.fridge_id,
        temperature: log.temperature,
        door_state: log.door_state,
        door_open_seconds: log.door_open_seconds || 0,
        power_source: log.power_source || 'GRID',
        compressor_state: log.compressor_state || 'OFF',
        timestamp: log.timestamp || Date.now(),
        nonce: log.nonce || null
      });
    if (error) console.error('[Supabase Mirror] Telemetry log error:', error.message);
  } catch (err) {
    console.error('[Supabase Mirror] Telemetry exception:', err.message);
  }
}

/**
 * Asynchronously mirror vaccine batch updates to Supabase
 */
async function mirrorBatchUpdate(batchId, fields) {
  if (!supabase || !batchId) return;
  try {
    const { error } = await supabase
      .from('vaccine_batches')
      .update({
        ...fields,
        updated_at: new Date().toISOString()
      })
      .eq('id', batchId);
    if (error) console.error('[Supabase Mirror] Batch update error:', error.message);
  } catch (err) {
    console.error('[Supabase Mirror] Batch exception:', err.message);
  }
}

/**
 * Asynchronously mirror audit log entry to Supabase
 */
async function mirrorAuditLog(entry) {
  if (!supabase || !entry) return;
  try {
    const { error } = await supabase
      .from('audit_log_chain')
      .insert({
        timestamp: entry.timestamp,
        event_type: entry.event_type,
        record_data: typeof entry.record_data === 'string' ? entry.record_data : JSON.stringify(entry.record_data),
        actor: entry.actor || 'system',
        previous_hash: entry.previous_hash,
        current_hash: entry.current_hash
      });
    if (error) console.error('[Supabase Mirror] Audit log error:', error.message);
  } catch (err) {
    console.error('[Supabase Mirror] Audit exception:', err.message);
  }
}

/**
 * Asynchronously mirror alert to Supabase
 */
async function mirrorAlert(alert) {
  if (!supabase || !alert) return;
  try {
    const { error } = await supabase
      .from('alerts')
      .insert({
        fridge_id: alert.fridge_id,
        alert_type: alert.alert_type,
        message: alert.message,
        severity: alert.severity,
        timestamp: alert.timestamp || Date.now(),
        resolved: alert.resolved || 0
      });
    if (error) console.error('[Supabase Mirror] Alert error:', error.message);
  } catch (err) {
    console.error('[Supabase Mirror] Alert exception:', err.message);
  }
}

module.exports = {
  supabase,
  isSupabaseConfigured,
  mirrorFridgeState,
  mirrorTelemetryLog,
  mirrorBatchUpdate,
  mirrorAuditLog,
  mirrorAlert
};
