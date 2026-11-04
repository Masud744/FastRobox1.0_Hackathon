/**
 * ColdChain Frontend Dashboard Application Logic
 * Comprehensive SaaS UI/UX & Real-time Telemetry Management
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
// 1. INITIALIZATION & SESSION RESTORATION
// =========================================================================

document.addEventListener('DOMContentLoaded', async () => {
  setupNavigation();
  initTelemetryChart();
  initGlobalEventListeners();
  
  // Restore or initialize authentication
  await initAuthSession();
  
  connectWebSocket();
  refreshAllData();

  // Polling fallback every 5 seconds
  setInterval(refreshAllData, 5000);
});

/**
 * Setup Tab Navigation
 */
function setupNavigation() {
  const tabs = document.querySelectorAll('.nav-tab[data-tab]');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.getAttribute('data-tab');
      navigateToTab(target);
    });
  });
}

function navigateToTab(target) {
  const tabs = document.querySelectorAll('.nav-tab[data-tab]');
  tabs.forEach(t => {
    if (t.getAttribute('data-tab') === target) {
      t.classList.add('active');
    } else {
      t.classList.remove('active');
    }
  });

  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  const targetPane = document.getElementById(`tab-${target}`);
  if (targetPane) targetPane.classList.add('active');
  state.activeTab = target;

  if (target === 'inventory') loadInventoryData();
  if (target === 'ai-relocation') checkAIRelocation();
  if (target === 'audit') loadAuditLedger();
}

/**
 * Global click listener for closing dropdowns on outside click
 */
function initGlobalEventListeners() {
  document.addEventListener('click', (e) => {
    const dropdown = document.getElementById('userDropdown');
    const profileBtn = document.getElementById('userProfileBtn');
    if (dropdown && profileBtn) {
      if (!dropdown.contains(e.target) && !profileBtn.contains(e.target)) {
        dropdown.classList.remove('open');
      }
    }
  });

  // ESC key closes any open modal
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-backdrop.open').forEach(m => m.classList.remove('open'));
      closeUserDropdown();
    }
  });
}

// =========================================================================
// 2. DEFENSIVE TOAST NOTIFICATION SYSTEM (/ui-ux-design)
// =========================================================================

function showToast(title, message, type = 'info', duration = 3800) {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;

  let iconName = 'info';
  if (type === 'success') iconName = 'check-circle-2';
  if (type === 'error') iconName = 'alert-octagon';
  if (type === 'warning') iconName = 'alert-triangle';

  toast.innerHTML = `
    <div class="toast-icon">
      <i data-lucide="${iconName}"></i>
    </div>
    <div class="toast-body">
      <div class="toast-title">${title}</div>
      <div class="toast-message">${message}</div>
    </div>
    <button class="toast-close" onclick="this.closest('.toast').remove()" aria-label="Close">
      <i data-lucide="x" style="width: 14px; height: 14px;"></i>
    </button>
  `;

  container.appendChild(toast);
  lucide.createIcons();

  setTimeout(() => {
    toast.classList.add('removing');
    setTimeout(() => toast.remove(), 260);
  }, duration);
}

// =========================================================================
// 3. AUTHENTICATION & RBAC (SIGN IN, SIGN UP, SESSION)
// =========================================================================

/**
 * Check and restore stored session from localStorage
 */
async function initAuthSession() {
  const savedToken = localStorage.getItem('coldchain_token');
  const savedUser = localStorage.getItem('coldchain_user');

  if (savedToken && savedUser) {
    try {
      state.token = savedToken;
      state.currentUser = JSON.parse(savedUser);

      // Verify token with backend
      const res = await fetch('/api/auth/me', {
        headers: { 'Authorization': `Bearer ${savedToken}` }
      });

      if (res.ok) {
        const data = await res.json();
        state.currentUser = data.user;
        updateUserUI();
        return;
      }
    } catch (e) {
      console.warn('Session verification failed, falling back to default admin');
    }
  }

  // Default initial sign in as Admin for demo hackathon environment
  await autoLoginDefault('admin', 'Admin@123');
}

