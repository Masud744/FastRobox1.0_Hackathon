/**
 * ColdChain Frontend Dashboard Application Logic
 */

// Application State
const state = {
  currentUser: { username: 'admin', role: 'Admin' },
  token: '',
  fridges: {},
  batches: [],
  telemetryHistory: { fridge_1: [], fridge_2: [] },
  chart: null,
  activeTab: 'dashboard',
  currentPlanId: null
};

// =========================================================================
// 1. INITIALIZATION & WEBSOCKET
// =========================================================================

document.addEventListener('DOMContentLoaded', () => {
  lucide.createIcons();
  setupNavigation();
  initTelemetryChart();
  autoLoginDefault('admin', 'Admin@123');
  connectWebSocket();
  refreshAllData();

  // Polling fallback every 5 seconds
  setInterval(refreshAllData, 5000);
});

function setupNavigation() {
  const tabs = document.querySelectorAll('.nav-tab[data-tab]');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      const target = tab.getAttribute('data-tab');
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
      document.getElementById(`tab-${target}`).classList.add('active');
      state.activeTab = target;

      if (target === 'inventory') loadInventoryData();
      if (target === 'ai-relocation') checkAIRelocation();
      if (target === 'audit') loadAuditLedger();
    });
  });
}

function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;
  const ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    document.getElementById('wsStatus').textContent = 'LIVE (WS)';
    document.getElementById('wsStatus').parentElement.style.color = 'var(--safe-green)';
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'INITIAL_SNAPSHOT') {
        data.fridges.forEach(f => state.fridges[f.id] = f);
        state.batches = data.batches;
        updateFridgeUI();
      } else if (data.type === 'TELEMETRY_UPDATE') {
        refreshAllData();
      } else if (data.type === 'BATCH_RELOCATION_COMPLETED' || data.type === 'DISCARD_ALARM_RESET') {
        refreshAllData();
      }
    } catch (err) {
      console.error('WS parse error:', err);
    }
  };

  ws.onclose = () => {
    document.getElementById('wsStatus').textContent = 'RECONNECTING';
    document.getElementById('wsStatus').parentElement.style.color = 'var(--warning-amber)';
    setTimeout(connectWebSocket, 3000);
  };
}

// =========================================================================
// 2. DATA FETCHING & UI UPDATES
// =========================================================================

async function refreshAllData() {
  try {
    // 1. Fetch Fridges
    const fridgesRes = await fetch('/api/fridges');
    const fridges = await fridgesRes.json();
    fridges.forEach(f => state.fridges[f.id] = f);
    updateFridgeUI();

    // 2. Fetch AI Forecast & Compressor Health for Fridge 1
    fetchAIForecast('fridge_1');
    fetchCompressorHealth('fridge_1');

    // 3. Update Chart
    updateChartData('fridge_1');

    // 4. Update Alarm Banner
    checkGlobalAlarmState();
  } catch (err) {
    console.error('Data refresh error:', err);
  }
}

