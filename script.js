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
// Publique a função em supabase/functions/ai-assistant (veja README_NOVAS_FEATURES.md)
// e configure o secret ANTHROPIC_API_KEY no projeto Supabase antes de usar.
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
let ultimosItensFiltrados = [];
let pendingMfaFactorId = null;

let barChartInstance = null;
let doughnutChartInstance = null;
let compareChartInstance = null;
let annualChartInstance = null;
let graficoSemanalInstance = null;
let pendingDeleteAction = null;

// --- NOVOS ESTADOS: undo de exclusão, câmbio, insights de IA ---
const EXCLUSAO_TEMPO_DESFAZER_MS = 6000; // janela para "Desfazer exclusão"
let exclusoesPendentes = {}; // { id: timeoutId }
let taxasCambio = { BRL: 1 }; // cache de câmbio (base BRL)
let taxasCambioCarregadas = false;
let ultimoInsightIA = 0; // timestamp da última chamada real de IA (throttle)
const INSIGHT_IA_INTERVALO_MS = 5 * 60 * 1000; // no máx. 1 chamada real a cada 5 min
let serieEmEdicao = null; // transação de referência para o editor de série recorrente

// --- SEGURANÇA: ESCAPE DE HTML ---
function escapeHtml(str) {
  const div = document.createElement('div');
  div.innerText = str ?? '';
  return div.innerHTML;
}

// --- TAGS ---
function normalizarTags(str) {
  return (str || '')
    .split(',')
    .map(t => t.trim().toLowerCase())
    .filter(Boolean)
    .join(',');
}

// --- MÚLTIPLAS MOEDAS ---
// Busca taxas de câmbio (base BRL) numa API pública e gratuita, sem chave (frankfurter.app).
// Os totais do dashboard, orçamento e envelopes são sempre exibidos convertidos em BRL,
// mas cada lançamento mantém e mostra seu valor e moeda originais.
async function carregarTaxasCambio() {
  try {
    const resp = await fetch('https://api.frankfurter.app/latest?from=BRL&to=USD,EUR');
    if (!resp.ok) throw new Error('Falha ao buscar câmbio');
    const data = await resp.json();
    // data.rates: quantos USD/EUR equivalem a 1 BRL. Precisamos do inverso (quantos BRL por 1 USD/EUR).
    taxasCambio = {
      BRL: 1,
      USD: data.rates?.USD ? 1 / data.rates.USD : 5,
      EUR: data.rates?.EUR ? 1 / data.rates.EUR : 5.5
    };
    taxasCambioCarregadas = true;
  } catch (err) {
    console.warn('Não foi possível buscar câmbio em tempo real, usando estimativa fixa:', err.message);
    taxasCambio = { BRL: 1, USD: 5, EUR: 5.5 }; // fallback aproximado
    taxasCambioCarregadas = true;
  }
  renderizarDados();
}

function converterParaBRL(valor, moeda) {
  const taxa = taxasCambio[moeda] ?? 1;
  return valor * taxa;
}

function simboloMoeda(moeda) {
  return { BRL: 'R$', USD: 'US$', EUR: '€' }[moeda] || 'R$';
}

// --- MÁSCARAS ---
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

// --- NOTIFICAÇÃO & MODAL ---
function notify(text) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerText = text;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// Toast com um botão de ação (usado pelo "Desfazer exclusão")
function notifyComAcao(text, actionLabel, onAction, duracaoMs = EXCLUSAO_TEMPO_DESFAZER_MS) {
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
  setTimeout(() => { if (toast.isConnected) toast.remove(); }, duracaoMs + 500);
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

// --- EVENTOS E SESSÃO ---
document.addEventListener('DOMContentLoaded', () => {
  setupEventListeners();
  applyMasks();
  registrarServiceWorker();

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
        mostrarTelaMfa();
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
      iniciarSistema();
    } else {
      currentUser = null;
      document.getElementById('auth-screen').style.display = 'flex';
      document.getElementById('app-screen').style.display = 'none';
    }
  });
});

function registrarServiceWorker() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('service-worker.js').catch(err => {
        console.warn('Service worker não registrado:', err.message);
      });
    });
  }
}

function mostrarTelaMfa() {
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
  if (errFactors) return alert('Erro ao buscar fator 2FA: ' + errFactors.message);
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
    iniciarSistema();
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

  document.getElementById('search-input')?.addEventListener('input', renderizarDados);
  document.getElementById('filter-type')?.addEventListener('change', renderizarDados);
  document.getElementById('filter-date-start')?.addEventListener('change', renderizarDados);
  document.getElementById('filter-date-end')?.addEventListener('change', renderizarDados);
  document.getElementById('budget-limit')?.addEventListener('change', renderizarDados);
  document.getElementById('month-picker')?.addEventListener('change', renderizarDados);
  document.getElementById('dash-account-filter')?.addEventListener('change', renderizarDados);
  document.getElementById('btn-clear-month')?.addEventListener('click', () => {
    document.getElementById('month-picker').value = '';
    document.getElementById('filter-date-start').value = '';
    document.getElementById('filter-date-end').value = '';
    document.getElementById('dash-account-filter').value = '';
    renderizarDados();
  });

  document.getElementById('btn-export')?.addEventListener('click', exportarCSV);
  document.getElementById('btn-print-pdf')?.addEventListener('click', exportarPDF);
  document.getElementById('btn-import-file')?.addEventListener('click', handleImportFile);

  // Cofrinho automático (arredondamento)
  document.getElementById('trans-roundup')?.addEventListener('change', atualizarPreviewCofrinho);
  document.getElementById('trans-val')?.addEventListener('input', atualizarPreviewCofrinho);
  document.getElementById('trans-type')?.addEventListener('change', atualizarPreviewCofrinho);

  // Editor de série recorrente
  document.getElementById('series-btn-cancel')?.addEventListener('click', fecharEdicaoSerie);
  document.getElementById('series-btn-confirm')?.addEventListener('click', confirmarEdicaoSerie);

  // Planejamento de metas (quanto guardar por mês/semana)
  document.getElementById('goal-target')?.addEventListener('input', atualizarPreviewMeta);
  document.getElementById('goal-saved-initial')?.addEventListener('input', atualizarPreviewMeta);
  document.getElementById('goal-deadline')?.addEventListener('change', atualizarPreviewMeta);
}

function switchTab(sectionId, navId) {
  document.querySelectorAll('.page-section').forEach(sec => sec.style.display = 'none');
  document.querySelectorAll('.nav-item').forEach(nav => nav.classList.remove('active'));

  document.getElementById(sectionId).style.display = 'block';
  document.getElementById(navId).classList.add('active');

  if (sectionId === 'section-bills') carregarContasNuvem();
  if (sectionId === 'section-categories') renderizarCategorias();
  if (sectionId === 'section-goals') renderizarMetas();
  if (sectionId === 'section-investments') carregarInvestimentos();
  if (sectionId === 'section-accounts') { renderizarCarteiras(); carregarCompartilhamentos(); }
  if (sectionId === 'section-profile') renderizarStatusMfa();
}

async function iniciarSistema() {
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('app-screen').style.display = 'flex';
  document.getElementById('user-display-name').innerText = currentUser.name || currentUser.email;

  document.getElementById('edit-name').value = currentUser.name || '';
  document.getElementById('edit-email').value = currentUser.email || '';
  document.getElementById('edit-doc').value = currentUser.doc || '';
  document.getElementById('edit-phone').value = currentUser.phone || '';
  document.getElementById('edit-profile').value = currentUser.profile || 'Pessoal';

  document.getElementById('trans-date').valueAsDate = new Date();

  await carregarCategoriasNuvem();
  await carregarCarteiras();
  await processarRecorrencias();
  await processarRecorrenciasContas();
  await carregarTransacoesNuvem();
  await carregarContasNuvem();
  await carregarMetas();
  carregarTaxasCambio(); // não bloqueia a UI — atualiza os totais quando chegar

  verificarContasProximas();
}

// --- AUTENTICAÇÃO ---
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

  if (error) return alert('Erro no cadastro: ' + error.message);
  notify('Conta criada com sucesso!');
  document.getElementById('register-box').style.display = 'none';
  document.getElementById('login-box').style.display = 'block';
}