/**
 * Perform login request
 */
async function loginUser(username, password) {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });

  const data = await res.json();
  if (res.ok && data.success) {
    state.currentUser = data.user;
    state.token = data.token;
    localStorage.setItem('coldchain_token', data.token);
    localStorage.setItem('coldchain_user', JSON.stringify(data.user));
    updateUserUI();
    return { success: true, user: data.user };
  } else {
    return { success: false, error: data.message || data.error || 'Authentication failed' };
  }
}

/**
 * Perform registration request
 */
async function registerUser(username, password, role) {
  const res = await fetch('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, role })
  });

  const data = await res.json();
  if (res.ok && data.success) {
    state.currentUser = data.user;
    state.token = data.token;
    localStorage.setItem('coldchain_token', data.token);
    localStorage.setItem('coldchain_user', JSON.stringify(data.user));
    updateUserUI();
    return { success: true, user: data.user };
  } else {
    return { success: false, error: data.message || data.error || 'Registration failed' };
  }
}

async function autoLoginDefault(username, password) {
  try {
    const result = await loginUser(username, password);
    if (!result.success) {
      console.warn('Auto-login default fallback notice:', result.error);
    }
  } catch (err) {
    console.error('Auto login error:', err);
  }
}

function updateUserUI() {
  const username = state.currentUser.username || 'User';
  const role = state.currentUser.role || 'Pharmacist';

  // Header badges
  const userEl = document.getElementById('currentUsername');
  const roleTag = document.getElementById('currentRoleTag');
  const avatar = document.getElementById('userAvatar');

  if (userEl) userEl.textContent = username;
  if (roleTag) {
    roleTag.textContent = role;
    roleTag.className = `role-tag role-${role.toLowerCase()}`;
  }
  if (avatar) {
    avatar.textContent = username.charAt(0).toUpperCase();
    if (role === 'Admin') avatar.style.borderColor = 'var(--role-admin)';
    else if (role === 'Pharmacist') avatar.style.borderColor = 'var(--role-pharmacist)';
    else avatar.style.borderColor = 'var(--role-inspector)';
  }

  // Dropdown text
  const dropUser = document.getElementById('dropUsername');
  const dropRole = document.getElementById('dropUserRole');
  if (dropUser) dropUser.textContent = username;
  if (dropRole) dropRole.textContent = `Active Role: ${role}`;

  // Update quick switch buttons active state
  ['admin', 'pharmacist', 'inspector'].forEach(r => {
    const btn = document.getElementById(`btnSwitch${r.charAt(0).toUpperCase() + r.slice(1, 6)}`);
    if (btn) {
      if (role.toLowerCase() === r) btn.classList.add('active');
      else btn.classList.remove('active');
    }
  });

  lucide.createIcons();
}

/**
 * Handle Sign In form submit
 */
