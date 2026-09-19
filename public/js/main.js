const socket = io();

let localStream = null;
let peer = null;
let currentCall = null;
let currentConsultation = null;
let medSessaoAtiva = null;
let arquivosTrocados = [];

// Modo Claro / Escuro
const btnTema = document.getElementById('btn-tema');
btnTema.addEventListener('click', () => {
  const atual = document.documentElement.getAttribute('data-theme');
  const novo = atual === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', novo);
});

// Navegação por Abas
const tabButtons = document.querySelectorAll('.tab-btn');
const tabContents = document.querySelectorAll('.tab-content');

tabButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    tabButtons.forEach(b => b.classList.remove('active'));
    tabContents.forEach(c => c.classList.add('hidden'));

    btn.classList.add('active');
    const tabId = `tab-${btn.getAttribute('data-tab')}`;
    document.getElementById(tabId).classList.remove('hidden');
  });
});

// Formulários Área Médica
const btnMedLoginView = document.getElementById('btn-med-login-view');
const btnMedCadView = document.getElementById('btn-med-cad-view');
const formLoginMedico = document.getElementById('form-login-medico');
const formCadastroMedico = document.getElementById('form-cadastro-medico');
const formRecuperarSenha = document.getElementById('form-recuperar-senha');
const linkEsqueciSenha = document.getElementById('link-esqueci-senha');
const linkVoltarLogin = document.getElementById('link-voltar-login');

btnMedLoginView.addEventListener('click', () => {
  btnMedLoginView.classList.add('active');
  btnMedCadView.classList.remove('active');
  formLoginMedico.classList.remove('hidden');
  formCadastroMedico.classList.add('hidden');
  formRecuperarSenha.classList.add('hidden');
});

btnMedCadView.addEventListener('click', () => {
  btnMedCadView.classList.add('active');
  btnMedLoginView.classList.remove('active');
  formCadastroMedico.classList.remove('hidden');
  formLoginMedico.classList.add('hidden');
  formRecuperarSenha.classList.add('hidden');
});

linkEsqueciSenha.addEventListener('click', (e) => {
  e.preventDefault();
  formLoginMedico.classList.add('hidden');
  formCadastroMedico.classList.add('hidden');
  formRecuperarSenha.classList.remove('hidden');
});

linkVoltarLogin.addEventListener('click', (e) => {
  e.preventDefault();
  formRecuperarSenha.classList.add('hidden');
  formLoginMedico.classList.remove('hidden');
});

// Cadastro de Médico
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

  if (res.ok) {
    alert(data.message);
    formCadastroMedico.reset();
    btnMedLoginView.click();
  } else {
    alert(data.error);
  }
});

// Redefinir Senha
formRecuperarSenha.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('rec-email').value;
  const novaSenha = document.getElementById('rec-nova-senha').value;

  const res = await fetch('/api/medico/recuperar-senha', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, novaSenha })
  });
  const data = await res.json();

  if (res.ok) {
    alert(data.message);
    formRecuperarSenha.reset();
    linkVoltarLogin.click();
  } else {
    alert(data.error);
  }
});

// Login do Médico
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
    document.getElementById('saudacao-medico').innerText = `Dr(a). ${data.medico.nome}`;
    document.getElementById('box-medico-auth').classList.add('hidden');
    document.getElementById('dashboard-medico').classList.remove('hidden');
  } else {
    alert(data.error);
  }
});

// Logoff Médico
document.getElementById('btn-logout-medico').addEventListener('click', () => {
  medSessaoAtiva = null;
  document.getElementById('dashboard-medico').classList.add('hidden');
  document.getElementById('box-medico-auth').classList.remove('hidden');
  formLoginMedico.reset();
});

// Login Admin
document.getElementById('form-login-admin').addEventListener('submit', async (e) => {
  e.preventDefault();
  const user = document.getElementById('adm-user').value;
  const pass = document.getElementById('adm-pass').value;

  if (user === 'Admin' && pass === 'Tr0sH!') {
    document.getElementById('login-admin-box').classList.add('hidden');
    document.getElementById('dashboard-admin').classList.remove('hidden');
    carregarDadosAdmin();
  } else {
    alert('Usuário ou senha do Administrador incorretos!');
  }
});

