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
let lastFilteredItems = [];
let pendingMfaFactorId = null;

let barChartInstance = null;
let doughnutChartInstance = null;
let compareChartInstance = null;
let annualChartInstance = null;
let weeklyChartInstance = null;
let pendingDeleteAction = null;

const EXCLUSION_UNDO_TIME_MS = 6000;
let pendingExclusions = {};
let exchangeRates = { BRL: 1 };
let exchangeRatesLoaded = false;
let lastAiInsightTime = 0;
const AI_INSIGHT_INTERVAL_MS = 5 * 60 * 1000;
let seriesInEditing = null;

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
    return alert('Por favor, insira um valor de receita mensal válido.');
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
    return alert('Por favor, insira um valor de receita válido antes de aplicar aos envelopes.');
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
    console.warn('Não foi possível procurar câmbio em tempo real, a usar estimativa fixa:', err.message);
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
    .replace(/(\d{3})(\d)/, '$1.$2') .replace(/(\d{3})(\d{1,2})$/, '$1-$2') .replace(/^(\d{2})\.(\d{3})\.(\d{3})\/(\d{4})-(\d{2})$/, '$1.$2.$3/$4-$5');
}

function maskPhone(value) {
  return value
    .replace(/\D/g, '')
    .replace(/^(\d{2})(\d)/g, '($1) $2') .replace(/(\d)(\d{4})$/, '$1-$2');
}

function applyMasks() {
  const docInputs = [document.getElementById('reg-doc'), document.getElementById('edit-doc')];
  const phoneInputs = [document.getElementById('reg-phone'), document.getElementById('edit-phone')];

  docInputs.forEach(input => input?.addEventListener('input', (e) => e.target.value = maskDoc(e.target.value)));
  phoneInputs.forEach(input => input?.addEventListener('input', (e) => e.target.value = maskPhone(e.target.value)));
}

function notify(text) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerText = text;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
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

document.addEventListener('DOMContentLoaded', () => {
  setupEventListeners();
  applyMasks();
  registerServiceWorker();

  _supabase.auth.onAuthStateChange(async (event, session) => {
    if (event === 'PASSWORD_RECOVERY') {
      document.getElementById('auth-screen').style.display = 'flex';
      document.getElementById('login-box').style.display = 'none';
      document.getElementById('forgot-box').style.display = 'none';
      document.getElementById('reset-password-box').style.display = 'block';
      return;
    }

    if (session && session.user) {
      const { data: aal } = await _supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (aal && aal.nextLevel === 'aal2' && aal.nextLevel !== aal.currentLevel) {
        showMfaScreen();
        return;
      }

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
      document.getElementById('auth-screen').style.display = 'flex';
      document.getElementById('app-screen').style.display = 'none';
    }
  });
});

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('service-worker.js').catch(err => {
        console.warn('Service worker não registado:', err.message);
      });
    });
  }
}