async function handleLogin(e) {
  e.preventDefault();
  const email = document.getElementById('login-email').value;
  const password = document.getElementById('login-password').value;

  const { error } = await _supabase.auth.signInWithPassword({ email, password });
  if (error) alert('Falha no login: ' + error.message);
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
  if (error) return alert('Erro ao redefinir senha: ' + error.message);

  notify('Senha atualizada com sucesso!');
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

// --- GESTÃO DE CATEGORIAS ---
async function carregarCategoriasNuvem() {
  if(!currentUser) return;

  const { data, error } = await _supabase.from('categories').select('*').eq('user_id', currentUser.id).order('name');
  if (error) return console.error('Erro ao carregar categorias:', error);

  if (data.length === 0) {
    const padrao = [
      { user_id: currentUser.id, name: 'Salário', limit_val: 0 },
      { user_id: currentUser.id, name: 'Alimentação', limit_val: 800 },
      { user_id: currentUser.id, name: 'Moradia', limit_val: 1500 },
      { user_id: currentUser.id, name: 'Investimentos', limit_val: 1000 },
      { user_id: currentUser.id, name: 'Lazer', limit_val: 400 },
      { user_id: currentUser.id, name: 'Geral', limit_val: 500 }
    ];
    const { data: criadas, error: erroCriar } = await _supabase.from('categories').insert(padrao).select();
    if (erroCriar) { console.error('Erro ao criar categorias padrão:', erroCriar); categories = []; }
    else categories = criadas.map(c => ({ id: c.id, name: c.name, limit: parseFloat(c.limit_val) || 0 }));
  } else {
    categories = data.map(c => ({ id: c.id, name: c.name, limit: parseFloat(c.limit_val) || 0 }));
  }

  atualizarSelectCategorias();
  renderizarCategorias();
}

function atualizarSelectCategorias() {
  const select = document.getElementById('trans-cat');
  if (!select) return;
  const valorAtual = select.value;
  select.innerHTML = '';

  categories.forEach(c => {
    const option = document.createElement('option');
    option.value = c.name;
    option.innerText = c.name;
    select.appendChild(option);
  });

  if (valorAtual) select.value = valorAtual;

  const importCat = document.getElementById('import-default-cat');
  if (importCat) {
    const valorImportAtual = importCat.value;
    importCat.innerHTML = '';
    categories.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.name;
      opt.innerText = c.name;
      importCat.appendChild(opt);
    });
    if (valorImportAtual) importCat.value = valorImportAtual;
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
  atualizarSelectCategorias();
  renderizarCategorias();
  renderizarDados();
  e.target.reset();
  notify('Categoria criada!');
}

window.removerCategoria = function(id, name) {
  showModal('Remover Categoria', `Deseja apagar a categoria "${name}"?`, async () => {
    const { error } = await _supabase.from('categories').delete().eq('id', id);
    if (error) return alert('Erro ao remover categoria: ' + error.message);

    categories = categories.filter(c => c.id !== id);
    atualizarSelectCategorias();
    renderizarCategorias();
    renderizarDados();
    notify('Categoria removida!');
  });
};

function renderizarCategorias() {
  const container = document.getElementById('categories-list-container');
  if (!container) return;
  container.innerHTML = '';

  // Envelopes de orçamento: o gasto considerado é sempre o do mês atual (reinicia todo mês),
  // e valores em outras moedas entram convertidos para BRL.
  const mesAtualStr = new Date().toISOString().slice(0, 7);
  const gastosPorCat = {};
  transactions.forEach(t => {
    if (t.type === 'Despesa' && t.date.startsWith(mesAtualStr)) {
      const v = t.currency && t.currency !== 'BRL' ? converterParaBRL(t.val, t.currency) : t.val;
      gastosPorCat[t.cat] = (gastosPorCat[t.cat] || 0) + v;
    }
  });

  categories.forEach(c => {
    const gasto = gastosPorCat[c.name] || 0;
    const perc = c.limit > 0 ? Math.min(100, (gasto / c.limit) * 100) : 0;
    const restante = c.limit > 0 ? c.limit - gasto : null;
    const statusClasse = perc >= 100 ? 'over' : (perc >= 80 ? 'warn' : 'ok');

    const card = document.createElement('div');
    card.className = 'category-card';
    card.innerHTML = `
      <div class="category-card-header">
        <h4>${escapeHtml(c.name)}</h4>
        <button class="action-btn btn-del" onclick="removerCategoria('${c.id}', '${escapeHtml(c.name)}')">Excluir</button>
      </div>
      <div>
        <span style="font-size: 13px; color: var(--text-muted);">Gastos este mês: <strong>R$ ${gasto.toFixed(2)}</strong> ${c.limit > 0 ? `/ R$ ${c.limit.toFixed(2)}` : ''}</span>
      </div>
      ${c.limit > 0 ? `
        <div class="progress-bar-bg">
          <div class="progress-bar-fill" style="width: ${perc}%; background: ${perc >= 100 ? '#ef4444' : (perc >= 80 ? '#f59e0b' : '#10b981')};"></div>
        </div>
        <div class="envelope-remaining ${statusClasse}">${restante >= 0 ? `Restam R$ ${restante.toFixed(2)} no envelope` : `Estourou o envelope em R$ ${Math.abs(restante).toFixed(2)}`}</div>
      ` : ''}
    `;
    container.appendChild(card);
  });
}

// --- CONTAS & CARTEIRAS ---
async function carregarCarteiras() {
  if (!currentUser) return;

  const { data, error } = await _supabase.from('accounts').select('*').eq('user_id', currentUser.id).order('name');
  if (error) return console.error('Erro ao carregar contas/carteiras:', error);

  accounts = data.map(a => ({ id: a.id, name: a.name, initial: parseFloat(a.initial_balance) || 0 }));
  atualizarSelectContas();
  renderizarCarteiras();
}

function atualizarSelectContas() {
  [document.getElementById('trans-account'), document.getElementById('bill-account'), document.getElementById('import-default-account')].forEach(select => {
    if (!select) return;
    const valorAtual = select.value;
    select.innerHTML = '<option value="">Sem conta específica</option>';
    accounts.forEach(a => {
      const opt = document.createElement('option');
      opt.value = a.id;
      opt.innerText = a.name;
      select.appendChild(opt);
    });
    if (valorAtual) select.value = valorAtual;
  });

  const dashFilter = document.getElementById('dash-account-filter');
  if (dashFilter) {
    const valorAtual = dashFilter.value;
    dashFilter.innerHTML = '<option value="">Todas as contas</option>';
    accounts.forEach(a => {
      const opt = document.createElement('option');
      opt.value = a.id;
      opt.innerText = a.name;
      dashFilter.appendChild(opt);
    });
    if (valorAtual) dashFilter.value = valorAtual;
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
  carregarCarteiras();
}

window.deletarCarteira = function(id) {
  showModal('Excluir Conta', 'Deseja remover esta conta? Lançamentos vinculados ficam sem conta associada.', async () => {
    const { error } = await _supabase.from('accounts').delete().eq('id', id);
    if (error) return alert('Erro ao excluir conta: ' + error.message);
    notify('Conta removida!');
    carregarCarteiras();
  });
};

function renderizarCarteiras() {
  const container = document.getElementById('accounts-list-container');
  if (!container) return;
  container.innerHTML = '';

  if (accounts.length === 0) {
    container.innerHTML = '<p style="color: var(--text-muted);">Nenhuma conta cadastrada ainda.</p>';
    return;
  }

  accounts.forEach(a => {
    const movimentado = transactions
      .filter(t => t.accountId === a.id)
      .reduce((soma, t) => soma + (t.type === 'Receita' ? t.val : -t.val), 0);
    const saldo = a.initial + movimentado;

    const card = document.createElement('div');
    card.className = 'category-card';
    card.innerHTML = `
      <div class="category-card-header">
        <h4>${escapeHtml(a.name)}</h4>
        <button class="action-btn btn-del" onclick="deletarCarteira('${a.id}')">Excluir</button>
      </div>
      <div style="font-size: 24px; font-weight: 800; color: ${saldo >= 0 ? '#10b981' : '#ef4444'};">
        R$ ${saldo.toFixed(2)}
      </div>
      <span style="font-size: 12px; color: var(--text-muted);">Saldo inicial: R$ ${a.initial.toFixed(2)}</span>
    `;
    container.appendChild(card);
  });
}

// --- METAS DE ECONOMIA ---
async function carregarMetas() {
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

  renderizarMetas();
  atualizarSelectMetasCofrinho();
}

// --- COFRINHO AUTOMÁTICO (arredondamento) ---
function atualizarSelectMetasCofrinho() {
  const select = document.getElementById('roundup-goal-select');
  if (!select) return;
  const valorAtual = select.value;
  select.innerHTML = '<option value="">Escolha a meta...</option>';
  goals.forEach(g => {
    const opt = document.createElement('option');
    opt.value = g.id;
    opt.innerText = g.name;
    select.appendChild(opt);
  });
  if (valorAtual) select.value = valorAtual;
}

function atualizarPreviewCofrinho() {
  const checkbox = document.getElementById('trans-roundup');
  const select = document.getElementById('roundup-goal-select');
  const preview = document.getElementById('roundup-preview');
  const val = parseFloat(document.getElementById('trans-val')?.value);
  const type = document.getElementById('trans-type')?.value;
  if (!checkbox || !select || !preview) return;

  select.disabled = !checkbox.checked;

  if (!checkbox.checked || !val || type !== 'Despesa') {
    preview.innerText = checkbox.checked && type !== 'Despesa' ? 'Só funciona para despesas.' : '';
    return;
  }

  const diferenca = Math.ceil(val) - val;
  preview.innerText = diferenca > 0
    ? `Vai guardar R$ ${diferenca.toFixed(2)} (arredondando para R$ ${Math.ceil(val).toFixed(2)})`
    : 'Valor já é redondo — nada a guardar desta vez.';
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

  notify('Planejamento criado!');
  e.target.reset();
  const preview = document.getElementById('goal-planning-preview');
  if (preview) preview.style.display = 'none';
  carregarMetas();
}

// --- PLANEJAMENTO DE METAS (calculadora "quanto guardar por mês") ---

// Quantos dias faltam entre hoje e uma data-prazo (null = sem prazo, 0 = vencido).
function diasAteOPrazo(deadlineStr) {
  if (!deadlineStr) return null;
  const hoje = new Date();
  const prazo = new Date(deadlineStr + 'T00:00:00');
  const diffMs = prazo - new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate());
  if (diffMs <= 0) return 0; // prazo já venceu
  return diffMs / (1000 * 60 * 60 * 24);
}