// Logoff Admin
document.getElementById('btn-logout-admin').addEventListener('click', () => {
  document.getElementById('dashboard-admin').classList.add('hidden');
  document.getElementById('login-admin-box').classList.remove('hidden');
  document.getElementById('form-login-admin').reset();
});

// Paciente entra na fila
document.getElementById('form-paciente').addEventListener('submit', (e) => {
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

// Atualizar fila
socket.on('atualizar-fila', (fila) => {
  const lista = document.getElementById('lista-pacientes-fila');
  const count = document.getElementById('count-fila');
  if (count) count.innerText = `${fila.length} paciente(s) em espera`;
  if (!lista) return;

  lista.innerHTML = fila.length === 0 ? '<li class="empty-msg">Nenhum paciente na fila.</li>' : '';

  fila.forEach((p, idx) => {
    const li = document.createElement('li');
    li.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; padding:10px; background:var(--bg-color); border-radius:8px;';
    li.innerHTML = `
      <div><strong>${idx + 1}. ${p.nome}</strong> (CPF: ${p.cpf}) - Entrou às ${p.horaEntrada || ''}</div>
      <button class="btn-primary" style="width:auto; padding:6px 12px;" onclick="chamarPaciente('${p.id}', '${p.nome}', '${p.cpf}')">Chamar</button>
    `;
    lista.appendChild(li);
  });
});

// Inicialização do PeerJS
function inicializarPeerJS() {
  if (peer) return;

  // Cria o nó PeerJS utilizando o próprio ID do Socket.io para alinhamento direto
  peer = new Peer(socket.id, {
    debug: 1,
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun.relay.metered.ca:80' },
        {
          urls: 'turn:global.relay.metered.ca:80',
          username: 'e823f6eb7e39ef695420e181',
          credential: 'K8a2x8C83/aJ9fGL'
        },
        {
          urls: 'turn:global.relay.metered.ca:443',
          username: 'e823f6eb7e39ef695420e181',
          credential: 'K8a2x8C83/aJ9fGL'
        }
      ]
    }
  });

  // Atendimento de chamadas recebidas (Lado Paciente)
  peer.on('call', async (call) => {
    currentCall = call;
    try {
      if (!localStream) {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        document.getElementById('local-video').srcObject = localStream;
      }
      call.answer(localStream);

      call.on('stream', (remoteStream) => {
        const remoteVideo = document.getElementById('remote-video');
        remoteVideo.srcObject = remoteStream;
        remoteVideo.play().catch(e => console.log('Erro ao dar play no vídeo:', e));
      });
    } catch (err) {
      console.error('Erro ao capturar mídia local ao atender:', err);
    }
  });
}

// Conectar ao Socket para garantir ID do PeerJS
socket.on('connect', () => {
  inicializarPeerJS();
});

window.chamarPaciente = async (pacienteSocketId, nome, cpf) => {
  currentConsultation = { pacienteId: pacienteSocketId, nome, cpf, sessionId: Date.now() };
  socket.emit('chamar-paciente', { pacienteSocketId, medicoInfo: medSessaoAtiva });
  configurarInterfaceConsulta(true);
  iniciarChamadaPeer(pacienteSocketId);
};

socket.on('chamado-para-consulta', (dados) => {
  alert('O médico chamou para a consulta!');
  document.getElementById('tab-paciente').classList.add('hidden');
  configurarInterfaceConsulta(false);
});

function configurarInterfaceConsulta(isDoctor) {
  document.getElementById('sala-consulta').classList.remove('hidden');
  
  if (isDoctor) {
    document.getElementById('anamnese-box').classList.remove('hidden');
    document.getElementById('area-upload-medico').classList.remove('hidden');
    document.getElementById('btn-encerrar-consulta').classList.remove('hidden');
    document.getElementById('titulo-documentos').innerText = "Documentos da Consulta";
  } else {
    document.getElementById('anamnese-box').classList.add('hidden');
    document.getElementById('area-upload-medico').classList.add('hidden');
    document.getElementById('btn-encerrar-consulta').classList.add('hidden');
    document.getElementById('titulo-documentos').innerText = "Documentos Recebidos do Médico";
  }
}

