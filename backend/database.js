const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

const dbPath = path.resolve(__dirname, 'coldchain.db');
const db = new Database(dbPath);

// Enable WAL mode for high performance and concurrency
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function initializeDatabase() {
  db.exec(`
    -- Users & RBAC
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT CHECK(role IN ('Admin', 'Pharmacist', 'Inspector')) NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Fridges Table
    CREATE TABLE IF NOT EXISTS fridges (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      target_min_temp REAL DEFAULT 3.0,
      target_max_temp REAL DEFAULT 7.0,
      current_temp REAL DEFAULT 4.5,
      compressor_state TEXT DEFAULT 'OFF',
      compressor_last_switched INTEGER DEFAULT 0,
      door_state TEXT DEFAULT 'CLOSED',
      door_last_opened INTEGER DEFAULT 0,
      power_source TEXT DEFAULT 'GRID',
      red_led_latched INTEGER DEFAULT 0,
      last_seen INTEGER DEFAULT 0
    );

    -- Vaccine Batches
    CREATE TABLE IF NOT EXISTS vaccine_batches (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      fridge_id TEXT NOT NULL,
      expiry_date TEXT NOT NULL,
      total_budget_mins REAL DEFAULT 60.0,
      consumed_budget_mins REAL DEFAULT 0.0,
      status TEXT CHECK(status IN ('Safe', 'At Risk', 'Discard')) DEFAULT 'Safe',
      qr_code TEXT UNIQUE NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (fridge_id) REFERENCES fridges(id)
    );

    -- Telemetry Readings
    CREATE TABLE IF NOT EXISTS telemetry_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fridge_id TEXT NOT NULL,
      temperature REAL NOT NULL,
      door_state TEXT NOT NULL,
      door_open_seconds INTEGER DEFAULT 0,
      power_source TEXT NOT NULL,
      compressor_state TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      nonce TEXT,
      FOREIGN KEY (fridge_id) REFERENCES fridges(id)
    );

    -- Cryptographic Tamper-Evident Hash Chain
    CREATE TABLE IF NOT EXISTS audit_log_chain (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      record_data TEXT NOT NULL,
      actor TEXT DEFAULT 'system',
      previous_hash TEXT NOT NULL,
      current_hash TEXT NOT NULL
    );

    -- Device Nonce Cache (Replay Protection)
    CREATE TABLE IF NOT EXISTS device_nonces (
      nonce TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL
    );

    -- Alerts Table
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fridge_id TEXT NOT NULL,
      alert_type TEXT NOT NULL,
      message TEXT NOT NULL,
      severity TEXT CHECK(severity IN ('INFO', 'WARNING', 'CRITICAL')) NOT NULL,
      timestamp INTEGER NOT NULL,
      resolved INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_telemetry_fridge_time ON telemetry_logs(fridge_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_audit_chain_time ON audit_log_chain(timestamp);
  `);

  seedInitialData();
}

function seedInitialData() {
  // 1. Seed Default Users
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  if (userCount === 0) {
    const salt = bcrypt.genSaltSync(10);
    const insertUser = db.prepare(`
      INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)
    `);

    insertUser.run('admin', bcrypt.hashSync('Admin@123', salt), 'Admin');
    insertUser.run('pharmacist', bcrypt.hashSync('Pharma@123', salt), 'Pharmacist');
    insertUser.run('inspector', bcrypt.hashSync('Inspect@123', salt), 'Inspector');
    console.log('Seeded 3 default RBAC users (admin, pharmacist, inspector).');
  }

  // 2. Seed Default Fridges
  const fridgeCount = db.prepare('SELECT COUNT(*) as count FROM fridges').get().count;
  if (fridgeCount === 0) {
    const insertFridge = db.prepare(`
      INSERT INTO fridges (id, name, target_min_temp, target_max_temp, current_temp, compressor_state, door_state, power_source, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const now = Date.now();
    insertFridge.run('fridge_1', 'Main Cold Room (Fridge 1)', 3.0, 7.0, 4.2, 'OFF', 'CLOSED', 'GRID', now);
    insertFridge.run('fridge_2', 'Relocation Reserve (Fridge 2)', 3.0, 7.0, 3.8, 'OFF', 'CLOSED', 'GRID', now);
    console.log('Seeded 2 cold-chain fridges (Fridge 1 & Fridge 2).');
  }

  // 3. Seed Sample Vaccine Batches
  const batchCount = db.prepare('SELECT COUNT(*) as count FROM vaccine_batches').get().count;
  if (batchCount === 0) {
    const insertBatch = db.prepare(`
      INSERT INTO vaccine_batches (id, name, type, fridge_id, expiry_date, total_budget_mins, consumed_budget_mins, status, qr_code)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertBatch.run('BATCH-CV19-001', 'Pfizer-BioNTech Comirnaty', 'mRNA Vaccine', 'fridge_1', '2027-06-30', 60.0, 0.0, 'Safe', 'QR-CV19-001-A9Z');
    insertBatch.run('BATCH-INS-002', 'Insulin Glargine Lantus', 'Long-acting Insulin', 'fridge_1', '2026-12-31', 60.0, 4.5, 'Safe', 'QR-INS-002-K3P');
    insertBatch.run('BATCH-MMR-003', 'MMR (Measles, Mumps, Rubella)', 'Live Attenuated', 'fridge_1', '2027-03-15', 60.0, 49.0, 'At Risk', 'QR-MMR-003-L7X');
    insertBatch.run('BATCH-HEPB-004', 'Hepatitis B Recombinant', 'Recombinant Protein', 'fridge_2', '2027-11-20', 60.0, 1.2, 'Safe', 'QR-HEPB-004-R2W');
    insertBatch.run('BATCH-BCG-005', 'BCG Tuberculosis Vaccine', 'Live Bacterial', 'fridge_2', '2026-10-15', 60.0, 0.0, 'Safe', 'QR-BCG-005-M8Q');
    console.log('Seeded 5 sample vaccine batches.');
  }

  // 4. Seed Genesis Block in Audit Log Chain if empty
  const auditCount = db.prepare('SELECT COUNT(*) as count FROM audit_log_chain').get().count;
  if (auditCount === 0) {
    const crypto = require('crypto');
    const genesisTime = Date.now();
    const genesisData = JSON.stringify({ message: 'Genesis Block - ColdChain Audit Ledger Initialized' });
    const genesisPrevHash = '0'.repeat(64);
    const genesisMessage = `${genesisPrevHash}:${genesisTime}:GENESIS_BLOCK:system:${genesisData}`;
    const genesisHash = crypto.createHash('sha256').update(genesisMessage).digest('hex');

    db.prepare(`
      INSERT INTO audit_log_chain (timestamp, event_type, record_data, actor, previous_hash, current_hash)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(genesisTime, 'GENESIS_BLOCK', genesisData, 'system', genesisPrevHash, genesisHash);
    console.log('Genesis block created for cryptographic Hash-Chain audit log.');
  }
}

// Auto-initialize when module is loaded
initializeDatabase();

module.exports = db;
