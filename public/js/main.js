const socket = io();

let localStream = null;
let peer = null;
let currentCall = null;
let targetSocketId = null;
let currentConsultation = null;
let medSessaoAtiva = null;
let arquivosTrocados = [];
let remoteStream = null;

const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelay', credential: 'openrelay' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelay', credential: 'openrelay' }
  ]
};

function switchTab(tabName) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
  const target = document.getElementById(`tab-${tabName}`);
  if (target) target.classList.remove('hidden');

  ['paciente', 'medico', 'admin'].forEach(name => {
    const btn = document.getElementById(`nav-btn-${name}`);
    if (btn) {
      if (name === tabName) {
        btn.className = "px-4 py-2 rounded-lg text-sm font-medium transition-all bg-slate-800 text-white flex items-center gap-2";
      } else {
        btn.className = "px-4 py-2 rounded-lg text-sm font-medium transition-all text-slate-400 hover:text-white hover:bg-slate-800/50 flex items-center gap-2";
      }
    }
  });
}

function iniciarPeer() {
  if (peer && !peer.destroyed) return peer;

  peer = new Peer(socket.id, {
    host: location.hostname,
    port: location.port || (location.protocol === 'https:' ? 443 : 80),
    path: '/peerjs',
    secure: location.protocol === 'https:',
    config: rtcConfig
  });

  peer.on('call', async (call) => {
    await obterMidiaLocal();
    call.answer(localStream);
    wireCall(call);
  });

  return peer;
}

function wireCall(call) {
  currentCall = call;
  targetSocketId = call.peer;

  call.on('stream', (stream) => {
    remoteStream = stream;
    const remoteVideo = document.getElementById('remote-video');
    if (remoteVideo) {
      remoteVideo.srcObject = stream;
      remoteVideo.play().catch(e => console.log('Erro play remoto:', e));
    }
  });

  call.on('close', () => { currentCall = null; });
}

socket.on('connect', () => { iniciarPeer(); });
if (socket.connected) iniciarPeer();

async function obterMidiaLocal() {
  if (localStream) return localStream;

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (err) {
    alert('Permita o acesso à câmera e microfone.');
    return null;
  }

  const locVid = document.getElementById('local-video');
  if (locVid) {
    locVid.srcObject = localStream;
    locVid.muted = true;
    locVid.play().catch(e => console.log('Erro play local:', e));
  }
  return localStream;
}

// Fila e Ações
socket.on('atualizar-lista-medicos-geral', (listaMedicos) => {
  const containerPaciente = document.getElementById('lista-medicos-status-paciente');
  if (containerPaciente) {
    const aprovados = listaMedicos.filter(m => m.statusCadastro === 'aprovado');
    containerPaciente.innerHTML = aprovados.length === 0 
      ? '<p class="text-xs text-slate-400">Nenhum médico aprovado no momento.</p>'
      : aprovados.map(m => `
        <div class="flex items-center justify-between p-3 bg-slate-900 border border-slate-800 rounded-xl text-xs">
          <div>
            <strong class="text-slate-200">Dr(a). ${m.nome}</strong><br>
            <span class="text-slate-400">CRM: ${m.crm}</span>
          </div>
          <span class="w-2.5 h-2.5 rounded-full ${m.isOnline ? 'bg-emerald-500 animate-pulse' : 'bg-slate-600'}"></span>
        </div>
      `).join('');
  }

  renderMedicosAdmin(listaMedicos);
});

socket.on('atualizar-admin-dashboard', (data) => {
  if (!data) return;
  document.getElementById('count-atendimentos-hoje').innerText = data.atendimentosHoje || 0;
  document.getElementById('count-atendimentos-mes').innerText = data.atendimentosMes || 0;
  document.getElementById('count-total-acessos').innerText = data.totalGeralAcessos || 0;
  document.getElementById('count-admin-fila').innerText = data.filaAtualCount || 0;
  
  if (data.medicos) renderMedicosAdmin(data.medicos);
  if (data.logsConsultas) renderLogsAdmin(data.logsConsultas);
});

// Formulários Médico e Paciente
const formCadastroMedico = document.getElementById('form-cadastro-medico');
if (formCadastroMedico) {
  formCadastroMedico.addEventListener('submit', async (e) => {
    e.preventDefault();
    const dados = {
      nome: document.getElementById('med-cad-nome').value,
      cpf: document.getElementById('med-cad-cpf').value,
      email: document.getElementById('med-cad-email').value,
      crm: document.getElementById('med-cad-crm').value,
      senha: document.getElementById('med-cad-senha').value,
    };

    const res = await fetch('/api/medico/cadastro', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dados)
    });
    const data = await res.json();
    alert(data.message || data.error);
    if (res.ok) formCadastroMedico.reset();
  });
}

