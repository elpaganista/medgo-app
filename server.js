const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const PDFDocument = require('pdfkit');
const archiver = require('archiver');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

['uploads', 'logs', 'data'].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({ storage });

// Persistência em Banco JSON
const FILE_MEDICOS = path.join(__dirname, 'data', 'medicos.json');
const FILE_STATS = path.join(__dirname, 'data', 'estatisticas.json');

function carregarMedicos() {
  if (!fs.existsSync(FILE_MEDICOS)) {
    fs.writeFileSync(FILE_MEDICOS, JSON.stringify([], null, 2));
    return [];
  }
  try { return JSON.parse(fs.readFileSync(FILE_MEDICOS, 'utf8')); } catch (err) { return []; }
}

function salvarMedicos(lista) {
  fs.writeFileSync(FILE_MEDICOS, JSON.stringify(lista, null, 2));
}

function carregarStats() {
  const padrao = {
    totalGeralAcessos: 0,
    historicoDiario: {},  // ex: { "19/09/2026": 5 }
    historicoMensal: {}   // ex: { "09/2026": 45 }
  };
  if (!fs.existsSync(FILE_STATS)) {
    fs.writeFileSync(FILE_STATS, JSON.stringify(padrao, null, 2));
    return padrao;
  }
  try {
    return { ...padrao, ...JSON.parse(fs.readFileSync(FILE_STATS, 'utf8')) };
  } catch (err) {
    return padrao;
  }
}

function salvarStats(stats) {
  fs.writeFileSync(FILE_STATS, JSON.stringify(stats, null, 2));
}

let medicos = carregarMedicos();
let statsGeral = carregarStats();
let filaPacientes = [];
let registroPacientesGeral = [];
let consultasAtivas = new Map();
let logsConsultas = [];

function registrarAcessoEAtendimento() {
  const agora = new Date();
  const dataHoje = agora.toLocaleDateString('pt-BR');
  const mesAno = `${String(agora.getMonth() + 1).padStart(2, '0')}/${agora.getFullYear()}`;

  statsGeral.totalGeralAcessos = (statsGeral.totalGeralAcessos || 0) + 1;
  statsGeral.historicoDiario[dataHoje] = (statsGeral.historicoDiario[dataHoje] || 0) + 1;
  statsGeral.historicoMensal[mesAno] = (statsGeral.historicoMensal[mesAno] || 0) + 1;

  salvarStats(statsGeral);
}

// Upload de Arquivos
app.post('/api/upload', upload.single('arquivo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
  res.json({ 
    filename: req.file.filename, 
    originalname: req.file.originalname,
    path: `/uploads/${req.file.filename}` 
  });
});

// Cadastro de Médico
app.post('/api/medico/cadastro', (req, res) => {
  const { nome, cpf, email, crm, senha } = req.body;
  if (medicos.find(m => m.cpf === cpf)) {
    return res.status(400).json({ error: 'Este CPF já está cadastrado no sistema.' });
  }
  if (medicos.find(m => m.email.toLowerCase() === email.toLowerCase())) {
    return res.status(400).json({ error: 'Este E-mail já está cadastrado por outro médico.' });
  }

  const novoMedico = { id: Date.now().toString(), nome, cpf, email, crm, senha, status: 'pendente' };
  medicos.push(novoMedico);
  salvarMedicos(medicos);

  io.emit('atualizar-admin-medicos', medicos);
  res.json({ success: true, message: 'Cadastro enviado para aprovação do Administrador.' });
});

// Login do Médico
app.post('/api/medico/login', (req, res) => {
  const { cpf, senha } = req.body;
  const medico = medicos.find(m => m.cpf === cpf && m.senha === senha);
  
  if (!medico) return res.status(401).json({ error: 'CPF ou Senha incorretos.' });
  if (medico.status === 'pendente') return res.status(403).json({ error: 'Cadastro pendente de aprovação.' });
  if (medico.status === 'bloqueado') return res.status(403).json({ error: 'Conta médica bloqueada.' });

  res.json({ success: true, medico: { nome: medico.nome, crm: medico.crm, cpf: medico.cpf } });
});

// Recuperação de Senha
app.post('/api/medico/recuperar-senha', (req, res) => {
  const { email, novaSenha } = req.body;
  const medico = medicos.find(m => m.email.toLowerCase() === email.toLowerCase());

  if (!medico) return res.status(404).json({ error: 'Conta não encontrada.' });

  if (novaSenha) {
    medico.senha = novaSenha;
    salvarMedicos(medicos);
    return res.json({ success: true, message: 'Senha redefinida com sucesso!' });
  }

  res.json({ success: true, message: 'Conta localizada! Digite sua nova senha.' });
});

