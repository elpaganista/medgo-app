const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const PDFDocument = require('pdfkit');
const archiver = require('archiver');

process.env.TZ = 'America/Fortaleza';

process.on('uncaughtException', (err) => console.error('uncaughtException:', err));
process.on('unhandledRejection', (err) => console.error('unhandledRejection:', err));

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
  cors: { origin: "*" },
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

['uploads', 'logs', 'data'].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// TENANTS MULTI-DOMÍNIO
const FILE_TENANTS = path.join(__dirname, 'data', 'tenants.json');
const FILE_TENANTS_ROOT = path.join(__dirname, 'tenants.json');

function carregarTenants() {
  if (!fs.existsSync(FILE_TENANTS) && fs.existsSync(FILE_TENANTS_ROOT)) fs.copyFileSync(FILE_TENANTS_ROOT, FILE_TENANTS);
  if (!fs.existsSync(FILE_TENANTS)) {
    const padrao = {
      "default": { id: "medgo", nome: "MedGo Telemedicina", subtitulo: "Plataforma de Saúde Digital", badge: "TELEMEDICINA", logo: "/images/medgo-logo.png" },
      "paracuru": { id: "paracuru", nome: "Prefeitura de Paracuru", subtitulo: "Secretaria Municipal de Saúde", badge: "TELEMEDICINA", logo: "/images/paracuru-logo.png" },
      "palmacia": { id: "palmacia", nome: "Prefeitura de Palmácia", subtitulo: "Secretaria Municipal de Saúde", badge: "TELEMEDICINA", logo: "/images/palmacia-logo.png" }
    };
    fs.writeFileSync(FILE_TENANTS, JSON.stringify(padrao, null, 2));
    return padrao;
  }
  try { return JSON.parse(fs.readFileSync(FILE_TENANTS, 'utf8')); } catch (err) { return {}; }
}

let tenants = carregarTenants();

function identificarTenantKey(req) {
  const host = (req.headers.host || '').toLowerCase();
  if (host.includes('paracuru')) return 'paracuru';
  if (host.includes('palmacia')) return 'palmacia';
  return 'default';
}

function getTenantPath(tenantId, fileName) {
  const dir = path.join(__dirname, 'data', tenantId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, fileName);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({ storage });

function carregarMedicos(tenantId) {
  const file = getTenantPath(tenantId, 'medicos.json');
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify([], null, 2));
    return [];
  }
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { return []; }
}

function salvarMedicos(tenantId, lista) {
  try { fs.writeFileSync(getTenantPath(tenantId, 'medicos.json'), JSON.stringify(lista, null, 2)); } catch (err) { console.error(err); }
}

function carregarPacientes(tenantId) {
  const file = getTenantPath(tenantId, 'pacientes.json');
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify([], null, 2));
    return [];
  }
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { return []; }
}

function salvarPacientes(tenantId, lista) {
  try { fs.writeFileSync(getTenantPath(tenantId, 'pacientes.json'), JSON.stringify(lista, null, 2)); } catch (err) { console.error(err); }
}

