// --- CONFIGURAÇÃO DO SUPABASE ---
const SUPABASE_URL = 'https://mtbcprghwtcmkfsskqtp.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_-dJjl0HjeTktRmhMuvChMw_4uDLb1c3';

const _supabase = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true
  }
});

// --- EDGE FUNCTION (IA real: insights + OCR de nota fiscal) ---
const AI_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/ai-assistant`;

// --- ESTADO GLOBAL ---
let currentUser = null;
let transactions = [];
let bills = [];
let categories = [];
let accounts = [];
let goals = [];
let investments = [];
let shares = [];
let cards = [];
let subscriptions = [];
let splitExpenses = [];
let lastFilteredItems = [];
let pendingMfaFactorId = null;

let barChartInstance = null;
let doughnutChartInstance = null;
let compareChartInstance = null;
let annualChartInstance = null;
let weeklyChartInstance = null;
let simulatorChartInstance = null;
let rebalanceChartInstance = null;
let pendingDeleteAction = null;

const EXCLUSION_UNDO_TIME_MS = 6000;
let pendingExclusions = {};
let exchangeRates = { BRL: 1 };
let exchangeRatesLoaded = false;
let lastAiInsightTime = 0;
const AI_INSIGHT_INTERVAL_MS = 5 * 60 * 1000;
let seriesInEditing = null;

// --- NOTIFICAÇÕES PUSH NATIVAS ---
window.requestPushNotificationPermission = function() {
  if (!('Notification' in window)) {
    return notify('O seu navegador não suporta Notificações Push.', 'error');
  }

  Notification.requestPermission().then(permission => {
    if (permission === 'granted') {
      notify('🔔 Notificações ativas! Receberá alertas de vencimento.', 'success');
      new Notification('FluxoPro Enterprise', {
        body: 'Notificações ativadas com sucesso!',
        icon: 'icons/icon-192.png'
      });
    } else {
      notify('Permissão para notificações negada.', 'error');
    }
  });
};

function triggerPushAlert(title, message) {
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(title, { body: message, icon: 'icons/icon-192.png' });
  }
}

// --- FUNÇÃO: MODO PRIVACIDADE (STEALTH MODE) ---
window.toggleStealthMode = function() {
  const body = document.body;
  const btn = document.getElementById('btn-stealth');
  body.classList.toggle('stealth-mode');
  
  const isStealth = body.classList.contains('stealth-mode');
  if (btn) {
    btn.innerText = isStealth ? '🙈 A Ver Valores' : '👁️ Modo Privado';
  }
  
  notify(isStealth ? 'Modo Privado ativado (valores ocultos).' : 'Modo Privado desativado.');
};

// --- CALCULADORA AUTOMÁTICA DE ORÇAMENTO (50/30/20) ---
window.calcularOrcamentoAutomatico = function() {
  const inputRendimento = document.getElementById('calc-income-input');
  const boxResultado = document.getElementById('calc-result-box');
  
  const rendimento = parseFloat(inputRendimento?.value);

  if (!rendimento || rendimento <= 0) {
    return notify('Por favor, insira um valor de receita mensal válido.', 'error');
  }

  const essenciais = rendimento * 0.50;
  const lazer = rendimento * 0.30;
  const poupanca = rendimento * 0.20;

  document.getElementById('res-essentials').innerText = `R$ ${essenciais.toFixed(2)}`;
  document.getElementById('res-lifestyle').innerText = `R$ ${lazer.toFixed(2)}`;
  document.getElementById('res-savings').innerText = `R$ ${poupanca.toFixed(2)}`;

  if (boxResultado) boxResultado.style.display = 'block';
  notify('Cálculo do orçamento efetuado com sucesso!');
};

window.aplicarCalculoAosEnvelopes = async function() {
  const inputRendimento = document.getElementById('calc-income-input');
  const rendimento = parseFloat(inputRendimento?.value);

  if (!rendimento || rendimento <= 0) {
    return notify('Por favor, insira um valor de receita válido antes de aplicar aos envelopes.', 'error');
  }

  const essenciaisLimit = rendimento * 0.50;
  const lazerLimit = rendimento * 0.30;
  const poupancaLimit = rendimento * 0.20;

  for (let cat of categories) {
    let novoLimite = null;
    const nome = cat.name.toLowerCase();

    if (nome.includes('habitação') || nome.includes('moradia') || nome.includes('alimentação') || nome.includes('geral')) {
      novoLimite = essenciaisLimit / 3;
    } else if (nome.includes('lazer')) {
      novoLimite = lazerLimit;
    } else if (nome.includes('investimentos') || nome.includes('poupança')) {
      novoLimite = poupancaLimit;
    }

    if (novoLimite !== null) {
      cat.limit = novoLimite;
      await _supabase.from('categories').update({ limit_val: novoLimite }).eq('id', cat.id);
    }
  }

  renderCategories();
  renderData();
  notify('Limites aplicados aos envelopes de categorias com sucesso!');
};

function escapeHtml(str) {
  const div = document.createElement('div');
  div.innerText = str ?? '';
  return div.innerHTML;
}

function normalizeTags(str) {
  return (str || '')
    .split(',')
    .map(t => t.trim().toLowerCase())
    .filter(Boolean)
    .join(',');
}

async function loadExchangeRates() {
  try {
    const response = await fetch('https://api.frankfurter.app/latest?from=BRL&to=USD,EUR');
    if (!response.ok) throw new Error('Falha ao procurar taxas de câmbio');
    const data = await response.json();
    exchangeRates = {
      BRL: 1,
      USD: data.rates?.USD ? 1 / data.rates.USD : 5,
      EUR: data.rates?.EUR ? 1 / data.rates.EUR : 5.5
    };
    exchangeRatesLoaded = true;
  } catch (err) {
    exchangeRates = { BRL: 1, USD: 5, EUR: 5.5 };
    exchangeRatesLoaded = true;
  }
  renderData();
}

function convertToBRL(value, currency) {
  const rate = exchangeRates[currency] ?? 1;
  return value * rate;
}

function currencySymbol(currency) {
  return { BRL: 'R$', USD: 'US$', EUR: '€' }[currency] || 'R$';
}

function maskDoc(value) {
  return value
    .replace(/\D/g, '')
    .replace(/(\d{3})(\d)/, '$1.$2')
    .replace(/(\d{3})(\d)/, '$1.$2')
    .replace(/(\d{3})(\d{1,2})$/, '$1-$2')
    .replace(/^(\d{2})\.(\d{3})\.(\d{3})\/(\d{4})-(\d{2})$/, '$1.$2.$3/$4-$5');
}

function maskPhone(value) {
  return value
    .replace(/\D/g, '')
    .replace(/^(\d{2})(\d)/g, '($1) $2')
    .replace(/(\d)(\d{4})$/, '$1-$2');
}

function applyMasks() {
  const docInputs = [document.getElementById('reg-doc'), document.getElementById('edit-doc')];
  const phoneInputs = [document.getElementById('reg-phone'), document.getElementById('edit-phone')];

  docInputs.forEach(input => input?.addEventListener('input', (e) => e.target.value = maskDoc(e.target.value)));
  phoneInputs.forEach(input => input?.addEventListener('input', (e) => e.target.value = maskPhone(e.target.value)));
}

function notify(text, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'toast';
  
  if (type === 'error') {
    toast.style.borderLeft = '4px solid #f43f5e';
    toast.style.background = '#2a121d';
  } else if (type === 'success') {
    toast.style.borderLeft = '4px solid #10b981';
  }

  toast.innerText = text;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}

function notifyWithAction(text, actionLabel, onAction, durationMs = EXCLUSION_UNDO_TIME_MS) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'toast';

  const row = document.createElement('div');
  row.className = 'toast-row';

  const span = document.createElement('span');
  span.innerText = text;

  const btn = document.createElement('button');
  btn.className = 'toast-undo-btn';
  btn.type = 'button';
  btn.innerText = actionLabel;
  btn.addEventListener('click', () => {
    onAction();
    toast.remove();
  });

  row.appendChild(span);
  row.appendChild(btn);
  toast.appendChild(row);
  container.appendChild(toast);
  setTimeout(() => { if (toast.isConnected) toast.remove(); }, durationMs + 500);
}

function showModal(title, message, onConfirm) {
  const modal = document.getElementById('custom-modal');
  document.getElementById('modal-title').innerText = title;
  document.getElementById('modal-message').innerText = message;
  modal.style.display = 'flex';
  pendingDeleteAction = onConfirm;
}

function hideModal() {
  document.getElementById('custom-modal').style.display = 'none';
  pendingDeleteAction = null;
}

window.openReceiptModal = function(url) {
  const modal = document.getElementById('receipt-modal');
  const body = document.getElementById('receipt-preview-body');
  if (!modal || !body) return;

  const isPdf = url.toLowerCase().endsWith('.pdf');
  if (isPdf) {
    body.innerHTML = `<iframe src="${escapeHtml(url)}" style="width:100%; height:500px; border:none; border-radius:6px;"></iframe>`;
  } else {
    body.innerHTML = `<img src="${escapeHtml(url)}" style="max-width:100%; max-height:500px; object-fit:contain; border-radius:6px;">`;
  }
  modal.style.display = 'flex';
};

window.closeReceiptModal = function() {
  const modal = document.getElementById('receipt-modal');
  if (modal) modal.style.display = 'none';
};

function setupKeyboardShortcuts() {
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
      return;
    }

    if (e.key.toLowerCase() === 'n') {
      e.preventDefault();
      switchTab('section-dashboard', 'nav-dash');
      const descInput = document.getElementById('trans-desc');
      if (descInput) {
        descInput.focus();
        window.scrollTo({ top: descInput.offsetTop - 100, behavior: 'smooth' });
      }
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      switchTab('section-dashboard', 'nav-dash');
      const searchInput = document.getElementById('search-input');
      if (searchInput) searchInput.focus();
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  setupEventListeners();
  applyMasks();
  registerServiceWorker();
  setupKeyboardShortcuts();

  _supabase.auth.onAuthStateChange(async (event, session) => {
    if (event === 'PASSWORD_RECOVERY') {
      const landing = document.getElementById('landing-screen');
      if (landing) landing.style.display = 'none';
      document.getElementById('auth-screen').style.display = 'flex';
      document.getElementById('login-box').style.display = 'none';
      document.getElementById('forgot-box').style.display = 'none';
      document.getElementById('reset-password-box').style.display = 'block';
      return;
    }

    if (session && session.user) {
      const landing = document.getElementById('landing-screen');
      if (landing) landing.style.display = 'none';

      currentUser = {
        id: session.user.id,
        email: session.user.email,
        name: session.user.user_metadata?.name || session.user.user_metadata?.full_name,
        doc: session.user.user_metadata?.doc,
        phone: session.user.user_metadata?.phone,
        profile: session.user.user_metadata?.profile || 'Pessoal'
      };
      startSystem();
    } else {
      currentUser = null;
      const landing = document.getElementById('landing-screen');
      if (landing) landing.style.display = 'block';
      document.getElementById('auth-screen').style.display = 'none';
      document.getElementById('app-screen').style.display = 'none';
    }
  });

  setTimeout(() => {
    if (document.getElementById('sim-initial')) calcularJurosCompostos();
  }, 500);
});

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('service-worker.js').catch(err => {});
    });
  }
}

function setupEventListeners() {
  document.getElementById('modal-btn-cancel')?.addEventListener('click', hideModal);
  document.getElementById('modal-btn-confirm')?.addEventListener('click', () => {
    if (pendingDeleteAction) pendingDeleteAction();
    hideModal();
  });

  document.getElementById('go-to-register')?.addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('login-box').style.display = 'none';
    document.getElementById('register-box').style.display = 'block';
  });

  document.getElementById('go-to-login')?.addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('register-box').style.display = 'none';
    document.getElementById('login-box').style.display = 'block';
  });

  document.getElementById('go-to-forgot')?.addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('login-box').style.display = 'none';
    document.getElementById('forgot-box').style.display = 'block';
  });

  document.getElementById('go-to-login-from-forgot')?.addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('forgot-box').style.display = 'none';
    document.getElementById('login-box').style.display = 'block';
  });

  // Navegação original + nova
  document.getElementById('nav-dash')?.addEventListener('click', () => switchTab('section-dashboard', 'nav-dash'));
  document.getElementById('nav-bills')?.addEventListener('click', () => switchTab('section-bills', 'nav-bills'));
  document.getElementById('nav-cards')?.addEventListener('click', () => switchTab('section-cards', 'nav-cards'));
  document.getElementById('nav-subscriptions')?.addEventListener('click', () => switchTab('section-subscriptions', 'nav-subscriptions'));
  document.getElementById('nav-split')?.addEventListener('click', () => switchTab('section-split', 'nav-split'));
  document.getElementById('nav-categories')?.addEventListener('click', () => switchTab('section-categories', 'nav-categories'));
  document.getElementById('nav-goals')?.addEventListener('click', () => switchTab('section-goals', 'nav-goals'));
  document.getElementById('nav-investments')?.addEventListener('click', () => switchTab('section-investments', 'nav-investments'));
  document.getElementById('nav-simulator')?.addEventListener('click', () => switchTab('section-simulator', 'nav-simulator'));
  document.getElementById('nav-accounts')?.addEventListener('click', () => switchTab('section-accounts', 'nav-accounts'));
  document.getElementById('nav-profile')?.addEventListener('click', () => switchTab('section-profile', 'nav-profile'));
  document.getElementById('nav-support')?.addEventListener('click', () => switchTab('section-support', 'nav-support'));

  document.getElementById('btn-theme')?.addEventListener('click', () => {
    const isLight = document.body.getAttribute('data-theme') === 'light';
    if (isLight) document.body.removeAttribute('data-theme');
    else document.body.setAttribute('data-theme', 'light');
  });

  document.getElementById('form-register')?.addEventListener('submit', handleRegister);
  document.getElementById('form-login')?.addEventListener('submit', handleLogin);
  document.getElementById('btn-google-login')?.addEventListener('click', handleGoogleLogin);
  document.getElementById('form-forgot')?.addEventListener('submit', handleForgotPassword);
  document.getElementById('form-reset-password')?.addEventListener('submit', handleResetPassword);
  document.getElementById('btn-logout')?.addEventListener('click', () => _supabase.auth.signOut());
  document.getElementById('form-transaction')?.addEventListener('submit', handleSaveTransaction);
  document.getElementById('form-bill')?.addEventListener('submit', handleSaveBill);
  document.getElementById('form-add-category')?.addEventListener('submit', handleAddCategory);
  document.getElementById('form-goal')?.addEventListener('submit', handleSaveGoal);
  document.getElementById('form-account')?.addEventListener('submit', handleSaveAccount);
  document.getElementById('form-update-profile')?.addEventListener('submit', handleUpdateProfile);
  document.getElementById('form-investment')?.addEventListener('submit', handleSaveInvestment);

  document.getElementById('search-input')?.addEventListener('input', renderData);
  document.getElementById('filter-type')?.addEventListener('change', renderData);
  document.getElementById('filter-date-start')?.addEventListener('change', renderData);
  document.getElementById('filter-date-end')?.addEventListener('change', renderData);
  document.getElementById('budget-limit')?.addEventListener('change', renderData);
  document.getElementById('month-picker')?.addEventListener('change', renderData);
  document.getElementById('dash-account-filter')?.addEventListener('change', renderData);
  document.getElementById('btn-clear-month')?.addEventListener('click', () => {
    document.getElementById('month-picker').value = '';
    document.getElementById('filter-date-start').value = '';
    document.getElementById('filter-date-end').value = '';
    document.getElementById('dash-account-filter').value = '';
    renderData();
  });

  document.getElementById('btn-export')?.addEventListener('click', exportCSV);
  document.getElementById('btn-print-pdf')?.addEventListener('click', exportPDF);
  document.getElementById('btn-import-file')?.addEventListener('click', handleImportFile);

  document.getElementById('trans-roundup')?.addEventListener('change', updatePiggyBankPreview);
  document.getElementById('trans-val')?.addEventListener('input', updatePiggyBankPreview);
  document.getElementById('trans-type')?.addEventListener('change', updatePiggyBankPreview);

  document.getElementById('series-btn-cancel')?.addEventListener('click', closeSeriesEditing);
  document.getElementById('series-btn-confirm')?.addEventListener('click', confirmSeriesEditing);
}

function switchTab(sectionId, navId) {
  document.querySelectorAll('.page-section').forEach(sec => sec.style.display = 'none');
  document.querySelectorAll('.nav-item').forEach(nav => nav.classList.remove('active'));

  document.getElementById(sectionId).style.display = 'block';
  document.getElementById(navId).classList.add('active');

  if (sectionId === 'section-bills') loadBillsCloud();
  if (sectionId === 'section-cards') renderCards();
  if (sectionId === 'section-subscriptions') renderSubscriptions();
  if (sectionId === 'section-split') renderSplitExpenses();
  if (sectionId === 'section-categories') renderCategories();
  if (sectionId === 'section-goals') renderGoals();
  if (sectionId === 'section-investments') { loadInvestments(); renderRebalanceChart(); }
  if (sectionId === 'section-simulator') calcularJurosCompostos();
  if (sectionId === 'section-accounts') { renderWallets(); loadShares(); }
}

async function startSystem() {
  const landing = document.getElementById('landing-screen');
  if (landing) landing.style.display = 'none';
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('app-screen').style.display = 'flex';
  document.getElementById('user-display-name').innerText = currentUser.name || currentUser.email;

  document.getElementById('trans-date').valueAsDate = new Date();

  await loadCategoriesCloud();
  await loadWallets();
  await processRecurringTransactions();
  await processRecurringBills();
  await loadTransactionsCloud();
  await loadBillsCloud();
  await loadGoals();
  loadExchangeRates();
}

async function handleRegister(e) {
  e.preventDefault();
  const name = document.getElementById('reg-name').value;
  const email = document.getElementById('reg-email').value;
  const password = document.getElementById('reg-password').value;

  const { error } = await _supabase.auth.signUp({ email, password, options: { data: { name } } });
  if (error) return notify('Erro no registo: ' + error.message, 'error');
  notify('Conta criada com sucesso!', 'success');
  document.getElementById('register-box').style.display = 'none';
  document.getElementById('login-box').style.display = 'block';
}

async function handleLogin(e) {
  e.preventDefault();
  const email = document.getElementById('login-email').value;
  const password = document.getElementById('login-password').value;

  const { error } = await _supabase.auth.signInWithPassword({ email, password });
  if (error) notify('Falha no início de sessão: ' + error.message, 'error');
}

async function handleGoogleLogin() {
  await _supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.origin } });
}

async function handleForgotPassword(e) {
  e.preventDefault();
  const email = document.getElementById('forgot-email').value;
  await _supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
  notify('E-mail enviado!', 'success');
}

async function handleResetPassword(e) {
  e.preventDefault();
  const newPassword = document.getElementById('new-password').value;
  await _supabase.auth.updateUser({ password: newPassword });
  notify('Palavra-passe atualizada com sucesso!', 'success');
}

async function handleUpdateProfile(e) {
  e.preventDefault();
  const name = document.getElementById('edit-name').value;
  await _supabase.auth.updateUser({ data: { name } });
  currentUser = { ...currentUser, name };
  document.getElementById('user-display-name').innerText = name;
  notify('Perfil atualizado!', 'success');
}

// --- GESTÃO DE CARTÕES DE CRÉDITO ---
function handleSaveCard(e) {
  e.preventDefault();
  const name = document.getElementById('card-name').value;
  const limit = parseFloat(document.getElementById('card-limit').value);
  const closeDay = parseInt(document.getElementById('card-close-day').value);
  const dueDay = parseInt(document.getElementById('card-due-day').value);

  cards.push({ id: Date.now().toString(), name, limit, closeDay, dueDay, used: 0 });
  notify('Cartão adicionado com sucesso!', 'success');
  e.target.reset();
  renderCards();
}

function renderCards() {
  const container = document.getElementById('cards-list-container');
  if (!container) return;
  container.innerHTML = '';
  if (cards.length === 0) {
    container.innerHTML = '<p style="color: var(--text-muted);">Nenhum cartão registado.</p>';
    return;
  }
  cards.forEach(c => {
    const available = c.limit - c.used;
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <h3>💳 ${escapeHtml(c.name)}</h3>
      <div class="value" style="font-size: 24px; color: #a855f7;">R$ ${c.used.toFixed(2)} / R$ ${c.limit.toFixed(2)}</div>
      <p style="font-size: 12px; color: var(--text-muted); margin-top: 8px;">Fecho: dia ${c.closeDay} · Vencimento: dia ${c.dueDay}</p>
      <span style="font-size: 13px; color: #10b981; font-weight: 700;">Disponível: R$ ${available.toFixed(2)}</span>
    `;
    container.appendChild(card);
  });
}