// Endpoints Admin & Estatísticas
app.get('/api/admin/dados', (req, res) => {
  const agora = new Date();
  const dataHoje = agora.toLocaleDateString('pt-BR');
  const mesAno = `${String(agora.getMonth() + 1).padStart(2, '0')}/${agora.getFullYear()}`;

  res.json({
    medicos,
    logsConsultas,
    registroPacientesGeral,
    atendimentosHoje: statsGeral.historicoDiario[dataHoje] || 0,
    atendimentosMes: statsGeral.historicoMensal[mesAno] || 0,
    totalGeralAcessos: statsGeral.totalGeralAcessos || 0,
    historicoDiario: statsGeral.historicoDiario,
    historicoMensal: statsGeral.historicoMensal,
    filaAtualCount: filaPacientes.length
  });
});

app.post('/api/admin/medico/status', (req, res) => {
  const { medicoId, novoStatus } = req.body;
  const medico = medicos.find(m => m.id === medicoId);
  if (medico) {
    medico.status = novoStatus;
    salvarMedicos(medicos);
    io.emit('atualizar-admin-medicos', medicos);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Médico não encontrado.' });
  }
});

// Exclusão de Registros do Banco pelo Admin
app.post('/api/admin/limpar-historico', (req, res) => {
  const { tipo } = req.body;
  if (tipo === 'pacientes') {
    registroPacientesGeral = [];
  } else if (tipo === 'stats') {
    statsGeral = { totalGeralAcessos: 0, historicoDiario: {}, historicoMensal: {} };
    salvarStats(statsGeral);
  } else if (tipo === 'logs') {
    logsConsultas = [];
  }
  res.json({ success: true, message: 'Registros atualizados pelo Administrador.' });
});

app.get('/api/admin/download-log/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const zipPath = path.join(__dirname, 'logs', `consulta-${sessionId}.zip`);
  if (fs.existsSync(zipPath)) return res.download(zipPath);
  res.status(404).send('Arquivo ZIP não encontrado.');
});

function processarFinalizacaoConsulta(dados) {
  registrarAcessoEAtendimento();

  const { medico, paciente, anamnese, arquivosTrocados, sessionId } = dados;
  const pdfPath = path.join(__dirname, 'uploads', `anamnese-${sessionId}.pdf`);
  const zipPath = path.join(__dirname, 'logs', `consulta-${sessionId}.zip`);

  const doc = new PDFDocument();
  const stream = fs.createWriteStream(pdfPath);
  doc.pipe(stream);

  doc.fontSize(20).text('MedGo - Relatório de Telemedicina', { align: 'center' });
  doc.moveDown();
  doc.fontSize(12).text(`Data/Hora: ${new Date().toLocaleString('pt-BR')}`);
  doc.text(`Médico: ${medico.nome || 'Dr. MedGo'} (CRM: ${medico.crm || 'N/A'})`);
  doc.text(`Paciente: ${paciente.nome || 'Paciente'} | CPF: ${paciente.cpf || 'N/A'}`);
  doc.moveDown();
  doc.fontSize(14).text('Ficha Clínico-Anamnese:');
  doc.fontSize(11).text(anamnese || 'Consulta encerrada devido a desconexão ou término.');
  doc.end();

  stream.on('finish', () => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    archive.pipe(output);
    archive.file(pdfPath, { name: `Anamnese_${paciente.nome || 'Paciente'}.pdf` });

    (arquivosTrocados || []).forEach(file => {
      const filePath = path.join(__dirname, 'uploads', file.filename);
      if (fs.existsSync(filePath)) {
        archive.file(filePath, { name: `Anexos/${file.originalname}` });
      }
    });

    archive.finalize();

    output.on('close', () => {
      logsConsultas.push({
        sessionId,
        paciente: paciente.nome || 'Paciente',
        medico: medico.nome || 'Dr. MedGo',
        data: new Date().toLocaleString('pt-BR'),
        zipUrl: `/api/admin/download-log/${sessionId}`
      });

      const pGeral = registroPacientesGeral.find(p => p.cpf === paciente.cpf);
      if (pGeral) pGeral.status = 'Atendido';

      const agora = new Date();
      const dataHoje = agora.toLocaleDateString('pt-BR');
      const mesAno = `${String(agora.getMonth() + 1).padStart(2, '0')}/${agora.getFullYear()}`;

      io.emit('atualizar-admin-dashboard', {
        logsConsultas,
        atendimentosHoje: statsGeral.historicoDiario[dataHoje] || 0,
        atendimentosMes: statsGeral.historicoMensal[mesAno] || 0,
        totalGeralAcessos: statsGeral.totalGeralAcessos || 0,
        registroPacientesGeral,
        filaAtualCount: filaPacientes.length
      });
    });
  });
}