function carregarStats(tenantId) {
  const file = getTenantPath(tenantId, 'estatisticas.json');
  const padrao = { 
    totalGeralAcessos: 0, 
    perfis: { medicos: 0, pacientes: 0, geral: 0 },
    historicoDiario: {}, 
    historicoMensal: {},
    historicoAnual: {}
  };
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(padrao, null, 2));
    return padrao;
  }
  try { return { ...padrao, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch (err) { return padrao; }
}

function salvarStats(tenantId, stats) {
  try { fs.writeFileSync(getTenantPath(tenantId, 'estatisticas.json'), JSON.stringify(stats, null, 2)); } catch (err) { console.error(err); }
}

function registrarAcessoAvancado(tenantKey, tipoPerfil = 'geral') {
  const stats = carregarStats(tenantKey);
  if (!stats.perfis) stats.perfis = { medicos: 0, pacientes: 0, geral: 0 };
  stats.totalGeralAcessos = (stats.totalGeralAcessos || 0) + 1;
  stats.perfis[tipoPerfil] = (stats.perfis[tipoPerfil] || 0) + 1;
  salvarStats(tenantKey, stats);
}

let filaPacientes = [];
let consultasAtivas = new Map();
let medicosOnline = new Map();
let logsConsultas = [];

function obterDataHoraBR() {
  const agora = new Date();
  return {
    data: agora.toLocaleDateString('pt-BR', { timeZone: 'America/Fortaleza' }),
    hora: agora.toLocaleTimeString('pt-BR', { timeZone: 'America/Fortaleza' }),
    dataHoraCompleta: agora.toLocaleString('pt-BR', { timeZone: 'America/Fortaleza' }),
    mesAno: `${String(agora.getMonth() + 1).padStart(2, '0')}/${agora.getFullYear()}`,
    ano: `${agora.getFullYear()}`
  };
}

function obterMedicosComStatus(tenantId) {
  const medicos = carregarMedicos(tenantId);
  const cpfsOnline = new Set(Array.from(medicosOnline.values()).filter(m => m.tenantKey === tenantId).map(m => m.cpf));
  return medicos.map(m => ({
    id: m.id,
    nome: m.nome,
    crm: m.crm,
    cpf: m.cpf,
    email: m.email,
    foto: m.foto || '/images/default-avatar.png',
    statusCadastro: m.status,
    atendimentosConcluidos: m.atendimentosConcluidos || 0,
    historicoAtendimentos: m.historicoAtendimentos || {},
    isOnline: cpfsOnline.has(m.cpf)
  }));
}

function obterFilaPorTenant(tenantKey) {
  return filaPacientes.filter(p => p.tenantKey === tenantKey);
}

// ENDPOINTS DA API
app.get('/api/tenant/info', (req, res) => {
  tenants = carregarTenants();
  const key = identificarTenantKey(req);
  const t = tenants[key] || tenants['default'];
  res.json({ ...t, badge: 'TELEMEDICINA' });
});

app.get('/api/ice-config', (req, res) => {
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' }
  ];

  if (process.env.TURN_URL && process.env.TURN_USER && process.env.TURN_PASS) {
    const urlsArray = process.env.TURN_URL.split(',').map(u => u.trim());
    iceServers.push({
      urls: urlsArray,
      username: process.env.TURN_USER,
      credential: process.env.TURN_PASS
    });
  } else {
    iceServers.push(
      { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
    );
  }

  res.json({ iceServers });
});

app.post('/api/upload', upload.single('arquivo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
  res.json({ filename: req.file.filename, originalname: req.file.originalname, path: `/uploads/${req.file.filename}` });
});

// PACIENTES: LOGIN E RECUPERAÇÃO DE SENHA
app.post('/api/paciente/login', (req, res) => {
  const key = identificarTenantKey(req);
  const pacientes = carregarPacientes(key);
  const { cpf, senha } = req.body;

  const paciente = pacientes.find(p => p.cpf === cpf && p.senha === senha);
  if (!paciente) return res.status(401).json({ error: 'CPF ou Senha incorretos.' });
  if (paciente.status === 'bloqueado') return res.status(403).json({ error: 'Conta bloqueada pelo administrador.' });

  res.json({ success: true, paciente });
});

app.post('/api/paciente/recuperar-senha', (req, res) => {
  const key = identificarTenantKey(req);
  const pacientes = carregarPacientes(key);
  const { email } = req.body;

  const paciente = pacientes.find(p => p.email === email);
  if (!paciente) return res.status(404).json({ error: 'E-mail não encontrado no sistema.' });

  res.json({ success: true, message: 'Instruções para redefinição de senha enviadas para o e-mail informado.' });
});

app.post('/api/medico/cadastro', upload.single('fotoPerfil'), (req, res) => {
  const key = identificarTenantKey(req);
  const medicos = carregarMedicos(key);
  const { nome, cpf, email, crm, senha } = req.body;
  const fotoPath = req.file ? `/uploads/${req.file.filename}` : '/images/default-avatar.png';

  if (!nome || !cpf || !crm || !senha) return res.status(400).json({ error: 'Preencha todos os campos.' });
  if (medicos.find(m => m.cpf === cpf)) return res.status(400).json({ error: 'CPF já cadastrado.' });

  const novoMedico = { 
    id: Date.now().toString(), 
    nome, 
    cpf, 
    email, 
    crm, 
    senha, 
    foto: fotoPath,
    status: 'pendente', 
    atendimentosConcluidos: 0,
    historicoAtendimentos: {}
  };
  medicos.push(novoMedico);
  salvarMedicos(key, medicos);

  io.to(key).emit('atualizar-lista-medicos-geral', obterMedicosComStatus(key));
  res.json({ success: true, message: 'Cadastro enviado! Aguarde aprovação do administrador.' });
});

app.post('/api/medico/editar-perfil', upload.single('fotoPerfil'), (req, res) => {
  const key = identificarTenantKey(req);
  const medicos = carregarMedicos(key);
  const { id, nome, crm, senha } = req.body;

  const medico = medicos.find(m => m.id === id);
  if (!medico) return res.status(404).json({ error: 'Médico não encontrado.' });

  if (nome) medico.nome = nome;
  if (crm) medico.crm = crm;
  if (senha) medico.senha = senha;
  if (req.file) medico.foto = `/uploads/${req.file.filename}`;

  salvarMedicos(key, medicos);
  io.to(key).emit('atualizar-lista-medicos-geral', obterMedicosComStatus(key));

  res.json({ 
    success: true, 
    medico: { 
      id: medico.id, 
      nome: medico.nome, 
      crm: medico.crm, 
      cpf: medico.cpf, 
      foto: medico.foto, 
      atendimentosConcluidos: medico.atendimentosConcluidos || 0,
      historicoAtendimentos: medico.historicoAtendimentos || {},
      tenantKey: key 
    } 
  });
});

app.post('/api/medico/login', (req, res) => {
  const key = identificarTenantKey(req);
  const medicos = carregarMedicos(key);
  const { cpf, senha } = req.body;

  const medico = medicos.find(m => m.cpf === cpf && m.senha === senha);
  if (!medico) return res.status(401).json({ error: 'CPF ou Senha incorretos.' });
  if (medico.status === 'pendente') return res.status(403).json({ error: 'Cadastro pendente de aprovação.' });
  if (medico.status === 'bloqueado') return res.status(403).json({ error: 'Conta médica bloqueada.' });

  registrarAcessoAvancado(key, 'medicos');

  res.json({ 
    success: true, 
    medico: { 
      id: medico.id, 
      nome: medico.nome, 
      crm: medico.crm, 
      cpf: medico.cpf, 
      foto: medico.foto || '/images/default-avatar.png',
      atendimentosConcluidos: medico.atendimentosConcluidos || 0,
      historicoAtendimentos: medico.historicoAtendimentos || {},
      tenantKey: key 
    } 
  });
});

app.post('/api/admin/login', (req, res) => {
  const { user, pass } = req.body;
  if (user === 'Admin' && pass === 'Tr0sH!') {
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Credenciais inválidas.' });
  }
});

app.get('/api/admin/dados', (req, res) => {
  const key = identificarTenantKey(req);
  const statsGeral = carregarStats(key);
  const dh = obterDataHoraBR();

  res.json({
    medicos: obterMedicosComStatus(key),
    pacientes: carregarPacientes(key),
    logsConsultas: logsConsultas.filter(l => l.tenantKey === key),
    perfis: statsGeral.perfis || { medicos: 0, pacientes: 0, geral: 0 },
    atendimentosHoje: statsGeral.historicoDiario[dh.data] || 0,
    atendimentosMes: statsGeral.historicoMensal[dh.mesAno] || 0,
    atendimentosAno: statsGeral.historicoAnual[dh.ano] || 0,
    totalGeralAcessos: statsGeral.totalGeralAcessos || 0,
    filaAtualCount: obterFilaPorTenant(key).length
  });
});

app.post('/api/admin/zerar-stats', (req, res) => {
  const key = identificarTenantKey(req);
  const statsZeradas = {
    totalGeralAcessos: 0,
    perfis: { medicos: 0, pacientes: 0, geral: 0 },
    historicoDiario: {},
    historicoSemanal: {},
    historicoMensal: {},
    historicoAnual: {}
  };
  salvarStats(key, statsZeradas);
  res.json({ success: true, message: 'Contadores zerados com sucesso!' });
});

app.post('/api/admin/medico/status', (req, res) => {
  const key = identificarTenantKey(req);
  const medicos = carregarMedicos(key);
  const { medicoId, novoStatus } = req.body;

  const medico = medicos.find(m => m.id === medicoId);
  if (medico) {
    medico.status = novoStatus;
    salvarMedicos(key, medicos);
    io.to(key).emit('atualizar-lista-medicos-geral', obterMedicosComStatus(key));
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Médico não encontrado.' });
  }
});

app.post('/api/admin/medico/excluir', (req, res) => {
  const key = identificarTenantKey(req);
  let medicos = carregarMedicos(key);
  const { medicoId } = req.body;

  medicos = medicos.filter(m => m.id !== medicoId);
  salvarMedicos(key, medicos);
  io.to(key).emit('atualizar-lista-medicos-geral', obterMedicosComStatus(key));
  res.json({ success: true });
});

app.post('/api/admin/paciente/status', (req, res) => {
  const key = identificarTenantKey(req);
  const pacientes = carregarPacientes(key);
  const { pacienteId, novoStatus } = req.body;

  const paciente = pacientes.find(p => p.id === pacienteId);
  if (paciente) {
    paciente.status = novoStatus;
    salvarPacientes(key, pacientes);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Paciente não encontrado.' });
  }
});

app.post('/api/admin/paciente/excluir', (req, res) => {
  const key = identificarTenantKey(req);
  let pacientes = carregarPacientes(key);
  const { pacienteId } = req.body;

  pacientes = pacientes.filter(p => p.id !== pacienteId);
  salvarPacientes(key, pacientes);
  res.json({ success: true, message: 'Paciente removido com sucesso.' });
});

app.get('/api/admin/download-log/:sessionId', (req, res) => {
  const zipPath = path.join(__dirname, 'logs', `consulta-${req.params.sessionId}.zip`);
  if (fs.existsSync(zipPath)) return res.download(zipPath);
  res.status(404).send('Arquivo não encontrado.');
});

function processarFinalizacaoConsulta(dados, tenantKey) {
  try {
    const dh = obterDataHoraBR();
    const stats = carregarStats(tenantKey);
    const { medico, paciente, anamnese, arquivosTrocados, sessionId } = dados;

    stats.historicoDiario[dh.data] = (stats.historicoDiario[dh.data] || 0) + 1;
    stats.historicoMensal[dh.mesAno] = (stats.historicoMensal[dh.mesAno] || 0) + 1;
    stats.historicoAnual[dh.ano] = (stats.historicoAnual[dh.ano] || 0) + 1;
    salvarStats(tenantKey, stats);

    if (medico && medico.cpf) {
      const medicos = carregarMedicos(tenantKey);
      const mObj = medicos.find(m => m.cpf === medico.cpf);
      if (mObj) {
        mObj.atendimentosConcluidos = (mObj.atendimentosConcluidos || 0) + 1;
        if (!mObj.historicoAtendimentos) mObj.historicoAtendimentos = {};
        mObj.historicoAtendimentos[dh.data] = (mObj.historicoAtendimentos[dh.data] || 0) + 1;
        mObj.historicoAtendimentos[dh.mesAno] = (mObj.historicoAtendimentos[dh.mesAno] || 0) + 1;
        mObj.historicoAtendimentos[dh.ano] = (mObj.historicoAtendimentos[dh.ano] || 0) + 1;
        salvarMedicos(tenantKey, medicos);
      }
    }

    const pdfPath = path.join(__dirname, 'uploads', `anamnese-${sessionId}.pdf`);
    const zipPath = path.join(__dirname, 'logs', `consulta-${sessionId}.zip`);

    const doc = new PDFDocument();
    const stream = fs.createWriteStream(pdfPath);
    doc.pipe(stream);

    const tenantInfo = tenants[tenantKey] || tenants['default'];
    doc.fontSize(20).text(`Relatório de Telemedicina - ${tenantInfo.nome}`, { align: 'center' });
    doc.moveDown();
    doc.fontSize(12).text(`Data/Hora: ${dh.dataHoraCompleta}`);
    doc.text(`Médico: ${medico?.nome || 'Dr. Plantonista'} (CRM: ${medico?.crm || 'N/A'})`);
    doc.text(`Paciente: ${paciente?.nome || 'Paciente'} | CPF: ${paciente?.cpf || 'N/I'} | Nascimento: ${paciente?.dataNascimento || 'N/I'}`);
    doc.text(`E-mail: ${paciente?.email || 'N/I'} | Prioridade: ${paciente?.prioridade || 'Atendimento Geral'}`);
    doc.text(`Telefone: ${paciente?.telefone || 'N/I'} | Endereço: ${paciente?.endereco || 'N/I'}`);
    doc.text(`Consentimento LGPD: Aceito em ${paciente?.dataHoraConsentimento || dh.dataHoraCompleta}`);
    doc.moveDown();
    doc.fontSize(14).text('Ficha Clínico-Anamnese:');
    doc.fontSize(11).text(anamnese || 'Consulta encerrada.');
    doc.end();

    stream.on('finish', () => {
      try {
        const output = fs.createWriteStream(zipPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        archive.pipe(output);
        if (fs.existsSync(pdfPath)) archive.file(pdfPath, { name: `Anamnese_${paciente?.nome || 'Paciente'}.pdf` });

        (arquivosTrocados || []).forEach(file => {
          const filePath = path.join(__dirname, 'uploads', file.filename);
          if (fs.existsSync(filePath)) archive.file(filePath, { name: `Anexos/${file.originalname}` });
        });

        archive.finalize();

        output.on('close', () => {
          logsConsultas.push({
            sessionId,
            tenantKey,
            paciente: paciente?.nome || 'Paciente',
            medico: medico?.nome || 'Dr. Plantonista',
            data: dh.dataHoraCompleta,
            zipUrl: `/api/admin/download-log/${sessionId}`
          });
        });
      } catch (e) { console.error('Erro no ZIP:', e); }
    });
  } catch (err) { console.error('Erro geral ao finalizar:', err); }
}

// WEBSOCKETS E SINALIZAÇÃO
io.on('connection', (socket) => {
  const reqHost = socket.handshake.headers.host || '';
  const tenantKey = reqHost.includes('paracuru') ? 'paracuru' : (reqHost.includes('palmacia') ? 'palmacia' : 'default');

  socket.join(tenantKey);

  registrarAcessoAvancado(tenantKey, 'geral');

  socket.emit('atualizar-fila', obterFilaPorTenant(tenantKey));
  socket.emit('atualizar-lista-medicos-geral', obterMedicosComStatus(tenantKey));

  socket.on('medico-online', (medico) => {
    medicosOnline.set(socket.id, { ...medico, tenantKey });
    io.to(tenantKey).emit('atualizar-lista-medicos-geral', obterMedicosComStatus(tenantKey));
  });

  socket.on('medico-offline', () => {
    medicosOnline.delete(socket.id);
    io.to(tenantKey).emit('atualizar-lista-medicos-geral', obterMedicosComStatus(tenantKey));
  });

  socket.on('entrar-fila', (dados) => {
    registrarAcessoAvancado(tenantKey, 'pacientes');
    
    const dh = obterDataHoraBR();
    const paciente = { 
      id: socket.id, 
      tenantKey,
      ...dados, 
      horaEntrada: dh.hora, 
      status: 'Em Espera',
      ipConsentimento: socket.handshake.address 
    };
    
    filaPacientes.push(paciente);
    
    const cadastrados = carregarPacientes(tenantKey);
    const pExistente = cadastrados.find(p => p.cpf === dados.cpf);
    if (!pExistente) {
      cadastrados.push({ 
        id: Date.now().toString(), 
        ...dados, 
        status: 'ativo',
        dataCadastro: dh.dataHoraCompleta 
      });
      salvarPacientes(tenantKey, cadastrados);
    }

    io.to(tenantKey).emit('atualizar-fila', obterFilaPorTenant(tenantKey));
  });

  socket.on('chamar-paciente', (dadosChamada) => {
    const { pacienteSocketId, medicoInfo, roomId } = dadosChamada;
    const paciente = filaPacientes.find(p => p.id === pacienteSocketId);
    if (!paciente) { socket.emit('paciente-indisponivel'); return; }
    paciente.status = 'Em Atendimento';
    
    filaPacientes = filaPacientes.filter(p => p.id !== pacienteSocketId);
    
    const sessionId = Date.now().toString();
    const dadosConsulta = {
      tenantKey,
      sessionId,
      roomId,
      medicoSocketId: socket.id,
      pacienteSocketId,
      medico: medicoInfo || { nome: 'Médico Plantonista', crm: 'N/A' },
      paciente: paciente || { nome: 'Paciente', cpf: '000.000.000-00' },
      anamnese: '',
      arquivosTrocados: []
    };

    consultasAtivas.set(socket.id, dadosConsulta);
    consultasAtivas.set(pacienteSocketId, dadosConsulta);

    io.to(tenantKey).emit('atualizar-fila', obterFilaPorTenant(tenantKey));
    
    io.to(pacienteSocketId).emit('chamado-para-consulta', { 
      medicoSocketId: socket.id, 
      sender: socket.id,
      sessionId,
      roomId,
      medicoInfo: dadosConsulta.medico,
      pacienteInfo: dadosConsulta.paciente
    });

    socket.emit('dados-paciente-atendimento', dadosConsulta.paciente);
  });

  socket.on('paciente-pronto-para-oferta', (data) => {
    if (data.targetId) io.to(data.targetId).emit('iniciar-criacao-oferta', { pacienteSocketId: socket.id });
  });

  socket.on('webrtc-offer', (data) => {
    if (data.targetId) io.to(data.targetId).emit('webrtc-offer', { offer: data.offer, senderId: socket.id });
  });

  socket.on('webrtc-answer', (data) => {
    if (data.targetId) io.to(data.targetId).emit('webrtc-answer', { answer: data.answer, senderId: socket.id });
  });

  socket.on('webrtc-candidate', (data) => {
    if (data.targetId) io.to(data.targetId).emit('webrtc-candidate', { candidate: data.candidate, senderId: socket.id });
  });

  socket.on('enviar-mensagem-chat', (data) => {
    if (data.targetId) io.to(data.targetId).emit('receber-mensagem-chat', { sender: data.sender, msg: data.msg });
  });

  socket.on('novo-arquivo-enviado', (data) => {
    const consulta = consultasAtivas.get(socket.id);
    if (consulta) consulta.arquivosTrocados.push(data.file);
    if (data.targetId) io.to(data.targetId).emit('receber-arquivo-medico', data.file);
  });

  socket.on('finalizar-consulta', (dados) => {
    const consulta = consultasAtivas.get(socket.id);
    if (!consulta) return;

    if (dados && dados.anamnese) consulta.anamnese = dados.anamnese;

    processarFinalizacaoConsulta(consulta, consulta.tenantKey || tenantKey);

    if (consulta.pacienteSocketId) io.to(consulta.pacienteSocketId).emit('consulta-encerrada');
    if (consulta.medicoSocketId) io.to(consulta.medicoSocketId).emit('consulta-encerrada');

    consultasAtivas.delete(consulta.medicoSocketId);
    consultasAtivas.delete(consulta.pacienteSocketId);
  });

  socket.on('disconnect', () => {
    filaPacientes = filaPacientes.filter(p => p.id !== socket.id);
    medicosOnline.delete(socket.id);

    if (consultasAtivas.has(socket.id)) {
      const consulta = consultasAtivas.get(socket.id);
      processarFinalizacaoConsulta(consulta, consulta.tenantKey || tenantKey);

      const outroSocketId = socket.id === consulta.medicoSocketId ? consulta.pacienteSocketId : consulta.medicoSocketId;
      if (outroSocketId) io.to(outroSocketId).emit('consulta-encerrada');

      consultasAtivas.delete(consulta.medicoSocketId);
      consultasAtivas.delete(consulta.pacienteSocketId);
    }

    io.to(tenantKey).emit('atualizar-fila', obterFilaPorTenant(tenantKey));
    io.to(tenantKey).emit('atualizar-lista-medicos-geral', obterMedicosComStatus(tenantKey));
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Servidor MedGo Multi-Tenant Ativo na porta ${PORT}`));