// Quantos meses faltam entre hoje e uma data-prazo (arredondado para cima;
// mínimo 1 mês para não dividir por zero quando o prazo é no mês corrente).
function mesesAteOPrazo(deadlineStr) {
  const dias = diasAteOPrazo(deadlineStr);
  if (dias === null) return null;
  if (dias === 0) return 0;
  return Math.max(1, Math.ceil(dias / 30.44));
}

// Quantas semanas faltam até o prazo (mesma lógica, base 7 dias).
function semanasAteOPrazo(deadlineStr) {
  const dias = diasAteOPrazo(deadlineStr);
  if (dias === null) return null;
  if (dias === 0) return 0;
  return Math.max(1, Math.ceil(dias / 7));
}

// Média mensal de (receitas - despesas), em BRL, nos últimos 3 meses com
// lançamentos — usada para avaliar se uma meta é realista.
function capacidadePoupancaMensal() {
  const hoje = new Date();
  const porMes = {};

  transactions.forEach(t => {
    const v = t.currency && t.currency !== 'BRL' ? converterParaBRL(t.val, t.currency) : t.val;
    const chaveMes = t.date.slice(0, 7);
    porMes[chaveMes] = porMes[chaveMes] || 0;
    porMes[chaveMes] += t.type === 'Receita' ? v : -v;
  });

  const ultimosMeses = [];
  for (let i = 1; i <= 3; i++) {
    const d = new Date(hoje.getFullYear(), hoje.getMonth() - i, 1);
    ultimosMeses.push(d.toISOString().slice(0, 7));
  }

  const valoresComDados = ultimosMeses.filter(m => porMes[m] !== undefined).map(m => porMes[m]);
  if (valoresComDados.length === 0) return null; // sem histórico suficiente

  return valoresComDados.reduce((soma, v) => soma + v, 0) / valoresComDados.length;
}

// Monta o planejamento de uma meta: quanto falta, quanto guardar por mês e
// por semana, percentual concluído, e se o ritmo de economia atual do
// usuário dá conta do prazo.
function calcularPlanejamentoMeta(target, saved, deadlineStr) {
  const faltam = Math.max(0, target - saved);
  const percConcluido = target > 0 ? Math.min(100, (saved / target) * 100) : 0;

  if (faltam === 0) return { atingida: true, percConcluido: 100 };

  const meses = mesesAteOPrazo(deadlineStr);
  const semanas = semanasAteOPrazo(deadlineStr);
  const capacidade = capacidadePoupancaMensal();

  if (meses === null) {
    // Meta sem prazo definido: só mostra quanto falta e a capacidade atual
    return { semPrazo: true, faltam, percConcluido, capacidade };
  }
  if (meses === 0) {
    return { vencida: true, faltam, percConcluido };
  }

  const mensalNecessario = faltam / meses;
  const semanalNecessario = faltam / semanas;
  // "Sobra mensal necessária": quanto a mais você precisa liberar no
  // orçamento, além do que já consegue economizar hoje, para bater o prazo.
  const sobraMensalNecessaria = capacidade !== null ? Math.max(0, mensalNecessario - capacidade) : null;

  let status = 'ok';
  if (capacidade !== null) {
    if (capacidade <= 0) status = 'bad';
    else if (mensalNecessario > capacidade) status = 'warn';
  }

  return { meses, semanas, faltam, percConcluido, mensalNecessario, semanalNecessario, sobraMensalNecessaria, capacidade, status };
}

// Grid com os números do "Cálculo automático": guardar/mês, guardar/semana,
// quanto falta, e percentual concluído.
function gerarGridEstatisticasMeta(plano) {
  if (plano.atingida || plano.vencida) return '';

  const itens = [
    { label: '% Concluído', valor: `${plano.percConcluido.toFixed(0)}%` },
    { label: 'Falta', valor: `R$ ${plano.faltam.toFixed(2)}` }
  ];

  if (!plano.semPrazo) {
    itens.push({ label: 'Guardar/mês', valor: `R$ ${plano.mensalNecessario.toFixed(2)}` });
    itens.push({ label: 'Guardar/semana', valor: `R$ ${plano.semanalNecessario.toFixed(2)}` });
    if (plano.sobraMensalNecessaria !== null) {
      itens.push({ label: 'Sobra mensal necessária', valor: `R$ ${plano.sobraMensalNecessaria.toFixed(2)}` });
    }
  }

  return `<div class="goal-stats-grid">${itens.map(i => `
    <div class="goal-stat-item">
      <span class="stat-label">${i.label}</span>
      <span class="stat-value">${i.valor}</span>
    </div>
  `).join('')}</div>`;
}

// Mensagem de viabilidade: diz se o ritmo de economia atual do usuário
// (calculado pela "Análise Financeira") dá conta do prazo da meta.
function textoPlanejamentoMeta(plano) {
  if (plano.atingida) return '🏆 Meta já atingida!';
  if (plano.vencida) {
    return `O prazo dessa meta já passou e ainda faltam <strong>R$ ${plano.faltam.toFixed(2)}</strong>. Vale ajustar a data ou o valor.`;
  }

  if (plano.semPrazo) {
    if (plano.capacidade === null) return 'Defina uma data limite para eu calcular quanto guardar por mês e por semana.';
    return plano.capacidade > 0
      ? `Defina um prazo para o cálculo exato. No seu ritmo atual (economiza ~R$ ${plano.capacidade.toFixed(2)}/mês), levaria cerca de <strong>${Math.ceil(plano.faltam / plano.capacidade)} meses</strong>.`
      : `Nos últimos meses suas despesas superaram as receitas, então no ritmo atual essa meta não avança. Defina um prazo para ver o cálculo exato.`;
  }

  if (plano.capacidade === null) {
    return `<span class="feasibility-warn">Ainda não tenho histórico suficiente de receitas/despesas para avaliar se esse prazo é realista pra você.</span>`;
  }
  if (plano.status === 'bad') {
    return `<span class="feasibility-bad">⚠️ Nos últimos meses suas despesas superaram as receitas — nesse ritmo, a meta não vai sair do papel sem algum ajuste no orçamento.</span>`;
  }
  if (plano.status === 'warn') {
    return `<span class="feasibility-warn">⚠️ Sua economia média hoje é de R$ ${plano.capacidade.toFixed(2)}/mês, abaixo do necessário. Dá pra rever o prazo ou cortar gastos em alguma categoria.</span>`;
  }
  return `<span class="feasibility-ok">✅ No seu ritmo atual de economia (R$ ${plano.capacidade.toFixed(2)}/mês), essa meta é totalmente viável.</span>`;
}

function atualizarPreviewMeta() {
  const preview = document.getElementById('goal-planning-preview');
  if (!preview) return;

  const target = parseFloat(document.getElementById('goal-target')?.value);
  const saved = parseFloat(document.getElementById('goal-saved-initial')?.value) || 0;
  const deadline = document.getElementById('goal-deadline')?.value || null;

  if (!target || target <= 0) {
    preview.style.display = 'none';
    return;
  }

  const plano = calcularPlanejamentoMeta(target, saved, deadline);
  preview.innerHTML = gerarGridEstatisticasMeta(plano) + `<div>${textoPlanejamentoMeta(plano)}</div>`;
  preview.style.display = 'block';
}

