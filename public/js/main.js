const socket = io();

let localStream = null;
let peerConnection = null;
let targetSocketId = null;
let currentConsultation = null;
let medSessaoAtiva = null;
let arquivosTrocados = [];
let micAtivo = true;
let camAtiva = true;

// Servidores STUN/TURN Públicos e de Alta Conectividade
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' }
  ]
};

// MÁSCARAS
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

// Sessão Médica Local
function obterMedicoSalvoLocal() {
  try { return JSON.parse(localStorage.getItem('medgo_medico_sessao')); } catch(e) { return null; }
}
function salvarMedicoLocal(medico) {
  if (medico) localStorage.setItem('medgo_medico_sessao', JSON.stringify(medico));
  else localStorage.removeItem('medgo_medico_sessao');
}

// Tema Claro / Escuro
const btnTema = document.getElementById('btn-tema');
if (btnTema) {
  btnTema.addEventListener('click', () => {
    const atual = document.documentElement.getAttribute('data-theme');
    document.documentElement.setAttribute('data-theme', atual === 'dark' ? 'light' : 'dark');
  });
}

// Controle de Navegação das 3 Abas Principais (Lógica sem Ocultar Botões)
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

// Captura de Câmera/Microfone
async function obterMidiaLocal() {
  if (localStream) return localStream;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 640 },
        height: { ideal: 480 },
        facingMode: "user"
      },
      audio: true
    });
    const locVid = document.getElementById('local-video');
    if (locVid) {
      locVid.srcObject = localStream;
      locVid.muted = true;
      locVid.play().catch(e => console.log('Erro play local:', e));
    }
    return localStream;
  } catch (err) {
    alert('Permita o acesso à Câmera e Microfone para realizar a consulta de vídeo.');
    console.error('Erro de mídia:', err);
    return null;
  }
}

// Criar Conexão WebRTC Nativa
function criarPeerConnection(outroSocketId) {
  peerConnection = new RTCPeerConnection(rtcConfig);

  // Adicionar faixas locais (áudio/vídeo)
  if (localStream) {
    localStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, localStream);
    });
  }

  // Receber stream remota
  peerConnection.ontrack = (event) => {
    const remoteVideo = document.getElementById('remote-video');
    if (remoteVideo && event.streams[0]) {
      remoteVideo.srcObject = event.streams[0];
      remoteVideo.play().catch(e => console.log('Erro play remoto:', e));
    }
  };

  // Enviar candidatos ICE
  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('webrtc-ice-candidate', { target: outroSocketId, candidate: event.candidate });
    }
  };
}

// Sinalização WebRTC via Socket.io
socket.on('webrtc-offer', async (data) => {
  targetSocketId = data.sender;
  await obterMidiaLocal();
  criarPeerConnection(targetSocketId);
  await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
  
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);
  
  socket.emit('webrtc-answer', { target: targetSocketId, sdp: answer });
});

socket.on('webrtc-answer', async (data) => {
  if (peerConnection) {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
  }
});

socket.on('webrtc-ice-candidate', async (data) => {
  if (peerConnection && data.candidate) {
    try {
      await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
    } catch (e) {
      console.error('Erro ao adicionar Candidate:', e);
    }
  }
});

// Controles Mic/Cam
const btnToggleMic = document.getElementById('btn-toggle-mic');
const btnToggleCam = document.getElementById('btn-toggle-cam');

if (btnToggleMic) {
  btnToggleMic.addEventListener('click', () => {
    if (localStream && localStream.getAudioTracks().length > 0) {
      micAtivo = !micAtivo;
      localStream.getAudioTracks()[0].enabled = micAtivo;
      btnToggleMic.innerText = micAtivo ? '🎤 Microfone On' : '🎙️ Microfone Off';
      btnToggleMic.classList.toggle('off', !micAtivo);
    }
  });
}

if (btnToggleCam) {
  btnToggleCam.addEventListener('click', () => {
    if (localStream && localStream.getVideoTracks().length > 0) {
      camAtiva = !camAtiva;
      localStream.getVideoTracks()[0].enabled = camAtiva;
      btnToggleCam.innerText = camAtiva ? '📷 Câmera On' : '📷 Câmera Off';
      btnToggleCam.classList.toggle('off', !camAtiva);
    }
  });
}

// Formulários Área Médica
const formLoginMedico = document.getElementById('form-login-medico');
const formCadastroMedico = document.getElementById('form-cadastro-medico');
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

const medicoSalvo = obterMedicoSalvoLocal();
if (medicoSalvo) {
  medSessaoAtiva = medicoSalvo;
  ativarPainelMedico(medicoSalvo);
}

// Logoff Médico
const btnLogoutMed = document.getElementById('btn-logout-medico');
if (btnLogoutMed) {
  btnLogoutMed.addEventListener('click', () => {
    medSessaoAtiva = null;
    salvarMedicoLocal(null);
    document.getElementById('dashboard-medico').classList.add('hidden');
    document.getElementById('box-medico-auth').classList.remove('hidden');
  });
}

// Paciente Fila
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
  currentConsultation = { pacienteId: pacienteSocketId, nome, cpf, sessionId: Date.now() };
  socket.emit('chamar-paciente', { pacienteSocketId, medicoInfo: medSessaoAtiva });
  configurarInterfaceConsulta(true);
  
  await obterMidiaLocal();
  criarPeerConnection(targetSocketId);
  
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  
  socket.emit('webrtc-offer', { target: targetSocketId, sdp: offer });
};

socket.on('chamado-para-consulta', (dados) => {
  alert('O médico chamou para a consulta!');
  document.getElementById('tab-paciente').classList.add('hidden');
  
  if (dados.medicoInfo) {
    document.getElementById('info-medico-paciente-banner').classList.remove('hidden');
    document.getElementById('nome-medico-atendendo').innerText = `Em consulta com Dr(a). ${dados.medicoInfo.nome} (CRM: ${dados.medicoInfo.crm})`;
  }
  
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
    document.getElementById('btn-encerrar-consulta').classList.remove('hidden');
    document.getElementById('titulo-documentos').innerText = "Documentos Recebidos do Médico";
  }
}

// Desconexão e Finalização
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
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }

  const txtAnamnese = document.getElementById('texto-anamnese');
  if (txtAnamnese) txtAnamnese.value = '';
  
  document.getElementById('lista-arquivos').innerHTML = '<p class="empty-files">Nenhum documento anexado ainda.</p>';
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