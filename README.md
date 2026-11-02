# ColdChain — Vaccine & Medicine Storage Monitor

[![Node.js](https://img.shields.io/badge/Node.js-v24.x-green.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/Tests-30%2F30%20PASS-brightgreen.svg)]()
[![Security](https://img.shields.io/badge/HMAC--SHA256-Active-cyan.svg)]()
[![Ledger](https://img.shields.io/badge/Cryptographic%20Hash%20Chain-Verified-emerald.svg)]()

> **Total Marks:** 100  
> **Problem Statement:** Vaccines and insulin can lose effectiveness when stored outside **2–8°C**. ColdChain is an enterprise-grade IoT & AI cold-chain monitoring system that monitors fridge conditions, tracks vaccine heat exposure, maintains safe temperature automatically, enforces cryptographic audit trails, and provides a full-stack real-time web application.

---

## 🚀 Key Features Implemented

### 1. Dual Fridge Monitoring & Digital Twin
* **Dual ESP32 Node Architecture:** Monitors Fridge 1 (Primary) and Fridge 2 (Reserve).
* **Live Sensors:** Temperature tracking, door open/closed detection with open duration counter, AC Grid vs Backup Battery power mode reporting.
* **Compressor Hysteresis & Delay:**
  * Compressor **ON** at $\ge 7^\circ\text{C}$ (pull down cooling).
  * Compressor **OFF** at $\le 3^\circ\text{C}$.
  * **60-Second Minimum Off-Time Protection:** Prevents short-cycling compressor damage.

### 2. Heat-Exposure Budget Engine (Vaccine Shelf-Life Tracker)
* **60-Minute Budget:** Cumulative 60-minute heat exposure budget above $8^\circ\text{C}$.
* **Double Penalty Above 12°C:** Exposure above $12^\circ\text{C}$ counts **double (2x penalty)**.
* **Tiered Alerts:**
  * Remaining budget $< 20\%$ ($<12$ mins): Status transitions to **`At Risk`**.
  * Remaining budget reaches $0\%$: Status transitions to **`Discard`**.
  * **Latched Red LED Alarm:** Discard triggers a physical Red LED that stays **latched ON** until an authorized `Admin` resets it.

### 3. Resilience, Offline Mode & Deduplication
* **30-Minute Edge Buffering:** Buffers at least 30 minutes of telemetry during Wi-Fi or network outages.
* **Order-Preserving Deduplication:** Synchronizes buffered readings chronologically, dropping duplicate packets by nonce and timestamp.
* **Door Open >60s Alarm:** Door left open for over 60 seconds triggers local buzzer alert + automated multi-channel remote alerts (Telegram & Email).
* **Power Failure Simulation:** Simulates grid power loss and switches to Battery mode with instant alerting.

### 4. Enterprise Security & Cryptographic Audit Ledger
* **Device Security:** `HMAC-SHA256` signature + `timestamp` + `nonce` validation. Replayed nonces and tampered payloads are immediately blocked.
* **Cryptographic Hash Chain:** Blockchain-style immutable SHA-256 ledger:
  $$H_i = \text{SHA256}(H_{i-1} \,\|\, \text{Timestamp} \,\|\, \text{EventType} \,\|\, \text{Actor} \,\|\, \text{Payload})$$
* **"Verify Integrity" Engine:** Live verification traversing all blocks from Genesis to Head to detect unauthorized database tampering.
* **Zero-Login Public QR Portal:** Anyone can scan a batch QR code or visit `/verify/[batchId]` to verify safety status (`Safe`, `At Risk`, `Discard`) and expiry date without authentication.
* **JWT + bcrypt RBAC:** Strict server-side permission enforcement for **`Admin`**, **`Pharmacist`**, and **`Inspector`**.

### 5. AI Breach Prediction & 1-Click Relocation
* **30-Minute Temperature Forecasting:** Predicts temperature trajectory 30 minutes in advance, providing predictive warnings before an $8^\circ\text{C}$ breach occurs.
* **Compressor Health Scoring (0–100):** Monitors cooling pull-down rate ($\Delta T / \Delta t$) during compressor ON cycles to detect mechanical wear or refrigerant leaks.
* **Smart Relocation Recommendation:** Intelligently assesses capacity in the reserve fridge and suggests prioritized batch evacuation.
* **1-Click Relocation Confirmation:** Pharmacist can confirm and execute batch relocation with a single click.

---

## 🛠️ Tech Stack

* **Backend:** Node.js, Express, WebSocket (`ws`), `better-sqlite3` (WAL mode).
* **Security:** Native `crypto` (HMAC-SHA256, timingSafeEqual, SHA-256 chain), `bcryptjs`, `jsonwebtoken`.
* **Frontend:** Bespoke Glassmorphism Dark Mode UI, Chart.js, Lucide Icons, QRious.

---

## 🏁 Quick Start Guide

### 1. Installation & Dependencies
```bash
git clone https://github.com/Masud744/FastRobox1.0_Hackathon.git
cd FastRobox1.0_Hackathon/backend
npm install
```

### 2. Run All Automated Test Suites
ColdChain includes 30 automated integration tests covering security, business logic, AI, and APIs:
```bash
# Run Phase 1 Tests (DB, RBAC, HMAC Security, Hash Chain)
node tests/test_phase1.js

# Run Phase 2 Tests (Heat Budget, 30m Offline Sync, Door/Power Alerts)
node tests/test_phase2.js

# Run Phase 3 Tests (AI 30m Forecast, Compressor Health, Relocation)
node tests/test_phase3.js

# Run API Integration Tests
node tests/test_api_server.js
```

### 3. Start the Server
```bash
npm start
```
* **Dashboard:** [http://localhost:5000](http://localhost:5000)
* **Public QR Check:** [http://localhost:5000/verify/BATCH-CV19-001](http://localhost:5000/verify/BATCH-CV19-001)

### 4. Default RBAC Credentials
| Role | Username | Password | Permissions |
|:---|:---|:---|:---|
| **Admin** | `admin` | `Admin@123` | Full system control, Discard Red LED alarm reset |
| **Pharmacist** | `pharmacist` | `Pharma@123` | Batch inventory management, 1-Click Relocation confirmation |
| **Inspector** | `inspector` | `Inspect@123` | Read-only audit log review, Cryptographic integrity check |

---

## 📡 REST API Summary

| Method | Endpoint | Description | Role / Auth |
|:---|:---|:---|:---|
| `POST` | `/api/auth/login` | JWT login with role issuance | Public |
| `GET` | `/api/fridges` | Live dual fridge telemetry snapshot | Public |
| `POST` | `/api/telemetry` | Secure device ingest with HMAC + nonce | Device Secret |
| `POST` | `/api/telemetry/offline-sync` | 30-minute offline buffer sync | Device Secret |
| `GET` | `/api/batches` | Vaccine batch inventory & heat budgets | Public |
| `GET` | `/api/batches/public-verify/:id` | **Public QR verification certificate** | **Zero Login** |
| `GET` | `/api/ai/forecast/:fridgeId` | 30-minute ahead temperature prediction | Public |
| `GET` | `/api/ai/compressor-health/:fridgeId` | 0–100 compressor health diagnostic | Public |
| `POST` | `/api/ai/relocation-confirm` | 1-Click batch relocation execution | Pharmacist, Admin |
| `GET` | `/api/audit/verify-integrity` | Cryptographic ledger proof validation | Public |
| `POST` | `/api/audit/simulate-tamper` | Demonstration of tampering detection | Admin, Inspector |
| `POST` | `/api/admin/reset-discard-alarm` | Reset latched Red LED discard alarm | Admin |