function showMfaScreen() {
  ['login-box', 'register-box', 'forgot-box', 'reset-password-box'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  document.getElementById('auth-screen').style.display = 'flex';
  document.getElementById('mfa-verify-box').style.display = 'block';
}

async function handleMfaVerifyLogin(e) {
  e.preventDefault();
  const code = document.getElementById('mfa-code-input').value.trim();

  const { data: factors, error: errFactors } = await _supabase.auth.mfa.listFactors();
  if (errFactors) return alert('Erro ao procurar fator 2FA: ' + errFactors.message);
  const factor = factors.totp?.[0];
  if (!factor) return alert('Nenhum fator 2FA encontrado.');

  const { data: challenge, error: errChallenge } = await _supabase.auth.mfa.challenge({ factorId: factor.id });
  if (errChallenge) return alert('Erro ao iniciar verificação: ' + errChallenge.message);

  const { error: errVerify } = await _supabase.auth.mfa.verify({
    factorId: factor.id, challengeId: challenge.id, code
  });
  if (errVerify) return alert('Código inválido: ' + errVerify.message);

  document.getElementById('mfa-verify-box').style.display = 'none';
  document.getElementById('login-box').style.display = 'block';

  const { data: { session } } = await _supabase.auth.getSession();
  if (session && session.user) {
    currentUser = {
      id: session.user.id,
      email: session.user.email,
      name: session.user.user_metadata?.name || session.user.user_metadata?.full_name,
      doc: session.user.user_metadata?.doc,
      phone: session.user.user_metadata?.phone,
      profile: session.user.user_metadata?.profile || 'Pessoal'
    };
    startSystem();
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

  document.getElementById('nav-dash')?.addEventListener('click', () => switchTab('section-dashboard', 'nav-dash'));
  document.getElementById('nav-bills')?.addEventListener('click', () => switchTab('section-bills', 'nav-bills'));
  document.getElementById('nav-categories')?.addEventListener('click', () => switchTab('section-categories', 'nav-categories'));
  document.getElementById('nav-goals')?.addEventListener('click', () => switchTab('section-goals', 'nav-goals'));
  document.getElementById('nav-investments')?.addEventListener('click', () => switchTab('section-investments', 'nav-investments'));
  document.getElementById('nav-accounts')?.addEventListener('click', () => switchTab('section-accounts', 'nav-accounts'));
  document.getElementById('nav-profile')?.addEventListener('click', () => switchTab('section-profile', 'nav-profile'));
  document.getElementById('nav-support')?.addEventListener('click', () => switchTab('section-support', 'nav-support'));

  document.getElementById('btn-theme')?.addEventListener('click', () => {
    const isDark = document.body.getAttribute('data-theme') === 'dark';
    if (isDark) document.body.removeAttribute('data-theme');
    else document.body.setAttribute('data-theme', 'dark');
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
  document.getElementById('form-share-invite')?.addEventListener('submit', handleShareInvite);
  document.getElementById('form-mfa-verify')?.addEventListener('submit', handleMfaVerifyLogin);

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

  document.getElementById('goal-target')?.addEventListener('input', updateGoalPreview);
  document.getElementById('goal-saved-initial')?.addEventListener('input', updateGoalPreview);
  document.getElementById('goal-deadline')?.addEventListener('change', updateGoalPreview);
}

function switchTab(sectionId, navId) {
  document.querySelectorAll('.page-section').forEach(sec => sec.style.display = 'none');
  document.querySelectorAll('.nav-item').forEach(nav => nav.classList.remove('active'));

  document.getElementById(sectionId).style.display = 'block';
  document.getElementById(navId).classList.add('active');

  if (sectionId === 'section-bills') loadBillsCloud();
  if (sectionId === 'section-categories') renderCategories();
  if (sectionId === 'section-goals') renderGoals();
  if (sectionId === 'section-investments') loadInvestments();
  if (sectionId === 'section-accounts') { renderWallets(); loadShares(); }
  if (sectionId === 'section-profile') renderMfaStatus();
}

async function startSystem() {
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('app-screen').style.display = 'flex';
  document.getElementById('user-display-name').innerText = currentUser.name || currentUser.email;

  document.getElementById('edit-name').value = currentUser.name || '';
  document.getElementById('edit-email').value = currentUser.email || '';
  document.getElementById('edit-doc').value = currentUser.doc || '';
  document.getElementById('edit-phone').value = currentUser.phone || '';
  document.getElementById('edit-profile').value = currentUser.profile || 'Pessoal';

  document.getElementById('trans-date').valueAsDate = new Date();

  await loadCategoriesCloud();
  await loadWallets();
  await processRecurringTransactions();
  await processRecurringBills();
  await loadTransactionsCloud();
  await loadBillsCloud();
  await loadGoals();
  loadExchangeRates();

  checkUpcomingBills();
}

async function handleRegister(e) {
  e.preventDefault();
  const name = document.getElementById('reg-name').value;
  const email = document.getElementById('reg-email').value;
  const doc = document.getElementById('reg-doc').value;
  const phone = document.getElementById('reg-phone').value;
  const profile = document.getElementById('reg-profile').value;
  const password = document.getElementById('reg-password').value;

  const { error } = await _supabase.auth.signUp({
    email, password, options: { data: { name, doc, phone, profile } }
  });

  if (error) return alert('Erro no registo: ' + error.message);
  notify('Conta criada com sucesso!');
  document.getElementById('register-box').style.display = 'none';
  document.getElementById('login-box').style.display = 'block';
}

async function handleLogin(e) {
  e.preventDefault();
  const email = document.getElementById('login-email').value;
  const password = document.getElementById('login-password').value;

  const { error } = await _supabase.auth.signInWithPassword({ email, password });
  if (error) alert('Falha no início de sessão: ' + error.message);
}

async function handleGoogleLogin() {
  const { error } = await _supabase.auth.signInWithOAuth({
    provider: 'google', options: { redirectTo: window.location.origin }
  });
  if (error) alert('Erro ao autenticar com o Google: ' + error.message);
}

async function handleForgotPassword(e) {
  e.preventDefault();
  const email = document.getElementById('forgot-email').value;

  const { error } = await _supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
  if (error) return alert('Erro ao enviar e-mail: ' + error.message);

  notify('E-mail enviado!');
  document.getElementById('forgot-box').style.display = 'none';
  document.getElementById('login-box').style.display = 'block';
}

async function handleResetPassword(e) {
  e.preventDefault();
  const newPassword = document.getElementById('new-password').value;

  const { error } = await _supabase.auth.updateUser({ password: newPassword });
  if (error) return alert('Erro ao redefinir palavra-passe: ' + error.message);

  notify('Palavra-passe atualizada com sucesso!');
  document.getElementById('reset-password-box').style.display = 'none';
  document.getElementById('login-box').style.display = 'block';
}

async function handleUpdateProfile(e) {
  e.preventDefault();
  const name = document.getElementById('edit-name').value;
  const doc = document.getElementById('edit-doc').value;
  const phone = document.getElementById('edit-phone').value;
  const profile = document.getElementById('edit-profile').value;

  const { error } = await _supabase.auth.updateUser({ data: { name, doc, phone, profile } });
  if (error) return alert('Erro ao atualizar: ' + error.message);

  currentUser = { ...currentUser, name, doc, phone, profile };
  document.getElementById('user-display-name').innerText = name;
  notify('Perfil atualizado com sucesso!');
}

async function loadCategoriesCloud() {
  if(!currentUser) return;

  const { data, error } = await _supabase.from('categories').select('*').eq('user_id', currentUser.id).order('name');
  if (error) return console.error('Erro ao carregar categorias:', error);

  if (data.length === 0) {
    const defaultCategories = [
      { user_id: currentUser.id, name: 'Salário', limit_val: 0 },
      { user_id: currentUser.id, name: 'Alimentação', limit_val: 800 },
      { user_id: currentUser.id, name: 'Habitação', limit_val: 1500 },
      { user_id: currentUser.id, name: 'Investimentos', limit_val: 1000 },
      { user_id: currentUser.id, name: 'Lazer', limit_val: 400 },
      { user_id: currentUser.id, name: 'Geral', limit_val: 500 }
    ];
    const { data: created, error: createError } = await _supabase.from('categories').insert(defaultCategories).select();
    if (createError) { console.error('Erro ao criar categorias padrão:', createError); categories = []; }
    else categories = created.map(c => ({ id: c.id, name: c.name, limit: parseFloat(c.limit_val) || 0 }));
  } else {
    categories = data.map(c => ({ id: c.id, name: c.name, limit: parseFloat(c.limit_val) || 0 }));
  }

  updateCategorySelects();
  renderCategories();
}

function updateCategorySelects() {
  const select = document.getElementById('trans-cat');
  if (!select) return;
  const currentValue = select.value;
  select.innerHTML = '';

  categories.forEach(c => {
    const option = document.createElement('option');
    option.value = c.name;
    option.innerText = c.name;
    select.appendChild(option);
  });

  if (currentValue) select.value = currentValue;

  const importCat = document.getElementById('import-default-cat');
  if (importCat) {
    const currentImportVal = importCat.value;
    importCat.innerHTML = '';
    categories.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.name;
      opt.innerText = c.name;
      importCat.appendChild(opt);
    });
    if (currentImportVal) importCat.value = currentImportVal;
  }
}

async function handleAddCategory(e) {
  e.preventDefault();
  const name = document.getElementById('cat-name-input').value.trim();
  const limit = parseFloat(document.getElementById('cat-limit-input').value) || 0;

  if (categories.some(c => c.name.toLowerCase() === name.toLowerCase())) {
    return alert('Esta categoria já existe!');
  }

  const { data, error } = await _supabase.from('categories').insert([{ user_id: currentUser.id, name, limit_val: limit }]).select();
  if (error) return alert('Erro ao criar categoria: ' + error.message);

  categories.push({ id: data[0].id, name: data[0].name, limit: parseFloat(data[0].limit_val) || 0 });
  updateCategorySelects();
  renderCategories();
  renderData();
  e.target.reset();
  notify('Categoria criada!');
}

window.removeCategory = function(id, name) {
  showModal('Remover Categoria', `Deseja apagar a categoria "${name}"?`, async () => {
    const { error } = await _supabase.from('categories').delete().eq('id', id);
    if (error) return alert('Erro ao remover categoria: ' + error.message);

    categories = categories.filter(c => c.id !== id);
    updateCategorySelects();
    renderCategories();
    renderData();
    notify('Categoria removida!');
  });
};

function renderCategories() {
  const container = document.getElementById('categories-list-container');
  if (!container) return;
  container.innerHTML = '';

  const currentMonthStr = new Date().toISOString().slice(0, 7);
  const expensesPerCat = {};
  transactions.forEach(t => {
    if (t.type === 'Despesa' && t.date.startsWith(currentMonthStr)) {
      const v = t.currency && t.currency !== 'BRL' ? convertToBRL(t.val, t.currency) : t.val;
      expensesPerCat[t.cat] = (expensesPerCat[t.cat] || 0) + v;
    }
  });

  categories.forEach(c => {
    const expense = expensesPerCat[c.name] || 0;
    const perc = c.limit > 0 ? Math.min(100, (expense / c.limit) * 100) : 0;
    const remaining = c.limit > 0 ? c.limit - expense : null;
    const statusClass = perc >= 100 ? 'over' : (perc >= 80 ? 'warn' : 'ok');

    const card = document.createElement('div');
    card.className = 'category-card';
    card.innerHTML = `
      <div class="category-card-header">
        <h4>${escapeHtml(c.name)}</h4>
        <button class="action-btn btn-del" onclick="removeCategory('${c.id}', '${escapeHtml(c.name)}')">Excluir</button>
      </div>
      <div>
        <span style="font-size: 13px; color: var(--text-muted);">Gastos este mês: <strong>R$ ${expense.toFixed(2)}</strong> ${c.limit > 0 ? `/ R$ ${c.limit.toFixed(2)}` : ''}</span>
      </div>
      ${c.limit > 0 ? `
        <div class="progress-bar-bg">
          <div class="progress-bar-fill" style="width: ${perc}%; background:${perc >= 100 ? '#ef4444' : (perc >= 80 ? '#f59e0b' : '#10b981')};"></div>
        </div>
        <div class="envelope-remaining ${statusClass}">${remaining >= 0 ? `Restam R$ ${remaining.toFixed(2)} no envelope` : `Ultrapassou o limite em R$ ${Math.abs(remaining).toFixed(2)}`}</div>
      ` : ''}
    `;
    container.appendChild(card);
  });
}

async function loadWallets() {
  if (!currentUser) return;

  const { data, error } = await _supabase.from('accounts').select('*').eq('user_id', currentUser.id).order('name');
  if (error) return console.error('Erro ao carregar contas/carteiras:', error);

  accounts = data.map(a => ({ id: a.id, name: a.name, initial: parseFloat(a.initial_balance) || 0 }));
  updateAccountSelects();
  renderWallets();
}

function updateAccountSelects() {
  [document.getElementById('trans-account'), document.getElementById('bill-account'), document.getElementById('import-default-account')].forEach(select => {
    if (!select) return;
    const currentValue = select.value;
    select.innerHTML = '<option value="">Sem conta específica</option>';
    accounts.forEach(a => {
      const opt = document.createElement('option');
      opt.value = a.id;
      opt.innerText = a.name;
      select.appendChild(opt);
    });
    if (currentValue) select.value = currentValue;
  });

  const dashFilter = document.getElementById('dash-account-filter');
  if (dashFilter) {
    const currentValue = dashFilter.value;
    dashFilter.innerHTML = '<option value="">Todas as contas</option>';
    accounts.forEach(a => {
      const opt = document.createElement('option');
      opt.value = a.id;
      opt.innerText = a.name;
      dashFilter.appendChild(opt);
    });
    if (currentValue) dashFilter.value = currentValue;
  }
}

async function handleSaveAccount(e) {
  e.preventDefault();
  const name = document.getElementById('account-name').value.trim();
  const initial = parseFloat(document.getElementById('account-initial').value) || 0;

  const { error } = await _supabase.from('accounts').insert([{ user_id: currentUser.id, name, initial_balance: initial }]);
  if (error) return alert('Erro ao criar conta: ' + error.message);

  notify('Conta criada!');
  e.target.reset();
  loadWallets();
}

window.deleteWallet = function(id) {
  showModal('Excluir Conta', 'Deseja remover esta conta? Os lançamentos vinculados ficarão sem conta associada.', async () => {
    const { error } = await _supabase.from('accounts').delete().eq('id', id);
    if (error) return alert('Erro ao excluir conta: ' + error.message);
    notify('Conta removida!');
    loadWallets();
  });
};

function renderWallets() {
  const container = document.getElementById('accounts-list-container');
  if (!container) return;
  container.innerHTML = '';

  if (accounts.length === 0) {
    container.innerHTML = '<p style="color: var(--text-muted);">Nenhuma conta cadastrada ainda.</p>';
    return;
  }

  accounts.forEach(a => {
    const moved = transactions
      .filter(t => t.accountId === a.id)
      .reduce((sum, t) => sum + (t.type === 'Receita' ? t.val : -t.val), 0);
    const balance = a.initial + moved;

    const card = document.createElement('div');
    card.className = 'category-card';
    card.innerHTML = `
      <div class="category-card-header">
        <h4>${escapeHtml(a.name)}</h4>
        <button class="action-btn btn-del" onclick="deleteWallet('${a.id}')">Excluir</button>
      </div>
      <div style="font-size: 24px; font-weight: 800; color: ${balance >= 0 ? '#10b981' : '#ef4444'};">
        R$ ${balance.toFixed(2)}
      </div>
      <span style="font-size: 12px; color: var(--text-muted);">Saldo inicial: R$ ${a.initial.toFixed(2)}</span>
    `;
    container.appendChild(card);
  });
}

async function loadGoals() {
  if (!currentUser) return;

  const { data, error } = await _supabase.from('goals').select('*').eq('user_id', currentUser.id).order('created_at');
  if (error) return console.error('Erro ao carregar metas:', error);

  goals = data.map(g => ({
    id: g.id,
    name: g.name,
    target: parseFloat(g.target) || 0,
    saved: parseFloat(g.saved) || 0,
    deadline: g.deadline,
    startDate: g.start_date
  }));

  renderGoals();
  updatePiggyBankGoalSelect();
}

function updatePiggyBankGoalSelect() {
  const select = document.getElementById('roundup-goal-select');
  if (!select) return;
  const currentValue = select.value;
  select.innerHTML = '<option value="">Escolha a meta...</option>';
  goals.forEach(g => {
    const opt = document.createElement('option');
    opt.value = g.id;
    opt.innerText = g.name;
    select.appendChild(opt);
  });
  if (currentValue) select.value = currentValue;
}

function updatePiggyBankPreview() {
  const checkbox = document.getElementById('trans-roundup');
  const select = document.getElementById('roundup-goal-select');
  const preview = document.getElementById('roundup-preview');
  const val = parseFloat(document.getElementById('trans-val')?.value);
  const type = document.getElementById('trans-type')?.value;
  if (!checkbox || !select || !preview) return;

  select.disabled = !checkbox.checked;

  if (!checkbox.checked || !val || type !== 'Despesa') {
    preview.innerText = checkbox.checked && type !== 'Despesa' ? 'Apenas funciona para despesas.' : '';
    return;
  }

  const difference = Math.ceil(val) - val;
  preview.innerText = difference > 0
    ? `Irá guardar R$ ${difference.toFixed(2)} (arredondando para R$ ${Math.ceil(val).toFixed(2)})`
    : 'O valor já é redondo — nada a guardar desta vez.';
}

async function handleSaveGoal(e) {
  e.preventDefault();
  const name = document.getElementById('goal-name').value.trim();
  const target = parseFloat(document.getElementById('goal-target').value);
  const saved = parseFloat(document.getElementById('goal-saved-initial')?.value) || 0;
  const startDate = document.getElementById('goal-start-date')?.value || new Date().toISOString().split('T')[0];
  const deadline = document.getElementById('goal-deadline').value || null;

  const { error } = await _supabase.from('goals').insert([{ user_id: currentUser.id, name, target, saved, deadline, start_date: startDate }]);
  if (error) return alert('Erro ao criar meta: ' + error.message);

  notify('Planeamento criado!');
  e.target.reset();
  const preview = document.getElementById('goal-planning-preview');
  if (preview) preview.style.display = 'none';
  loadGoals();
}

function daysUntilDeadline(deadlineStr) {
  if (!deadlineStr) return null;
  const today = new Date();
  const deadline = new Date(deadlineStr + 'T00:00:00');
  const diffMs = deadline - new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (diffMs <= 0) return 0;
  return diffMs / (1000 * 60 * 60 * 24);
}

function monthsUntilDeadline(deadlineStr) {
  const days = daysUntilDeadline(deadlineStr);
  if (days === null) return null;
  if (days === 0) return 0;
  return Math.max(1, Math.ceil(days / 30.44));
}

function weeksUntilDeadline(deadlineStr) {
  const days = daysUntilDeadline(deadlineStr);
  if (days === null) return null;
  if (days === 0) return 0;
  return Math.max(1, Math.ceil(days / 7));
}

function monthlySavingsCapacity() {
  const today = new Date();
  const perMonth = {};

  transactions.forEach(t => {
    const v = t.currency && t.currency !== 'BRL' ? convertToBRL(t.val, t.currency) : t.val;
    const monthKey = t.date.slice(0, 7);
    perMonth[monthKey] = perMonth[monthKey] || 0;
    perMonth[monthKey] += t.type === 'Receita' ? v : -v;
  });

  const lastMonths = [];
  for (let i = 1; i <= 3; i++) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    lastMonths.push(d.toISOString().slice(0, 7));
  }

  const valuesWithData = lastMonths.filter(m => perMonth[m] !== undefined).map(m => perMonth[m]);
  if (valuesWithData.length === 0) return null;

  return valuesWithData.reduce((sum, v) => sum + v, 0) / valuesWithData.length;
}

function calculateGoalPlanning(target, saved, deadlineStr) {
  const missing = Math.max(0, target - saved);
  const completedPerc = target > 0 ? Math.min(100, (saved / target) * 100) : 0;

  if (missing === 0) return { achieved: true, completedPerc: 100 };

  const months = monthsUntilDeadline(deadlineStr);
  const weeks = weeksUntilDeadline(deadlineStr);
  const capacity = monthlySavingsCapacity();

  if (months === null) {
    return { noDeadline: true, missing, completedPerc, capacity };
  }
  if (months === 0) {
    return { overdue: true, missing, completedPerc };
  }

  const monthlyRequired = missing / months;
  const weeklyRequired = missing / weeks;
  const requiredMonthlySurplus = capacity !== null ? Math.max(0, monthlyRequired - capacity) : null;

  let status = 'ok';
  if (capacity !== null) {
    if (capacity <= 0) status = 'bad';
    else if (monthlyRequired > capacity) status = 'warn';
  }

  return { months, weeks, missing, completedPerc, monthlyRequired, weeklyRequired, requiredMonthlySurplus, capacity, status };
}

function generateGoalStatsGrid(plan) {
  if (plan.achieved || plan.overdue) return '';

  const items = [
    { label: '% Concluído', value: `${plan.completedPerc.toFixed(0)}%` },
    { label: 'Falta', value: `R$ ${plan.missing.toFixed(2)}` }
  ];

  if (!plan.noDeadline) {
    items.push({ label: 'Guardar/mês', value: `R$ ${plan.monthlyRequired.toFixed(2)}` });
    items.push({ label: 'Guardar/semana', value: `R$ ${plan.weeklyRequired.toFixed(2)}` });
    if (plan.requiredMonthlySurplus !== null) {
      items.push({ label: 'Excedente mensal necessário', value: `R$ ${plan.requiredMonthlySurplus.toFixed(2)}` });
    }
  }

  return `<div class="goal-stats-grid">${items.map(i => `
    <div class="goal-stat-item">
      <span class="stat-label">${i.label}</span>
      <span class="stat-value">${i.value}</span>
    </div>
  `).join('')}</div>`;
}

function goalPlanningText(plan) {
  if (plan.achieved) return '🏆 Meta já atingida!';
  if (plan.overdue) {
    return `O prazo desta meta já passou e ainda faltam <strong>R$ ${plan.missing.toFixed(2)}</strong>. Considere ajustar a data ou o valor.`;
  }

  if (plan.noDeadline) {
    if (plan.capacity === null) return 'Defina uma data limite para eu calcular quanto guardar por mês e por semana.';
    return plan.capacity > 0
      ? `Defina um prazo para o cálculo exato. No seu ritmo atual (poupa ~R$ ${plan.capacity.toFixed(2)}/mês), demoraria cerca de <strong>${Math.ceil(plan.missing / plan.capacity)} meses</strong>.`
      : `Nos últimos meses as suas despesas superaram as receitas, pelo que no ritmo atual esta meta não avança. Defina um prazo para ver o cálculo exato.`;
  }

  if (plan.capacity === null) {
    return `<span class="feasibility-warn">Ainda não tenho histórico suficiente de receitas/despesas para avaliar se este prazo é realista para si.</span>`;
  }
  if (plan.status === 'bad') {
    return `<span class="feasibility-bad">⚠️ Nos últimos meses as suas despesas superaram as receitas — nesse ritmo, a meta não sairá do papel sem algum ajuste no orçamento.</span>`;
  }
  if (plan.status === 'warn') {
    return `<span class="feasibility-warn">⚠️ A sua poupança média hoje é de R$ ${plan.capacity.toFixed(2)}/mês, abaixo do necessário. Pode rever o prazo ou cortar gastos numa categoria.</span>`;
  }
  return `<span class="feasibility-ok">✅ No seu ritmo atual de poupança (R$ ${plan.capacity.toFixed(2)}/mês), esta meta é perfeitamente viável.</span>`;
}

function updateGoalPreview() {
  const preview = document.getElementById('goal-planning-preview');
  if (!preview) return;

  const target = parseFloat(document.getElementById('goal-target')?.value);
  const saved = parseFloat(document.getElementById('goal-saved-initial')?.value) || 0;
  const deadline = document.getElementById('goal-deadline')?.value || null;

  if (!target || target <= 0) {
    preview.style.display = 'none';
    return;
  }

  const plan = calculateGoalPlanning(target, saved, deadline);
  preview.innerHTML = generateGoalStatsGrid(plan) + `<div>${goalPlanningText(plan)}</div>`;
  preview.style.display = 'block';
}

function renderPlanningSummary() {
  const box = document.getElementById('planning-summary-box');
  if (!box) return;

  const capacity = monthlySavingsCapacity();
  const activeGoals = goals.filter(g => g.saved < g.target);

  if (activeGoals.length === 0) {
    box.innerHTML = capacity !== null
      ? `<div class="summary-row"><span>Sua poupança média atual</span><strong>R$ ${capacity.toFixed(2)}/mês</strong></div><div class="summary-row"><span>Metas ativas</span><strong>Nenhuma — crie um planeamento acima</strong></div>`
      : 'Cadastre suas transações e crie um planeamento para ver a análise.';
    return;
  }

  let totalMonthlyRequired = 0;
  let someWithoutDeadline = false;
  activeGoals.forEach(g => {
    const plan = calculateGoalPlanning(g.target, g.saved, g.deadline);
    if (plan.monthlyRequired) totalMonthlyRequired += plan.monthlyRequired;
    else someWithoutDeadline = true;
  });

  const lines = [];
  lines.push(`<div class="summary-row"><span>Sua poupança média atual</span><strong>${capacity !== null ? `R$ ${capacity.toFixed(2)}/mês` : 'sem histórico suficiente'}</strong></div>`);
  lines.push(`<div class="summary-row"><span>Necessário para todas as metas com prazo${someWithoutDeadline ? ' (existem metas sem prazo, não contabilizadas)' : ''}</span><strong>R$ ${totalMonthlyRequired.toFixed(2)}/mês</strong></div>`);

  if (capacity !== null) {
    const difference = capacity - totalMonthlyRequired;
    const classStyle = difference >= 0 ? 'feasibility-ok' : 'feasibility-bad';
    const text = difference >= 0
      ? `✅ Sobram R$ ${difference.toFixed(2)}/mês para cobrir todas as metas`
      : `⚠️ Faltam R$ ${Math.abs(difference).toFixed(2)}/mês para cobrir todas as metas no ritmo atual`;
    lines.push(`<div class="summary-row"><span class="${classStyle}">${text}</span></div>`);
  }

  box.innerHTML = lines.join('');
}

window.addGoalAmount = async function(id) {
  const amountStr = prompt('Quanto deseja adicionar a esta meta? (R$)');
  if (amountStr === null) return;
  const amount = parseFloat(amountStr);
  if (!amount || amount <= 0) return alert('Introduza um valor válido.');

  const goal = goals.find(g => g.id === id);
  if (!goal) return;

  const newSaved = goal.saved + amount;
  const { error } = await _supabase.from('goals').update({ saved: newSaved }).eq('id', id);
  if (error) return alert('Erro ao atualizar meta: ' + error.message);

  notify(newSaved >= goal.target ? '🎉 Meta atingida! Parabéns!' : 'Valor adicionado à meta!');
  loadGoals();
};

window.deleteGoal = function(id) {
  showModal('Excluir Meta', 'Deseja remover esta meta de poupança?', async () => {
    const { error } = await _supabase.from('goals').delete().eq('id', id);
    if (error) return alert('Erro ao excluir: ' + error.message);
    notify('Meta removida!');
    loadGoals();
  });
};

function renderGoals() {
  const container = document.getElementById('goals-list-container');
  if (!container) return;
  container.innerHTML = '';

  if (goals.length === 0) {
    container.innerHTML = '<p style="color: var(--text-muted);">Nenhuma meta cadastrada ainda.</p>';
    renderPlanningSummary();
    return;
  }

  goals.forEach(g => {
    const perc = g.target > 0 ? Math.min(100, (g.saved / g.target) * 100) : 0;
    const achieved = g.saved >= g.target;
    const plan = calculateGoalPlanning(g.target, g.saved, g.deadline);

    const card = document.createElement('div');
    card.className = 'category-card';
    card.innerHTML = `
      <div class="category-card-header">
        <h4>${achieved ? '🏆 ' : ''}${escapeHtml(g.name)}</h4>
        <button class="action-btn btn-del" onclick="deleteGoal('${g.id}')">Excluir</button>
      </div>
      <div style="font-size: 13px; color: var(--text-muted);">
        R$ ${g.saved.toFixed(2)} / R$ ${g.target.toFixed(2)}
        ${g.startDate ? ` · início ${g.startDate.split('-').reverse().join('/')}` : ''}
        ${g.deadline ? ` · até ${g.deadline.split('-').reverse().join('/')}` : ''}
      </div>
      <div class="progress-bar-bg">
        <div class="progress-bar-fill" style="width: ${perc}%; background: ${achieved ? '#10b981' : '#6366f1'};"></div>
      </div>
      ${!achieved ? generateGoalStatsGrid(plan) : ''}
      ${!achieved ? `<div class="goal-planning-box">${goalPlanningText(plan)}</div>` : ''}
      ${!achieved ? `<button class="action-btn btn-pay" onclick="addGoalAmount('${g.id}')" style="width: 100%; text-align: center;">💰 Adicionar Valor</button>` : ''}
    `;
    container.appendChild(card);
  });

  renderPlanningSummary();
}

async function processRecurringTransactions() {
  if (!currentUser) return;

  const today = new Date();
  const currentYear = today.getFullYear();
  const currentMonth = today.getMonth();

  const { data, error } = await _supabase
    .from('transactions')
    .select('*')
    .eq('user_id', currentUser.id)
    .eq('is_recurring', true);

  if (error || !data) return;

  const groups = {};
  data.forEach(item => {
    const key = `${item.description}|${item.category}|${item.type}|${item.amount}`;
    (groups[key] = groups[key] || []).push(item);
  });

  const newTransactions = [];

  Object.values(groups).forEach(list => {
    list.sort((a, b) => new Date(b.date) - new Date(a.date));
    const mostRecent = list[0];
    const mostRecentDate = new Date(mostRecent.date + 'T00:00:00');

    const alreadyExistsInCurrentMonth = list.some(item => {
      const d = new Date(item.date + 'T00:00:00');
      return d.getFullYear() === currentYear && d.getMonth() === currentMonth;
    });

    const beforeCurrentMonth = mostRecentDate < new Date(currentYear, currentMonth, 1);

    if (!alreadyExistsInCurrentMonth && beforeCurrentMonth) {
      const day = mostRecentDate.getDate();
      const lastDayOfMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
      const newDate = new Date(currentYear, currentMonth, Math.min(day, lastDayOfMonth));

      newTransactions.push({
        user_id: currentUser.id,
        description: mostRecent.description,
        amount: mostRecent.amount,
        type: mostRecent.type,
        category: mostRecent.category,
        date: newDate.toISOString().split('T')[0],
        is_recurring: true,
        account_id: mostRecent.account_id || null
      });
    }
  });

  if (newTransactions.length > 0) {
    const { error: insertError } = await _supabase.from('transactions').insert(newTransactions);
    if (!insertError) notify(`🔄 ${newTransactions.length} lançamento(s) recorrente(s) gerado(s) para este mês!`);
  }
}

async function processRecurringBills() {
  if (!currentUser) return;

  const today = new Date();
  const currentYear = today.getFullYear();
  const currentMonth = today.getMonth();

  const { data, error } = await _supabase
    .from('bills')
    .select('*')
    .eq('user_id', currentUser.id)
    .eq('is_recurring', true);

  if (error || !data) return;

  const newBills = [];

  data.forEach(item => {
    const dueDate = new Date(item.due_date + 'T00:00:00');
    const alreadyExistsInCurrentMonth = dueDate.getFullYear() === currentYear && dueDate.getMonth() === currentMonth;

    if (!alreadyExistsInCurrentMonth && dueDate < new Date(currentYear, currentMonth, 1)) {
      const day = dueDate.getDate();
      const lastDayOfMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
      const newDate = new Date(currentYear, currentMonth, Math.min(day, lastDayOfMonth));

      newBills.push({
        user_id: currentUser.id,
        description: item.description,
        amount: item.amount,
        due_date: newDate.toISOString().split('T')[0],
        status: 'Pendente',
        account_id: item.account_id || null,
        is_recurring: true
      });
    }
  });

  if (newBills.length > 0) {
    await _supabase.from('bills').insert(newBills);
  }
}

window.openSeriesEditing = function(id) {
  const t = transactions.find(x => x.id === id);
  if (!t) return;
  seriesInEditing = t;
  document.getElementById('series-new-desc').value = t.desc;
  document.getElementById('series-new-val').value = t.val;
  document.getElementById('series-modal').style.display = 'flex';
};

function closeSeriesEditing() {
  document.getElementById('series-modal').style.display = 'none';
  seriesInEditing = null;
}

async function confirmSeriesEditing() {
  if (!seriesInEditing) return;
  const newDesc = document.getElementById('series-new-desc').value.trim();
  const newValStr = document.getElementById('series-new-val').value;
  const newVal = newValStr ? parseFloat(newValStr) : null;

  if (!newDesc && !newVal) {
    alert('Introduza uma nova descrição ou um novo valor para aplicar à série.');
    return;
  }

  const updateData = {};
  if (newDesc) updateData.description = newDesc;
  if (newVal) updateData.amount = newVal;

  const { error } = await _supabase
    .from('transactions')
    .update(updateData)
    .eq('user_id', currentUser.id)
    .eq('description', seriesInEditing.desc)
    .eq('category', seriesInEditing.cat)
    .eq('type', seriesInEditing.type)
    .eq('is_recurring', true)
    .gte('date', seriesInEditing.date);

  if (error) return alert('Erro ao atualizar a série: ' + error.message);

  notify('Série recorrente atualizada a partir desta data!');
  closeSeriesEditing();
  await loadTransactionsCloud();
}

async function loadBillsCloud() {
  if (!currentUser) return;

  const { data, error } = await _supabase.from('bills').select('*').eq('user_id', currentUser.id);
  if (error) return console.error('Erro ao carregar contas:', error);

  bills = data.map(item => ({
    id: item.id,
    userId: item.user_id,
    desc: item.description,
    val: parseFloat(item.amount),
    dueDate: item.due_date,
    status: item.status,
    accountId: item.account_id,
    isRecurring: !!item.is_recurring
  }));

  renderBills();
}

async function handleSaveBill(e) {
  e.preventDefault();
  const desc = document.getElementById('bill-desc').value;
  const val = parseFloat(document.getElementById('bill-val').value);
  const dueDate = document.getElementById('bill-duedate').value;
  const accountId = document.getElementById('bill-account')?.value || null;
  const isRecurring = document.getElementById('bill-recurring')?.checked || false;

  const { error } = await _supabase.from('bills').insert([{ user_id: currentUser.id, description: desc, amount: val, due_date: dueDate, status: 'Pendente', account_id: accountId, is_recurring: isRecurring }]);
  if (error) return alert('Erro ao agendar conta: ' + error.message);

  notify('Conta agendada!');
  e.target.reset();
  loadBillsCloud();
}

function renderBills() {
  const tbody = document.getElementById('bills-table-body');
  if (!tbody) return;
  tbody.innerHTML = '';

  const today = new Date().toISOString().split('T')[0];
  bills.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));

  bills.forEach(b => {
    let statusClass = 'badge-pending';
    let statusText = 'Pendente';

    if (b.status === 'Paga') {
      statusClass = 'badge-paid';
      statusText = 'Paga';
    } else if (b.dueDate < today) {
      statusClass = 'badge-overdue';
      statusText = 'Vencida';
    }

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${b.dueDate.split('-').reverse().join('/')}</td>
      <td>${escapeHtml(b.desc)}</td>
      <td>R$ ${b.val.toFixed(2)}</td>
      <td><span class="badge ${statusClass}">${statusText}</span></td>
      <td>
        ${b.status !== 'Paga' ? `<button class="action-btn btn-pay" onclick="payBill('${b.id}')">Pagar</button>` : ''}
        <button class="action-btn btn-del" onclick="deleteBill('${b.id}')">Excluir</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

window.payBill = async function(id) {
  const b = bills.find(item => item.id === id);
  if (!b) return;

  const { error: errBill } = await _supabase.from('bills').update({ status: 'Paga' }).eq('id', id);
  if (errBill) return alert('Erro ao atualizar conta: ' + errBill.message);

  await _supabase.from('transactions').insert([{
    user_id: currentUser.id,
    description: `Pagamento: ${b.desc}`,
    amount: b.val,
    type: 'Despesa',
    category: 'Geral',
    date: new Date().toISOString().split('T')[0],
    account_id: b.accountId || null
  }]);

  notify('Conta paga e lançada no extrato!');
  loadBillsCloud();
  loadTransactionsCloud();
};

window.deleteBill = function(id) {
  showModal('Excluir Conta a Pagar', 'Deseja excluir esta conta agendada?', async () => {
    const { error } = await _supabase.from('bills').delete().eq('id', id);
    if (error) return alert('Erro ao excluir: ' + error.message);
    notify('Conta removida!');
    loadBillsCloud();
  });
};

function checkUpcomingBills() {
  const today = new Date();
  const in3Days = new Date();
  in3Days.setDate(today.getDate() + 3);

  const todayStr = today.toISOString().split('T')[0];
  const limitStr = in3Days.toISOString().split('T')[0];

  const upcoming = bills.filter(b => b.status === 'Pendente' && b.dueDate >= todayStr && b.dueDate <= limitStr);
  if (upcoming.length > 0) {
    notify(`⚠️ Tem ${upcoming.length} conta(s) a vencer nos próximos dias!`);
  }
}

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
    accountId: item.account_id,
    currency: item.currency || 'BRL',
    receiptUrl: item.receipt_url || null
  }));

  renderData();
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
  const accountId = document.getElementById('trans-account').value || null;
  const currency = document.getElementById('moeda').value || 'BRL';

  const payload = {
    user_id: currentUser.id,
    description: desc,
    amount: val,
    type,
    category: cat,
    date,
    tags,
    is_recurring: isRecurring,
    account_id: accountId,
    currency
  };

  const receiptInput = document.getElementById('comprovante');
  const receiptFile = receiptInput?.files?.[0];
  if (receiptFile) {
    try {
      const path = `${currentUser.id}/${Date.now()}_${receiptFile.name}`;
      const { error: uploadError } = await _supabase.storage.from('receipts').upload(path, receiptFile);
      if (uploadError) {
        console.error('Erro ao anexar comprovativo:', uploadError);
        notify('⚠️ Lançamento salvo, mas o comprovativo não pôde ser anexado (' + uploadError.message + ')');
      } else {
        const { data: urlData } = _supabase.storage.from('receipts').getPublicUrl(path);
        payload.receipt_url = urlData?.publicUrl || null;
      }
    } catch (err) {
      console.error('Erro ao anexar comprovativo:', err);
    }
  }

  if (id) {
    const { error } = await _supabase.from('transactions').update(payload).eq('id', id);
    if (error) return alert('Erro ao atualizar: ' + error.message);
    notify('Lançamento atualizado!');
  } else {
    const { error } = await _supabase.from('transactions').insert([payload]);
    if (error) return alert('Erro ao guardar: ' + error.message);
    notify('Lançamento salvo!');
  }

  const roundupChecked = document.getElementById('trans-roundup')?.checked;
  const roundupGoalId = document.getElementById('roundup-goal-select')?.value;
  if (!id && roundupChecked && roundupGoalId && type === 'Despesa') {
    const difference = parseFloat((Math.ceil(val) - val).toFixed(2));
    if (difference > 0) {
      const goal = goals.find(g => g.id === roundupGoalId);
      if (goal) {
        const newSaved = parseFloat((goal.saved + difference).toFixed(2));
        const { error: goalError } = await _supabase.from('goals').update({ saved: newSaved }).eq('id', roundupGoalId);
        if (!goalError) notify(`🐷 R$ ${difference.toFixed(2)} guardados na meta "${goal.name}"!`);
      }
    }
  }

  document.getElementById('trans-id').value = '';
  e.target.reset();
  document.getElementById('trans-date').valueAsDate = new Date();
  document.getElementById('form-title').innerText = 'Novo Lançamento Financeiro';
  const roundupSelect = document.getElementById('roundup-goal-select');
  if (roundupSelect) roundupSelect.disabled = true;
  const roundupPreview = document.getElementById('roundup-preview');
  if (roundupPreview) roundupPreview.innerText = '';

  await loadTransactionsCloud();
  await loadGoals();
  loadWallets();
}