async function handleLoginSubmit() {
  const usernameInput = document.getElementById('loginUsername');
  const passwordInput = document.getElementById('loginPassword');
  const submitBtn = document.getElementById('btnSignInSubmit');

  const username = usernameInput.value.trim();
  const password = passwordInput.value;

  if (!username || !password) {
    showToast('Missing Credentials', 'Please enter both username and password.', 'warning');
    return;
  }

  submitBtn.disabled = true;
  submitBtn.innerHTML = '<span class="pulse-dot" style="display:inline-block; width:8px; height:8px;"></span> Signing In...';

  try {
    const result = await loginUser(username, password);
    if (result.success) {
      closeAuthModal();
      showToast('Authentication Successful', `Welcome back, ${result.user.username} (${result.user.role}).`, 'success');
      refreshAllData();
    } else {
      showToast('Sign In Failed', result.error, 'error');
    }
  } catch (err) {
    showToast('Network Error', 'Unable to reach the authentication service.', 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = '<i data-lucide="log-in" style="width: 18px; height: 18px;"></i> Sign In';
    lucide.createIcons();
  }
}

/**
 * Handle Sign Up form submit
 */
async function handleRegisterSubmit() {
  const usernameInput = document.getElementById('regUsername');
  const passwordInput = document.getElementById('regPassword');
  const confirmInput = document.getElementById('regConfirmPassword');
  const roleInput = document.getElementById('regRole');
  const submitBtn = document.getElementById('btnSignUpSubmit');

  const username = usernameInput.value.trim();
  const password = passwordInput.value;
  const confirmPassword = confirmInput.value;
  const role = roleInput.value;

  if (!username || !password) {
    showToast('Validation Error', 'Username and password are required.', 'warning');
    return;
  }

  if (password.length < 6) {
    showToast('Weak Password', 'Password must be at least 6 characters.', 'warning');
    return;
  }

  if (password !== confirmPassword) {
    showToast('Password Mismatch', 'The two passwords do not match. Please re-enter.', 'warning');
    return;
  }

  submitBtn.disabled = true;
  submitBtn.innerHTML = '<span class="pulse-dot" style="display:inline-block; width:8px; height:8px;"></span> Creating Account...';

  try {
    const result = await registerUser(username, password, role);
    if (result.success) {
      closeAuthModal();
      showToast('Account Created!', `Welcome to ColdChain, ${result.user.username}. You are signed in as ${result.user.role}.`, 'success');
      refreshAllData();
    } else {
      showToast('Registration Error', result.error, 'error');
    }
  } catch (err) {
    showToast('Network Error', 'Registration request failed.', 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = '<i data-lucide="user-plus" style="width: 18px; height: 18px;"></i> Create Account & Sign In';
    lucide.createIcons();
  }
}

function handleLogout() {
  localStorage.removeItem('coldchain_token');
  localStorage.removeItem('coldchain_user');
  state.currentUser = { username: 'Guest', role: 'Inspector' };
  state.token = '';
  updateUserUI();
  showToast('Signed Out', 'You have been safely signed out. Operating in guest inspection mode.', 'info');
}

/**
 * Quick Role Switcher for hackathon testing
 */
async function handleQuickRoleSwitch(role) {
  let u = 'admin';
  let p = 'Admin@123';

  if (role === 'pharmacist') {
    u = 'pharmacist';
    p = 'Pharma@123';
  } else if (role === 'inspector') {
    u = 'inspector';
    p = 'Inspect@123';
  }

  const result = await loginUser(u, p);
  if (result.success) {
    closeUserDropdown();
    showToast('Role Switched', `Active session switched to ${result.user.username} (${result.user.role}).`, 'success');
    refreshAllData();
  } else {
    showToast('Role Switch Failed', result.error, 'error');
  }
}

function toggleUserDropdown(e) {
  if (e) e.stopPropagation();
  const dropdown = document.getElementById('userDropdown');
  if (dropdown) dropdown.classList.toggle('open');
}

function closeUserDropdown() {
  const dropdown = document.getElementById('userDropdown');
  if (dropdown) dropdown.classList.remove('open');
}

function openAuthModal(initialTab = 'signin') {
  switchAuthTab(initialTab);
  document.getElementById('authModal').classList.add('open');
}

function closeAuthModal() {
  document.getElementById('authModal').classList.remove('open');
}

function switchAuthTab(tab) {
  const btnSignIn = document.getElementById('tabBtnSignIn');
  const btnSignUp = document.getElementById('tabBtnSignUp');
  const paneSignIn = document.getElementById('authPaneSignIn');
  const paneSignUp = document.getElementById('authPaneSignUp');
  const modalTitle = document.getElementById('authModalTitle');

  if (tab === 'signin') {
    btnSignIn.classList.add('active');
    btnSignUp.classList.remove('active');
    paneSignIn.style.display = 'block';
    paneSignUp.style.display = 'none';
    modalTitle.textContent = 'Sign In to ColdChain';
  } else {
    btnSignUp.classList.add('active');
    btnSignIn.classList.remove('active');
    paneSignUp.style.display = 'block';
    paneSignIn.style.display = 'none';
    modalTitle.textContent = 'Create New ColdChain Account';
  }
  lucide.createIcons();
}

function quickFillLogin(role) {
  const uInput = document.getElementById('loginUsername');
  const pInput = document.getElementById('loginPassword');

  if (role === 'admin') {
    uInput.value = 'admin';
    pInput.value = 'Admin@123';
  } else if (role === 'pharmacist') {
    uInput.value = 'pharmacist';
    pInput.value = 'Pharma@123';
  } else {
    uInput.value = 'inspector';
    pInput.value = 'Inspect@123';
  }
}

function selectRegisterRole(role) {
  document.getElementById('regRole').value = role;
  const cards = {
    'Pharmacist': document.getElementById('cardRolePharm'),
    'Inspector': document.getElementById('cardRoleInspect'),
    'Admin': document.getElementById('cardRoleAdmin')
  };

  Object.keys(cards).forEach(r => {
    if (cards[r]) {
      if (r === role) cards[r].classList.add('selected');
      else cards[r].classList.remove('selected');
    }
  });
}

function togglePasswordVisibility(inputId, btn) {
  const input = document.getElementById(inputId);
  if (!input) return;

  if (input.type === 'password') {
    input.type = 'text';
    btn.innerHTML = '<i data-lucide="eye-off"></i>';
  } else {
    input.type = 'password';
    btn.innerHTML = '<i data-lucide="eye"></i>';
  }
  lucide.createIcons();
}

// =========================================================================
// 4. WEBSOCKET & REAL-TIME INGESTION
// =========================================================================

function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;
  const ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    const el = document.getElementById('wsStatus');
    if (el) {
      el.textContent = 'LIVE (WS & HiveMQ)';
      el.parentElement.style.color = 'var(--safe-green)';
    }
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
      } else if (data.type === 'BATCH_RELOCATION_COMPLETED' || data.type === 'DISCARD_ALARM_RESET' || data.type === 'BATCH_REGISTERED') {
        refreshAllData();
      }
    } catch (err) {
      console.error('WS parse error:', err);
    }
  };

  ws.onclose = () => {
    const el = document.getElementById('wsStatus');
    if (el) {
      el.textContent = 'RECONNECTING';
      el.parentElement.style.color = 'var(--warning-amber)';
    }
    setTimeout(connectWebSocket, 3000);
  };
}