function updateFridgeUI() {
  ['fridge_1', 'fridge_2'].forEach(id => {
    const f = state.fridges[id];
    if (!f) return;

    // Temperature & Numeric Value
    const tempEl = document.getElementById(`temp-${id}`);
    if (tempEl) {
      tempEl.innerHTML = `${f.current_temp.toFixed(1)}<span class="temp-unit">°C</span>`;
    }

    // Circular SVG Gauge (Circumference 251.2, min -5°C, max 20°C)
    const gaugeEl = document.getElementById(`gauge-${id}`);
    if (gaugeEl) {
      const clamped = Math.max(-5, Math.min(20, f.current_temp));
      const percent = (clamped + 5) / 25; // 0 to 1
      const offset = 251.2 * (1 - percent);
      gaugeEl.style.strokeDashoffset = offset;

      if (f.current_temp < 2.0 || f.current_temp > 8.0) {
        gaugeEl.style.stroke = 'var(--discard-red)';
      } else {
        gaugeEl.style.stroke = 'var(--accent-cyan)';
      }
    }

    // Status Badge
    const statusEl = document.getElementById(`status-${id}`);
    const cardEl = document.getElementById(`card-${id}`);
    if (statusEl) {
      if (f.current_temp >= 2.0 && f.current_temp <= 8.0) {
        statusEl.className = 'status-badge status-safe';
        statusEl.innerHTML = '<i data-lucide="check-circle-2"></i> SAFE (2–8°C)';
        if (cardEl) cardEl.classList.remove('breach');
      } else if (f.current_temp > 8.0 && f.current_temp <= 12.0) {
        statusEl.className = 'status-badge status-warning';
        statusEl.innerHTML = '<i data-lucide="alert-triangle"></i> WARNING (>8°C)';
        if (cardEl) cardEl.classList.remove('breach');
      } else {
        statusEl.className = 'status-badge status-breach';
        statusEl.innerHTML = '<i data-lucide="alert-octagon"></i> BREACH DANGER';
        if (cardEl) cardEl.classList.add('breach');
      }
    }

    // Compressor State
    const compEl = document.getElementById(`comp-${id}`);
    const compIcon = document.getElementById(`compIcon-${id}`);
    if (compEl && compIcon) {
      if (f.compressor_state === 'ON') {
        compEl.textContent = 'COOLING (ON)';
        compEl.style.color = 'var(--accent-cyan)';
        compIcon.className = 'spin-fan';
      } else {
        compEl.textContent = 'IDLE (OFF)';
        compEl.style.color = 'var(--text-main)';
        compIcon.className = '';
      }
    }

    // Door State
    const doorEl = document.getElementById(`door-${id}`);
    const doorIcon = document.getElementById(`doorIcon-${id}`);
    if (doorEl && doorIcon) {
      if (f.door_state === 'OPEN') {
        doorEl.textContent = 'OPEN (>60s alert)';
        doorEl.style.color = 'var(--warning-amber)';
        doorIcon.setAttribute('data-lucide', 'door-open');
      } else {
        doorEl.textContent = 'CLOSED';
        doorEl.style.color = 'var(--text-main)';
        doorIcon.setAttribute('data-lucide', 'door-closed');
      }
    }

    // Power Source
    const powerEl = document.getElementById(`power-${id}`);
    if (powerEl) {
      if (f.power_source === 'BATTERY') {
        powerEl.textContent = 'BATTERY (AC LOST)';
        powerEl.style.color = 'var(--warning-amber)';
      } else {
        powerEl.textContent = 'AC GRID';
        powerEl.style.color = 'var(--safe-green)';
      }
    }
  });

  lucide.createIcons();
}

function checkGlobalAlarmState() {
  const banner = document.getElementById('globalAlarmBanner');
  const bannerText = document.getElementById('globalAlarmText');
  const resetBtn = document.getElementById('alarmResetBtn');

  let hasDiscardAlarm = false;
  let hasDoorAlarm = false;
  let alarmFridgeId = 'fridge_1';

  Object.values(state.fridges).forEach(f => {
    if (f.red_led_latched === 1) {
      hasDiscardAlarm = true;
      alarmFridgeId = f.id;
    }
    if (f.door_state === 'OPEN') {
      hasDoorAlarm = true;
    }
  });

  if (hasDiscardAlarm) {
    banner.classList.add('active');
    bannerText.textContent = `CRITICAL: Discard threshold reached on ${state.fridges[alarmFridgeId]?.name || 'Fridge'}! Red LED latched ON until Admin reset.`;
    resetBtn.style.display = 'block';
  } else if (hasDoorAlarm) {
    banner.classList.add('active');
    bannerText.textContent = 'WARNING: Fridge door is currently OPEN. Close within 60s to prevent buzzer and alert dispatch!';
    resetBtn.style.display = 'none';
  } else {
    banner.classList.remove('active');
  }
}

// =========================================================================
// 3. CHART.JS TELEMETRY & 30-MIN FORECAST
// =========================================================================

function initTelemetryChart() {
  const ctx = document.getElementById('telemetryChart').getContext('2d');
  state.chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: 'Historical Temp (°C)',
          data: [],
          borderColor: '#06b6d4',
          backgroundColor: 'rgba(6, 182, 212, 0.1)',
          fill: true,
          tension: 0.3,
          borderWidth: 2,
          pointRadius: 2
        },
        {
          label: '30-Min AI Forecast',
          data: [],
          borderColor: '#f59e0b',
          borderDash: [6, 4],
          borderWidth: 2.5,
          pointRadius: 4,
          pointBackgroundColor: '#f59e0b',
          fill: false
        },
        {
          label: '8°C Safe Ceiling',
          data: [],
          borderColor: 'rgba(239, 68, 68, 0.6)',
          borderDash: [2, 2],
          borderWidth: 1.5,
          pointRadius: 0,
          fill: false
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: { color: '#94a3b8', font: { family: 'Inter', size: 11 } }
        }
      },
      scales: {
        x: {
          ticks: { color: '#64748b', maxTicksLimit: 8 },
          grid: { color: 'rgba(255, 255, 255, 0.04)' }
        },
        y: {
          min: 0,
          max: 15,
          ticks: { color: '#64748b', callback: val => `${val}°C` },
          grid: { color: 'rgba(255, 255, 255, 0.04)' }
        }
      }
    }
  });
}

