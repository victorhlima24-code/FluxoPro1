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

// --- ESTADO GLOBAL ---
let currentUser = null;
let transactions = [];
let bills = [];
let barChartInstance = null;
let doughnutChartInstance = null;
let pendingDeleteAction = null;

// --- MÁSCARAS DE ENTRADA (CPF/CNPJ e Telefone) ---
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

  docInputs.forEach(input => {
    input?.addEventListener('input', (e) => e.target.value = maskDoc(e.target.value));
  });

  phoneInputs.forEach(input => {
    input?.addEventListener('input', (e) => e.target.value = maskPhone(e.target.value));
  });
}

// --- TOAST NOTIFICATION ---
function notify(text) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerText = text;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// --- MODAL CUSTOMIZADO ---
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

// --- EVENTOS E MONITORAMENTO DE SESSÃO ---
document.addEventListener('DOMContentLoaded', () => {
  setupEventListeners();
  applyMasks();

  _supabase.auth.onAuthStateChange((event, session) => {
    if (session && session.user) {
      currentUser = {
        id: session.user.id,
        email: session.user.email,
        ...session.user.user_metadata
      };
      iniciarSistema();
    } else {
      currentUser = null;
      document.getElementById('auth-screen').style.display = 'flex';
      document.getElementById('app-screen').style.display = 'none';
    }
  });
});

function setupEventListeners() {
  // Modal Buttons
  document.getElementById('modal-btn-cancel')?.addEventListener('click', hideModal);
  document.getElementById('modal-btn-confirm')?.addEventListener('click', () => {
    if (pendingDeleteAction) pendingDeleteAction();
    hideModal();
  });

  // Alternar Login / Cadastro
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

  // Navegação
  document.getElementById('nav-dash')?.addEventListener('click', () => switchTab('section-dashboard', 'nav-dash'));
  document.getElementById('nav-bills')?.addEventListener('click', () => switchTab('section-bills', 'nav-bills'));
  document.getElementById('nav-profile')?.addEventListener('click', () => switchTab('section-profile', 'nav-profile'));
  document.getElementById('nav-support')?.addEventListener('click', () => switchTab('section-support', 'nav-support'));

  // Tema
  document.getElementById('btn-theme')?.addEventListener('click', () => {
    const isDark = document.body.getAttribute('data-theme') === 'dark';
    if (isDark) document.body.removeAttribute('data-theme');
    else document.body.setAttribute('data-theme', 'dark');
  });

  // Formulários
  document.getElementById('form-register')?.addEventListener('submit', handleRegister);
  document.getElementById('form-login')?.addEventListener('submit', handleLogin);
  document.getElementById('btn-logout')?.addEventListener('click', handleLogout);
  document.getElementById('form-transaction')?.addEventListener('submit', handleSaveTransaction);
  document.getElementById('form-bill')?.addEventListener('submit', handleSaveBill);
  document.getElementById('form-update-profile')?.addEventListener('submit', handleUpdateProfile);

  // Filtros
  document.getElementById('search-input')?.addEventListener('input', renderizarDados);
  document.getElementById('filter-type')?.addEventListener('change', renderizarDados);
  document.getElementById('filter-date-start')?.addEventListener('change', renderizarDados);
  document.getElementById('filter-date-end')?.addEventListener('change', renderizarDados);
  document.getElementById('budget-limit')?.addEventListener('change', renderizarDados);
  document.getElementById('month-picker')?.addEventListener('change', renderizarDados);
  document.getElementById('btn-clear-month')?.addEventListener('click', () => {
    document.getElementById('month-picker').value = '';
    document.getElementById('filter-date-start').value = '';
    document.getElementById('filter-date-end').value = '';
    renderizarDados();
  });

  // Exportações
  document.getElementById('btn-export')?.addEventListener('click', exportarCSV);
  document.getElementById('btn-print-pdf')?.addEventListener('click', () => window.print());
}