// --- 3. ANÁLISE FINANCEIRA GERAL (resumo agregado de todas as metas ativas) ---
function renderizarResumoPlanejamento() {
  const box = document.getElementById('planning-summary-box');
  if (!box) return;

  const capacidade = capacidadePoupancaMensal();
  const metasAtivas = goals.filter(g => g.saved < g.target);

  if (metasAtivas.length === 0) {
    box.innerHTML = capacidade !== null
      ? `<div class="summary-row"><span>Sua economia média atual</span><strong>R$ ${capacidade.toFixed(2)}/mês</strong></div><div class="summary-row"><span>Metas ativas</span><strong>Nenhuma — crie um planejamento acima</strong></div>`
      : 'Cadastre suas transações e crie um planejamento para ver a análise.';
    return;
  }

  let totalMensalNecessario = 0;
  let algumSemPrazo = false;
  metasAtivas.forEach(g => {
    const plano = calcularPlanejamentoMeta(g.target, g.saved, g.deadline);
    if (plano.mensalNecessario) totalMensalNecessario += plano.mensalNecessario;
    else algumSemPrazo = true;
  });

  const linhas = [];
  linhas.push(`<div class="summary-row"><span>Sua economia média atual</span><strong>${capacidade !== null ? `R$ ${capacidade.toFixed(2)}/mês` : 'sem histórico suficiente'}</strong></div>`);
  linhas.push(`<div class="summary-row"><span>Necessário p/ todas as metas com prazo${algumSemPrazo ? ' (há metas sem prazo, não contadas)' : ''}</span><strong>R$ ${totalMensalNecessario.toFixed(2)}/mês</strong></div>`);

  if (capacidade !== null) {
    const diferenca = capacidade - totalMensalNecessario;
    const classe = diferenca >= 0 ? 'feasibility-ok' : 'feasibility-bad';
    const texto = diferenca >= 0
      ? `✅ Sobra R$ ${diferenca.toFixed(2)}/mês decobrir todas as metas`
      : `⚠️ Falta R$ ${Math.abs(diferenca).toFixed(2)}/mês para cobrir todas as metas no ritmo atual`;
    linhas.push(`<div class="summary-row"><span class="${classe}">${texto}</span></div>`);
  }

  box.innerHTML = linhas.join('');
}

window.adicionarValorMeta = async function(id) {
  const valorStr = prompt('Quanto você quer adicionar a esta meta? (R$)');
  if (valorStr === null) return;
  const valor = parseFloat(valorStr);
  if (!valor || valor <= 0) return alert('Digite um valor válido.');

  const meta = goals.find(g => g.id === id);
  if (!meta) return;

  const novoSaved = meta.saved + valor;
  const { error } = await _supabase.from('goals').update({ saved: novoSaved }).eq('id', id);
  if (error) return alert('Erro ao atualizar meta: ' + error.message);

  notify(novoSaved >= meta.target ? '🎉 Meta atingida! Parabéns!' : 'Valor adicionado à meta!');
  carregarMetas();
};

window.deletarMeta = function(id) {
  showModal('Excluir Meta', 'Deseja remover esta meta de economia?', async () => {
    const { error } = await _supabase.from('goals').delete().eq('id', id);
    if (error) return alert('Erro ao excluir meta: ' + error.message);
    notify('Meta removida!');
    carregarMetas();
  });
};

function renderizarMetas() {
  const container = document.getElementById('goals-list-container');
  if (!container) return;
  container.innerHTML = '';

  if (goals.length === 0) {
    container.innerHTML = '<p style="color: var(--text-muted);">Nenhuma meta cadastrada ainda.</p>';
    renderizarResumoPlanejamento();
    return;
  }

  goals.forEach(g => {
    const perc = g.target > 0 ? Math.min(100, (g.saved / g.target) * 100) : 0;
    const atingida = g.saved >= g.target;
    const plano = calcularPlanejamentoMeta(g.target, g.saved, g.deadline);

    const card = document.createElement('div');
    card.className = 'category-card';
    card.innerHTML = `
      <div class="category-card-header">
        <h4>${atingida ? '🏆 ' : ''}${escapeHtml(g.name)}</h4>
        <button class="action-btn btn-del" onclick="deletarMeta('${g.id}')">Excluir</button>
      </div>
      <div style="font-size: 13px; color: var(--text-muted);">
        R$ ${g.saved.toFixed(2)} / R$ ${g.target.toFixed(2)}
        ${g.startDate ? ` · início ${g.startDate.split('-').reverse().join('/')}` : ''}
        ${g.deadline ? ` · até ${g.deadline.split('-').reverse().join('/')}` : ''}
      </div>
      <div class="progress-bar-bg">
        <div class="progress-bar-fill" style="width: ${perc}%; background: ${atingida ? '#10b981' : '#6366f1'};"></div>
      </div>
      ${!atingida ? gerarGridEstatisticasMeta(plano) : ''}
      ${!atingida ? `<div class="goal-planning-box">${textoPlanejamentoMeta(plano)}</div>` : ''}
      ${!atingida ? `<button class="action-btn btn-pay" onclick="adicionarValorMeta('${g.id}')" style="width: 100%; text-align: center;">💰 Adicionar Valor</button>` : ''}
    `;
    container.appendChild(card);
  });

  renderizarResumoPlanejamento();
}

// --- TRANSAÇÕES RECORRENTES ---
async function processarRecorrencias() {
  if (!currentUser) return;

  const hoje = new Date();
  const anoAtual = hoje.getFullYear();
  const mesAtual = hoje.getMonth();

  const { data, error } = await _supabase
    .from('transactions')
    .select('*')
    .eq('user_id', currentUser.id)
    .eq('is_recurring', true);

  if (error || !data) return;

  const grupos = {};
  data.forEach(item => {
    const chave = `${item.description}|${item.category}|${item.type}|${item.amount}`;
    (grupos[chave] = grupos[chave] || []).push(item);
  });

  const novasTransacoes = [];

  Object.values(grupos).forEach(lista => {
    lista.sort((a, b) => new Date(b.date) - new Date(a.date));
    const maisRecente = lista[0];
    const dataRecente = new Date(maisRecente.date + 'T00:00:00');

    const jaExisteNoMesAtual = lista.some(item => {
      const d = new Date(item.date + 'T00:00:00');
      return d.getFullYear() === anoAtual && d.getMonth() === mesAtual;
    });

    const antesDoMesAtual = dataRecente < new Date(anoAtual, mesAtual, 1);

    if (!jaExisteNoMesAtual && antesDoMesAtual) {
      const dia = dataRecente.getDate();
      const ultimoDiaMes = new Date(anoAtual, mesAtual + 1, 0).getDate();
      const novaData = new Date(anoAtual, mesAtual, Math.min(dia, ultimoDiaMes));

      novasTransacoes.push({
        user_id: currentUser.id,
        description: maisRecente.description,
        amount: maisRecente.amount,
        type: maisRecente.type,
        category: maisRecente.category,
        date: novaData.toISOString().split('T')[0],
        is_recurring: true,
        account_id: maisRecente.account_id || null
      });
    }
  });

  if (novasTransacoes.length > 0) {
    const { error: erroInsercao } = await _supabase.from('transactions').insert(novasTransacoes);
    if (!erroInsercao) notify(`🔄 ${novasTransacoes.length} lançamento(s) recorrente(s) gerado(s) para este mês!`);
  }
}

async function processarRecorrenciasContas() {
  if (!currentUser) return;

  const hoje = new Date();
  const anoAtual = hoje.getFullYear();
  const mesAtual = hoje.getMonth();

  const { data, error } = await _supabase
    .from('bills')
    .select('*')
    .eq('user_id', currentUser.id)
    .eq('is_recurring', true);

  if (error || !data) return;

  const novasContas = [];

  data.forEach(item => {
    const dataVenc = new Date(item.due_date + 'T00:00:00');
    const jaExisteNoMesAtual = dataVenc.getFullYear() === anoAtual && dataVenc.getMonth() === mesAtual;

    if (!jaExisteNoMesAtual && dataVenc < new Date(anoAtual, mesAtual, 1)) {
      const dia = dataVenc.getDate();
      const ultimoDiaMes = new Date(anoAtual, mesAtual + 1, 0).getDate();
      const novaData = new Date(anoAtual, mesAtual, Math.min(dia, ultimoDiaMes));

      novasContas.push({
        user_id: currentUser.id,
        description: item.description,
        amount: item.amount,
        due_date: novaData.toISOString().split('T')[0],
        status: 'Pendente',
        account_id: item.account_id || null,
        is_recurring: true
      });
    }
  });

  if (novasContas.length > 0) {
    await _supabase.from('bills').insert(novasContas);
  }
}

