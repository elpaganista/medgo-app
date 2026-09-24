const socket = io();

let localStream = null;
let peerConnection = null;
let targetSocketId = null;
let currentConsultation = null;
let medSessaoAtiva = null;
let arquivosTrocados = [];
let micAtivo = true;
let camAtiva = true;

let candidatosPendentes = [];
let remoteStream = null;

// Servidores STUN/TURN Globais com suporte a TCP/UDP
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    {
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelay',
      credential: 'openrelay'
    },
    {
      urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelay',
      credential: 'openrelay'
    },
    {
      urls: 'turns:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelay',
      credential: 'openrelay'
    }
  ]
};

// MÁSCARAS DE ENTRADA
function aplicarMascaraCPF(e) {
  let v = e.target.value.replace(/\D/g, '');
  if (v.length > 11) v = v.substring(0, 11);
  v = v.replace(/(\d{3})(\d)/, '$1.$2');
  v = v.replace(/(\d{3})(\d)/, '$1.$2');
  v = v.replace(/(\d{3})(\d{1,2})$/, '$1-$2');
  e.target.value = v;
}

function aplicarMascaraTelefone(e) {
  let v = e.target.value.replace(/\D/g, '');
  if (v.length > 11) v = v.substring(0, 11);
  v = v.replace(/^(\d{2})(\d)/g, '($1) $2');
  v = v.replace(/(\d{5})(\d)/, '$1-$2');
  e.target.value = v;
}

document.querySelectorAll('#pac-cpf, #med-login-cpf, #med-cad-cpf').forEach(input => {
  if (input) input.addEventListener('input', aplicarMascaraCPF);
});

const pacTel = document.getElementById('pac-telefone');
if (pacTel) pacTel.addEventListener('input', aplicarMascaraTelefone);

function obterMedicoSalvoLocal() {
  try { return JSON.parse(localStorage.getItem('medgo_medico_sessao')); } catch(e) { return null; }
}
function salvarMedicoLocal(medico) {
  if (medico) localStorage.setItem('medgo_medico_sessao', JSON.stringify(medico));
  else localStorage.removeItem('medgo_medico_sessao');
}

const btnTema = document.getElementById('btn-tema');
if (btnTema) {
  btnTema.addEventListener('click', () => {
    const atual = document.documentElement.getAttribute('data-theme');
    document.documentElement.setAttribute('data-theme', atual === 'dark' ? 'light' : 'dark');
  });
}

const tabButtons = document.querySelectorAll('.tab-btn');
const tabContents = document.querySelectorAll('.tab-content');

tabButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    tabButtons.forEach(b => b.classList.remove('active'));
    tabContents.forEach(c => c.classList.add('hidden'));

    btn.classList.add('active');
    const target = document.getElementById(`tab-${btn.getAttribute('data-tab')}`);
    if (target) target.classList.remove('hidden');
  });
});

// CAPTURA DE MÍDIA LOCAL
async function obterMidiaLocal() {
  if (localStream) return localStream;

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    alert('Este navegador não suporta acesso à câmera e microfone.');
    return null;
  }

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
      audio: true
    });
  } catch (err) {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch (e) {
      alert('Por favor, permita o acesso à Câmera e Microfone.');
      return null;
    }
  }

  const locVid = document.getElementById('local-video');
  if (locVid) {
    locVid.srcObject = localStream;
    locVid.muted = true;
    locVid.playsInline = true;
    locVid.play().catch(e => console.log('Erro play local:', e));
  }
  return localStream;
}

function tocarVideoRemoto(video) {
  video.playsInline = true;
  const p = video.play();
  if (p && p.catch) {
    p.catch(err => console.log('Erro play remoto:', err));
  }
}

async function aplicarCandidatosPendentes() {
  if (!peerConnection || !peerConnection.remoteDescription) return;
  while (candidatosPendentes.length > 0) {
    const candidate = candidatosPendentes.shift();
    try {
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      console.warn('Erro ao aplicar ICE:', e);
    }
  }
}

