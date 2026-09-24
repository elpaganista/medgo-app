const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const PDFDocument = require('pdfkit');
const archiver = require('archiver');
const { ExpressPeerServer } = require('peer');

process.env.TZ = 'America/Fortaleza';

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const peerServer = ExpressPeerServer(server, { path: '/' });
app.use('/peerjs', peerServer);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
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
  try { fs.writeFileSync(FILE_MEDICOS, JSON.stringify(lista, null, 2)); } catch (err) { console.error(err); }
}

function carregarStats() {
  const padrao = { totalGeralAcessos: 0, historicoDiario: {}, historicoMensal: {} };
  if (!fs.existsSync(FILE_STATS)) {
    fs.writeFileSync(FILE_STATS, JSON.stringify(padrao, null, 2));
    return padrao;
  }
  try { return { ...padrao, ...JSON.parse(fs.readFileSync(FILE_STATS, 'utf8')) }; } catch (err) { return padrao; }
}

function salvarStats(stats) {
  try { fs.writeFileSync(FILE_STATS, JSON.stringify(stats, null, 2)); } catch (err) { console.error(err); }
}

let medicos = carregarMedicos();
let statsGeral = carregarStats();
let filaPacientes = [];
let registroPacientesGeral = [];
let consultasAtivas = new Map();
let medicosOnline = new Map();
let logsConsultas = [];

function obterDataHoraBR() {
  const agora = new Date();
  return {
    data: agora.toLocaleDateString('pt-BR', { timeZone: 'America/Fortaleza' }),
    hora: agora.toLocaleTimeString('pt-BR', { timeZone: 'America/Fortaleza' }),
    dataHoraCompleta: agora.toLocaleString('pt-BR', { timeZone: 'America/Fortaleza' }),
    mesAno: `${String(agora.getMonth() + 1).padStart(2, '0')}/${agora.getFullYear()}`
  };
}

function obterMedicosComStatus() {
  const cpfsOnline = new Set(Array.from(medicosOnline.values()).map(m => m.cpf));
  return medicos.map(m => ({
    id: m.id,
    nome: m.nome,
    crm: m.crm,
    cpf: m.cpf,
    email: m.email,
    statusCadastro: m.status,
    isOnline: cpfsOnline.has(m.cpf)
  }));
}

// Upload
app.post('/api/upload', upload.single('arquivo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
  res.json({ filename: req.file.filename, originalname: req.file.originalname, path: `/uploads/${req.file.filename}` });
});

// Cadastro
app.post('/api/medico/cadastro', (req, res) => {
  const { nome, cpf, email, crm, senha } = req.body;
  if (!nome || !cpf || !crm || !senha) return res.status(400).json({ error: 'Preencha todos os campos.' });
  if (medicos.find(m => m.cpf === cpf)) return res.status(400).json({ error: 'CPF já cadastrado.' });

  const novoMedico = { id: Date.now().toString(), nome, cpf, email, crm, senha, status: 'pendente' };
  medicos.push(novoMedico);
  salvarMedicos(medicos);

  io.emit('atualizar-lista-medicos-geral', obterMedicosComStatus());
  res.json({ success: true, message: 'Cadastro enviado! Aguarde aprovação.' });
});

// Login
app.post('/api/medico/login', (req, res) => {
  const { cpf, senha } = req.body;
  const medico = medicos.find(m => m.cpf === cpf && m.senha === senha);
  if (!medico) return res.status(401).json({ error: 'CPF ou Senha incorretos.' });
  if (medico.status === 'pendente') return res.status(403).json({ error: 'Cadastro pendente de aprovação.' });
  if (medico.status === 'bloqueado') return res.status(403).json({ error: 'Conta médica bloqueada.' });

  res.json({ success: true, medico: { id: medico.id, nome: medico.nome, crm: medico.crm, cpf: medico.cpf } });
});

// Login Admin Seguro no Backend
app.post('/api/admin/login', (req, res) => {
  const { user, pass } = req.body;
  if (user === 'Admin' && pass === 'Tr0sH!') {
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Credenciais inválidas.' });
  }
});

// Admin Dados
app.get('/api/admin/dados', (req, res) => {
  const dh = obterDataHoraBR();
  res.json({
    medicos: obterMedicosComStatus(),
    logsConsultas,
    registroPacientesGeral,
    atendimentosHoje: statsGeral.historicoDiario[dh.data] || 0,
    atendimentosMes: statsGeral.historicoMensal[dh.mesAno] || 0,
    totalGeralAcessos: statsGeral.totalGeralAcessos || 0,
    filaAtualCount: filaPacientes.length
  });
});

app.post('/api/admin/medico/status', (req, res) => {
  const { medicoId, novoStatus } = req.body;
  const medico = medicos.find(m => m.id === medicoId);
  if (medico) {
    medico.status = novoStatus;
    salvarMedicos(medicos);
    io.emit('atualizar-lista-medicos-geral', obterMedicosComStatus());
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Médico não encontrado.' });
  }
});