// --- EDITOR DE SÉRIE RECORRENTE ---
// Permite mudar a descrição/valor de todos os lançamentos futuros de uma série
// recorrente de uma vez, sem precisar editar mês a mês. Os lançamentos já
// passados não são alterados.
window.abrirEdicaoSerie = function(id) {
  const t = transactions.find(x => x.id === id);
  if (!t) return;
  serieEmEdicao = t;
  document.getElementById('series-new-desc').value = t.desc;
  document.getElementById('series-new-val').value = t.val;
  document.getElementById('series-modal').style.display = 'flex';
};

function fecharEdicaoSerie() {
  document.getElementById('series-modal').style.display = 'none';
  serieEmEdicao = null;
}

async function confirmarEdicaoSerie() {
  if (!serieEmEdicao) return;
  const novaDesc = document.getElementById('series-new-desc').value.trim();
  const novoValStr = document.getElementById('series-new-val').value;
  const novoVal = novoValStr ? parseFloat(novoValStr) : null;

  if (!novaDesc && !novoVal) {
    alert('Informe uma nova descrição ou um novo valor para aplicar à série.');
    return;
  }

  const atualizacao = {};
  if (novaDesc) atualizacao.description = novaDesc;
  if (novoVal) atualizacao.amount = novoVal;

  const { error } = await _supabase
    .from('transactions')
    .update(atualizacao)
    .eq('user_id', currentUser.id)
    .eq('description', serieEmEdicao.desc)
    .eq('category', serieEmEdicao.cat)
    .eq('type', serieEmEdicao.type)
    .eq('is_recurring', true)
    .gte('date', serieEmEdicao.date);

  if (error) return alert('Erro ao atualizar a série: ' + error.message);

  notify('Série recorrente atualizada a partir desta data!');
  fecharEdicaoSerie();
  await carregarTransacoesNuvem();
}

// --- CONTAS A PAGAR ---
async function carregarContasNuvem() {
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

  renderizarContas();
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
  carregarContasNuvem();
}