function criarPeerConnection(outroSocketId) {
  if (peerConnection) peerConnection.close();
  peerConnection = new RTCPeerConnection(rtcConfig);

  if (localStream) {
    localStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, localStream);
    });
  }

  remoteStream = new MediaStream();
  const remoteVideo = document.getElementById('remote-video');
  if (remoteVideo) {
    remoteVideo.srcObject = remoteStream;
  }

  peerConnection.ontrack = (event) => {
    if (event.streams && event.streams[0]) {
      event.streams[0].getTracks().forEach(track => {
        if (!remoteStream.getTracks().includes(track)) {
          remoteStream.addTrack(track);
        }
      });
    } else if (event.track) {
      remoteStream.addTrack(event.track);
    }
    if (remoteVideo) tocarVideoRemoto(remoteVideo);
  };

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('webrtc-ice-candidate', { target: outroSocketId, candidate: event.candidate });
    }
  };
}

socket.on('webrtc-offer', async (data) => {
  targetSocketId = data.sender;
  candidatosPendentes = [];

  await obterMidiaLocal();
  criarPeerConnection(targetSocketId);

  await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
  await aplicarCandidatosPendentes();

  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);

  socket.emit('webrtc-answer', { target: targetSocketId, sdp: answer });
});

socket.on('webrtc-answer', async (data) => {
  if (peerConnection) {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
    await aplicarCandidatosPendentes();
  }
});

socket.on('webrtc-ice-candidate', async (data) => {
  if (!data.candidate) return;
  if (peerConnection && peerConnection.remoteDescription) {
    try {
      await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
    } catch (e) {}
  } else {
    candidatosPendentes.push(data.candidate);
  }
});

// LISTA DE MÉDICOS
socket.on('atualizar-lista-medicos-geral', (listaMedicos) => {
  const containerPaciente = document.getElementById('lista-medicos-status-paciente');
  if (containerPaciente) {
    const aprovados = listaMedicos.filter(m => m.statusCadastro === 'aprovado');
    if (aprovados.length === 0) {
      containerPaciente.innerHTML = '<p style="color:var(--text-muted); font-size:0.85rem;">Nenhum médico aprovado no momento.</p>';
    } else {
      containerPaciente.innerHTML = aprovados.map(m => `
        <div class="medico-status-item">
          <div>
            <strong>Dr(a). ${m.nome}</strong><br>
            <small style="color:var(--text-muted);">CRM: ${m.crm}</small>
          </div>
          <span class="status-indicator ${m.isOnline ? 'online' : 'offline'}" title="${m.isOnline ? 'Online' : 'Offline'}"></span>
        </div>
      `).join('');
    }
  }

  renderMedicosAdmin(listaMedicos);
});

socket.on('atualizar-admin-dashboard', (data) => {
  renderAdminDashboard(data);
});

// CADASTRO MÉDICO
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

// LOGIN MÉDICO
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
      salvarMedicoLocal(medSessaoAtiva);
      socket.emit('medico-online', medSessaoAtiva);
      ativarPainelMedico(medSessaoAtiva);
    } else {
      alert(data.error);
    }
  });
}

function ativarPainelMedico(medico) {
  const sauda = document.getElementById('saudacao-medico');
  if (sauda) sauda.innerText = `Dr(a). ${medico.nome}`;
  
  document.getElementById('box-medico-auth').classList.add('hidden');
  document.getElementById('dashboard-medico').classList.remove('hidden');
}

const btnMedLoginView = document.getElementById('btn-med-login-view');
const btnMedCadView = document.getElementById('btn-med-cad-view');

if (btnMedLoginView && btnMedCadView) {
  btnMedLoginView.addEventListener('click', () => {
    btnMedLoginView.classList.add('active');
    btnMedCadView.classList.remove('active');
    formLoginMedico.classList.remove('hidden');
    formCadastroMedico.classList.add('hidden');
  });

  btnMedCadView.addEventListener('click', () => {
    btnMedCadView.classList.add('active');
    btnMedLoginView.classList.remove('active');
    formCadastroMedico.classList.remove('hidden');
    formLoginMedico.classList.add('hidden');
  });
}

const btnLogoutMed = document.getElementById('btn-logout-medico');
if (btnLogoutMed) {
  btnLogoutMed.addEventListener('click', () => {
    socket.emit('medico-offline');
    medSessaoAtiva = null;
    salvarMedicoLocal(null);
    document.getElementById('dashboard-medico').classList.add('hidden');
    document.getElementById('box-medico-auth').classList.remove('hidden');
  });
}