// --- TAB SWITCH ---
function switchTab(sectionId, navId) {
  document.querySelectorAll('.page-section').forEach(sec => sec.style.display = 'none');
  document.querySelectorAll('.nav-item').forEach(nav => nav.classList.remove('active'));
  
  document.getElementById(sectionId).style.display = 'block';
  document.getElementById(navId).classList.add('active');

  if (sectionId === 'section-bills') carregarContasNuvem();
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

  const { data, error } = await _supabase.auth.signUp({
    email,
    password,
    options: {
      data: { name, doc, phone, profile }
    }
  });

  if (error) return alert('Erro no cadastro: ' + error.message);

  notify('Conta criada com sucesso! Faça login.');
  document.getElementById('register-box').style.display = 'none';
  document.getElementById('login-box').style.display = 'block';
  document.getElementById('form-register').reset();
}

async function handleLogin(e) {
  e.preventDefault();
  const email = document.getElementById('login-email').value;
  const password = document.getElementById('login-password').value;

  const { error } = await _supabase.auth.signInWithPassword({
    email,
    password
  });

  if (error) return alert('Falha no login: ' + error.message);
}

async function handleLogout() {
  await _supabase.auth.signOut();
}

function iniciarSistema() {
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('app-screen').style.display = 'flex';
  document.getElementById('user-display-name').innerText = currentUser.name || currentUser.email;

  document.getElementById('edit-name').value = currentUser.name || '';
  document.getElementById('edit-email').value = currentUser.email || '';
  document.getElementById('edit-doc').value = currentUser.doc || '';
  document.getElementById('edit-phone').value = currentUser.phone || '';
  document.getElementById('edit-profile').value = currentUser.profile || 'Pessoal';

  document.getElementById('trans-date').valueAsDate = new Date();
  carregarTransacoesNuvem();
}

// --- PERFIL ---
async function handleUpdateProfile(e) {
  e.preventDefault();
  const name = document.getElementById('edit-name').value;
  const doc = document.getElementById('edit-doc').value;
  const phone = document.getElementById('edit-phone').value;
  const profile = document.getElementById('edit-profile').value;

  const { error } = await _supabase.auth.updateUser({
    data: { name, doc, phone, profile }
  });

  if (error) return alert('Erro ao atualizar dados: ' + error.message);

  currentUser = { ...currentUser, name, doc, phone, profile };
  document.getElementById('user-display-name').innerText = name;
  notify('Perfil atualizado com sucesso!');
}