function renderizarContas() {
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
        ${b.status !== 'Paga' ? `<button class="action-btn btn-pay" onclick="pagarConta('${b.id}')">Pagar</button>` : ''}
        <button class="action-btn btn-del" onclick="deletarConta('${b.id}')">Excluir</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

window.pagarConta = async function(id) {
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
  carregarContasNuvem();
  carregarTransacoesNuvem();
};

window.deletarConta = function(id) {
  showModal('Excluir Conta a Pagar', 'Deseja excluir esta conta agendada?', async () => {
    const { error } = await _supabase.from('bills').delete().eq('id', id);
    if (error) return alert('Erro ao excluir: ' + error.message);
    notify('Conta removida!');
    carregarContasNuvem();
  });
};

function verificarContasProximas() {
  const today = new Date();
  const daqui3Dias = new Date();
  daqui3Dias.setDate(today.getDate() + 3);

  const hojeStr = today.toISOString().split('T')[0];
  const limiteStr = daqui3Dias.toISOString().split('T')[0];

  const proximas = bills.filter(b => b.status === 'Pendente' && b.dueDate >= hojeStr && b.dueDate <= limiteStr);
  if (proximas.length > 0) {
    notify(`⚠️ Você tem ${proximas.length} conta(s) vencendo nos próximos dias!`);
  }
}

// --- TRANSAÇÕES ---
async function carregarTransacoesNuvem() {
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

  renderizarDados();
}

async function handleSaveTransaction(e) {
  e.preventDefault();
  const id = document.getElementById('trans-id').value;
  const desc = document.getElementById('trans-desc').value;
  const val = parseFloat(document.getElementById('trans-val').value);
  const type = document.getElementById('trans-type').value;
  const cat = document.getElementById('trans-cat').value;
  const date = document.getElementById('trans-date').value;
  const tags = normalizarTags(document.getElementById('trans-tags').value);
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

  // --- Comprovante/nota fiscal (upload para o Supabase Storage) ---
  // Requer o bucket "receipts" criado no projeto — veja README_NOVAS_FEATURES.md.
  const comprovanteInput = document.getElementById('comprovante');
  const comprovanteFile = comprovanteInput?.files?.[0];
  if (comprovanteFile) {
    try {
      const caminho = `${currentUser.id}/${Date.now()}_${comprovanteFile.name}`;
      const { error: erroUpload } = await _supabase.storage.from('receipts').upload(caminho, comprovanteFile);
      if (erroUpload) {
        console.error('Erro ao anexar comprovante:', erroUpload);
        notify('⚠️ Lançamento salvo, mas o comprovante não pôde ser anexado (' + erroUpload.message + ')');
      } else {
        const { data: urlData } = _supabase.storage.from('receipts').getPublicUrl(caminho);
        payload.receipt_url = urlData?.publicUrl || null;
      }
    } catch (err) {
      console.error('Erro ao anexar comprovante:', err);
    }
  }

  if (id) {
    const { error } = await _supabase.from('transactions').update(payload).eq('id', id);
    if (error) return alert('Erro ao atualizar: ' + error.message);
    notify('Lançamento atualizado!');
  } else {
    const { error } = await _supabase.from('transactions').insert([payload]);
    if (error) return alert('Erro ao salvar: ' + error.message);
    notify('Lançamento salvo!');
  }

  // --- Cofrinho automático: arredonda a despesa e guarda a diferença numa meta ---
  const roundupChecked = document.getElementById('trans-roundup')?.checked;
  const roundupGoalId = document.getElementById('roundup-goal-select')?.value;
  if (!id && roundupChecked && roundupGoalId && type === 'Despesa') {
    const diferenca = parseFloat((Math.ceil(val) - val).toFixed(2));
    if (diferenca > 0) {
      const meta = goals.find(g => g.id === roundupGoalId);
      if (meta) {
        const novoSaved = parseFloat((meta.saved + diferenca).toFixed(2));
        const { error: erroMeta } = await _supabase.from('goals').update({ saved: novoSaved }).eq('id', roundupGoalId);
        if (!erroMeta) notify(`🐷 R$ ${diferenca.toFixed(2)} guardados na meta "${meta.name}"!`);
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

  await carregarTransacoesNuvem();
  await carregarMetas();
  carregarCarteiras();
}

window.editarTransacao = function(id) {
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

window.deletarTransacao = function(id) {
  showModal('Excluir Lançamento', 'Deseja remover este lançamento? Você terá alguns segundos para desfazer.', () => {
    const idx = transactions.findIndex(t => t.id === id);
    if (idx === -1) return;
    const removida = transactions[idx];

    // Remoção otimista da tela (o registro só é apagado do banco de fato
    // depois da janela de "Desfazer" — funciona como uma lixeira temporária).
    transactions.splice(idx, 1);
    renderizarDados();
    carregarCarteiras();

    const timeoutId = setTimeout(async () => {
      delete exclusoesPendentes[id];
      const { error } = await _supabase.from('transactions').delete().eq('id', id);
      if (error) {
        console.error('Erro ao excluir definitivamente:', error);
        await carregarTransacoesNuvem();
      }
    }, EXCLUSAO_TEMPO_DESFAZER_MS);

    exclusoesPendentes[id] = timeoutId;

    notifyComAcao('Lançamento removido.', '↩️ Desfazer', () => {
      const pendente = exclusoesPendentes[id];
      if (pendente) {
        clearTimeout(pendente);
        delete exclusoesPendentes[id];
      }
      transactions.push(removida);
      transactions.sort((a, b) => new Date(b.date) - new Date(a.date));
      renderizarDados();
      carregarCarteiras();
      notify('Exclusão desfeita!');
    });
  });
};

// --- RENDERIZAÇÃO GERAL E DASHBOARD ---
function renderizarDados() {
  const search = document.getElementById('search-input')?.value.toLowerCase() || '';
  const filterType = document.getElementById('filter-type')?.value || 'Todos';
  const dateStart = document.getElementById('filter-date-start')?.value || '';
  const dateEnd = document.getElementById('filter-date-end')?.value || '';
  const monthPicker = document.getElementById('month-picker')?.value || '';
  const accountFilter = document.getElementById('dash-account-filter')?.value || '';

  let filtradas = transactions.filter(t => {
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

  ultimosItensFiltrados = filtradas;

  let totalRec = 0;
  let totalDesp = 0;

  filtradas.forEach(t => {
    const valorEmBrl = t.currency && t.currency !== 'BRL' ? converterParaBRL(t.val, t.currency) : t.val;
    if (t.type === 'Receita') totalRec += valorEmBrl;
    else totalDesp += valorEmBrl;
  });

  const saldo = totalRec - totalDesp;

  const elRec = document.getElementById('val-receita');
  const elDesp = document.getElementById('val-despesa');
  const elSaldo = document.getElementById('val-saldo');

  if (elRec) elRec.innerText = `R$ ${totalRec.toFixed(2)}`;
  if (elDesp) elDesp.innerText = `R$ ${totalDesp.toFixed(2)}`;
  if (elSaldo) {
    elSaldo.innerText = `R$ ${saldo.toFixed(2)}`;
    elSaldo.style.color = saldo >= 0 ? '#10b981' : '#ef4444';
  }

  atualizarOrcamento(totalDesp);
  atualizarTabela(filtradas);
  atualizarGraficos(filtradas);
  renderizarCategorias();
  renderizarCarteiras();
}

function atualizarOrcamento(totalDespesas) {
  const limitInput = document.getElementById('budget-limit');
  const fill = document.getElementById('budget-progress');
  const badge = document.getElementById('budget-alert-badge');
  const text = document.getElementById('budget-text');
  if (!limitInput || !fill) return;

  const limite = parseFloat(limitInput.value) || 5000;
  const perc = limite > 0 ? Math.min(100, (totalDespesas / limite) * 100) : 0;

  fill.style.width = `${perc}%`;
  fill.style.background = perc >= 100 ? '#ef4444' : (perc >= 80 ? '#f59e0b' : '#10b981');

  if (badge) {
    if (perc >= 90) badge.classList.remove('hidden');
    else badge.classList.add('hidden');
  }

  if (text) {
    text.innerText = `${perc.toFixed(1)}% do limite utilizado (R$ ${totalDespesas.toFixed(2)} / R$ ${limite.toFixed(2)})`;
  }
}

function atualizarTabela(lista) {
  const tbody = document.getElementById('table-body');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (lista.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">Nenhum lançamento encontrado.</td></tr>';
    return;
  }

  lista.forEach(t => {
    const moedaNaoBrl = t.currency && t.currency !== 'BRL';
    const valorConvertido = moedaNaoBrl ? converterParaBRL(t.val, t.currency) : null;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${t.date.split('-').reverse().join('/')}</td>
      <td>${escapeHtml(t.desc)} ${t.tags ? `<br><small style="color:var(--text-muted);">#${escapeHtml(t.tags.split(',').join(' #'))}</small>` : ''}
        ${t.receiptUrl ? `<br><a class="receipt-thumb-link" href="${escapeHtml(t.receiptUrl)}" target="_blank" rel="noopener">📎 Comprovante</a>` : ''}
      </td>
      <td>${escapeHtml(t.cat)}</td>
      <td><span class="badge ${t.type === 'Receita' ? 'badge-paid' : 'badge-overdue'}">${t.type}</span></td>
      <td style="color: ${t.type === 'Receita' ? '#10b981' : '#ef4444'}; font-weight:700;">
        ${t.type === 'Receita' ? '+' : '-'} ${simboloMoeda(t.currency)} ${t.val.toFixed(2)}
        ${moedaNaoBrl ? `<span class="currency-badge">${t.currency} · ≈ R$ ${valorConvertido.toFixed(2)}</span>` : ''}
      </td>
      <td>
        <button class="action-btn" onclick="editarTransacao('${t.id}')">Editar</button>
        ${t.isRecurring ? `<button class="btn-series" onclick="abrirEdicaoSerie('${t.id}')" title="Editar todos os lançamentos futuros desta série">🔄 Série</button>` : ''}
        <button class="action-btn btn-del" onclick="deletarTransacao('${t.id}')">Excluir</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function atualizarGraficos(filtradas) {
  const barCtx = document.getElementById('barChart')?.getContext('2d');
  const doughCtx = document.getElementById('doughnutChart')?.getContext('2d');
  const compareCtx = document.getElementById('compareChart')?.getContext('2d');
  const annualCtx = document.getElementById('annualChart')?.getContext('2d');
  const semanalCtx = document.getElementById('graficoSemanal')?.getContext('2d');

  let rec = 0;
  let desp = 0;
  filtradas.forEach(t => {
    const v = t.currency && t.currency !== 'BRL' ? converterParaBRL(t.val, t.currency) : t.val;
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
  filtradas.filter(t => t.type === 'Despesa').forEach(t => {
    const v = t.currency && t.currency !== 'BRL' ? converterParaBRL(t.val, t.currency) : t.val;
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

  // Gráfico Semanal (Gastos por Dia da Semana)
  const diasSemana = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
  const gastosPorDia = [0, 0, 0, 0, 0, 0, 0];
  filtradas.filter(t => t.type === 'Despesa').forEach(t => {
    const diaIndex = new Date(t.date + 'T00:00:00').getDay();
    const v = t.currency && t.currency !== 'BRL' ? converterParaBRL(t.val, t.currency) : t.val;
    gastosPorDia[diaIndex] += v;
  });

  if (semanalCtx) {
    if (graficoSemanalInstance) graficoSemanalInstance.destroy();
    graficoSemanalInstance = new Chart(semanalCtx, {
      type: 'bar',
      data: {
        labels: diasSemana,
        datasets: [{ label: 'Gastos por Dia da Semana', data: gastosPorDia, backgroundColor: '#3b82f6' }]
      },
      options: { responsive: true }
    });
  }

  // Comparativo Mês Atual vs Anterior
  const hoje = new Date();
  const mesAtualStr = hoje.toISOString().slice(0, 7);
  const dataAnterior = new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1);
  const mesAnteriorStr = dataAnterior.toISOString().slice(0, 7);

  let despAtual = 0, despAnterior = 0;
  transactions.filter(t => t.type === 'Despesa').forEach(t => {
    const v = t.currency && t.currency !== 'BRL' ? converterParaBRL(t.val, t.currency) : t.val;
    if (t.date.startsWith(mesAtualStr)) despAtual += v;
    if (t.date.startsWith(mesAnteriorStr)) despAnterior += v;
  });

  if (compareCtx) {
    if (compareChartInstance) compareChartInstance.destroy();
    compareChartInstance = new Chart(compareCtx, {
      type: 'bar',
      data: {
        labels: ['Mês Anterior', 'Mês Atual'],
        datasets: [{ label: 'Despesas', data: [despAnterior, despAtual], backgroundColor: ['#94a3b8', '#4f46e5'] }]
      },
      options: { responsive: true }
    });
  }

  // Visão Anual (últimos 12 meses)
  const labelsAno = [];
  const dadosAno = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(hoje.getFullYear(), hoje.getMonth() - i, 1);
    const anoMes = d.toISOString().slice(0, 7);
    labelsAno.push(d.toLocaleString('pt-BR', { month: 'short', year: '2-digit' }));
    
    let totalMes = 0;
    transactions.filter(t => t.type === 'Despesa' && t.date.startsWith(anoMes)).forEach(t => {
      totalMes += t.currency && t.currency !== 'BRL' ? converterParaBRL(t.val, t.currency) : t.val;
    });
    dadosAno.push(totalMes);
  }

  if (annualCtx) {
    if (annualChartInstance) annualChartInstance.destroy();
    annualChartInstance = new Chart(annualCtx, {
      type: 'line',
      data: {
        labels: labelsAno,
        datasets: [{ label: 'Evolução de Gastos', data: dadosAno, borderColor: '#10b981', backgroundColor: 'rgba(16, 185, 129, 0.1)', fill: true, tension: 0.3 }]
      },
      options: { responsive: true }
    });
  }

  gerarInsightsIA(despAtual, despAnterior, totalRec);
}

// --- INSIGHTS DE IA ---
// Análise instantânea local (regra simples), usada como texto padrão enquanto
// a análise real por IA não é pedida — evita chamar a API a cada filtro/digitação.
function gerarInsightsIA(despAtual, despAnterior, totalRec) {
  const painel = document.getElementById('painel-insights');
  if (!painel || painel.dataset.iaReal === 'true') return; // não sobrescreve um insight real já carregado

  let texto = '🤖 <strong>Insights (análise rápida):</strong> ';
  if (despAtual > despAnterior && despAnterior > 0) {
    const aumento = (((despAtual - despAnterior) / despAnterior) * 100).toFixed(1);
    texto += `Seus gastos aumentaram ${aumento}% em relação ao mês passado. Fique atento ao orçamento!`;
  } else if (totalRec > 0 && despAtual > totalRec * 0.8) {
    texto += 'Atenção: Suas despesas já ultrapassaram 80% das suas receitas este mês.';
  } else {
    texto += 'Suas finanças estão equilibradas este mês. Continue assim!';
  }
  painel.innerHTML = `${texto} <button id="btn-refresh-insights" class="insights-refresh-btn" onclick="atualizarInsightsIA(true)">🔄 Atualizar com IA</button>`;
}

// Análise real, gerada pela IA a partir de um resumo dos seus dados do mês
// (enviado para a Edge Function — nenhuma chamada é feita direto do navegador
// para a API da Anthropic, para não expor a chave).
window.atualizarInsightsIA = async function(forcar) {
  const painel = document.getElementById('painel-insights');
  if (!painel) return;

  const agora = Date.now();
  if (!forcar && (agora - ultimoInsightIA) < INSIGHT_IA_INTERVALO_MS) return;

  const btnAtual = document.getElementById('btn-refresh-insights');
  if (btnAtual) { btnAtual.disabled = true; btnAtual.innerText = '🤖 Pensando...'; }

  try {
    const hoje = new Date();
    const mesAtualStr = hoje.toISOString().slice(0, 7);
    const resumo = { mesAtual: mesAtualStr, totalReceitas: 0, totalDespesas: 0, gastosPorCategoria: {} };

    transactions.filter(t => t.date.startsWith(mesAtualStr)).forEach(t => {
      const v = t.currency && t.currency !== 'BRL' ? converterParaBRL(t.val, t.currency) : t.val;
      if (t.type === 'Receita') resumo.totalReceitas += v;
      else {
        resumo.totalDespesas += v;
        resumo.gastosPorCategoria[t.cat] = (resumo.gastosPorCategoria[t.cat] || 0) + v;
      }
    });

    const { data: { session } } = await _supabase.auth.getSession();

    const resp = await fetch(AI_FUNCTION_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session?.access_token || SUPABASE_ANON_KEY}`,
        'apikey': SUPABASE_ANON_KEY
      },
      body: JSON.stringify({ action: 'insights', resumo })
    });

    if (!resp.ok) throw new Error(`Função retornou status ${resp.status}`);
    const dados = await resp.json();
    if (dados.error) throw new Error(dados.error);
    if (!dados.insight) throw new Error('Resposta sem insight.');

    painel.dataset.iaReal = 'true';
    painel.innerHTML = `🤖 <strong>Insight (IA):</strong> ${escapeHtml(dados.insight)} <button id="btn-refresh-insights" class="insights-refresh-btn" onclick="atualizarInsightsIA(true)">🔄 Atualizar com IA</button>`;
    ultimoInsightIA = agora;
  } catch (err) {
    console.warn('IA de insights indisponível, mantendo análise local:', err.message);
    if (forcar) notify('⚠️ IA indisponível agora (a Edge Function precisa estar publicada — veja README_NOVAS_FEATURES.md).');
    painel.dataset.iaReal = 'false';
    const btn = document.getElementById('btn-refresh-insights');
    if (btn) { btn.disabled = false; btn.innerText = '🔄 Atualizar com IA'; }
  }
};

// --- INVESTIMENTOS ---
async function carregarInvestimentos() {
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

  renderizarInvestimentos();
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

  if (error) return alert('Erro ao salvar ativo: ' + error.message);
  notify('Ativo adicionado com sucesso!');
  e.target.reset();
  carregarInvestimentos();
}

window.deletarInvestimento = function(id) {
  showModal('Excluir Ativo', 'Deseja remover este ativo da carteira?', async () => {
    const { error } = await _supabase.from('investments').delete().eq('id', id);
    if (error) return alert('Erro ao excluir: ' + error.message);
    notify('Ativo removido!');
    carregarInvestimentos();
  });
};

function renderizarInvestimentos() {
  const tbody = document.getElementById('investments-table-body');
  if (!tbody) return;
  tbody.innerHTML = '';

  let totalInvestido = 0;
  let valorAtualTotal = 0;

  investments.forEach(inv => {
    const invTotal = inv.qty * inv.avgPrice;
    const curTotal = inv.qty * inv.currentPrice;
    const rentabilidade = invTotal > 0 ? ((curTotal - invTotal) / invTotal) * 100 : 0;

    totalInvestido += invTotal;
    valorAtualTotal += curTotal;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(inv.name)}</td>
      <td>${escapeHtml(inv.type)}</td>
      <td>${inv.qty}</td>
      <td>R$ ${inv.avgPrice.toFixed(2)}</td>
      <td>R$ ${inv.currentPrice.toFixed(2)}</td>
      <td>R$ ${curTotal.toFixed(2)}</td>
      <td style="color: ${rentabilidade >= 0 ? '#10b981' : '#ef4444'}; font-weight:700;">${rentabilidade.toFixed(2)}%</td>
      <td><button class="action-btn btn-del" onclick="deletarInvestimento('${inv.id}')">Excluir</button></td>
    `;
    tbody.appendChild(tr);
  });

  const rentTotal = totalInvestido > 0 ? ((valorAtualTotal - totalInvestido) / totalInvestido) * 100 : 0;
  document.getElementById('val-investido').innerText = `R$ ${totalInvestido.toFixed(2)}`;
  document.getElementById('val-atual-investimentos').innerText = `R$ ${valorAtualTotal.toFixed(2)}`;
  const elRent = document.getElementById('val-rentabilidade');
  if (elRent) {
    elRent.innerText = `${rentTotal.toFixed(2)}%`;
    elRent.style.color = rentTotal >= 0 ? '#10b981' : '#ef4444';
  }
}

// --- CONTA COMPARTILHADA ---
async function handleShareInvite(e) {
  e.preventDefault();
  const email = document.getElementById('share-email').value;
  const { error } = await _supabase.from('shared_accounts').insert([{ owner_id: currentUser.id, shared_with_email: email }]);
  if (error) return alert('Erro ao enviar convite: ' + error.message);
  notify('Convite enviado com sucesso!');
  e.target.reset();
  carregarCompartilhamentos();
}

async function carregarCompartilhamentos() {
  if (!currentUser) return;
  const container = document.getElementById('shares-list-container');
  if (!container) return;

  const { data, error } = await _supabase.from('shared_accounts').select('*').eq('owner_id', currentUser.id);
  if (error) return;

  container.innerHTML = data.length > 0 
    ? `<p style="font-size: 14px; color: var(--text-muted);">Compartilhado com: <strong>${data.map(d => escapeHtml(d.shared_with_email)).join(', ')}</strong></p>` 
    : '<p style="font-size: 14px; color: var(--text-muted);">Nenhum compartilhamento ativo.</p>';
}

// --- OPEN FINANCE (REAL, via Pluggy) ---
// Fluxo: 1) pedimos um "connect token" de curta duração à Edge Function
// pluggy-connect-token (o client_secret nunca sai do servidor); 2) abrimos
// o widget oficial do Pluggy com esse token, onde o usuário escolhe o banco
// e faz login com segurança (senha do banco nunca passa pelo FluxoPro);
// 3) quando conecta, mandamos o itemId para a Edge Function pluggy-sync,
// que importa as contas e transações reais.
//
// Sem as credenciais PLUGGY_CLIENT_ID/PLUGGY_CLIENT_SECRET configuradas no
// Supabase (veja README_NOVAS_FEATURES.md), isso mostra um aviso amigável
// em vez de travar o app.
async function sincronizarContaBancaria() {
  const btn = document.getElementById('btn-open-finance');
  if (typeof PluggyConnect === 'undefined') {
    return notify('⚠️ Widget do Pluggy não carregou (verifique sua conexão com a internet).');
  }

  if (btn) { btn.disabled = true; btn.innerText = '🏦 Preparando conexão segura...'; }

  try {
    const { data: { session } } = await _supabase.auth.getSession();

    const resp = await fetch(`${SUPABASE_URL}/functions/v1/pluggy-connect-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session?.access_token || SUPABASE_ANON_KEY}`,
        'apikey': SUPABASE_ANON_KEY
      }
    });

    if (!resp.ok) throw new Error(`Função retornou status ${resp.status}`);
    const dados = await resp.json();
    if (dados.error) throw new Error(dados.error);
    if (!dados.connectToken) throw new Error('Não recebi um connect token do Pluggy.');

    const pluggyConnect = new PluggyConnect({
      connectToken: dados.connectToken,
      includeSandbox: true, // mantenha true enquanto estiver testando com credenciais de sandbox
      onSuccess: async (itemData) => {
        notify('✅ Banco conectado! Importando transações...');
        await importarViaPluggy(itemData.item.id);
      },
      onError: (erro) => {
        console.error('Erro no widget do Pluggy:', erro);
        notify('⚠️ Não foi possível concluir a conexão com o banco.');
      },
      onClose: () => {
        if (btn) { btn.disabled = false; btn.innerText = '🏦 Conectar Banco (Open Finance)'; }
      }
    });

    pluggyConnect.init();
  } catch (err) {
    console.error('Erro ao iniciar Open Finance:', err);
    notify('⚠️ Open Finance indisponível agora (as Edge Functions do Pluggy precisam estar publicadas — veja README_NOVAS_FEATURES.md).');
  } finally {
    if (btn) { btn.disabled = false; btn.innerText = '🏦 Conectar Banco (Open Finance)'; }
  }
}

async function importarViaPluggy(itemId) {
  try {
    const { data: { session } } = await _supabase.auth.getSession();

    const resp = await fetch(`${SUPABASE_URL}/functions/v1/pluggy-sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session?.access_token || SUPABASE_ANON_KEY}`,
        'apikey': SUPABASE_ANON_KEY
      },
      body: JSON.stringify({ itemId })
    });

    if (!resp.ok) throw new Error(`Função retornou status ${resp.status}`);
    const dados = await resp.json();
    if (dados.error) throw new Error(dados.error);

    notify(`🏦 ${dados.imported} transação(ões) importada(s) de ${dados.institution}!`);
    await carregarTransacoesNuvem();
    await carregarCarteiras();
  } catch (err) {
    console.error('Erro ao importar dados do Pluggy:', err);
    notify('⚠️ O banco conectou, mas não consegui importar as transações agora. Tente sincronizar de novo.');
  }
}

// --- OCR / LEITURA DE NOTA FISCAL (IA REAL, via Edge Function + visão do Claude) ---
window.lerNotaFiscalViaIA = async function(file) {
  if (!file) return;
  const statusOcr = document.getElementById('status-ocr');
  if (statusOcr) statusOcr.innerText = '🤖 IA lendo o comprovante/nota fiscal...';

  try {
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(new Error('Falha ao ler o arquivo.'));
      reader.readAsDataURL(file);
    });

    const { data: { session } } = await _supabase.auth.getSession();

    const resp = await fetch(AI_FUNCTION_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session?.access_token || SUPABASE_ANON_KEY}`,
        'apikey': SUPABASE_ANON_KEY
      },
      body: JSON.stringify({ action: 'ocr', mediaType: file.type || 'image/jpeg', imageBase64: base64 })
    });

    if (!resp.ok) throw new Error(`Função retornou status ${resp.status}`);
    const dados = await resp.json();
    if (dados.error) throw new Error(dados.error);

    if (dados.descricao) document.getElementById('trans-desc').value = dados.descricao;
    if (dados.valor) document.getElementById('trans-val').value = dados.valor;
    if (dados.data) document.getElementById('trans-date').value = dados.data;
    document.getElementById('trans-type').value = 'Despesa';
    atualizarPreviewCofrinho();

    if (statusOcr) statusOcr.innerText = '✅ Dados extraídos pela IA — confira antes de salvar!';
    notify('Nota fiscal lida pela IA — revise os dados antes de confirmar.');
  } catch (err) {
    console.error('Erro no OCR de nota fiscal:', err);
    if (statusOcr) statusOcr.innerText = '⚠️ Não consegui ler a nota agora. Preencha manualmente.';
    notify('⚠️ Leitura por IA indisponível agora (a Edge Function precisa estar publicada — veja README_NOVAS_FEATURES.md).');
  }
};

// --- EXPORTAR EXCEL (SHEETJS) ---
function exportarExcel() {
  if (ultimosItensFiltrados.length === 0) {
    return alert('Não há dados para exportar.');
  }

  const dadosFormatados = ultimosItensFiltrados.map(t => ({
    Data: t.date,
    Descrição: t.desc,
    Categoria: t.cat,
    Tipo: t.type,
    Valor: t.val,
    Moeda: t.currency || 'BRL'
  }));

  const worksheet = XLSX.utils.json_to_sheet(dadosFormatados);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Lançamentos');
  XLSX.writeFile(workbook, 'Relatorio_FluxoPro.xlsx');
  notify('Planilha Excel gerada com sucesso!');
}

// --- EXPORTAR CSV E PDF ---
function exportarCSV() {
  if (ultimosItensFiltrados.length === 0) return alert('Nenhum dado para exportar.');
  let csv = 'Data,Descricao,Categoria,Tipo,Valor\n';
  ultimosItensFiltrados.forEach(t => {
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

function exportarPDF() {
  if (ultimosItensFiltrados.length === 0) return alert('Nenhum dado para exportar.');
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();

  doc.text('Relatório Financeiro - FluxoPro Enterprise', 14, 20);
  const rows = ultimosItensFiltrados.map(t => [t.date, t.desc, t.cat, t.type, `R$ ${t.val.toFixed(2)}`]);

  doc.autoTable({
    head: [['Data', 'Descrição', 'Categoria', 'Tipo', 'Valor']],
    body: rows,
    startY: 30
  });

  doc.save('extrato_fluxopro.pdf');
  notify('PDF gerado com sucesso!');
}

// --- IMPORTAR ARQUIVO (CSV/OFX) ---
async function handleImportFile() {
  const fileInput = document.getElementById('import-file-input');
  const accountId = document.getElementById('import-default-account').value || null;
  const defaultCat = document.getElementById('import-default-cat').value || 'Geral';

  if (!fileInput.files || fileInput.files.length === 0) {
    return alert('Selecione um arquivo CSV ou OFX.');
  }

  const file = fileInput.files[0];
  Papa.parse(file, {
    header: false,
    complete: async function(results) {
      const novas = [];
      results.data.forEach(row => {
        if (row.length >= 3 && row[0] && row[1] && row[2]) {
          const val = parseFloat(row[2].replace(',', '.'));
          if (!isNaN(val)) {
            novas.push({
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

      if (novas.length > 0) {
        const { error } = await _supabase.from('transactions').insert(novas);
        if (error) return alert('Erro ao importar: ' + error.message);
        notify(`${novas.length} transações importadas com sucesso!`);
        carregarTransacoesNuvem();
        carregarCarteiras();
      } else {
        alert('Formato do arquivo não reconhecido ou vazio.');
      }
    }
  });
}

// --- STATUS DO PERFIL E MFA ---
async function renderizarStatusMfa() {
  const container = document.getElementById('mfa-setup-container');
  const text = document.getElementById('mfa-status-text');
  if (!container || !text) return;

  const { data, error } = await _supabase.auth.mfa.listFactors();
  if (error) return;

  const totpFactor = data.factors.find(f => f.factor_type === 'totp' && f.status === 'verified');

  if (totpFactor) {
    text.innerText = 'Status: 2FA Ativo (Sua conta está protegida)';
    container.innerHTML = `<button onclick="desativarMfa('${totpFactor.id}')" class="btn-del">Desativar 2FA</button>`;
  } else {
    text.innerText = 'Status: 2FA Inativo';
    container.innerHTML = `<button onclick="iniciarConfiguracaoMfa()" class="btn-primary">Configurar 2FA (Google Authenticator)</button>`;
  }
}

async function iniciarConfiguracaoMfa() {
  const { data, error } = await _supabase.auth.mfa.enroll({ factorType: 'totp' });
  if (error) return alert('Erro ao iniciar 2FA: ' + error.message);

  pendingMfaFactorId = data.id;
  const qrCodeUri = data.totp.qr_code;

  const container = document.getElementById('mfa-setup-container');
  container.innerHTML = `
    <p>Escaneie o QR Code abaixo com seu aplicativo autenticador (Google Authenticator, Authy):</p>
    <div style="margin: 10px 0;"><img src="${qrCodeUri}" alt="QR Code 2FA" style="max-width:200px;"></div>
    <div class="input-group">
      <label>Digite o código gerado para confirmar:</label>
      <input type="text" id="mfa-setup-code" placeholder="000000" maxlength="6">
    </div>
    <button onclick="confirmarConfiguracaoMfa()" class="btn-primary">Ativar 2FA</button>
  `;
}

async function confirmarConfiguracaoMfa() {
  const code = document.getElementById('mfa-setup-code').value.trim();
  const { data: challenge, error: errChallenge } = await _supabase.auth.mfa.challenge({ factorId: pendingMfaFactorId });
  if (errChallenge) return alert('Erro: ' + errChallenge.message);

  const { error: errVerify } = await _supabase.auth.mfa.verify({
    factorId: pendingMfaFactorId, challengeId: challenge.id, code
  });
  if (errVerify) return alert('Código inválido: ' + errVerify.message);

  notify('2FA ativado com sucesso!');
  renderizarStatusMfa();
}

async function desativarMfa(factorId) {
  showModal('Desativar 2FA', 'Tem certeza que deseja desativar a verificação em duas etapas?', async () => {
    const { error } = await _supabase.auth.mfa.unenroll({ factorId });
    if (error) return alert('Erro ao desativar: ' + error.message);
    notify('2FA desativado.');
    renderizarStatusMfa();
  });