// LOGIN ADMIN
const formAdmin = document.getElementById('form-login-admin');
if (formAdmin) {
  formAdmin.addEventListener('submit', (e) => {
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
}

const btnLogoutAdmin = document.getElementById('btn-logout-admin');
if (btnLogoutAdmin) {
  btnLogoutAdmin.addEventListener('click', () => {
    document.getElementById('dashboard-admin').classList.add('hidden');
    document.getElementById('login-admin-box').classList.remove('hidden');
  });
}

// FILA PACIENTE
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

window.chamarPaciente = async (pacienteSocketId, nome, cpf) => {
  targetSocketId = pacienteSocketId;
  candidatosPendentes = [];
  currentConsultation = { pacienteId: pacienteSocketId, nome, cpf, sessionId: Date.now() };
  
  socket.emit('chamar-paciente', { pacienteSocketId, medicoInfo: medSessaoAtiva });
  configurarInterfaceConsulta(true);
  
  await obterMidiaLocal();
  criarPeerConnection(targetSocketId);
  
  const offer = await peerConnection.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
  await peerConnection.setLocalDescription(offer);
  
  socket.emit('webrtc-offer', { target: targetSocketId, sdp: offer });
};

socket.on('chamado-para-consulta', async (dados) => {
  targetSocketId = dados.medicoSocketId || dados.sender;
  alert('O médico chamou para a consulta!');
  document.getElementById('tab-paciente').classList.add('hidden');
  
  if (dados.medicoInfo) {
    document.getElementById('info-medico-paciente-banner').classList.remove('hidden');
    document.getElementById('nome-medico-atendendo').innerText = `Em consulta com Dr(a). ${dados.medicoInfo.nome} (CRM: ${dados.medicoInfo.crm})`;
  }
  
  configurarInterfaceConsulta(false);
  await obterMidiaLocal();
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
    document.getElementById('btn-encerrar-consulta').classList.remove('hidden');
    document.getElementById('titulo-documentos').innerText = "Documentos Recebidos do Médico";
  }
}

socket.on('parceiro-desconectou', () => {
  alert('A outra parte se desconectou.');
  limparEVoltarLobby();
});

socket.on('consulta-encerrada', () => {
  alert('A consulta foi finalizada com sucesso!');
  limparEVoltarLobby();
});

function limparEVoltarLobby() {
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  candidatosPendentes = [];
  remoteStream = null;
  
  const remotoVid = document.getElementById('remote-video');
  if (remotoVid) remotoVid.srcObject = null;
  
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }

  const txtAnamnese = document.getElementById('texto-anamnese');
  if (txtAnamnese) txtAnamnese.value = '';
  
  const listaArq = document.getElementById('lista-arquivos');
  if (listaArq) listaArq.innerHTML = '<p class="empty-files">Nenhum documento anexado ainda.</p>';
  
  document.getElementById('info-medico-paciente-banner').classList.add('hidden');
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

const btnEncerrar = document.getElementById('btn-encerrar-consulta');
if (btnEncerrar) {
  btnEncerrar.addEventListener('click', () => {
    const txt = document.getElementById('texto-anamnese');
    const anamnese = txt ? txt.value : '';
    socket.emit('finalizar-consulta', { anamnese });
  });
}

// ADMIN DASHBOARD
async function carregarDadosAdmin() {
  const res = await fetch('/api/admin/dados');
  const data = await res.json();
  renderAdminDashboard(data);
}

function renderAdminDashboard(data) {
  if (!data) return;
  document.getElementById('count-atendimentos-hoje').innerText = data.atendimentosHoje || 0;
  document.getElementById('count-atendimentos-mes').innerText = data.atendimentosMes || 0;
  document.getElementById('count-total-acessos').innerText = data.totalGeralAcessos || 0;
  document.getElementById('count-admin-fila').innerText = data.filaAtualCount || 0;
  
  if (data.medicos) renderMedicosAdmin(data.medicos);
  if (data.registroPacientesGeral) renderPacientesAdmin(data.registroPacientesGeral);
  if (data.logsConsultas) renderLogsAdmin(data.logsConsultas);
}

function renderMedicosAdmin(medicos) {
  const container = document.getElementById('lista-medicos-admin');
  if (!container) return;
  if (!medicos || medicos.length === 0) {
    container.innerHTML = '<p class="empty-msg">Nenhum médico cadastrado.</p>';
    return;
  }

  container.innerHTML = medicos.map(m => `
    <div class="item-row" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; padding:10px; background:var(--bg-color); border-radius:8px;">
      <div>
        <strong>${m.nome}</strong> (CRM: ${m.crm}) - Status: <em style="color:var(--cyan);">${m.statusCadastro.toUpperCase()}</em>
      </div>
      <div style="display:flex; gap:6px;">
        ${m.statusCadastro === 'pendente' ? `
          <button class="btn-small btn-success" onclick="alterarStatusMedico('${m.id}', 'aprovado')">Aprovar</button>
          <button class="btn-small btn-warn" onclick="alterarStatusMedico('${m.id}', 'bloqueado')">Negar</button>
        ` : ''}
        ${m.statusCadastro === 'aprovado' ? `
          <button class="btn-small btn-warn" onclick="alterarStatusMedico('${m.id}', 'bloqueado')">Bloquear</button>
        ` : ''}
        ${m.statusCadastro === 'bloqueado' ? `
          <button class="btn-small btn-success" onclick="alterarStatusMedico('${m.id}', 'aprovado')">Desbloquear</button>
        ` : ''}
        <button class="btn-small btn-danger" onclick="excluirMedicoAdmin('${m.id}')">Excluir</button>
      </div>
    </div>
  `).join('');
}

function renderPacientesAdmin(pacientes) {
  const container = document.getElementById('lista-pacientes-admin');
  if (!container) return;
  if (!pacientes || pacientes.length === 0) {
    container.innerHTML = '<p class="empty-msg">Nenhum paciente registrado ainda.</p>';
    return;
  }

  container.innerHTML = pacientes.map(p => `
    <div class="item-row" style="display:flex; justify-content:space-between; margin-bottom:6px; padding:8px; background:var(--bg-color); border-radius:6px;">
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
    <li class="item-row" style="display:flex; justify-content:space-between; margin-bottom:6px; padding:8px; background:var(--bg-color); border-radius:6px;">
      <span><strong>${l.paciente}</strong> atendido por <em>${l.medico}</em> (${l.data})</span>
      <a href="${l.zipUrl}" class="btn-secondary" style="width:auto; text-decoration:none; padding:4px 10px; font-size:0.8rem;">📦 Baixar .ZIP</a>
    </li>
  `).join('');
}

window.alterarStatusMedico = async (medicoId, novoStatus) => {
  await fetch('/api/admin/medico/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ medicoId, novoStatus })
  });
  carregarDadosAdmin();
};

window.excluirMedicoAdmin = async (medicoId) => {
  if (!confirm('Deseja realmente excluir este médico do sistema?')) return;
  await fetch('/api/admin/medico/excluir', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ medicoId })
  });
  carregarDadosAdmin();
};