window.editTransaction = function(id) {
  const t = transactions.find(item => item.id === id);
  if (!t) return;

  document.getElementById('trans-id').value = t.id;
  document.getElementById('trans-desc').value = t.desc;
  document.getElementById('trans-val').value = t.val;
  document.getElementById('trans-type').value = t.type;
  document.getElementById('trans-cat').value = t.cat;
  document.getElementById('trans-date').value = t.date;
  document.getElementById('trans-tags').value = t.tags;
  document.getElementById('trans-recurring').checked = t.isRecurring;
  if (document.getElementById('trans-account')) document.getElementById('trans-account').value = t.accountId || '';
  if (document.getElementById('moeda')) document.getElementById('moeda').value = t.currency || 'BRL';

  document.getElementById('form-title').innerText = 'Editar Lançamento';
  window.scrollTo({ top: 0, behavior: 'smooth' });
};

window.deleteTransaction = function(id) {
  showModal('Excluir Lançamento', 'Deseja remover este lançamento? Terá alguns segundos para anular a ação.', () => {
    const idx = transactions.findIndex(t => t.id === id);
    if (idx === -1) return;
    const removed = transactions[idx];

    transactions.splice(idx, 1);
    renderData();
    loadWallets();

    const timeoutId = setTimeout(async () => {
      delete pendingExclusions[id];
      const { error } = await _supabase.from('transactions').delete().eq('id', id);
      if (error) {
        console.error('Erro ao excluir definitivamente:', error);
        await loadTransactionsCloud();
      }
    }, EXCLUSION_UNDO_TIME_MS);

    pendingExclusions[id] = timeoutId;

    notifyWithAction('Lançamento removido.', '↩️ Desfazer', () => {
      const pending = pendingExclusions[id];
      if (pending) {
        clearTimeout(pending);
        delete pendingExclusions[id];
      }
      transactions.push(removed);
      transactions.sort((a, b) => new Date(b.date) - new Date(a.date));
      renderData();
      loadWallets();
      notify('Exclusão anulada!');
    });
  });
};