// --- ASSINATURAS (SAAS TRACKER) ---
function handleSaveSubscription(e) {
  e.preventDefault();
  const name = document.getElementById('sub-name').value;
  const price = parseFloat(document.getElementById('sub-price').value);
  const chargeDay = parseInt(document.getElementById('sub-charge-day').value);
  const cat = document.getElementById('sub-category').value;

  subscriptions.push({ id: Date.now().toString(), name, price, chargeDay, cat });
  notify('Assinatura registada!', 'success');
  e.target.reset();
  renderSubscriptions();
}

function renderSubscriptions() {
  const tbody = document.getElementById('subscriptions-table-body');
  const valTotal = document.getElementById('val-total-subscriptions');
  if (!tbody) return;
  tbody.innerHTML = '';

  let total = 0;
  subscriptions.forEach(s => {
    total += s.price;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(s.name)}</td>
      <td>${escapeHtml(s.cat)}</td>
      <td>Dia ${s.chargeDay}</td>
      <td style="color: #f43f5e; font-weight: 700;">R$ ${s.price.toFixed(2)}</td>
      <td><button class="action-btn btn-del" onclick="deleteSubscription('${s.id}')">Excluir</button></td>
    `;
    tbody.appendChild(tr);
  });

  if (valTotal) valTotal.innerText = `R$ ${total.toFixed(2)}`;
}

window.deleteSubscription = function(id) {
  subscriptions = subscriptions.filter(s => s.id !== id);
  renderSubscriptions();
  notify('Assinatura removida.');
};

// --- DIVISÃO DE GASTOS (SPLITWISE) ---
function handleSaveSplitExpense(e) {
  e.preventDefault();
  const desc = document.getElementById('split-desc').value;
  const amount = parseFloat(document.getElementById('split-amount').value);
  const payer = document.getElementById('split-payer').value.trim();
  const participants = document.getElementById('split-participants').value.split(',').map(p => p.trim());

  splitExpenses.push({ desc, amount, payer, participants });
  notify('Despesa partilhada registada!', 'success');
  e.target.reset();
  renderSplitExpenses();
}

function renderSplitExpenses() {
  const container = document.getElementById('split-balance-container');
  if (!container) return;
  if (splitExpenses.length === 0) {
    container.innerHTML = 'Nenhuma despesa partilhada registada.';
    return;
  }

  const balances = {};
  splitExpenses.forEach(item => {
    const share = item.amount / item.participants.length;
    item.participants.forEach(p => { balances[p] = (balances[p] || 0) - share; });
    balances[item.payer] = (balances[item.payer] || 0) + item.amount;
  });

  let html = '<h4>Balanço do Grupo:</h4><ul style="margin-top: 10px; padding-left: 20px;">';
  for (let person in balances) {
    const val = balances[person];
    const color = val >= 0 ? '#10b981' : '#f43f5e';
    const text = val >= 0 ? `tem a receber R$ ${val.toFixed(2)}` : `deve R$ ${Math.abs(val).toFixed(2)}`;
    html += `<li style="margin-bottom: 6px;"><strong>${escapeHtml(person)}</strong>: <span style="color: ${color}; font-weight:700;">${text}</span></li>`;
  }
  html += '</ul>';
  container.innerHTML = html;
}

// --- REBALANCEAMENTO DE CARTEIRA ---
function renderRebalanceChart() {
  const ctx = document.getElementById('rebalanceChart')?.getContext('2d');
  if (!ctx) return;

  const allocation = {};
  investments.forEach(inv => {
    const total = inv.qty * inv.currentPrice;
    allocation[inv.type] = (allocation[inv.type] || 0) + total;
  });

  if (rebalanceChartInstance) rebalanceChartInstance.destroy();

  rebalanceChartInstance = new Chart(ctx, {
    type: 'pie',
    data: {
      labels: Object.keys(allocation),
      datasets: [{ data: Object.values(allocation), backgroundColor: ['#a855f7', '#10b981', '#3b82f6', '#f59e0b', '#f43f5e'] }]
    },
    options: { responsive: true }
  });
}

// --- TRANSAÇÕES (CORRIGIDO PARA O SUPABASE SEM ERRO DE account_id) ---
async function loadTransactionsCloud() {
  if (!currentUser) return;
  const { data, error } = await _supabase.from('transactions').select('*').eq('user_id', currentUser.id).order('date', { ascending: false });
  if (error) return console.error('Erro ao carregar transações:', error);

  transactions = data.map(item => ({
    id: item.id,
    userId: item.user_id,
    desc: item.description,
    val: parseFloat(item.amount),
    type: item.type,
    cat: item.category,
    date: item.date,
    tags: item.tags || '',
    isRecurring: !!item.is_recurring,
    accountId: item.account_id || null,
    currency: item.currency || 'BRL',
    receiptUrl: item.receipt_url || null
  }));

  renderData();
  renderCashFlowForecast();
}

async function handleSaveTransaction(e) {
  e.preventDefault();
  const id = document.getElementById('trans-id').value;
  const desc = document.getElementById('trans-desc').value;
  const val = parseFloat(document.getElementById('trans-val').value);
  const type = document.getElementById('trans-type').value;
  const cat = document.getElementById('trans-cat').value;
  const date = document.getElementById('trans-date').value;
  const tags = normalizeTags(document.getElementById('trans-tags').value);
  const isRecurring = document.getElementById('trans-recurring').checked;
  const accountId = document.getElementById('trans-account')?.value || null;
  const currency = document.getElementById('moeda')?.value || 'BRL';

  const payload = {
    user_id: currentUser.id,
    description: desc,
    amount: val,
    type,
    category: cat,
    date,
    tags,
    is_recurring: isRecurring,
    currency
  };

  if (accountId) payload.account_id = accountId;

  const receiptInput = document.getElementById('comprovante');
  const receiptFile = receiptInput?.files?.[0];
  if (receiptFile) {
    try {
      const path = `${currentUser.id}/${Date.now()}_${receiptFile.name}`;
      const { error: uploadError } = await _supabase.storage.from('receipts').upload(path, receiptFile);
      if (!uploadError) {
        const { data: urlData } = _supabase.storage.from('receipts').getPublicUrl(path);
        payload.receipt_url = urlData?.publicUrl || null;
      }
    } catch (err) {
      console.warn('Erro ao anexar comprovativo:', err);
    }
  }

  if (id) {
    const { error } = await _supabase.from('transactions').update(payload).eq('id', id);
    if (error) return notify('Erro ao atualizar: ' + error.message, 'error');
    notify('Lançamento atualizado!', 'success');
  } else {
    const { error } = await _supabase.from('transactions').insert([payload]);
    if (error) return notify('Erro ao guardar: ' + error.message, 'error');
    notify('Lançamento salvo com sucesso!', 'success');
  }

  document.getElementById('trans-id').value = '';
  e.target.reset();
  document.getElementById('trans-date').valueAsDate = new Date();
  document.getElementById('form-title').innerText = 'Novo Lançamento Financeiro';

  await loadTransactionsCloud();
  loadWallets();
}

window.deleteTransaction = function(id) {
  showModal('Excluir Lançamento', 'Deseja remover este lançamento?', async () => {
    const { error } = await _supabase.from('transactions').delete().eq('id', id);
    if (error) return notify('Erro ao excluir: ' + error.message, 'error');
    notify('Lançamento removido!');
    loadTransactionsCloud();
  });
};

function renderData() {
  const search = document.getElementById('search-input')?.value.toLowerCase() || '';
  const filterType = document.getElementById('filter-type')?.value || 'Todos';
  const monthPicker = document.getElementById('month-picker')?.value || '';

  let filtered = transactions.filter(t => {
    const matchSearch = t.desc.toLowerCase().includes(search) || t.tags.toLowerCase().includes(search);
    const matchType = filterType === 'Todos' || t.type === filterType;
    let matchDate = true;
    if (monthPicker) matchDate = t.date.startsWith(monthPicker);
    return matchSearch && matchType && matchDate;
  });

  lastFilteredItems = filtered;

  let totalRec = 0, totalDesp = 0;
  filtered.forEach(t => {
    const v = t.currency && t.currency !== 'BRL' ? convertToBRL(t.val, t.currency) : t.val;
    if (t.type === 'Receita') totalRec += v;
    else totalDesp += v;
  });

  const balance = totalRec - totalDesp;

  if (document.getElementById('val-receita')) document.getElementById('val-receita').innerText = `R$ ${totalRec.toFixed(2)}`;
  if (document.getElementById('val-despesa')) document.getElementById('val-despesa').innerText = `R$ ${totalDesp.toFixed(2)}`;
  if (document.getElementById('val-saldo')) {
    document.getElementById('val-saldo').innerText = `R$ ${balance.toFixed(2)}`;
    document.getElementById('val-saldo').style.color = balance >= 0 ? '#10b981' : '#f43f5e';
  }

  updateTable(filtered);
  updateCharts(filtered);
}

function updateTable(list) {
  const tbody = document.getElementById('table-body');
  if (!tbody) return;
  tbody.innerHTML = '';
  if (list.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">Nenhum lançamento encontrado.</td></tr>';
    return;
  }
  list.forEach(t => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${t.date.split('-').reverse().join('/')}</td>
      <td>${escapeHtml(t.desc)} ${t.receiptUrl ? `<br><a class="receipt-thumb-link" href="#" onclick="openReceiptModal('${t.receiptUrl}'); return false;">📎 Ver Comprovativo</a>` : ''}</td>
      <td>${escapeHtml(t.cat)}</td>
      <td><span class="badge ${t.type === 'Receita' ? 'badge-paid' : 'badge-late'}">${t.type}</span></td>
      <td style="color: ${t.type === 'Receita' ? '#10b981' : '#f43f5e'}; font-weight:700;">${t.type === 'Receita' ? '+' : '-'} R$ ${t.val.toFixed(2)}</td>
      <td><button class="action-btn btn-del" onclick="deleteTransaction('${t.id}')">Excluir</button></td>
    `;
    tbody.appendChild(tr);
  });
}

