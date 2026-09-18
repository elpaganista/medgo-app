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

// Persistência de Médicos em JSON
const FILE_MEDICOS = path.join(__dirname, 'data', 'medicos.json');

function carregarMedicos() {
  if (!fs.existsSync(FILE_MEDICOS)) {
    fs.writeFileSync(FILE_MEDICOS, JSON.stringify([], null, 2));
    return [];
  }
  try {
    const data = fs.readFileSync(FILE_MEDICOS, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    return [];
  }
}

function salvarMedicos(lista) {
  fs.writeFileSync(FILE_MEDICOS, JSON.stringify(lista, null, 2));
}

let medicos = carregarMedicos();
let filaPacientes = [];
let registroPacientesGeral = [];
let consultasAtivas = new Map(); // socket.id -> dados da consulta em andamento
let logsConsultas = [];
let contadorAtendimentosHoje = 0;
let dataAtualContador = new Date().toLocaleDateString('pt-BR');

function checarResetDiario() {
  const hoje = new Date().toLocaleDateString('pt-BR');
  if (hoje !== dataAtualContador) {
    contadorAtendimentosHoje = 0;
    dataAtualContador = hoje;
  }
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
  
  if (!medico) {
    return res.status(401).json({ error: 'CPF ou Senha incorretos.' });
  }
  if (medico.status === 'pendente') {
    return res.status(403).json({ error: 'Seu cadastro ainda está pendente de aprovação pelo Administrador.' });
  }
  if (medico.status === 'bloqueado') {
    return res.status(403).json({ error: 'Sua conta médica está temporariamente bloqueada pelo Administrador.' });
  }

  res.json({ success: true, medico: { nome: medico.nome, crm: medico.crm, cpf: medico.cpf } });
});

// Recuperação de Senha
app.post('/api/medico/recuperar-senha', (req, res) => {
  const { email, novaSenha } = req.body;
  const medico = medicos.find(m => m.email.toLowerCase() === email.toLowerCase());

  if (!medico) {
    return res.status(404).json({ error: 'Nenhuma conta encontrada com este e-mail.' });
  }

  if (novaSenha) {
    medico.senha = novaSenha;
    salvarMedicos(medicos);
    return res.json({ success: true, message: 'Senha redefinida com sucesso! Você já pode fazer login.' });
  }

  res.json({ success: true, message: 'Conta localizada! Digite sua nova senha.' });
});

// Endpoints Admin
app.get('/api/admin/dados', (req, res) => {
  checarResetDiario();
  res.json({
    medicos,
    logsConsultas,
    registroPacientesGeral,
    atendimentosHoje: contadorAtendimentosHoje,
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

app.get('/api/admin/download-log/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const zipPath = path.join(__dirname, 'logs', `consulta-${sessionId}.zip`);
  if (fs.existsSync(zipPath)) {
    return res.download(zipPath);
  }
  res.status(404).send('Arquivo ZIP não encontrado.');
});

// Função Auxiliar para Encerrar Consulta e Gerar ZIP
function processarFinalizacaoConsulta(dados) {
  checarResetDiario();
  contadorAtendimentosHoje++;

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

      io.emit('atualizar-admin-dashboard', {
        logsConsultas,
        atendimentosHoje: contadorAtendimentosHoje,
        registroPacientesGeral,
        filaAtualCount: filaPacientes.length
      });
    });
  });
}

// WebSockets (Tempo Real)
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
    if (paciente) {
      paciente.status = 'Em Atendimento';
    }
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

  socket.on('signal', (data) => {
    io.to(data.to).emit('signal', { from: socket.id, signal: data.signal });
  });

  socket.on('novo-arquivo-enviado', (data) => {
    const consulta = consultasAtivas.get(socket.id);
    if (consulta) {
      consulta.arquivosTrocados.push(data.file);
    }
    if (data.targetId) {
      io.to(data.targetId).emit('receber-arquivo-medico', data.file);
    }
  });

  socket.on('atualizar-anamnese-temp', (texto) => {
    const consulta = consultasAtivas.get(socket.id);
    if (consulta) {
      consulta.anamnese = texto;
    }
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

    // Se quem desconectou estava em consulta ativa
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