function renderData() {
  const search = document.getElementById('search-input')?.value.toLowerCase() || '';
  const filterType = document.getElementById('filter-type')?.value || 'Todos';
  const dateStart = document.getElementById('filter-date-start')?.value || '';
  const dateEnd = document.getElementById('filter-date-end')?.value || '';
  const monthPicker = document.getElementById('month-picker')?.value || '';
  const accountFilter = document.getElementById('dash-account-filter')?.value || '';

  let filtered = transactions.filter(t => {
    const matchSearch = t.desc.toLowerCase().includes(search) || t.tags.toLowerCase().includes(search);
    const matchType = filterType === 'Todos' || t.type === filterType;
    let matchDate = true;

    if (monthPicker) {
      matchDate = t.date.startsWith(monthPicker);
    } else {
      if (dateStart && t.date < dateStart) matchDate = false;
      if (dateEnd && t.date > dateEnd) matchDate = false;
    }

    let matchAccount = true;
    if (accountFilter) {
      matchAccount = t.accountId === accountFilter;
    }

    return matchSearch && matchType && matchDate && matchAccount;
  });

  lastFilteredItems = filtered;

  let totalRec = 0;
  let totalDesp = 0;

  filtered.forEach(t => {
    const valueInBrl = t.currency && t.currency !== 'BRL' ? convertToBRL(t.val, t.currency) : t.val;
    if (t.type === 'Receita') totalRec += valueInBrl;
    else totalDesp += valueInBrl;
  });

  const balance = totalRec - totalDesp;

  const elRec = document.getElementById('val-receita');
  const elDesp = document.getElementById('val-despesa');
  const elSaldo = document.getElementById('val-saldo');

  if (elRec) elRec.innerText = `R$ ${totalRec.toFixed(2)}`;
  if (elDesp) elDesp.innerText = `R$ ${totalDesp.toFixed(2)}`;
  if (elSaldo) {
    elSaldo.innerText = `R$ ${balance.toFixed(2)}`;
    elSaldo.style.color = balance >= 0 ? '#10b981' : '#ef4444';
  }

  updateBudget(totalDesp);
  updateTable(filtered);
  updateCharts(filtered);
  renderCategories();
  renderWallets();
}