const formLoginMedico = document.getElementById('form-login-medico');
if (formLoginMedico) {
  formLoginMedico.addEventListener('submit', async (e) => {
    e.preventDefault();
    const cpf = document.getElementById('med-login-cpf').value;
    const senha = document.getElementById('med-login-senha').value;

    const res = await fetch('/api/medico/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cpf, senha })
    });
    const data = await res.json();

    if (res.ok) {
      medSessaoAtiva = data.medico;
      socket.emit('medico-online', medSessaoAtiva);
      document.getElementById('saudacao-medico').innerText = `Dr(a). ${medSessaoAtiva.nome}`;
      document.getElementById('box-medico-auth').classList.add('hidden');
      document.getElementById('dashboard-medico').classList.remove('hidden');
    } else {
      alert(data.error);
    }
  });
}

const formPac = document.getElementById('form-paciente');
if (formPac) {
  formPac.addEventListener('submit', (e) => {
    e.preventDefault();
    const dados = {
      nome: document.getElementById('pac-nome').value,
      cpf: document.getElementById('pac-cpf').value,
      endereco: document.getElementById('pac-endereco').value,
      telefone: document.getElementById('pac-telefone').value,
      email: document.getElementById('pac-email').value,
    };
    
    socket.emit('entrar-fila', dados);
    document.getElementById('form-paciente-box').classList.add('hidden');
    document.getElementById('lobby-paciente').classList.remove('hidden');
  });
}

socket.on('atualizar-fila', (fila) => {
  const lista = document.getElementById('lista-pacientes-fila');
  const count = document.getElementById('count-fila');
  if (count) count.innerText = `${fila.length} paciente(s) em espera`;
  if (!lista) return;

  lista.innerHTML = fila.length === 0 ? '<p class="text-xs text-slate-500">Nenhum paciente na fila.</p>' : '';

  fila.forEach((p, idx) => {
    const li = document.createElement('li');
    li.className = "flex items-center justify-between p-3 bg-slate-900 border border-slate-800 rounded-xl text-xs";
    li.innerHTML = `
      <div><strong class="text-white">${idx + 1}. ${p.nome}</strong> <span class="text-slate-400">(CPF: ${p.cpf})</span></div>
      <button class="px-3 py-1.5 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg font-semibold transition" onclick="chamarPaciente('${p.id}', '${p.nome}', '${p.cpf}')">Chamar</button>
    `;
    lista.appendChild(li);
  });
});

window.chamarPaciente = async (pacienteSocketId, nome, cpf) => {
  targetSocketId = pacienteSocketId;
  currentConsultation = { pacienteId: pacienteSocketId, nome, cpf, sessionId: Date.now() };

  socket.emit('chamar-paciente', { pacienteSocketId, medicoInfo: medSessaoAtiva });
  configurarInterfaceConsulta(true);

  await obterMidiaLocal();
  iniciarPeer();

  const call = peer.call(pacienteSocketId, localStream);
  wireCall(call);
};

socket.on('chamado-para-consulta', async (dados) => {
  targetSocketId = dados.medicoSocketId || dados.sender;
  alert('O médico chamou para a consulta!');
  configurarInterfaceConsulta(false);
  await obterMidiaLocal();
  iniciarPeer();
});

function configurarInterfaceConsulta(isDoctor) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
  document.getElementById('sala-consulta').classList.remove('hidden');

  if (isDoctor) {
    document.getElementById('anamnese-box').classList.remove('hidden');
    document.getElementById('area-upload-medico').classList.remove('hidden');
  } else {
    document.getElementById('anamnese-box').classList.add('hidden');
    document.getElementById('area-upload-medico').classList.add('hidden');
  }
}

socket.on('consulta-encerrada', () => {
  alert('A consulta foi finalizada com sucesso!');
  location.reload();
});

const btnEncerrar = document.getElementById('btn-encerrar-consulta');
if (btnEncerrar) {
  btnEncerrar.addEventListener('click', () => {
    const txt = document.getElementById('texto-anamnese');
    const anamnese = txt ? txt.value : '';
    socket.emit('finalizar-consulta', { anamnese });
  });
}