async function updateChartData(fridgeId) {
  try {
    const res = await fetch(`/api/telemetry/recent/${fridgeId}?limit=15`);
    const logs = await res.json();
    if (!logs || logs.length === 0) return;

    const labels = logs.map(l => new Date(l.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    const data = logs.map(l => l.temperature);

    // Get 30-min AI prediction
    const forecastRes = await fetch(`/api/ai/forecast/${fridgeId}`);
    const forecast = await forecastRes.json();

    const futureTime = new Date(Date.now() + 30 * 60000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    // Build forecast dataset (extends from last point)
    const forecastData = new Array(logs.length - 1).fill(null);
    forecastData.push(data[data.length - 1]);
    forecastData.push(forecast.predictedTemp30Min);

    const extendedLabels = [...labels, `+30m (${futureTime})`];
    const safeCeiling = new Array(extendedLabels.length).fill(8.0);

    state.chart.data.labels = extendedLabels;
    state.chart.data.datasets[0].data = data;
    state.chart.data.datasets[1].data = forecastData;
    state.chart.data.datasets[2].data = safeCeiling;
    state.chart.update('none');

    // Update forecast badge
    const badge = document.getElementById('aiForecastBadge');
    if (forecast.isBreachPredicted) {
      badge.className = 'status-badge status-breach';
      badge.innerHTML = `<i data-lucide="alert-triangle"></i> Breach in ~${forecast.minutesToBreach || '<30'}m (${forecast.predictedTemp30Min}°C)`;
    } else {
      badge.className = 'status-badge status-safe';
      badge.innerHTML = `<i data-lucide="check-circle-2"></i> Safe: ${forecast.predictedTemp30Min}°C in 30m`;
    }
    lucide.createIcons();
  } catch (err) {
    console.error('Chart update error:', err);
  }
}

async function fetchAIForecast(fridgeId) {
  try {
    const res = await fetch(`/api/ai/forecast/${fridgeId}`);
    return await res.json();
  } catch (err) {
    return null;
  }
}

async function fetchCompressorHealth(fridgeId) {
  try {
    const res = await fetch(`/api/ai/compressor-health/${fridgeId}`);
    const health = await res.json();
    const scoreEl = document.getElementById('compHealthBigScore');
    const diagEl = document.getElementById('compHealthDiagnostic');

    if (scoreEl && diagEl) {
      scoreEl.innerHTML = `${health.score}<span style="font-size: 1.5rem; color: var(--accent-cyan);">/100</span>`;
      diagEl.textContent = `${health.diagnostic} (Cooling rate: ${health.coolingRatePerMin}°C/min)`;
    }

    const cardHealthEl = document.getElementById(`healthScore-${fridgeId}`);
    if (cardHealthEl) {
      cardHealthEl.textContent = `${health.score} / 100 (${health.status})`;
    }
  } catch (err) {}
}

// =========================================================================
// 4. VACCINE INVENTORY TABLE & PUBLIC QR CHECK
// =========================================================================

async function loadInventoryData() {
  try {
    const res = await fetch('/api/batches');
    const batches = await res.json();
    state.batches = batches;

    const tbody = document.getElementById('batchTableBody');
    tbody.innerHTML = '';

    batches.forEach(b => {
      const remainingMinutes = Math.max(0, b.total_budget_mins - b.consumed_budget_mins);
      const remainingPercent = (remainingMinutes / b.total_budget_mins) * 100.0;

      let statusBadge = '<span class="status-badge status-safe">Safe</span>';
      let progressClass = 'budget-bar-safe';

      if (b.status === 'At Risk') {
        statusBadge = '<span class="status-badge status-warning">At Risk (&lt;20%)</span>';
        progressClass = 'budget-bar-risk';
      } else if (b.status === 'Discard') {
        statusBadge = '<span class="status-badge status-breach">Discard (0%)</span>';
        progressClass = 'budget-bar-discard';
      }

      const fridgeName = state.fridges[b.fridge_id]?.name || b.fridge_id;

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>
          <div style="font-family: var(--font-mono); font-weight: 700; color: var(--accent-cyan);">${b.id}</div>
          <div style="font-size: 0.75rem; color: var(--text-dim);">${b.qr_code}</div>
        </td>
        <td>
          <div style="font-weight: 600;">${b.name}</div>
          <div style="font-size: 0.8rem; color: var(--text-muted);">${b.type}</div>
        </td>
        <td>
          <span style="font-family: var(--font-mono); font-size: 0.85rem;">${fridgeName}</span>
        </td>
        <td>
          <div class="budget-progress-container">
            <div class="budget-bar-bg">
              <div class="budget-bar-fill ${progressClass}" style="width: ${remainingPercent}%;"></div>
            </div>
            <div class="budget-meta">
              <span>${remainingMinutes.toFixed(1)}m left</span>
              <span>${remainingPercent.toFixed(0)}%</span>
            </div>
          </div>
        </td>
        <td>${statusBadge}</td>
        <td style="font-family: var(--font-mono); font-size: 0.85rem;">${b.expiry_date}</td>
        <td>
          <button class="action-btn" onclick="openQrModal('${b.id}', '${b.name}', '${b.qr_code}')">
            <i data-lucide="qr-code"></i> QR Code
          </button>
        </td>
      `;
      tbody.appendChild(tr);
    });

    lucide.createIcons();
  } catch (err) {
    console.error('Inventory error:', err);
  }
}

function openQrModal(batchId, batchName, qrCode) {
  document.getElementById('qrModalTitle').textContent = batchName;
  document.getElementById('qrModalDesc').textContent = `Serial ID: ${batchId} | QR: ${qrCode}`;

  const publicUrl = `${window.location.origin}/verify/${batchId}`;
  document.getElementById('qrPublicLink').href = publicUrl;

  // Render QR Code using QRious
  new QRious({
    element: document.getElementById('qrCanvas'),
    value: publicUrl,
    size: 200,
    background: '#ffffff',
    foreground: '#0f172a'
  });

  document.getElementById('qrModal').classList.add('open');
}

function closeQrModal() {
  document.getElementById('qrModal').classList.remove('open');
}

// =========================================================================
// 5. AI RELOCATION ADVISOR & 1-CLICK ACTION
// =========================================================================

async function checkAIRelocation() {
  try {
    const res = await fetch('/api/ai/clinical-brief/fridge_1');
    const data = await res.json();
    const plan = data.plan;
    const brief = data.brief;
    state.currentPlanId = plan.planId;

    const titleEl = document.getElementById('relocationTitle');
    const reasonEl = document.getElementById('relocationReason');
    const btn = document.getElementById('oneClickRelocateBtn');
    const detailsEl = document.getElementById('relocationPlanDetails');

    let briefHtml = '';
    if (brief && brief.text) {
      briefHtml = `
        <div style="margin-top: 1.25rem; padding: 1.2rem; background: rgba(59, 130, 246, 0.1); border-left: 4px solid var(--accent-cyan); border-radius: 8px;">
          <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem;">
            <span style="font-size: 0.75rem; font-weight: 700; background: var(--accent-cyan); color: #000; padding: 2px 8px; border-radius: 4px;">GROQ AI CLINICAL ADVISOR</span>
            <span style="font-size: 0.75rem; color: var(--text-muted);">${brief.source || 'LLM Agent'}</span>
          </div>
          <p style="color: #e2e8f0; font-size: 0.95rem; line-height: 1.6; white-space: pre-line;">${brief.text}</p>
        </div>
      `;
    }

    if (plan.isRelocationRecommended) {
      titleEl.innerHTML = `<span style="color: var(--warning-amber);">⚠ Action Required: Move Batches to ${plan.targetFridgeName}</span>`;
      reasonEl.textContent = plan.reason;
      btn.style.display = 'flex';

      detailsEl.innerHTML = `
        <div style="margin-bottom: 1rem; color: #ffffff;">
          <strong>Source:</strong> ${plan.sourceFridgeName} ➔ <strong>Destination:</strong> ${plan.targetFridgeName}
        </div>
        <p style="margin-bottom: 0.75rem;"><strong>Batches prioritized for evacuation:</strong></p>
        <ul style="padding-left: 1.25rem;">
          ${plan.batchesToRelocate.map(b => `
            <li style="margin-bottom: 0.35rem;">
              <strong>${b.name}</strong> (${b.batchId}) — ${b.remainingMinutes} mins budget remaining [${b.status}]
            </li>
          `).join('')}
        </ul>
        ${briefHtml}
      `;
    } else {
      titleEl.textContent = 'Thermal Conditions Optimal';
      reasonEl.textContent = 'All storage compartments are safely maintained at 2–8°C. No relocation required.';
      btn.style.display = 'none';
      detailsEl.innerHTML = `
        <div>Continuous monitoring active. Relocation advisor will trigger immediately if predictive breach or compressor degradation occurs.</div>
        ${briefHtml}
      `;
    }
    lucide.createIcons();
  } catch (err) {
    console.error('Error fetching AI relocation:', err);
  }
}

async function executeOneClickRelocation() {
  if (!state.currentPlanId) return;

  try {
    const res = await fetch('/api/ai/relocation-confirm', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.token}`
      },
      body: JSON.stringify({ planId: state.currentPlanId })
    });

    const data = await res.json();
    if (res.ok) {
      alert(`✔ 1-Click Relocation Executed!\n${data.relocatedCount} batches successfully evacuated to ${data.to}. Logged to cryptographic audit chain.`);
      refreshAllData();
      checkAIRelocation();
    } else {
      alert(`✘ Relocation Failed: ${data.message || data.error}`);
    }
  } catch (err) {
    alert('Network error executing relocation.');
  }
}

// =========================================================================
// 6. CRYPTOGRAPHIC HASH CHAIN AUDIT & TAMPER PROOFS
// =========================================================================

async function loadAuditLedger() {
  try {
    const res = await fetch('/api/audit/chain?limit=25');
    const logs = await res.json();

    const tbody = document.getElementById('auditTableBody');
    tbody.innerHTML = '';

    logs.forEach(log => {
      const timeStr = new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td style="font-family: var(--font-mono); font-weight: 700;">#${log.id}</td>
        <td style="color: var(--text-dim); font-size: 0.8rem;">${timeStr}</td>
        <td>
          <span class="role-tag role-pharmacist">${log.event_type}</span>
        </td>
        <td style="font-size: 0.85rem;">${log.actor}</td>
        <td class="hash-cell">${log.previous_hash.substring(0, 16)}...</td>
        <td class="hash-cell" style="color: var(--safe-green);">${log.current_hash.substring(0, 16)}...</td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {}
}

async function handleVerifyChainIntegrity() {
  try {
    const res = await fetch('/api/audit/verify-integrity');
    const result = await res.json();

    const titleEl = document.getElementById('integrityModalTitle');
    const iconEl = document.getElementById('integrityModalIcon');
    const headerEl = document.getElementById('integrityModalHeader');
    const detailsEl = document.getElementById('integrityModalDetails');

    if (result.valid) {
      titleEl.textContent = 'Ledger Verification Passed';
      iconEl.innerHTML = '<i data-lucide="shield-check" style="width: 54px; height: 54px; color: var(--safe-green);"></i>';
      headerEl.textContent = 'Cryptographic Integrity 100% Valid';
      headerEl.style.color = 'var(--safe-green)';
      detailsEl.textContent = `All ${result.totalRecords} blocks successfully verified from Genesis to Head. Head hash: ${result.headHash.substring(0, 24)}... Zero tampering detected.`;
    } else {
      titleEl.textContent = 'CRITICAL: Ledger Tampering Detected!';
      iconEl.innerHTML = '<i data-lucide="shield-alert" style="width: 54px; height: 54px; color: var(--discard-red);"></i>';
      headerEl.textContent = `Corrupted Block Caught: Row #${result.compromisedRowId}`;
      headerEl.style.color = 'var(--discard-red)';
      detailsEl.textContent = `Reason: ${result.reason}. ${result.details}`;
    }

    lucide.createIcons();
    document.getElementById('integrityModal').classList.add('open');
  } catch (err) {
    alert('Verification error.');
  }
}

async function handleSimulateTamper() {
  try {
    const res = await fetch('/api/audit/simulate-tamper', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.token}`
      },
      body: JSON.stringify({ rowId: 2, fakeData: { tamperedNote: 'MALICIOUS_RECORD_ALTERATION' } })
    });
    const data = await res.json();
    alert(`Judges Demonstration: Record #2 was intentionally modified in SQLite without recomputing hash chain.\n\nNow click "Verify Integrity" to watch the cryptographic detector catch the fraud!`);
    loadAuditLedger();
  } catch (err) {
    alert('Must be logged in as Admin or Inspector to simulate tamper.');
  }
}

function closeIntegrityModal() {
  document.getElementById('integrityModal').classList.remove('open');
}

// =========================================================================
// 7. ADMIN RESET & RBAC AUTHENTICATION
// =========================================================================

async function handleAdminAlarmReset() {
  if (state.currentUser.role !== 'Admin') {
    alert('Only Admin role can reset the latched discard alarm. Please switch to Admin role.');
    openLoginModal();
    return;
  }

  try {
    const res = await fetch('/api/admin/reset-discard-alarm', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.token}`
      },
      body: JSON.stringify({ fridgeId: 'fridge_1', note: 'Admin verified and reset latched alarm' })
    });
    if (res.ok) {
      alert('✔ Latched Red LED alarm successfully reset by Admin.');
      refreshAllData();
    } else {
      const data = await res.json();
      alert(`Error: ${data.message}`);
    }
  } catch (err) {
    alert('Reset request failed.');
  }
}

function openLoginModal() {
  document.getElementById('loginModal').classList.add('open');
}

function closeLoginModal() {
  document.getElementById('loginModal').classList.remove('open');
}

function autoFillLogin() {
  const role = document.getElementById('loginRoleSelect').value;
  if (role === 'admin') {
    document.getElementById('loginUsername').value = 'admin';
    document.getElementById('loginPassword').value = 'Admin@123';
  } else if (role === 'pharmacist') {
    document.getElementById('loginUsername').value = 'pharmacist';
    document.getElementById('loginPassword').value = 'Pharma@123';
  } else {
    document.getElementById('loginUsername').value = 'inspector';
    document.getElementById('loginPassword').value = 'Inspect@123';
  }
}

async function handleLoginSubmit() {
  const u = document.getElementById('loginUsername').value;
  const p = document.getElementById('loginPassword').value;

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u, password: p })
    });
    const data = await res.json();

    if (res.ok) {
      state.currentUser = data.user;
      state.token = data.token;
      updateUserRoleBadge();
      closeLoginModal();
      alert(`Logged in successfully as ${data.user.username} (${data.user.role})`);
    } else {
      alert(`Login failed: ${data.message || data.error}`);
    }
  } catch (err) {
    alert('Login network error.');
  }
}

async function autoLoginDefault(username, password) {
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (res.ok) {
      state.currentUser = data.user;
      state.token = data.token;
      updateUserRoleBadge();
    }
  } catch (err) {}
}

function updateUserRoleBadge() {
  document.getElementById('currentUsername').textContent = state.currentUser.username;
  const roleTag = document.getElementById('currentRoleTag');
  roleTag.textContent = state.currentUser.role;
  roleTag.className = `role-tag role-${state.currentUser.role.toLowerCase()}`;
}

async function openAIReportModal() {
  try {
    const res = await fetch('/api/ai/report');
    const r = await res.json();

    const c = document.getElementById('aiReportContent');
    c.innerHTML = `
      <h4 style="color: #ffffff; margin-bottom: 0.5rem; font-size: 1.1rem;">${r.title}</h4>
      <p style="margin-bottom: 1rem;">${r.executiveSummary}</p>
      
      <div style="background: rgba(255,255,255,0.03); padding: 1rem; border-radius: 8px; margin-bottom: 1rem;">
        <h5 style="color: var(--accent-cyan); margin-bottom: 0.35rem;">1. ${r.models[0].name}</h5>
        <p><strong>MAE:</strong> ${r.models[0].performanceMetrics.meanAbsoluteError} | <strong>Lead Time:</strong> ${r.models[0].performanceMetrics.earlyBreachDetectionLeadTime}</p>
        <p><strong>Precision:</strong> ${r.models[0].performanceMetrics.precisionAt8CBreach} | <strong>Recall:</strong> ${r.models[0].performanceMetrics.recallAt8CBreach}</p>
      </div>

      <div style="background: rgba(255,255,255,0.03); padding: 1rem; border-radius: 8px;">
        <h5 style="color: #3b82f6; margin-bottom: 0.35rem;">2. ${r.models[1].name}</h5>
        <p><strong>Features:</strong> ${r.models[1].features.map(f => f.name).join(', ')}</p>
        <p><strong>Scoring:</strong> 80-100 (Optimal), 50-79 (Degrading), 0-49 (Critical Risk)</p>
      </div>
    `;

    document.getElementById('aiReportModal').classList.add('open');
  } catch (err) {}
}

function closeAIReportModal() {
  document.getElementById('aiReportModal').classList.remove('open');
}