function updateBudget(totalExpenses) {
  const limitInput = document.getElementById('budget-limit');
  const fill = document.getElementById('budget-progress');
  const badge = document.getElementById('budget-alert-badge');
  const text = document.getElementById('budget-text');
  if (!limitInput || !fill) return;

  const limit = parseFloat(limitInput.value) || 5000;
  const perc = limit > 0 ? Math.min(100, (totalExpenses / limit) * 100) : 0;

  fill.style.width = `${perc}%`;
  fill.style.background = perc >= 100 ? '#ef4444' : (perc >= 80 ? '#f59e0b' : '#10b981');

  if (badge) {
    if (perc >= 90) badge.classList.remove('hidden');
    else badge.classList.add('hidden');
  }

  if (text) {
    text.innerText = `${perc.toFixed(1)}% do limite utilizado (R$ ${totalExpenses.toFixed(2)} / R$ ${limit.toFixed(2)})`;
  }
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
    const currencyNotBrl = t.currency && t.currency !== 'BRL';
    const convertedValue = currencyNotBrl ? convertToBRL(t.val, t.currency) : null;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${t.date.split('-').reverse().join('/')}</td>
      <td>${escapeHtml(t.desc)} ${t.tags ? `<br><small style="color:var(--text-muted);">#${escapeHtml(t.tags.split(',').join(' #'))}</small>` : ''}
        ${t.receiptUrl ? `<br><a class="receipt-thumb-link" href="${escapeHtml(t.receiptUrl)}" target="_blank" rel="noopener">📎 Comprovativo</a>` : ''}
      </td>
      <td>${escapeHtml(t.cat)}</td>
      <td><span class="badge ${t.type === 'Receita' ? 'badge-paid' : 'badge-overdue'}">${t.type}</span></td>
      <td style="color: ${t.type === 'Receita' ? '#10b981' : '#ef4444'}; font-weight:700;">
        ${t.type === 'Receita' ? '+' : '-'} ${currencySymbol(t.currency)} ${t.val.toFixed(2)}
        ${currencyNotBrl ? `<span class="currency-badge">${t.currency} · ≈ R$ ${convertedValue.toFixed(2)}</span>` : ''}
      </td>
      <td>
        <button class="action-btn" onclick="editTransaction('${t.id}')">Editar</button>
        ${t.isRecurring ? `<button class="btn-series" onclick="openSeriesEditing('${t.id}')" title="Editar todos os lançamentos futuros desta série">🔄 Série</button>` : ''}
        <button class="action-btn btn-del" onclick="deleteTransaction('${t.id}')">Excluir</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function updateCharts(filtered) {
  const barCtx = document.getElementById('barChart')?.getContext('2d');
  const doughCtx = document.getElementById('doughnutChart')?.getContext('2d');
  const compareCtx = document.getElementById('compareChart')?.getContext('2d');
  const annualCtx = document.getElementById('annualChart')?.getContext('2d');
  const weeklyCtx = document.getElementById('graficoSemanal')?.getContext('2d');

  let rec = 0;
  let desp = 0;
  filtered.forEach(t => {
    const v = t.currency && t.currency !== 'BRL' ? convertToBRL(t.val, t.currency) : t.val;
    if (t.type === 'Receita') rec += v;
    else desp += v;
  });

  if (barCtx) {
    if (barChartInstance) barChartInstance.destroy();
    barChartInstance = new Chart(barCtx, {
      type: 'bar',
      data: {
        labels: ['Entradas', 'Saídas'],
        datasets: [{ label: 'Valores (R$)', data: [rec, desp], backgroundColor: ['#10b981', '#ef4444'] }]
      },
      options: { responsive: true, plugins: { legend: { display: false } } }
    });
  }

  const catMap = {};
  filtered.filter(t => t.type === 'Despesa').forEach(t => {
    const v = t.currency && t.currency !== 'BRL' ? convertToBRL(t.val, t.currency) : t.val;
    catMap[t.cat] = (catMap[t.cat] || 0) + v;
  });

  if (doughCtx) {
    if (doughnutChartInstance) doughnutChartInstance.destroy();
    doughnutChartInstance = new Chart(doughCtx, {
      type: 'doughnut',
      data: {
        labels: Object.keys(catMap),
        datasets: [{ data: Object.values(catMap), backgroundColor: ['#6366f1', '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'] }]
      },
      options: { responsive: true }
    });
  }

  const weekdays = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
  const expensesPerDay = [0, 0, 0, 0, 0, 0, 0];
  filtered.filter(t => t.type === 'Despesa').forEach(t => {
    const dayIndex = new Date(t.date + 'T00:00:00').getDay();
    const v = t.currency && t.currency !== 'BRL' ? convertToBRL(t.val, t.currency) : t.val;
    expensesPerDay[dayIndex] += v;
  });

  if (weeklyCtx) {
    if (weeklyChartInstance) weeklyChartInstance.destroy();
    weeklyChartInstance = new Chart(weeklyCtx, {
      type: 'bar',
      data: {
        labels: weekdays,
        datasets: [{ label: 'Gastos por Dia da Semana', data: expensesPerDay, backgroundColor: '#3b82f6' }]
      },
      options: { responsive: true }
    });
  }

  const today = new Date();
  const currentMonthStr = today.toISOString().slice(0, 7);
  const previousDate = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const previousMonthStr = previousDate.toISOString().slice(0, 7);

  let currentExpense = 0, previousExpense = 0;
  transactions.filter(t => t.type === 'Despesa').forEach(t => {
    const v = t.currency && t.currency !== 'BRL' ? convertToBRL(t.val, t.currency) : t.val;
    if (t.date.startsWith(currentMonthStr)) currentExpense += v;
    if (t.date.startsWith(previousMonthStr)) previousExpense += v;
  });

  if (compareCtx) {
    if (compareChartInstance) compareChartInstance.destroy();
    compareChartInstance = new Chart(compareCtx, {
      type: 'bar',
      data: {
        labels: ['Mês Anterior', 'Mês Atual'],
        datasets: [{ label: 'Despesas', data: [previousExpense, currentExpense], backgroundColor: ['#94a3b8', '#4f46e5'] }]
      },
      options: { responsive: true }
    });
  }

  const yearLabels = [];
  const yearData = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const yearMonth = d.toISOString().slice(0, 7);
    yearLabels.push(d.toLocaleString('pt-PT', { month: 'short', year: '2-digit' }));
    
    let totalMonth = 0;
    transactions.filter(t => t.type === 'Despesa' && t.date.startsWith(yearMonth)).forEach(t => {
      totalMonth += t.currency && t.currency !== 'BRL' ? convertToBRL(t.val, t.currency) : t.val;
    });
    yearData.push(totalMonth);
  }

  if (annualCtx) {
    if (annualChartInstance) annualChartInstance.destroy();
    annualChartInstance = new Chart(annualCtx, {
      type: 'line',
      data: {
        labels: yearLabels,
        datasets: [{ label: 'Evolução de Gastos', data: yearData, borderColor: '#10b981', backgroundColor: 'rgba(16, 185, 129, 0.1)', fill: true, tension: 0.3 }]
      },
      options: { responsive: true }
    });
  }

  generateAiInsights(currentExpense, previousExpense, totalRec);
}