// Gestão de Admin
const formAdmin = document.getElementById('form-login-admin');
if (formAdmin) {
  formAdmin.addEventListener('submit', (e) => {
    e.preventDefault();
    if (document.getElementById('adm-user').value === 'Admin' && document.getElementById('adm-pass').value === 'Tr0sH!') {
      document.getElementById('login-admin-box').classList.add('hidden');
      document.getElementById('dashboard-admin').classList.remove('hidden');
      fetch('/api/admin/dados').then(r => r.json()).then(renderAdminDashboard);
    } else {
      alert('Credenciais incorretas!');
    }
  });
}

function renderMedicosAdmin(medicos) {
  const container = document.getElementById('lista-medicos-admin');
  if (!container) return;
  container.innerHTML = (!medicos || medicos.length === 0) 
    ? '<p class="text-xs text-slate-500">Nenhum médico cadastrado.</p>'
    : medicos.map(m => `
      <div class="flex items-center justify-between p-3 bg-slate-900 border border-slate-800 rounded-xl text-xs">
        <div><strong class="text-white">${m.nome}</strong> (CRM: ${m.crm}) - Status: <em class="text-cyan-400">${m.statusCadastro.toUpperCase()}</em></div>
        <div class="flex gap-2">
          ${m.statusCadastro === 'pendente' ? `<button class="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg" onclick="alterarStatusMedico('${m.id}', 'aprovado')">Aprovar</button>` : ''}
          ${m.statusCadastro === 'aprovado' ? `<button class="px-2.5 py-1 bg-amber-600 hover:bg-amber-500 text-white rounded-lg" onclick="alterarStatusMedico('${m.id}', 'bloqueado')">Bloquear</button>` : ''}
          <button class="px-2.5 py-1 bg-rose-600 hover:bg-rose-500 text-white rounded-lg" onclick="excluirMedicoAdmin('${m.id}')">Excluir</button>
        </div>
      </div>
    `).join('');
}

function renderLogsAdmin(logs) {
  const lista = document.getElementById('lista-logs-consultas');
  if (!lista) return;
  lista.innerHTML = (!logs || logs.length === 0)
    ? '<p class="text-xs text-slate-500">Nenhum log gravado.</p>'
    : logs.map(l => `
      <li class="flex items-center justify-between p-3 bg-slate-900 border border-slate-800 rounded-xl text-xs">
        <span><strong class="text-white">${l.paciente}</strong> atendido por <em>${l.medico}</em> (${l.data})</span>
        <a href="${l.zipUrl}" class="px-3 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg">📦 Baixar .ZIP</a>
      </li>
    `).join('');
}

window.alterarStatusMedico = async (medicoId, novoStatus) => {
  await fetch('/api/admin/medico/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ medicoId, novoStatus }) });
  fetch('/api/admin/dados').then(r => r.json()).then(renderAdminDashboard);
};

window.excluirMedicoAdmin = async (medicoId) => {
  if (!confirm('Deseja excluir este médico?')) return;
  await fetch('/api/admin/medico/excluir', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ medicoId }) });
  fetch('/api/admin/dados').then(r => r.json()).then(renderAdminDashboard);
};

// Upload de Documentos
const inputArquivo = document.getElementById('input-arquivo');
if (inputArquivo) {
  inputArquivo.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('arquivo', file);

    const res = await fetch('/api/upload', { method: 'POST', body: formData });
    const data = await res.json();

    if (res.ok) {
      const fileData = { filename: data.filename, originalname: data.originalname, path: data.path };
      adicionarArquivoNaLista(fileData);
      socket.emit('novo-arquivo-enviado', { targetId: targetSocketId, file: fileData });
      alert('Documento enviado ao paciente!');
    }
  });
}

socket.on('receber-arquivo-medico', (fileData) => {
  adicionarArquivoNaLista(fileData);
  alert(`Você recebeu um novo documento: ${fileData.originalname}`);
});

function adicionarArquivoNaLista(file) {
  const container = document.getElementById('lista-arquivos');
  if (!container) return;
  const emptyMsg = container.querySelector('.empty-files');
  if (emptyMsg) emptyMsg.remove();

  const div = document.createElement('div');
  div.className = "flex items-center justify-between p-2 bg-slate-900 border border-slate-800 rounded-lg text-xs";
  div.innerHTML = `
    <span class="text-slate-200">📄 <strong>${file.originalname}</strong></span>
    <a href="${file.path}" target="_blank" download class="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded-md text-[10px] font-semibold">Baixar</a>
  `;
  container.appendChild(div);
}