// =========================================================================
// 5. DATA REFRESH & DIGITAL TWIN UI
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

    // 5. Reload Inventory if active
    if (state.activeTab === 'inventory') {
      loadInventoryData();
    }
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
        statusEl.innerHTML = '<i data-lucide="check-circle-2" style="width: 14px; height: 14px;"></i> SAFE (2–8°C)';
        if (cardEl) cardEl.classList.remove('breach');
      } else if (f.current_temp > 8.0 && f.current_temp <= 12.0) {
        statusEl.className = 'status-badge status-warning';
        statusEl.innerHTML = '<i data-lucide="alert-triangle" style="width: 14px; height: 14px;"></i> WARNING (>8°C)';
        if (cardEl) cardEl.classList.remove('breach');
      } else {
        statusEl.className = 'status-badge status-breach';
        statusEl.innerHTML = '<i data-lucide="alert-octagon" style="width: 14px; height: 14px;"></i> BREACH DANGER';
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
// 6. CHART.JS TELEMETRY & 30-MIN AI PREDICTION
// =========================================================================

function initTelemetryChart() {
  const canvas = document.getElementById('telemetryChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

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
          borderWidth: 2.2,
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
          borderColor: 'rgba(239, 68, 68, 0.65)',
          borderDash: [3, 3],
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
    if (!logs || logs.length === 0 || !state.chart) return;

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
    if (badge) {
      if (forecast.isBreachPredicted) {
        badge.className = 'status-badge status-breach';
        badge.innerHTML = `<i data-lucide="alert-triangle" style="width: 14px; height: 14px;"></i> Breach in ~${forecast.minutesToBreach || '<30'}m (${forecast.predictedTemp30Min}°C)`;
      } else {
        badge.className = 'status-badge status-safe';
        badge.innerHTML = `<i data-lucide="check-circle-2" style="width: 14px; height: 14px;"></i> Safe: ${forecast.predictedTemp30Min}°C in 30m`;
      }
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
// 7. VACCINE INVENTORY & BATCH CREATION
// =========================================================================

async function loadInventoryData() {
  try {
    const res = await fetch('/api/batches');
    const batches = await res.json();
    state.batches = batches;

    const tbody = document.getElementById('batchTableBody');
    if (!tbody) return;
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
          <div style="font-size: 0.72rem; color: var(--text-dim);">${b.qr_code}</div>
        </td>
        <td>
          <div style="font-weight: 600; color: #ffffff;">${b.name}</div>
          <div style="font-size: 0.8rem; color: var(--text-muted);">${b.type}</div>
        </td>
        <td>
          <span style="font-family: var(--font-mono); font-size: 0.85rem; color: var(--text-secondary);">${fridgeName}</span>
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
        <td style="font-family: var(--font-mono); font-size: 0.85rem; color: var(--text-secondary);">${b.expiry_date}</td>
        <td>
          <div style="display: flex; gap: 0.4rem; align-items: center;">
            <button class="action-btn" onclick="openQrModal('${b.id}', '${b.name}', '${b.qr_code}')">
              <i data-lucide="qr-code" style="width: 14px; height: 14px;"></i> QR
            </button>
            <button class="action-btn" onclick="openMoveBatchModal('${b.id}', '${b.name}', '${b.fridge_id}')">
              <i data-lucide="arrow-right-left" style="width: 14px; height: 14px;"></i> Move
            </button>
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    });

    lucide.createIcons();
  } catch (err) {
    console.error('Inventory error:', err);
  }
}

function openAddBatchModal() {
  if (state.currentUser.role !== 'Admin' && state.currentUser.role !== 'Pharmacist') {
    showToast('Permission Denied', 'Only Pharmacists and Admins can register new vaccine batches. Please switch role.', 'warning');
    return;
  }
  document.getElementById('addBatchModal').classList.add('open');
}

function closeAddBatchModal() {
  document.getElementById('addBatchModal').classList.remove('open');
}

async function handleAddBatchSubmit() {
  const id = document.getElementById('newBatchId').value.trim();
  const name = document.getElementById('newBatchName').value.trim();
  const type = document.getElementById('newBatchType').value;
  const fridge_id = document.getElementById('newBatchFridge').value;
  const expiry_date = document.getElementById('newBatchExpiry').value;
  const total_budget_mins = parseFloat(document.getElementById('newBatchBudget').value) || 60;
  const submitBtn = document.getElementById('btnAddBatchSubmit');

  if (!id || !name || !expiry_date) {
    showToast('Incomplete Batch Data', 'Please fill all required fields.', 'warning');
    return;
  }

  submitBtn.disabled = true;
  submitBtn.innerHTML = '<span class="pulse-dot" style="display:inline-block; width:8px; height:8px;"></span> Registering Batch...';

  try {
    const res = await fetch('/api/batches', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.token}`
      },
      body: JSON.stringify({ id, name, type, fridge_id, expiry_date, total_budget_mins })
    });

    const data = await res.json();
    if (res.ok) {
      closeAddBatchModal();
      showToast('Batch Registered!', `Batch ${id} (${name}) registered and mirrored to Supabase.`, 'success');
      document.getElementById('addBatchForm').reset();
      loadInventoryData();
    } else {
      showToast('Registration Error', data.error || 'Failed to create batch.', 'error');
    }
  } catch (err) {
    showToast('Network Error', 'Failed to submit batch to server.', 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = '<i data-lucide="plus-circle" style="width: 18px; height: 18px;"></i> Register Vaccine Batch';
    lucide.createIcons();
  }
}

function openMoveBatchModal(batchId, batchName, currentFridgeId) {
  if (state.currentUser.role !== 'Admin' && state.currentUser.role !== 'Pharmacist') {
    showToast('Permission Denied', 'Only Pharmacists and Admins can move vaccine batches between fridges.', 'warning');
    return;
  }
  document.getElementById('moveBatchId').value = batchId;
  document.getElementById('moveBatchName').textContent = batchName;
  document.getElementById('moveBatchCode').textContent = `Batch ID: ${batchId}`;
  
  const targetSelect = document.getElementById('moveTargetFridge');
  targetSelect.value = currentFridgeId === 'fridge_1' ? 'fridge_2' : 'fridge_1';

  document.getElementById('moveBatchModal').classList.add('open');
  lucide.createIcons();
}

function closeMoveBatchModal() {
  document.getElementById('moveBatchModal').classList.remove('open');
}

async function handleMoveBatchSubmit() {
  const batchId = document.getElementById('moveBatchId').value;
  const targetFridgeId = document.getElementById('moveTargetFridge').value;
  const submitBtn = document.getElementById('btnMoveBatchSubmit');

  submitBtn.disabled = true;
  submitBtn.innerHTML = '<span class="pulse-dot" style="display:inline-block; width:8px; height:8px;"></span> Moving Batch...';

  try {
    const res = await fetch(`/api/batches/${encodeURIComponent(batchId)}/move`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.token}`
      },
      body: JSON.stringify({ targetFridgeId })
    });
    const data = await res.json();
    if (res.ok) {
      closeMoveBatchModal();
      showToast('Batch Moved!', data.message || `Batch relocated successfully.`, 'success');
      loadInventoryData();
      refreshAllData();
    } else {
      showToast('Move Failed', data.error || 'Failed to move batch.', 'error');
    }
  } catch (err) {
    showToast('Network Error', 'Error executing batch move request.', 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = '<i data-lucide="arrow-right-left" style="width: 18px; height: 18px;"></i> Confirm Transfer & Log Audit';
    lucide.createIcons();
  }
}