// --- TRANSAÇÕES ---
async function carregarTransacoesNuvem() {
  if (!currentUser) return;

  const { data, error } = await _supabase
    .from('transactions')
    .select('*')
    .eq('user_id', currentUser.id);

  if (error) {
    console.error('Erro ao carregar transações:', error);
    return;
  }

  transactions = data.map(item => ({
    id: item.id,
    userId: item.user_id,
    desc: item.description,
    val: parseFloat(item.amount),
    type: item.type,
    cat: item.category,
    date: item.date
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
  const isRecurring = document.getElementById('trans-recurring').checked;

  const descFinal = isRecurring ? `${desc} 🔄` : desc;

  if (id) {
    const { error } = await _supabase
      .from('transactions')
      .update({ description: descFinal, amount: val, type, category: cat, date })
      .eq('id', id);

    if (error) return alert('Erro ao atualizar: ' + error.message);
    notify('Lançamento atualizado!');
    document.getElementById('form-title').innerText = "Novo Lançamento Financeiro";
    document.getElementById('trans-id').value = "";
  } else {
    const { error } = await _supabase
      .from('transactions')
      .insert([{
        user_id: currentUser.id,
        description: descFinal,
        amount: val,
        type,
        category: cat,
        date
      }]);

    if (error) return alert('Erro ao salvar: ' + error.message);
    notify('Salvo com sucesso!');
  }

  e.target.reset();
  document.getElementById('trans-date').valueAsDate = new Date();
  carregarTransacoesNuvem();
}

window.editarItem = function(id) {
  const item = transactions.find(t => t.id === id);
  if (!item) return;

  document.getElementById('trans-id').value = item.id;
  document.getElementById('trans-desc').value = item.desc.replace(' 🔄', '');
  document.getElementById('trans-val').value = item.val;
  document.getElementById('trans-type').value = item.type;
  document.getElementById('trans-cat').value = item.cat;
  document.getElementById('trans-date').value = item.date;
  document.getElementById('form-title').innerText = "Editar Lançamento";
};

window.deletarItem = function(id) {
  showModal('Excluir Lançamento', 'Tem certeza que deseja apagar este lançamento permanentemente?', async () => {
    const { error } = await _supabase.from('transactions').delete().eq('id', id);
    if (error) return alert('Erro ao excluir: ' + error.message);
    notify('Removido da nuvem!');
    carregarTransacoesNuvem();
  });
};

function renderizarDados() {
  const tbody = document.getElementById('table-body');
  if (!tbody) return;
  tbody.innerHTML = '';

  const search = (document.getElementById('search-input')?.value || '').toLowerCase();
  const filterType = document.getElementById('filter-type')?.value || 'Todos';
  const selectedMonth = document.getElementById('month-picker')?.value;
  const dateStart = document.getElementById('filter-date-start')?.value;
  const dateEnd = document.getElementById('filter-date-end')?.value;

  let userItems = [...transactions];

  if (selectedMonth) {
    userItems = userItems.filter(t => t.date && t.date.startsWith(selectedMonth));
  }

  if (dateStart) userItems = userItems.filter(t => t.date >= dateStart);
  if (dateEnd) userItems = userItems.filter(t => t.date <= dateEnd);

  if (filterType !== 'Todos') userItems = userItems.filter(t => t.type === filterType);
  if (search) userItems = userItems.filter(t => t.desc.toLowerCase().includes(search));

  userItems.sort((a, b) => new Date(b.date) - new Date(a.date));

  let totalReceita = 0, totalDespesa = 0;
  const categoriasDespesas = {};

  userItems.forEach(t => {
    if (t.type === 'Receita') totalReceita += t.val;
    if (t.type === 'Despesa') {
      totalDespesa += t.val;
      categoriasDespesas[t.cat] = (categoriasDespesas[t.cat] || 0) + t.val;
    }

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${t.date ? t.date.split('-').reverse().join('/') : '-'}</td>
      <td><strong>${t.desc}</strong></td>
      <td>${t.cat}</td>
      <td style="color: ${t.type === 'Receita' ? '#10b981' : '#ef4444'}; font-weight: 700;">${t.type}</td>
      <td>R$ ${t.val.toFixed(2)}</td>
      <td>
        <button class="action-btn btn-edit" onclick="editarItem('${t.id}')">Editar</button>
        <button class="action-btn btn-del" onclick="deletarItem('${t.id}')">Excluir</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  document.getElementById('val-receita').innerText = `R$ ${totalReceita.toFixed(2)}`;
  document.getElementById('val-despesa').innerText = `R$ ${totalDespesa.toFixed(2)}`;
  document.getElementById('val-saldo').innerText = `R$ ${(totalReceita - totalDespesa).toFixed(2)}`;

  // Progresso Orçamento com Alerta
  const limit = parseFloat(document.getElementById('budget-limit')?.value) || 1;
  const perc = Math.min(100, (totalDespesa / limit) * 100);
  const progressBar = document.getElementById('budget-progress');
  const budgetContainer = document.getElementById('budget-card-container');
  const alertBadge = document.getElementById('budget-alert-badge');

  if (progressBar && budgetContainer) {
    progressBar.style.width = `${perc}%`;

    if (perc >= 100) {
      progressBar.style.background = '#ef4444';
      budgetContainer.className = 'budget-section danger';
      alertBadge.innerText = '🚨 Limite Ultrapassado!';
      alertBadge.classList.remove('hidden');
    } else if (perc >= 80) {
      progressBar.style.background = '#f59e0b';
      budgetContainer.className = 'budget-section warning';
      alertBadge.innerText = '⚠️ Atenção: Teto Próximo';
      alertBadge.classList.remove('hidden');
    } else {
      progressBar.style.background = '#10b981';
      budgetContainer.className = 'budget-section';
      alertBadge.classList.add('hidden');
    }
  }

  document.getElementById('budget-text').innerText = `${perc.toFixed(1)}% do teto utilizado (R$ ${totalDespesa.toFixed(2)} / R$ ${limit.toFixed(2)})`;

  atualizarGraficos(totalReceita, totalDespesa, categoriasDespesas);
}

// --- CONTAS A PAGAR ---
async function carregarContasNuvem() {
  if (!currentUser) return;

  const { data, error } = await _supabase
    .from('bills')
    .select('*')
    .eq('user_id', currentUser.id);

  if (error) {
    console.error('Erro ao carregar contas:', error);
    return;
  }

  bills = data.map(item => ({
    id: item.id,
    userId: item.user_id,
    desc: item.description,
    val: parseFloat(item.amount),
    dueDate: item.due_date,
    status: item.status
  }));

  renderizarContas();
}

async function handleSaveBill(e) {
  e.preventDefault();
  const desc = document.getElementById('bill-desc').value;
  const val = parseFloat(document.getElementById('bill-val').value);
  const dueDate = document.getElementById('bill-duedate').value;

  const { error } = await _supabase
    .from('bills')
    .insert([{
      user_id: currentUser.id,
      description: desc,
      amount: val,
      due_date: dueDate,
      status: 'Pendente'
    }]);

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
      statusClass = 'badge-late';
      statusText = 'Atrasada';
    }

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${b.dueDate.split('-').reverse().join('/')}</td>
      <td><strong>${b.desc}</strong></td>
      <td>R$ ${b.val.toFixed(2)}</td>
      <td><span class="badge ${statusClass}">${statusText}</span></td>
      <td>
        ${b.status !== 'Paga' ? `<button class="action-btn btn-pay" onclick="marcarComoPaga('${b.id}')">Marcar Paga</button>` : ''}
        <button class="action-btn btn-del" onclick="deletarConta('${b.id}')">Excluir</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

window.marcarComoPaga = async function(id) {
  const { error } = await _supabase.from('bills').update({ status: 'Paga' }).eq('id', id);
  if (error) return alert('Erro ao atualizar status: ' + error.message);
  notify('Conta marcada como Paga!');
  carregarContasNuvem();
};

window.deletarConta = function(id) {
  showModal('Excluir Conta', 'Deseja remover esta conta agendada?', async () => {
    const { error } = await _supabase.from('bills').delete().eq('id', id);
    if (error) return alert('Erro ao excluir conta: ' + error.message);
    notify('Conta removida!');
    carregarContasNuvem();
  });
};

function exportarCSV() {
  if (transactions.length === 0) return alert('Sem dados para exportar!');

  let csv = 'Data,Descricao,Categoria,Tipo,Valor\n';
  transactions.forEach(t => {
    csv += `${t.date},"${t.desc}",${t.cat},${t.type},${t.val}\n`;
  });

  const blob = new Blob([csv], { type: 'text/csv' });
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.setAttribute('href', url);
  a.setAttribute('download', 'relatorio_fluxopro.csv');
  a.click();
}

function atualizarGraficos(receitas, despesas, categorias) {
  const barCanvas = document.getElementById('barChart');
  if (barCanvas) {
    const ctxBar = barCanvas.getContext('2d');
    if (barChartInstance) barChartInstance.destroy();
    barChartInstance = new Chart(ctxBar, {
      type: 'bar',
      data: {
        labels: ['Entradas', 'Saídas'],
        datasets: [{ data: [receitas, despesas], backgroundColor: ['#10b981', '#ef4444'], borderRadius: 8 }]
      },
      options: { plugins: { legend: { display: false } } }
    });
  }

  const doughnutCanvas = document.getElementById('doughnutChart');
  if (doughnutCanvas) {
    const ctxDoughnut = doughnutCanvas.getContext('2d');
    if (doughnutChartInstance) doughnutChartInstance.destroy();
    doughnutChartInstance = new Chart(ctxDoughnut, {
      type: 'doughnut',
      data: {
        labels: Object.keys(categorias),
        datasets: [{
          data: Object.values(categorias),
          backgroundColor: ['#ef4444', '#f59e0b', '#3b82f6', '#8b5cf6', '#ec4899', '#64748b']
        }]
      }
    });
  }
}