function generateAiInsights(currentExpense, previousExpense, totalRec) {
  const panel = document.getElementById('painel-insights');
  if (!panel || panel.dataset.aiReal === 'true') return;

  let text = '🤖 <strong>Insights (análise rápida):</strong> ';
  if (currentExpense > previousExpense && previousExpense > 0) {
    const increase = (((currentExpense - previousExpense) / previousExpense) * 100).toFixed(1);
    text += `Os seus gastos aumentaram ${increase}% em relação ao mês passado. Fique atento ao orçamento!`;
  } else if (totalRec > 0 && currentExpense > totalRec * 0.8) {
    text += 'Atenção: As suas despesas já ultrapassaram 80% das suas receitas este mês.';
  } else {
    text += 'As suas finanças estão equilibradas este mês. Continue assim!';
  }
  panel.innerHTML = `${text} <button id="btn-refresh-insights" class="insights-refresh-btn" onclick="updateAiInsights(true)">🔄 Atualizar com IA</button>`;
}

window.updateAiInsights = async function(force) {
  const panel = document.getElementById('painel-insights');
  if (!panel) return;

  const now = Date.now();
  if (!force && (now - lastAiInsightTime) < AI_INSIGHT_INTERVAL_MS) return;

  const currentBtn = document.getElementById('btn-refresh-insights');
  if (currentBtn) { currentBtn.disabled = true; currentBtn.innerText = '🤖 A pensar...'; }

  try {
    const today = new Date();
    const currentMonthStr = today.toISOString().slice(0, 7);
    const summary = { currentMonth: currentMonthStr, totalReceitas: 0, totalDespesas: 0, expensesPerCategory: {} };

    transactions.filter(t => t.date.startsWith(currentMonthStr)).forEach(t => {
      const v = t.currency && t.currency !== 'BRL' ? convertToBRL(t.val, t.currency) : t.val;
      if (t.type === 'Receita') summary.totalReceitas += v;
      else {
        summary.totalDespesas += v;
        summary.expensesPerCategory[t.cat] = (summary.expensesPerCategory[t.cat] || 0) + v;
      }
    });

    const { data: { session } } = await _supabase.auth.getSession();

    const response = await fetch(AI_FUNCTION_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session?.access_token || SUPABASE_ANON_KEY}`,
        'apikey': SUPABASE_ANON_KEY
      },
      body: JSON.stringify({ action: 'insights', summary })
    });

    if (!response.ok) throw new Error(`Função retornou estado ${response.status}`);
    const data = await response.json();
    if (data.error) throw new Error(data.error);
    if (!data.insight) throw new Error('Resposta sem insight.');

    panel.dataset.aiReal = 'true';
    panel.innerHTML = `🤖 <strong>Insight (IA):</strong> ${escapeHtml(data.insight)} <button id="btn-refresh-insights" class="insights-refresh-btn" onclick="updateAiInsights(true)">🔄 Atualizar com IA</button>`;
    lastAiInsightTime = now;
  } catch (err) {
    console.warn('IA de insights indisponível, a manter análise local:', err.message);
    if (force) notify('⚠️ IA indisponível de momento (a Edge Function precisa de estar publicada — veja README_NOVAS_FEATURES.md).');
    panel.dataset.aiReal = 'false';
    const btn = document.getElementById('btn-refresh-insights');
    if (btn) { btn.disabled = false; btn.innerText = '🔄 Atualizar com IA'; }
  }
};

async function loadInvestments() {
  if (!currentUser) return;
  const { data, error } = await _supabase.from('investments').select('*').eq('user_id', currentUser.id);
  if (error) return console.error('Erro ao carregar investimentos:', error);

  investments = data.map(i => ({
    id: i.id,
    name: i.name,
    type: i.type,
    qty: parseFloat(i.quantity) || 0,
    avgPrice: parseFloat(i.avg_price) || 0,
    currentPrice: parseFloat(i.current_price) || 0
  }));

  renderInvestments();
}

async function handleSaveInvestment(e) {
  e.preventDefault();
  const name = document.getElementById('inv-name').value;
  const type = document.getElementById('inv-type').value;
  const qty = parseFloat(document.getElementById('inv-qty').value);
  const avgPrice = parseFloat(document.getElementById('inv-avg-price').value);
  const currentPrice = parseFloat(document.getElementById('inv-current-price').value);

  const { error } = await _supabase.from('investments').insert([{
    user_id: currentUser.id, name, type, quantity: qty, avg_price: avgPrice, current_price: currentPrice
  }]);

  if (error) return alert('Erro ao guardar ativo: ' + error.message);
  notify('Ativo adicionado com sucesso!');
  e.target.reset();
  loadInvestments();
}

window.deleteInvestment = function(id) {
  showModal('Excluir Ativo', 'Deseja remover este ativo da carteira?', async () => {
    const { error } = await _supabase.from('investments').delete().eq('id', id);
    if (error) return alert('Erro ao excluir: ' + error.message);
    notify('Ativo removido!');
    loadInvestments();
  });
};

function renderInvestments() {
  const tbody = document.getElementById('investments-table-body');
  if (!tbody) return;
  tbody.innerHTML = '';

  let totalInvested = 0;
  let totalCurrentValue = 0;

  investments.forEach(inv => {
    const invTotal = inv.qty * inv.avgPrice;
    const curTotal = inv.qty * inv.currentPrice;
    const profitability = invTotal > 0 ? ((curTotal - invTotal) / invTotal) * 100 : 0;

    totalInvested += invTotal;
    totalCurrentValue += curTotal;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(inv.name)}</td>
      <td>${escapeHtml(inv.type)}</td>
      <td>${inv.qty}</td>
      <td>R$ ${inv.avgPrice.toFixed(2)}</td>
      <td>R$ ${inv.currentPrice.toFixed(2)}</td>
      <td>R$ ${curTotal.toFixed(2)}</td>
      <td style="color: ${profitability >= 0 ? '#10b981' : '#ef4444'}; font-weight:700;">${profitability.toFixed(2)}%</td>
      <td><button class="action-btn btn-del" onclick="deleteInvestment('${inv.id}')">Excluir</button></td>
    `;
    tbody.appendChild(tr);
  });

  const totalProf = totalInvested > 0 ? ((totalCurrentValue - totalInvested) / totalInvested) * 100 : 0;
  document.getElementById('val-investido').innerText = `R$ ${totalInvested.toFixed(2)}`;
  document.getElementById('val-atual-investimentos').innerText = `R$ ${totalCurrentValue.toFixed(2)}`;
  const elProf = document.getElementById('val-rentabilidade');
  if (elProf) {
    elProf.innerText = `${totalProf.toFixed(2)}%`;
    elProf.style.color = totalProf >= 0 ? '#10b981' : '#ef4444';
  }
}