function openQrModal(batchId, batchName, qrCode) {
  document.getElementById('qrModalTitle').textContent = batchName;
  document.getElementById('qrModalDesc').textContent = `Serial ID: ${batchId} | QR: ${qrCode}`;

  const publicUrl = `${window.location.origin}/verify/${batchId}`;
  document.getElementById('qrPublicLink').href = publicUrl;

  new QRious({
    element: document.getElementById('qrCanvas'),
    value: publicUrl,
    size: 200,
    background: '#ffffff',
    foreground: '#0f172a'
  });

  document.getElementById('qrModal').classList.add('open');
  lucide.createIcons();
}

function closeQrModal() {
  document.getElementById('qrModal').classList.remove('open');
}

// =========================================================================
// 8. GROQ AI CLINICAL ADVISOR MODAL & INTEGRATION
// =========================================================================

async function openGroqClinicalBrief(fridgeId = 'fridge_1') {
  const modal = document.getElementById('groqAdvisorModal');
  const content = document.getElementById('groqAdvisorContent');
  modal.classList.add('open');

  content.innerHTML = `
    <div style="text-align: center; padding: 2.5rem; color: var(--text-muted);">
      <div class="pulse-dot" style="margin: 0 auto 1.25rem; width: 14px; height: 14px;"></div>
      <p style="font-size: 0.95rem; color: #ffffff; font-weight: 600;">Consulting Groq Qwen 3.8-27B Inference Engine...</p>
      <p style="font-size: 0.8rem; margin-top: 0.35rem;">Analyzing temperature telemetry, compressor hysteresis, and heat exposure logs.</p>
    </div>
  `;

  try {
    const res = await fetch(`/api/ai/clinical-brief/${fridgeId}`);
    const data = await res.json();
    const brief = data.brief || {};
    const plan = data.plan || {};

    const source = brief.source || 'Groq Cloud (qwen/qwen3.8-27b)';
    const text = brief.text || 'Telemetry assessment nominal. Cold chain integrity intact.';

    content.innerHTML = `
      <div class="groq-brief-card">
        <div class="groq-brief-header">
          <div style="display: flex; align-items: center; gap: 0.5rem;">
            <i data-lucide="shield-alert" style="color: var(--accent-cyan); width: 18px; height: 18px;"></i>
            <span style="font-weight: 700; color: #ffffff; font-size: 0.95rem;">Telemetry Context Assessment</span>
          </div>
          <span class="groq-model-pill">${source}</span>
        </div>
        <p style="color: var(--text-secondary); font-size: 0.9rem; line-height: 1.6; white-space: pre-line;">${text}</p>
      </div>

      <div class="groq-brief-card" style="margin-bottom: 0;">
        <h4 style="font-size: 0.85rem; color: var(--text-dim); text-transform: uppercase; margin-bottom: 0.6rem;">Operational Evacuation Status</h4>
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <div>
            <div style="font-weight: 700; color: #ffffff;">${plan.isRelocationRecommended ? 'Relocation Recommended' : 'Optimal Storage Parameters'}</div>
            <div style="font-size: 0.8rem; color: var(--text-muted);">${plan.reason || 'Storage maintained at target range.'}</div>
          </div>
          ${plan.isRelocationRecommended ? `
            <button class="btn-primary-action" onclick="closeGroqAdvisorModal(); navigateToTab('ai-relocation');">
              <i data-lucide="shuffle" style="width: 14px; height: 14px;"></i> View Evacuation Plan
            </button>
          ` : `
            <span class="status-badge status-safe"><i data-lucide="check" style="width: 14px; height: 14px;"></i> Nominal</span>
          `}
        </div>
      </div>
    `;
    lucide.createIcons();
  } catch (err) {
    content.innerHTML = `
      <div style="padding: 1.5rem; background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.3); border-radius: 8px; color: #f87171;">
        <h4 style="margin-bottom: 0.5rem; font-weight: 700;">Clinical Advisory Service Error</h4>
        <p style="font-size: 0.85rem;">Failed to fetch Groq clinical analysis. Please check network connectivity.</p>
      </div>
    `;
  }
}