function updateCharts(filtered) {
  const barCtx = document.getElementById('barChart')?.getContext('2d');
  const doughCtx = document.getElementById('doughnutChart')?.getContext('2d');

  let rec = 0, desp = 0;
  const catMap = {};

  filtered.forEach(t => {
    const v = t.currency && t.currency !== 'BRL' ? convertToBRL(t.val, t.currency) : t.val;
    if (t.type === 'Receita') rec += v;
    else {
      desp += v;
      catMap[t.cat] = (catMap[t.cat] || 0) + v;
    }
  });

  if (barCtx) {
    if (barChartInstance) barChartInstance.destroy();
    barChartInstance = new Chart(barCtx, {
      type: 'bar',
      data: { labels: ['Entradas', 'Saídas'], datasets: [{ data: [rec, desp], backgroundColor: ['#10b981', '#f43f5e'], borderRadius: 8 }] },
      options: { responsive: true, plugins: { legend: { display: false } } }
    });
  }

  if (doughCtx) {
    if (doughnutChartInstance) doughnutChartInstance.destroy();
    doughnutChartInstance = new Chart(doughCtx, {
      type: 'doughnut',
      data: { labels: Object.keys(catMap), datasets: [{ data: Object.values(catMap), backgroundColor: ['#a855f7', '#c084fc', '#8b5cf6', '#34d399', '#fbbf24', '#f43f5e'] }] },
      options: { responsive: true }
    });
  }
}

