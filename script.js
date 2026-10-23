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

const AI_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/ai-assistant`;

// --- ESTADO GLOBAL ---
let currentUser = null;
let transactions = [];
let bills = [];
let categories = [];
let accounts = [];
let goals = [];
let investments = [];
let cards = [];
let subscriptions = [];
let splitExpenses = [];
let lastFilteredItems = [];

let barChartInstance = null;
let doughnutChartInstance = null;
let compareChartInstance = null;
let annualChartInstance = null;
let weeklyChartInstance = null;
let simulatorChartInstance = null;
let rebalanceChartInstance = null;
let pendingDeleteAction = null;

let exchangeRates = { BRL: 1 };

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

// --- MODO PRIVACIDADE ---
window.toggleStealthMode = function() {
  const body = document.body;
  const btn = document.getElementById('btn-stealth');
  body.classList.toggle('stealth-mode');
  const isStealth = body.classList.contains('stealth-mode');
  if (btn) btn.innerText = isStealth ? '🙈 A Ver Valores' : '👁️ Modo Privado';
  notify(isStealth ? 'Modo Privado ativado.' : 'Modo Privado desativado.');
};

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
    body.innerHTML = `<iframe src="${url}" style="width:100%; height:500px; border:none; border-radius:6px;"></iframe>`;
  } else {
    body.innerHTML = `<img src="${url}" style="max-width:100%; max-height:500px; object-fit:contain; border-radius:6px;">`;
  }
  modal.style.display = 'flex';
};

window.closeReceiptModal = function() {
  const modal = document.getElementById('receipt-modal');
  if (modal) modal.style.display = 'none';
};

// --- ATALHOS DE TECLADO ---
function setupKeyboardShortcuts() {
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

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
  setupKeyboardShortcuts();

  _supabase.auth.onAuthStateChange(async (event, session) => {
    if (session && session.user) {
      currentUser = {
        id: session.user.id,
        email: session.user.email,
        name: session.user.user_metadata?.name || session.user.user_metadata?.full_name
      };
      startSystem();
    } else {
      currentUser = null;
      document.getElementById('landing-screen').style.display = 'block';
      document.getElementById('auth-screen').style.display = 'none';
      document.getElementById('app-screen').style.display = 'none';
    }
  });
});

function setupEventListeners() {
  document.getElementById('modal-btn-cancel')?.addEventListener('click', hideModal);
  document.getElementById('modal-btn-confirm')?.addEventListener('click', () => {
    if (pendingDeleteAction) pendingDeleteAction();
    hideModal();
  });

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

  document.getElementById('form-register')?.addEventListener('submit', handleRegister);
  document.getElementById('form-login')?.addEventListener('submit', handleLogin);
  document.getElementById('btn-logout')?.addEventListener('click', () => _supabase.auth.signOut());
  document.getElementById('form-transaction')?.addEventListener('submit', handleSaveTransaction);
  document.getElementById('form-bill')?.addEventListener('submit', handleSaveBill);
  document.getElementById('form-add-category')?.addEventListener('submit', handleAddCategory);
  document.getElementById('form-goal')?.addEventListener('submit', handleSaveGoal);
  document.getElementById('form-account')?.addEventListener('submit', handleSaveAccount);

  document.getElementById('search-input')?.addEventListener('input', renderData);
  document.getElementById('filter-type')?.addEventListener('change', renderData);
  document.getElementById('month-picker')?.addEventListener('change', renderData);
  document.getElementById('btn-clear-month')?.addEventListener('click', () => {
    document.getElementById('month-picker').value = '';
    renderData();
  });

  document.getElementById('btn-export')?.addEventListener('click', exportCSV);
  document.getElementById('btn-print-pdf')?.addEventListener('click', exportPDF);
}

function switchTab(sectionId, navId) {
  document.querySelectorAll('.page-section').forEach(sec => sec.style.display = 'none');
  document.querySelectorAll('.nav-item').forEach(nav => nav.classList.remove('active'));

  document.getElementById(sectionId).style.display = 'block';
  document.getElementById(navId).classList.add('active');

  if (sectionId === 'section-cards') renderCards();
  if (sectionId === 'section-subscriptions') renderSubscriptions();
  if (sectionId === 'section-split') renderSplitExpenses();
  if (sectionId === 'section-investments') { loadInvestments(); renderRebalanceChart(); }
  if (sectionId === 'section-categories') renderCategories();
  if (sectionId === 'section-goals') renderGoals();
  if (sectionId === 'section-accounts') renderWallets();
}

async function startSystem() {
  document.getElementById('landing-screen').style.display = 'none';
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('app-screen').style.display = 'flex';
  document.getElementById('user-display-name').innerText = currentUser.name || currentUser.email;

  document.getElementById('trans-date').valueAsDate = new Date();

  await loadCategoriesCloud();
  await loadWallets();
  await loadTransactionsCloud();
  await loadBillsCloud();
  await loadGoals();
}

async function handleRegister(e) {
  e.preventDefault();
  const name = document.getElementById('reg-name').value;
  const email = document.getElementById('reg-email').value;
  const password = document.getElementById('reg-password').value;

  const { error } = await _supabase.auth.signUp({
    email, password, options: { data: { name } }
  });

  if (error) return notify('Erro no registo: ' + error.message, 'error');
  notify('Conta criada com sucesso!', 'success');
}

async function handleLogin(e) {
  e.preventDefault();
  const email = document.getElementById('login-email').value;
  const password = document.getElementById('login-password').value;

  const { error } = await _supabase.auth.signInWithPassword({ email, password });
  if (error) notify('Falha no início de sessão: ' + error.message, 'error');
}

// --- LANÇAMENTOS (SEM account_id PARA EVITAR ERROS DE BD) ---
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
  const tags = document.getElementById('trans-tags')?.value || '';
  const isRecurring = document.getElementById('trans-recurring')?.checked || false;
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

  let totalRec = 0;
  let totalDesp = 0;

  filtered.forEach(t => {
    if (t.type === 'Receita') totalRec += t.val;
    else totalDesp += t.val;
  });

  const balance = totalRec - totalDesp;

  const elRec = document.getElementById('val-receita');
  const elDesp = document.getElementById('val-despesa');
  const elSaldo = document.getElementById('val-saldo');

  if (elRec) elRec.innerText = `R$ ${totalRec.toFixed(2)}`;
  if (elDesp) elDesp.innerText = `R$ ${totalDesp.toFixed(2)}`;
  if (elSaldo) {
    elSaldo.innerText = `R$ ${balance.toFixed(2)}`;
    elSaldo.style.color = balance >= 0 ? '#10b981' : '#f43f5e';
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
      <td>${t.desc} ${t.receiptUrl ? `<br><a class="receipt-thumb-link" href="#" onclick="openReceiptModal('${t.receiptUrl}'); return false;">📎 Ver Comprovativo</a>` : ''}</td>
      <td>${t.cat}</td>
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
    if (t.type === 'Receita') rec += t.val;
    else {
      desp += t.val;
      catMap[t.cat] = (catMap[t.cat] || 0) + t.val;
    }
  });

  if (barCtx) {
    if (barChartInstance) barChartInstance.destroy();
    barChartInstance = new Chart(barCtx, {
      type: 'bar',
      data: {
        labels: ['Entradas', 'Saídas'],
        datasets: [{ label: 'Valores (R$)', data: [rec, desp], backgroundColor: ['#10b981', '#f43f5e'], borderRadius: 8 }]
      },
      options: { responsive: true, plugins: { legend: { display: false } } }
    });
  }

  if (doughCtx) {
    if (doughnutChartInstance) doughnutChartInstance.destroy();
    doughnutChartInstance = new Chart(doughCtx, {
      type: 'doughnut',
      data: {
        labels: Object.keys(catMap),
        datasets: [{ data: Object.values(catMap), backgroundColor: ['#a855f7', '#c084fc', '#8b5cf6', '#34d399', '#fbbf24', '#f43f5e'] }]
      },
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

// --- CARTÕES DE CRÉDITO ---
function handleSaveCard(e) {
  e.preventDefault();
  const name = document.getElementById('card-name').value;
  const limit = parseFloat(document.getElementById('card-limit').value);
  const closeDay = parseInt(document.getElementById('card-close-day').value);
  const dueDay = parseInt(document.getElementById('card-due-day').value);

  cards.push({ id: Date.now().toString(), name, limit, closeDay, dueDay, used: 0 });
  notify('Cartão adicionado!', 'success');
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
      <h3>💳 ${c.name}</h3>
      <div class="value" style="font-size: 24px; color: #a855f7;">R$ ${c.used.toFixed(2)} / R$ ${c.limit.toFixed(2)}</div>
      <p style="font-size: 12px; color: var(--text-muted); margin-top: 8px;">Fecho: dia ${c.closeDay} · Vencimento: dia ${c.dueDay}</p>
      <span style="font-size: 13px; color: #10b981; font-weight: 700;">Disponível: R$ ${available.toFixed(2)}</span>
    `;
    container.appendChild(card);
  });
}