function closeGroqAdvisorModal() {
  document.getElementById('groqAdvisorModal').classList.remove('open');
}

// =========================================================================
// 9. AI RELOCATION ADVISOR & 1-CLICK ACTION
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
        <p style="margin-bottom: 0.75rem; color: #ffffff;"><strong>Batches prioritized for evacuation:</strong></p>
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

  if (state.currentUser.role !== 'Admin' && state.currentUser.role !== 'Pharmacist') {
    showToast('Permission Denied', 'Only Pharmacists or Admins can confirm batch relocations.', 'warning');
    return;
  }

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
      showToast('Relocation Executed', `${data.relocatedCount} batches successfully relocated to ${data.to}. Logged to SHA-256 audit chain.`, 'success');
      refreshAllData();
      checkAIRelocation();
    } else {
      showToast('Relocation Failed', data.message || data.error, 'error');
    }
  } catch (err) {
    showToast('Network Error', 'Error executing relocation request.', 'error');
  }
}

// =========================================================================
// 10. CRYPTOGRAPHIC HASH CHAIN AUDIT & TAMPER PROOFS
// =========================================================================

async function loadAuditLedger() {
  try {
    const res = await fetch('/api/audit/chain?limit=25');
    const logs = await res.json();

    const tbody = document.getElementById('auditTableBody');
    if (!tbody) return;
    tbody.innerHTML = '';

    logs.forEach(log => {
      const timeStr = new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td style="font-family: var(--font-mono); font-weight: 700; color: #ffffff;">#${log.id}</td>
        <td style="color: var(--text-dim); font-size: 0.8rem;">${timeStr}</td>
        <td>
          <span class="role-tag role-pharmacist">${log.event_type}</span>
        </td>
        <td style="font-size: 0.85rem; color: var(--text-secondary);">${log.actor}</td>
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
      showToast('Ledger Validated', 'All SHA-256 hashes successfully recomputed without discrepancy.', 'success');
    } else {
      titleEl.textContent = 'CRITICAL: Ledger Tampering Detected!';
      iconEl.innerHTML = '<i data-lucide="shield-alert" style="width: 54px; height: 54px; color: var(--discard-red);"></i>';
      headerEl.textContent = `Corrupted Block Caught: Row #${result.compromisedRowId}`;
      headerEl.style.color = 'var(--discard-red)';
      detailsEl.textContent = `Reason: ${result.reason}. ${result.details}`;
      showToast('Tamper Detected', `Fraud detected at Block #${result.compromisedRowId}!`, 'error');
    }

    lucide.createIcons();
    document.getElementById('integrityModal').classList.add('open');
  } catch (err) {
    showToast('Verification Error', 'Failed to communicate with audit verification engine.', 'error');
  }
}

async function handleSimulateTamper() {
  if (state.currentUser.role !== 'Admin' && state.currentUser.role !== 'Inspector') {
    showToast('Permission Denied', 'Must be logged in as Admin or Inspector to simulate tampering.', 'warning');
    return;
  }

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
    showToast('Tamper Injected (Judges Test)', 'Record #2 was modified in SQLite without recomputing hash chain. Click "Verify Integrity" to test!', 'warning', 6000);
    loadAuditLedger();
  } catch (err) {
    showToast('Tamper Failed', 'Unable to execute tamper simulation.', 'error');
  }
}