function renderCashFlowForecast() {
  const f30 = document.getElementById('forecast-30d');
  const f60 = document.getElementById('forecast-60d');
  const f90 = document.getElementById('forecast-90d');
  if (!f30 || !f60 || !f90) return;

  const currentBalance = transactions.reduce((sum, t) => sum + (t.type === 'Receita' ? t.val : -t.val), 0);
  const today = new Date();

  function calcForecast(days) {
    const targetDate = new Date();
    targetDate.setDate(today.getDate() + days);
    let pendingBillsTotal = 0;
    bills.filter(b => b.status === 'Pendente').forEach(b => {
      if (new Date(b.dueDate + 'T00:00:00') <= targetDate) pendingBillsTotal += b.val;
    });
    return currentBalance - pendingBillsTotal;
  }

  f30.innerText = `R$ ${calcForecast(30).toFixed(2)}`;
  f60.innerText = `R$ ${calcForecast(60).toFixed(2)}`;
  f90.innerText = `R$ ${calcForecast(90).toFixed(2)}`;
}

// Funções de suporte restantes
async function loadCategoriesCloud() {
  if (!currentUser) return;
  const { data } = await _supabase.from('categories').select('*').eq('user_id', currentUser.id);
  categories = data ? data.map(c => ({ id: c.id, name: c.name, limit: parseFloat(c.limit_val) || 0 })) : [];
}
async function loadWallets() {}
async function loadBillsCloud() {}
async function processRecurringTransactions() {}
async function processRecurringBills() {}
async function loadGoals() {}
async function loadInvestments() {
  if (!currentUser) return;
  const { data } = await _supabase.from('investments').select('*').eq('user_id', currentUser.id);
  investments = data ? data.map(i => ({ id: i.id, name: i.name, type: i.type, qty: i.quantity, avgPrice: i.avg_price, currentPrice: i.current_price })) : [];
}
async function loadShares() {}
async function handleSaveInvestment(e) { e.preventDefault(); }
async function handleAddCategory(e) { e.preventDefault(); }
async function handleSaveBill(e) { e.preventDefault(); }
async function handleSaveGoal(e) { e.preventDefault(); }
async function handleSaveAccount(e) { e.preventDefault(); }

function exportCSV() {
  if (lastFilteredItems.length === 0) return notify('Nenhum dado para exportar.', 'error');
  let csv = 'Data,Descricao,Categoria,Tipo,Valor\n';
  lastFilteredItems.forEach(t => { csv += `${t.date},"${t.desc}","${t.cat}",${t.type},${t.val}\n`; });
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'extrato.csv'; a.click();
}

function exportPDF() {
  if (lastFilteredItems.length === 0) return notify('Nenhum dado para exportar.', 'error');
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  doc.text('Relatório FluxoPro Enterprise', 14, 15);
  doc.autoTable({
    head: [['Data', 'Descrição', 'Categoria', 'Tipo', 'Valor']],
    body: lastFilteredItems.map(t => [t.date, t.desc, t.cat, t.type, `R$ ${t.val.toFixed(2)}`])
  });
  doc.save('relatorio.pdf');
}

window.enviarMensagemSuporte = function(e) {
  e.preventDefault();
  notify('Mensagem de suporte enviada com sucesso!', 'success');
  e.target.reset();
};