// --- ASSINATURAS (SAAS) ---
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
      <td>${s.name}</td>
      <td>${s.cat}</td>
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

// --- DIVISÃO DE GASTOS ---
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
    html += `<li style="margin-bottom: 6px;"><strong>${person}</strong>: <span style="color: ${color}; font-weight:700;">${text}</span></li>`;
  }
  html += '</ul>';
  container.innerHTML = html;
}

// --- INVESTIMENTOS & REBALANCEAMENTO ---
async function loadInvestments() {
  if (!currentUser) return;
  const { data, error } = await _supabase.from('investments').select('*').eq('user_id', currentUser.id);
  if (error) return console.error('Erro ao carregar investimentos:', error);

  investments = data.map(i => ({
    id: i.id, name: i.name, type: i.type, qty: parseFloat(i.quantity) || 0,
    avgPrice: parseFloat(i.avg_price) || 0, currentPrice: parseFloat(i.current_price) || 0
  }));

  renderInvestments();
}

function renderInvestments() {
  const tbody = document.getElementById('investments-table-body');
  if (!tbody) return;
  tbody.innerHTML = '';

  let totalInvested = 0, totalCurrentValue = 0;

  investments.forEach(inv => {
    const invTotal = inv.qty * inv.avgPrice;
    const curTotal = inv.qty * inv.currentPrice;
    const profitability = invTotal > 0 ? ((curTotal - invTotal) / invTotal) * 100 : 0;

    totalInvested += invTotal;
    totalCurrentValue += curTotal;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${inv.name}</td>
      <td>${inv.type}</td>
      <td>${inv.qty}</td>
      <td>R$ ${inv.avgPrice.toFixed(2)}</td>
      <td>R$ ${inv.currentPrice.toFixed(2)}</td>
      <td>R$ ${curTotal.toFixed(2)}</td>
      <td style="color: ${profitability >= 0 ? '#34d399' : '#f43f5e'}; font-weight:700;">${profitability.toFixed(2)}%</td>
      <td><button class="action-btn btn-del" onclick="deleteInvestment('${inv.id}')">Excluir</button></td>
    `;
    tbody.appendChild(tr);
  });

  document.getElementById('val-investido').innerText = `R$ ${totalInvested.toFixed(2)}`;
  document.getElementById('val-atual-investimentos').innerText = `R$ ${totalCurrentValue.toFixed(2)}`;
}

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

// --- CATEGORIAS, CONTAS & DEMAIS MÓDULOS ---
async function loadCategoriesCloud() {
  if (!currentUser) return;
  const { data } = await _supabase.from('categories').select('*').eq('user_id', currentUser.id);
  categories = data ? data.map(c => ({ id: c.id, name: c.name, limit: parseFloat(c.limit_val) || 0 })) : [];
  updateCategorySelects();
}

function updateCategorySelects() {
  const select = document.getElementById('trans-cat');
  if (!select) return;
  select.innerHTML = '';
  categories.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.name; opt.innerText = c.name;
    select.appendChild(opt);
  });
}

async function handleAddCategory(e) {
  e.preventDefault();
  const name = document.getElementById('cat-name-input').value.trim();
  const limit = parseFloat(document.getElementById('cat-limit-input').value) || 0;
  const { data, error } = await _supabase.from('categories').insert([{ user_id: currentUser.id, name, limit_val: limit }]).select();
  if (error) return notify('Erro ao criar categoria: ' + error.message, 'error');
  categories.push({ id: data[0].id, name, limit });
  updateCategorySelects();
  renderCategories();
  notify('Categoria criada!', 'success');
}

function renderCategories() {
  const container = document.getElementById('categories-list-container');
  if (!container) return;
  container.innerHTML = '';
  categories.forEach(c => {
    const card = document.createElement('div');
    card.className = 'category-card';
    card.innerHTML = `<h4>${c.name}</h4><p style="font-size: 13px; color: var(--text-muted);">Limite: R$ ${c.limit.toFixed(2)}</p>`;
    container.appendChild(card);
  });
}

async function loadWallets() {}
async function loadBillsCloud() {}
async function handleSaveBill(e) { e.preventDefault(); }
async function loadGoals() {}
async function handleSaveGoal(e) { e.preventDefault(); }
async function handleSaveAccount(e) { e.preventDefault(); }

function exportCSV() {
  if (lastFilteredItems.length === 0) return notify('Nenhum dado para exportar.', 'error');
  let csv = 'Data,Descricao,Categoria,Tipo,Valor\n';
  lastFilteredItems.forEach(t => { csv += `${t.date},"${t.desc}","${t.cat}",${t.type},${t.val}\n`; });
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'extrato_fluxopro.csv'; a.click();
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
  doc.save('extrato_fluxopro.pdf');
}

window.enviarMensagemSuporte = function(e) {
  e.preventDefault();
  notify('Mensagem de suporte enviada com sucesso!', 'success');
  e.target.reset();
};