async function handleShareInvite(e) {
  e.preventDefault();
  const email = document.getElementById('share-email').value;
  const { error } = await _supabase.from('shared_accounts').insert([{ owner_id: currentUser.id, shared_with_email: email }]);
  if (error) return alert('Erro ao enviar convite: ' + error.message);
  notify('Convite enviado com sucesso!');
  e.target.reset();
  loadShares();
}

async function loadShares() {
  if (!currentUser) return;
  const container = document.getElementById('shares-list-container');
  if (!container) return;

  const { data, error } = await _supabase.from('shared_accounts').select('*').eq('owner_id', currentUser.id);
  if (error) return;

  container.innerHTML = data.length > 0 
    ? `<p style="font-size: 14px; color: var(--text-muted);">Compartilhado com: <strong>${data.map(d => escapeHtml(d.shared_with_email)).join(', ')}</strong></p>` 
    : '<p style="font-size: 14px; color: var(--text-muted);">Nenhum compartilhamento ativo.</p>';
}

async function sincronizarContaBancaria() {
  const btn = document.getElementById('btn-open-finance');
  if (typeof PluggyConnect === 'undefined') {
    return notify('⚠️ O widget do Pluggy não carregou (verifique a sua ligação à internet).');
  }

  if (btn) { btn.disabled = true; btn.innerText = '🏦 A preparar ligação segura...'; }

  try {
    const { data: { session } } = await _supabase.auth.getSession();

    const response = await fetch(`${SUPABASE_URL}/functions/v1/pluggy-connect-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session?.access_token || SUPABASE_ANON_KEY}`,
        'apikey': SUPABASE_ANON_KEY
      }
    });

    if (!response.ok) throw new Error(`Função retornou estado ${response.status}`);
    const data = await response.json();
    if (data.error) throw new Error(data.error);
    if (!data.connectToken) throw new Error('Não recebi um token de conexão do Pluggy.');

    const pluggyConnect = new PluggyConnect({
      connectToken: data.connectToken,
      includeSandbox: true,
      onSuccess: async (itemData) => {
        notify('✅ Banco conectado! A importar transações...');
        await importViaPluggy(itemData.item.id);
      },
      onError: (err) => {
        console.error('Erro no widget do Pluggy:', err);
        notify('⚠️ Não foi possível concluir a conexão com o banco.');
      },
      onClose: () => {
        if (btn) { btn.disabled = false; btn.innerText = '🏦 Conectar Banco (Open Finance)'; }
      }
    });

    pluggyConnect.init();
  } catch (err) {
    console.error('Erro ao iniciar Open Finance:', err);
    notify('⚠️ Open Finance indisponível de momento (as Edge Functions do Pluggy precisam de estar publicadas — veja README_NOVAS_FEATURES.md).');
  } finally {
    if (btn) { btn.disabled = false; btn.innerText = '🏦 Conectar Banco (Open Finance)'; }
  }
}