// Sincronizar anamnese temporária
document.getElementById('texto-anamnese').addEventListener('input', (e) => {
  socket.emit('atualizar-anamnese-temp', e.target.value);
});

// Inicia a chamada via PeerJS (Lado Médico)
async function iniciarChamadaPeer(targetSocketId) {
  try {
    if (!localStream) {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      document.getElementById('local-video').srcObject = localStream;
    }

    const call = peer.call(targetSocketId, localStream);
    currentCall = call;

    call.on('stream', (remoteStream) => {
      const remoteVideo = document.getElementById('remote-video');
      remoteVideo.srcObject = remoteStream;
      remoteVideo.play().catch(e => console.log('Erro ao dar play no vídeo:', e));
    });
  } catch (err) {
    console.error('Erro ao acessar dispositivos de áudio/vídeo:', err);
  }
}

// Envio de Arquivos pelo Médico
document.getElementById('input-arquivo').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const formData = new FormData();
  formData.append('arquivo', file);

  const res = await fetch('/api/upload', { method: 'POST', body: formData });
  const data = await res.json();
  
  socket.emit('novo-arquivo-enviado', { 
    targetId: currentConsultation ? currentConsultation.pacienteId : null,
    file: data 
  });

  adicionarArquivoNaLista(data);
});

socket.on('receber-arquivo-medico', (fileData) => {
  adicionarArquivoNaLista(fileData);
});

function adicionarArquivoNaLista(data) {
  arquivosTrocados.push(data);
  const lista = document.getElementById('lista-arquivos');
  const emptyMsg = lista.querySelector('.empty-files');
  if (emptyMsg) emptyMsg.remove();

  lista.innerHTML += `<div style="margin-top:6px; padding:6px; background:var(--bg-color); border-radius:6px; font-size:0.85rem;">📄 <strong>${data.originalname}</strong> - <a href="${data.path}" target="_blank" download style="color:var(--cyan); text-decoration:underline;">Baixar Documento</a></div>`;
}

// Notificações de Encerramento e Desconexão
socket.on('parceiro-desconectou', () => {
  alert('A outra parte se desconectou. A consulta foi encerrada e o relatório final salvo automaticamente.');
  limparEVoltarLobby();
});

socket.on('consulta-encerrada-pelo-medico', () => {
  alert('A consulta foi finalizada.');
  limparEVoltarLobby();
});

function limparEVoltarLobby() {
  if (currentCall) {
    currentCall.close();
    currentCall = null;
  }
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }

  document.getElementById('texto-anamnese').value = '';
  document.getElementById('lista-arquivos').innerHTML = '<p class="empty-files">Nenhum documento anexado ainda.</p>';
  arquivosTrocados = [];
  currentConsultation = null;

  document.getElementById('sala-consulta').classList.add('hidden');
  
  if (medSessaoAtiva) {
    document.getElementById('dashboard-medico').classList.remove('hidden');
  } else {
    document.getElementById('tab-paciente').classList.remove('hidden');
    document.getElementById('lobby-paciente').classList.add('hidden');
    document.getElementById('form-paciente-box').classList.remove('hidden');
  }
}

// Finalizar Consulta Manualmente
document.getElementById('btn-encerrar-consulta').addEventListener('click', () => {
  const anamnese = document.getElementById('texto-anamnese').value;
  socket.emit('finalizar-consulta', { anamnese });
});

// Painel Admin
async function carregarDadosAdmin() {
  const res = await fetch('/api/admin/dados');
  const data = await res.json();
  renderAdminDashboard(data);
}

socket.on('atualizar-admin-medicos', () => carregarDadosAdmin());
socket.on('atualizar-admin-pacientes', (data) => {
  document.getElementById('count-admin-fila').innerText = data.filaAtualCount;
  renderPacientesAdmin(data.registroPacientesGeral);
});
socket.on('atualizar-admin-dashboard', (data) => {
  document.getElementById('count-atendimentos-hoje').innerText = data.atendimentosHoje;
  document.getElementById('count-admin-fila').innerText = data.filaAtualCount;
  renderLogsAdmin(data.logsConsultas);
  renderPacientesAdmin(data.registroPacientesGeral);
});