app.post('/api/admin/medico/excluir', (req, res) => {
  const { medicoId } = req.body;
  medicos = medicos.filter(m => m.id !== medicoId);
  salvarMedicos(medicos);
  io.emit('atualizar-lista-medicos-geral', obterMedicosComStatus());
  res.json({ success: true });
});

app.get('/api/admin/download-log/:sessionId', (req, res) => {
  const zipPath = path.join(__dirname, 'logs', `consulta-${req.params.sessionId}.zip`);
  if (fs.existsSync(zipPath)) return res.download(zipPath);
  res.status(404).send('Arquivo não encontrado.');
});

function processarFinalizacaoConsulta(dados) {
  try {
    const dh = obterDataHoraBR();
    const { medico, paciente, anamnese, arquivosTrocados, sessionId } = dados;

    statsGeral.historicoDiario[dh.data] = (statsGeral.historicoDiario[dh.data] || 0) + 1;
    statsGeral.historicoMensal[dh.mesAno] = (statsGeral.historicoMensal[dh.mesAno] || 0) + 1;
    salvarStats(statsGeral);

    const pdfPath = path.join(__dirname, 'uploads', `anamnese-${sessionId}.pdf`);
    const zipPath = path.join(__dirname, 'logs', `consulta-${sessionId}.zip`);

    const doc = new PDFDocument();
    const stream = fs.createWriteStream(pdfPath);
    doc.pipe(stream);

    doc.fontSize(20).text('MedGo - Relatório de Telemedicina', { align: 'center' });
    doc.moveDown();
    doc.fontSize(12).text(`Data/Hora: ${dh.dataHoraCompleta}`);
    doc.text(`Médico: ${medico?.nome || 'Dr. MedGo'} (CRM: ${medico?.crm || 'N/A'})`);
    doc.text(`Paciente: ${paciente?.nome || 'Paciente'} | CPF: ${paciente?.cpf || 'N/A'}`);
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
            paciente: paciente?.nome || 'Paciente',
            medico: medico?.nome || 'Dr. MedGo',
            data: dh.dataHoraCompleta,
            zipUrl: `/api/admin/download-log/${sessionId}`
          });

          io.emit('atualizar-admin-dashboard', {
            logsConsultas,
            atendimentosHoje: statsGeral.historicoDiario[dh.data] || 0,
            atendimentosMes: statsGeral.historicoMensal[dh.mesAno] || 0,
            totalGeralAcessos: statsGeral.totalGeralAcessos || 0,
            registroPacientesGeral,
            filaAtualCount: filaPacientes.length
          });
        });
      } catch (e) { console.error('Erro no ZIP:', e); }
    });
  } catch (err) { console.error('Erro geral ao finalizar:', err); }
}

// WebSockets
io.on('connection', (socket) => {
  statsGeral.totalGeralAcessos += 1;
  salvarStats(statsGeral);

  socket.emit('atualizar-fila', filaPacientes);
  socket.emit('atualizar-lista-medicos-geral', obterMedicosComStatus());

  socket.on('medico-online', (medico) => {
    medicosOnline.set(socket.id, medico);
    io.emit('atualizar-lista-medicos-geral', obterMedicosComStatus());
  });

  socket.on('medico-offline', () => {
    medicosOnline.delete(socket.id);
    io.emit('atualizar-lista-medicos-geral', obterMedicosComStatus());
  });

  socket.on('entrar-fila', (dados) => {
    const dh = obterDataHoraBR();
    const paciente = { id: socket.id, ...dados, horaEntrada: dh.hora, status: 'Em Espera' };
    filaPacientes.push(paciente);
    registroPacientesGeral.push(paciente);
    
    io.emit('atualizar-fila', filaPacientes);
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
      medico: medicoInfo || { nome: 'Médico MedGo', crm: 'N/A' },
      paciente: paciente || { nome: 'Paciente', cpf: '000.000.000-00' },
      anamnese: '',
      arquivosTrocados: []
    };

    consultasAtivas.set(socket.id, dadosConsulta);
    consultasAtivas.set(pacienteSocketId, dadosConsulta);

    io.emit('atualizar-fila', filaPacientes);
    io.to(pacienteSocketId).emit('chamado-para-consulta', { 
      medicoSocketId: socket.id, 
      sender: socket.id,
      sessionId,
      medicoInfo: dadosConsulta.medico
    });
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

    processarFinalizacaoConsulta(consulta);

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
      processarFinalizacaoConsulta(consulta);

      const outroSocketId = socket.id === consulta.medicoSocketId ? consulta.pacienteSocketId : consulta.medicoSocketId;
      if (outroSocketId) io.to(outroSocketId).emit('consulta-encerrada');

      consultasAtivas.delete(consulta.medicoSocketId);
      consultasAtivas.delete(consulta.pacienteSocketId);
    }

    io.emit('atualizar-fila', filaPacientes);
    io.emit('atualizar-lista-medicos-geral', obterMedicosComStatus());
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 MedGo ativo na porta ${PORT}`));