async function importViaPluggy(itemId) {
  try {
    const { data: { session } } = await _supabase.auth.getSession();

    const response = await fetch(`${SUPABASE_URL}/functions/v1/pluggy-sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session?.access_token || SUPABASE_ANON_KEY}`,
        'apikey': SUPABASE_ANON_KEY
      },
      body: JSON.stringify({ itemId })
    });

    if (!response.ok) throw new Error(`Função retornou estado ${response.status}`);
    const data = await response.json();
    if (data.error) throw new Error(data.error);

    notify(`🏦 ${data.imported} transação(ões) importada(s) de ${data.institution}!`);
    await loadTransactionsCloud();
    await loadWallets();
  } catch (err) {
    console.error('Erro ao importar dados do Pluggy:', err);
    notify('⚠️ O banco ligou-se, mas não foi possível importar as transações de momento. Tente sincronizar novamente.');
  }
}

window.lerNotaFiscalViaIA = async function(file) {
  if (!file) return;
  const statusOcr = document.getElementById('status-ocr');
  if (statusOcr) statusOcr.innerText = '🤖 IA a ler o comprovativo/nota fiscal...';

  try {
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(new Error('Falha ao ler o ficheiro.'));
      reader.readAsDataURL(file);
    });

    const { data: { session } } = await _supabase.auth.getSession();

    const response = await fetch(AI_FUNCTION_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session?.access_token || SUPABASE_ANON_KEY}`,
        'apikey': SUPABASE_ANON_KEY
      },
      body: JSON.stringify({ action: 'ocr', mediaType: file.type || 'image/jpeg', imageBase64: base64 })
    });

    if (!response.ok) throw new Error(`Função retornou estado ${response.status}`);
    const data = await response.json();
    if (data.error) throw new Error(data.error);

    if (data.descricao) document.getElementById('trans-desc').value = data.descricao;
    if (data.valor) document.getElementById('trans-val').value = data.valor;
    if (data.data) document.getElementById('trans-date').value = data.data;
    document.getElementById('trans-type').value = 'Despesa';
    updatePiggyBankPreview();

    if (statusOcr) statusOcr.innerText = '✅ Dados extraídos pela IA — confira antes de guardar!';
    notify('Nota fiscal lida pela IA — reveja os dados antes de confirmar.');
  } catch (err) {
    console.error('Erro no OCR de nota fiscal:', err);
    if (statusOcr) statusOcr.innerText = '⚠️ Não foi possível ler a nota. Preencha manualmente.';
    notify('⚠️ Leitura por IA indisponível de momento (a Edge Function precisa de estar publicada — veja README_NOVAS_FEATURES.md).');
  }
};

function exportarExcel() {
  if (lastFilteredItems.length === 0) {
    return alert('Não existem dados para exportar.');
  }

  const formattedData = lastFilteredItems.map(t => ({
    Data: t.date,
    Descrição: t.desc,
    Categoria: t.cat,
    Tipo: t.type,
    Valor: t.val,
    Moeda: t.currency || 'BRL'
  }));

  const worksheet = XLSX.utils.json_to_sheet(formattedData);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Lançamentos');
  XLSX.writeFile(workbook, 'Relatorio_FluxoPro.xlsx');
  notify('Folha de cálculo Excel gerada com sucesso!');
}

function exportCSV() {
  if (lastFilteredItems.length === 0) return alert('Nenhum dado para exportar.');
  let csv = 'Data,Descricao,Categoria,Tipo,Valor\n';
  lastFilteredItems.forEach(t => {
    csv += `${t.date},"${t.desc}","${t.cat}",${t.type},${t.val}\n`;
  });
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'extrato_fluxopro.csv';
  a.click();
  notify('CSV exportado!');
}

function exportPDF() {
  if (lastFilteredItems.length === 0) return alert('Nenhum dado para exportar.');
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();

  doc.text('Relatório Financeiro - FluxoPro Enterprise', 14, 20);
  const rows = lastFilteredItems.map(t => [t.date, t.desc, t.cat, t.type, `R$ ${t.val.toFixed(2)}`]);

  doc.autoTable({
    head: [['Data', 'Descrição', 'Categoria', 'Tipo', 'Valor']],
    body: rows,
    startY: 30
  });

  doc.save('extrato_fluxopro.pdf');
  notify('PDF gerado com sucesso!');
}

async function handleImportFile() {
  const fileInput = document.getElementById('import-file-input');
  const accountId = document.getElementById('import-default-account').value || null;
  const defaultCat = document.getElementById('import-default-cat').value || 'Geral';

  if (!fileInput.files || fileInput.files.length === 0) {
    return alert('Selecione um ficheiro CSV ou OFX.');
  }

  const file = fileInput.files[0];
  Papa.parse(file, {
    header: false,
    complete: async function(results) {
      const news = [];
      results.data.forEach(row => {
        if (row.length >= 3 && row[0] && row[1] && row[2]) {
          const val = parseFloat(row[2].replace(',', '.'));
          if (!isNaN(val)) {
            news.push({
              user_id: currentUser.id,
              description: row[1],
              amount: Math.abs(val),
              type: val < 0 ? 'Despesa' : 'Receita',
              category: defaultCat,
              date: row[0].trim(),
              account_id: accountId
            });
          }
        }
      });

      if (news.length > 0) {
        const { error } = await _supabase.from('transactions').insert(news);
        if (error) return alert('Erro ao importar: ' + error.message);
        notify(`${news.length} transações importadas com sucesso!`);
        loadTransactionsCloud();
        loadWallets();
      } else {
        alert('Formato do ficheiro não reconhecido ou vazio.');
      }
    }
  });
}

async function renderMfaStatus() {
  const container = document.getElementById('mfa-setup-container');
  const text = document.getElementById('mfa-status-text');
  if (!container || !text) return;

  const { data, error } = await _supabase.auth.mfa.listFactors();
  if (error) return;

  const totpFactor = data.factors.find(f => f.factor_type === 'totp' && f.status === 'verified');

  if (totpFactor) {
    text.innerText = 'Estado: 2FA Ativo (A sua conta está protegida)';
    container.innerHTML = `<button onclick="disableMfa('${totpFactor.id}')" class="btn-del">Desativar 2FA</button>`;
  } else {
    text.innerText = 'Estado: 2FA Inativo';
    container.innerHTML = `<button onclick="startMfaSetup()" class="btn-primary">Configurar 2FA (Google Authenticator)</button>`;
  }
}

async function startMfaSetup() {
  const { data, error } = await _supabase.auth.mfa.enroll({ factorType: 'totp' });
  if (error) return alert('Erro ao iniciar 2FA: ' + error.message);

  pendingMfaFactorId = data.id;
  const qrCodeUri = data.totp.qr_code;

  const container = document.getElementById('mfa-setup-container');
  container.innerHTML = `
    <p>Faça a leitura do QR Code abaixo com a sua aplicação autenticadora (Google Authenticator, Authy):</p>
    <div style="margin: 10px 0;"><img src="${qrCodeUri}" alt="QR Code 2FA" style="max-width:200px;"></div>
    <div class="input-group">
      <label>Introduza o código gerado para confirmar:</label>
      <input type="text" id="mfa-setup-code" placeholder="000000" maxlength="6">
    </div>
    <button onclick="confirmMfaSetup()" class="btn-primary">Ativar 2FA</button>
  `;
}

async function confirmMfaSetup() {
  const code = document.getElementById('mfa-setup-code').value.trim();
  const { data: challenge, error: errChallenge } = await _supabase.auth.mfa.challenge({ factorId: pendingMfaFactorId });
  if (errChallenge) return alert('Erro: ' + errChallenge.message);

  const { error: errVerify } = await _supabase.auth.mfa.verify({
    factorId: pendingMfaFactorId, challengeId: challenge.id, code
  });
  if (errVerify) return alert('Código inválido: ' + errVerify.message);

  notify('2FA ativado com sucesso!');
  renderMfaStatus();
}

async function disableMfa(factorId) {
  showModal('Desativar 2FA', 'Tem certeza que deseja desativar a verificação em duas etapas?', async () => {
    const { error } = await _supabase.auth.mfa.unenroll({ factorId });
    if (error) return alert('Erro ao desativar: ' + error.message);
    notify('2FA desativado.');
    renderMfaStatus();
  });
}