// WebSockets
io.on('connection', (socket) => {
  socket.emit('atualizar-fila', filaPacientes);

  socket.on('entrar-fila', (dados) => {
    const paciente = { 
      id: socket.id, 
      ...dados, 
      horaEntrada: new Date().toLocaleTimeString('pt-BR'),
      status: 'Em Espera'
    };
    filaPacientes.push(paciente);
    registroPacientesGeral.push(paciente);
    
    io.emit('atualizar-fila', filaPacientes);
    io.emit('atualizar-admin-pacientes', {
      registroPacientesGeral,
      filaAtualCount: filaPacientes.length
    });
  });

  socket.on('chamar-paciente', (dadosChamada) => {
    const { pacienteSocketId, medicoInfo } = dadosChamada;
    const paciente = filaPacientes.find(p => p.id === pacienteSocketId);
    if (paciente) paciente.status = 'Em Atendimento';
    
    filaPacientes = filaPacientes.filter(p => p.id !== pacienteSocketId);
    
    const sessionId = Date.now().toString();
    const dadosConsulta = {
      sessionId,
      medicoSocketId: socket.id,
      pacienteSocketId,
      medico: medicoInfo,
      paciente: paciente || { nome: 'Paciente', cpf: '000.000.000-00' },
      anamnese: '',
      arquivosTrocados: []
    };

    consultasAtivas.set(socket.id, dadosConsulta);
    consultasAtivas.set(pacienteSocketId, dadosConsulta);

    io.emit('atualizar-fila', filaPacientes);
    io.emit('atualizar-admin-pacientes', {
      registroPacientesGeral,
      filaAtualCount: filaPacientes.length
    });
    
    io.to(pacienteSocketId).emit('chamado-para-consulta', { medicoSocketId: socket.id, sessionId });
  });

  socket.on('novo-arquivo-enviado', (data) => {
    const consulta = consultasAtivas.get(socket.id);
    if (consulta) consulta.arquivosTrocados.push(data.file);
    if (data.targetId) io.to(data.targetId).emit('receber-arquivo-medico', data.file);
  });

  socket.on('atualizar-anamnese-temp', (texto) => {
    const consulta = consultasAtivas.get(socket.id);
    if (consulta) consulta.anamnese = texto;
  });

  socket.on('finalizar-consulta', async (dados) => {
    const consulta = consultasAtivas.get(socket.id);
    const payload = consulta || dados;
    if (dados.anamnese) payload.anamnese = dados.anamnese;

    processarFinalizacaoConsulta(payload);

    if (payload.pacienteSocketId) io.to(payload.pacienteSocketId).emit('consulta-encerrada-pelo-medico');
    if (payload.medicoSocketId) io.to(payload.medicoSocketId).emit('consulta-encerrada-pelo-medico');

    consultasAtivas.delete(payload.medicoSocketId);
    consultasAtivas.delete(payload.pacienteSocketId);
  });

  socket.on('disconnect', () => {
    filaPacientes = filaPacientes.filter(p => p.id !== socket.id);

    if (consultasAtivas.has(socket.id)) {
      const consulta = consultasAtivas.get(socket.id);
      processarFinalizacaoConsulta(consulta);

      const outroSocketId = socket.id === consulta.medicoSocketId ? consulta.pacienteSocketId : consulta.medicoSocketId;
      io.to(outroSocketId).emit('parceiro-desconectou');

      consultasAtivas.delete(consulta.medicoSocketId);
      consultasAtivas.delete(consulta.pacienteSocketId);
    }

    io.emit('atualizar-fila', filaPacientes);
    io.emit('atualizar-admin-pacientes', {
      registroPacientesGeral,
      filaAtualCount: filaPacientes.length
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 MedGo rodando na porta ${PORT}`));