// UPLOAD DE DOCUMENTOS
const inputArquivo = document.getElementById('input-arquivo');
if (inputArquivo) {
  inputArquivo.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('arquivo', file);

    try {
      const res = await fetch('/api/upload', {
        method: 'POST',
        body: formData
      });

      const data = await res.json();

      if (res.ok) {
        const fileData = {
          filename: data.filename,
          originalname: data.originalname,
          path: data.path
        };

        arquivosTrocados.push(fileData);
        adicionarArquivoNaLista(fileData);

        socket.emit('novo-arquivo-enviado', {
          targetId: targetSocketId,
          file: fileData
        });

        inputArquivo.value = '';
        alert('Documento enviado com sucesso!');
      } else {
        alert(data.error || 'Erro ao enviar arquivo.');
      }
    } catch (err) {
      console.error('Erro no upload:', err);
      alert('Erro de conexão ao enviar arquivo.');
    }
  });
}

socket.on('receber-arquivo-medico', (fileData) => {
  arquivosTrocados.push(fileData);
  adicionarArquivoNaLista(fileData);
  alert(`Você recebeu um novo documento: ${fileData.originalname}`);
});

function adicionarArquivoNaLista(file) {
  const container = document.getElementById('lista-arquivos');
  if (!container) return;

  const emptyMsg = container.querySelector('.empty-files');
  if (emptyMsg) emptyMsg.remove();

  const div = document.createElement('div');
  div.className = 'item-row';
  div.style.cssText = 'margin-bottom:8px; padding:8px; background:var(--bg-color); border-radius:6px; display:flex; justify-content:space-between; align-items:center;';
  div.innerHTML = `
    <span>📄 <strong>${file.originalname}</strong></span>
    <a href="${file.path}" target="_blank" download class="btn-small btn-success" style="text-decoration:none; padding:4px 8px;">Baixar</a>
  `;
  container.appendChild(div);
}