function renderAdminDashboard(data) {
  document.getElementById('count-atendimentos-hoje').innerText = data.atendimentosHoje;
  document.getElementById('count-admin-fila').innerText = data.filaAtualCount;
  renderMedicosAdmin(data.medicos);
  renderPacientesAdmin(data.registroPacientesGeral);
  renderLogsAdmin(data.logsConsultas);
}

function renderMedicosAdmin(medicos) {
  const container = document.getElementById('lista-medicos-admin');
  if (!container) return;
  if (!medicos || medicos.length === 0) {
    container.innerHTML = '<p class="empty-msg">Nenhum médico cadastrado ainda.</p>';
    return;
  }

  container.innerHTML = medicos.map(m => `
    <div class="item-row" style="flex-wrap:wrap; gap:8px;">
      <div>
        <strong>${m.nome}</strong> (CRM: ${m.crm}) - Status: <em>${m.status.toUpperCase()}</em>
      </div>
      <div>
        <button class="btn-small" style="background:var(--border); color:var(--text-color);" onclick="verPerfilMedico('${m.nome}', '${m.cpf}', '${m.crm}', '${m.email}', '${m.status}')">Ver Perfil</button>
        ${m.status === 'pendente' ? `
          <button class="btn-small btn-success" onclick="alterarStatusMedico('${m.id}', 'aprovado')">Aprovar</button>
          <button class="btn-small btn-danger" onclick="alterarStatusMedico('${m.id}', 'bloqueado')">Negar</button>
        ` : ''}
        ${m.status === 'aprovado' ? `
          <button class="btn-small btn-warn" onclick="alterarStatusMedico('${m.id}', 'bloqueado')">Bloquear</button>
        ` : ''}
        ${m.status === 'bloqueado' ? `
          <button class="btn-small btn-success" onclick="alterarStatusMedico('${m.id}', 'aprovado')">Desbloquear</button>
        ` : ''}
      </div>
    </div>
  `).join('');
}

window.verPerfilMedico = (nome, cpf, crm, email, status) => {
  alert(`📋 PERFIL DO MÉDICO:\n\n• Nome: ${nome}\n• CRM: ${crm}\n• CPF: ${cpf}\n• E-mail: ${email}\n• Status: ${status.toUpperCase()}`);
};

window.alterarStatusMedico = async (medicoId, novoStatus) => {
  await fetch('/api/admin/medico/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ medicoId, novoStatus })
  });
  carregarDadosAdmin();
};

function renderPacientesAdmin(pacientes) {
  const container = document.getElementById('lista-pacientes-admin');
  if (!container) return;
  if (!pacientes || pacientes.length === 0) {
    container.innerHTML = '<p class="empty-msg">Nenhum paciente registrado ainda.</p>';
    return;
  }

  container.innerHTML = pacientes.map(p => `
    <div class="item-row">
      <div>
        <strong>${p.nome}</strong> (CPF: ${p.cpf}) | 📞 ${p.telefone}
      </div>
      <div>
        Entrou: ${p.horaEntrada} | <span class="badge" style="position:static;">${p.status}</span>
      </div>
    </div>
  `).join('');
}

function renderLogsAdmin(logs) {
  const lista = document.getElementById('lista-logs-consultas');
  if (!lista) return;
  if (!logs || logs.length === 0) {
    lista.innerHTML = '<li class="empty-msg">Nenhum log gravado.</li>';
    return;
  }
  lista.innerHTML = logs.map(l => `
    <li class="item-row">
      <span><strong>${l.paciente}</strong> atendido por <em>${l.medico}</em> (${l.data})</span>
      <a href="${l.zipUrl}" class="btn-secondary" style="width:auto; text-decoration:none; padding:4px 10px; font-size:0.8rem;">📦 Baixar .ZIP</a>
    </li>
  `).join('');
}