function closeIntegrityModal() {
  document.getElementById('integrityModal').classList.remove('open');
}

// =========================================================================
// 11. HARDWARE ALARM RESET & AI RESEARCH REPORT
// =========================================================================

async function handleAdminAlarmReset() {
  if (state.currentUser.role !== 'Admin') {
    showToast('Admin Required', 'Only Admin role can reset the latched discard alarm.', 'warning');
    openAuthModal('signin');
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
      showToast('Alarm Reset', 'Latched Red LED alarm successfully reset by Admin.', 'success');
      refreshAllData();
    } else {
      const data = await res.json();
      showToast('Reset Failed', data.message || 'Error executing alarm reset.', 'error');
    }
  } catch (err) {
    showToast('Network Error', 'Reset request failed.', 'error');
  }
}

async function openAIReportModal() {
  try {
    const res = await fetch('/api/ai/report');
    const r = await res.json();

    const c = document.getElementById('aiReportContent');
    c.innerHTML = `
      <h4 style="color: #ffffff; margin-bottom: 0.5rem; font-size: 1.15rem; font-family: var(--font-heading);">${r.title}</h4>
      <p style="margin-bottom: 1rem; color: var(--text-secondary);">${r.executiveSummary}</p>
      
      <div style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); padding: 1rem; border-radius: 8px; margin-bottom: 1rem;">
        <h5 style="color: var(--accent-cyan); margin-bottom: 0.35rem; font-size: 1rem;">1. ${r.models[0].name}</h5>
        <p><strong>MAE:</strong> ${r.models[0].performanceMetrics.meanAbsoluteError} | <strong>Lead Time:</strong> ${r.models[0].performanceMetrics.earlyBreachDetectionLeadTime}</p>
        <p><strong>Precision:</strong> ${r.models[0].performanceMetrics.precisionAt8CBreach} | <strong>Recall:</strong> ${r.models[0].performanceMetrics.recallAt8CBreach}</p>
      </div>

      <div style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); padding: 1rem; border-radius: 8px;">
        <h5 style="color: #3b82f6; margin-bottom: 0.35rem; font-size: 1rem;">2. ${r.models[1].name}</h5>
        <p><strong>Features:</strong> ${r.models[1].features.map(f => f.name).join(', ')}</p>
        <p><strong>Scoring:</strong> 80-100 (Optimal), 50-79 (Degrading), 0-49 (Critical Risk)</p>
      </div>
    `;

    document.getElementById('aiReportModal').classList.add('open');
  } catch (err) {
    showToast('Report Error', 'Failed to load AI model report.', 'error');
  }
}

function closeAIReportModal() {
  document.getElementById('aiReportModal').classList.remove('open');
}
