const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const PDFDocument = require('pdfkit');
const archiver = require('archiver');
const Database = require('better-sqlite3');

process.env.TZ = 'America/Fortaleza';

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// DIRETÓRIOS E BANCO DE DADOS SQLITE
['uploads', 'logs', 'data'].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const dbPath = path.join(__dirname, 'data', 'database.db');
const db = new Database(dbPath);

// INICIALIZAÇÃO DAS TABELAS NO SQLITE
db.exec(`
  CREATE TABLE IF NOT EXISTS medicos (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    nome TEXT NOT NULL,
    cpf TEXT UNIQUE NOT NULL,
    email TEXT,
    crm TEXT NOT NULL,
    senha TEXT NOT NULL,
    status TEXT DEFAULT 'pendente',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS estatisticas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    perfil TEXT NOT NULL,
    data_hoje TEXT NOT NULL,
    semana_ano TEXT NOT NULL,
    mes_ano TEXT NOT NULL,
    ano TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS prontuarios_lgpd (
    session_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    medico_nome TEXT,
    medico_crm TEXT,
    paciente_nome TEXT,
    paciente_cpf TEXT,
    consentimento_lgpd INTEGER,
    data_hora TEXT,
    zip_path TEXT
  );
`);

// TENANTS MULTI-DOMÍNIO
const FILE_TENANTS = path.join(__dirname, 'data', 'tenants.json');

function carregarTenants() {
  if (!fs.existsSync(FILE_TENANTS)) {
    const padrao = {
      "default": { id: "medgo", nome: "MedGo Telemedicina", subtitulo: "Plataforma de Saúde Digital", badge: "TELEMEDICINA", logo: "/images/medgo-logo.png" },
      "paracuru": { id: "paracuru", nome: "Prefeitura de Paracuru", subtitulo: "Secretaria Municipal de Saúde", badge: "PARACURU", logo: "/images/paracuru-logo.png" },
      "palmacia": { id: "palmacia", nome: "Prefeitura de Palmácia", subtitulo: "Secretaria Municipal de Saúde", badge: "PALMÁCIA", logo: "/images/palmacia-logo.png" }
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

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({ storage });

// FUNÇÕES AUXILIARES DO SQLITE
function obterMedicosComStatusSQL(tenantId) {
  const stmt = db.prepare('SELECT id, nome, crm, cpf, email, status AS statusCadastro FROM medicos WHERE tenant_id = ?');
  const medicos = stmt.all(tenantId);
  const cpfsOnline = new Set(Array.from(medicosOnline.values()).map(m => m.cpf));

  return medicos.map(m => ({
    ...m,
    isOnline: cpfsOnline.has(m.cpf)
  }));
}

function registrarAcessoSQL(tenantKey, perfil = 'geral') {
  const agora = new Date();
  const dataHoje = agora.toLocaleDateString('pt-BR', { timeZone: 'America/Fortaleza' });
  const mesAno = `${String(agora.getMonth() + 1).padStart(2, '0')}/${agora.getFullYear()}`;
  const anoAtual = `${agora.getFullYear()}`;
  
  const inicioAno = new Date(agora.getFullYear(), 0, 1);
  const dias = Math.floor((agora - inicioAno) / (24 * 60 * 60 * 1000));
  const semanaAtual = `Semana ${Math.ceil((dias + inicioAno.getDay() + 1) / 7)} - ${anoAtual}`;

  const stmt = db.prepare(`
    INSERT INTO estatisticas (tenant_id, perfil, data_hoje, semana_ano, mes_ano, ano)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(tenantKey, perfil, dataHoje, semanaAtual, mesAno, anoAtual);
}

function obterEstatisticasSQL(tenantKey) {
  const dh = obterDataHoraBR();

  const totalGeral = db.prepare('SELECT COUNT(*) AS total FROM estatisticas WHERE tenant_id = ?').get(tenantKey).total;
  const hoje = db.prepare('SELECT COUNT(*) AS total FROM estatisticas WHERE tenant_id = ? AND data_hoje = ?').get(tenantKey, dh.data).total;
  const mes = db.prepare('SELECT COUNT(*) AS total FROM estatisticas WHERE tenant_id = ? AND mes_ano = ?').get(tenantKey, dh.mesAno).total;
  const ano = db.prepare('SELECT COUNT(*) AS total FROM estatisticas WHERE tenant_id = ? AND ano = ?').get(tenantKey, dh.ano).total;

  const medicosCount = db.prepare('SELECT COUNT(*) AS total FROM estatisticas WHERE tenant_id = ? AND perfil = ?').get(tenantKey, 'medicos').total;
  const pacientesCount = db.prepare('SELECT COUNT(*) AS total FROM estatisticas WHERE tenant_id = ? AND perfil = ?').get(tenantKey, 'pacientes').total;

  return {
    totalGeralAcessos: totalGeral,
    atendimentosHoje: hoje,
    atendimentosMes: mes,
    atendimentosAno: ano,
    perfis: { medicos: medicosCount, pacientes: pacientesCount, geral: totalGeral }
  };
}

let filaPacientes = [];
let registroPacientesGeral = [];
let consultasAtivas = new Map();
let medicosOnline = new Map();

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

// ENDPOINTS DA API REESTRUTURADOS COM SQLITE
app.get('/api/tenant/info', (req, res) => {
  tenants = carregarTenants();
  const key = identificarTenantKey(req);
  res.json(tenants[key] || tenants['default']);
});

app.post('/api/upload', upload.single('arquivo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
  res.json({ filename: req.file.filename, originalname: req.file.originalname, path: `/uploads/${req.file.filename}` });
});

app.post('/api/medico/cadastro', (req, res) => {
  const key = identificarTenantKey(req);
  const { nome, cpf, email, crm, senha } = req.body;

  if (!nome || !cpf || !crm || !senha) return res.status(400).json({ error: 'Preencha todos os campos.' });

  try {
    const stmt = db.prepare('INSERT INTO medicos (id, tenant_id, nome, cpf, email, crm, senha, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    stmt.run(Date.now().toString(), key, nome, cpf, email, crm, senha, 'pendente');

    io.emit('atualizar-lista-medicos-geral', obterMedicosComStatusSQL(key));
    res.json({ success: true, message: 'Cadastro enviado! Aguarde aprovação.' });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'CPF já cadastrado.' });
    res.status(500).json({ error: 'Erro ao realizar cadastro.' });
  }
});

app.post('/api/medico/login', (req, res) => {
  const key = identificarTenantKey(req);
  const { cpf, senha } = req.body;

  const stmt = db.prepare('SELECT * FROM medicos WHERE tenant_id = ? AND cpf = ? AND senha = ?');
  const medico = stmt.get(key, cpf, senha);

  if (!medico) return res.status(401).json({ error: 'CPF ou Senha incorretos.' });
  if (medico.status === 'pendente') return res.status(403).json({ error: 'Cadastro pendente de aprovação.' });
  if (medico.status === 'bloqueado') return res.status(403).json({ error: 'Conta médica bloqueada.' });

  registrarAcessoSQL(key, 'medicos');

  res.json({ success: true, medico: { id: medico.id, nome: medico.nome, crm: medico.crm, cpf: medico.cpf } });
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
  const stats = obterEstatisticasSQL(key);
  
  const logs = db.prepare('SELECT session_id AS sessionId, paciente_nome AS paciente, medico_nome AS medico, data_hora AS data, zip_path AS zipUrl FROM prontuarios_lgpd WHERE tenant_id = ? ORDER BY data_hora DESC').all(key);

  res.json({
    medicos: obterMedicosComStatusSQL(key),
    logsConsultas: logs,
    registroPacientesGeral,
    ...stats,
    filaAtualCount: filaPacientes.length
  });
});

// ZERAR ESTATÍSTICAS DO CLIENTE NO SQLITE
app.post('/api/admin/zerar-stats', (req, res) => {
  const key = identificarTenantKey(req);
  const stmt = db.prepare('DELETE FROM estatisticas WHERE tenant_id = ?');
  stmt.run(key);
  res.json({ success: true, message: 'Estatísticas zeradas no banco SQLite para o cliente!' });
});

app.post('/api/admin/medico/status', (req, res) => {
  const key = identificarTenantKey(req);
  const { medicoId, novoStatus } = req.body;

  const stmt = db.prepare('UPDATE medicos SET status = ? WHERE id = ? AND tenant_id = ?');
  stmt.run(novoStatus, medicoId, key);

  io.emit('atualizar-lista-medicos-geral', obterMedicosComStatusSQL(key));
  res.json({ success: true });
});

app.post('/api/admin/medico/excluir', (req, res) => {
  const key = identificarTenantKey(req);
  const { medicoId } = req.body;

  const stmt = db.prepare('DELETE FROM medicos WHERE id = ? AND tenant_id = ?');
  stmt.run(medicoId, key);

  io.emit('atualizar-lista-medicos-geral', obterMedicosComStatusSQL(key));
  res.json({ success: true });
});

app.get('/api/admin/download-log/:sessionId', (req, res) => {
  const zipPath = path.join(__dirname, 'logs', `consulta-${req.params.sessionId}.zip`);
  if (fs.existsSync(zipPath)) return res.download(zipPath);
  res.status(404).send('Arquivo não encontrado.');
});

function processarFinalizacaoConsulta(dados, tenantKey) {
  try {
    const dh = obterDataHoraBR();
    registrarAcessoSQL(tenantKey, 'consultas_concluidas');

    const { medico, paciente, anamnese, arquivosTrocados, sessionId } = dados;
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
    doc.text(`Paciente: ${paciente?.nome || 'Paciente'} | CPF: ${paciente?.cpf || 'N/A'}`);
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
          const stmtProntuario = db.prepare(`
            INSERT INTO prontuarios_lgpd (session_id, tenant_id, medico_nome, medico_crm, paciente_nome, paciente_cpf, consentimento_lgpd, data_hora, zip_path)
            VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
          `);
          stmtProntuario.run(sessionId, tenantKey, medico?.nome, medico?.crm, paciente?.nome, paciente?.cpf, dh.dataHoraCompleta, `/api/admin/download-log/${sessionId}`);

          const stats = obterEstatisticasSQL(tenantKey);
          const logs = db.prepare('SELECT session_id AS sessionId, paciente_nome AS paciente, medico_nome AS medico, data_hora AS data, zip_path AS zipUrl FROM prontuarios_lgpd WHERE tenant_id = ? ORDER BY data_hora DESC').all(tenantKey);

          io.emit('atualizar-admin-dashboard', {
            logsConsultas: logs,
            ...stats,
            registroPacientesGeral,
            filaAtualCount: filaPacientes.length
          });
        });
      } catch (e) { console.error('Erro no ZIP:', e); }
    });
  } catch (err) { console.error('Erro geral ao finalizar:', err); }
}

// WEBSOCKETS
io.on('connection', (socket) => {
  const reqHost = socket.handshake.headers.host || '';
  const tenantKey = reqHost.includes('paracuru') ? 'paracuru' : (reqHost.includes('palmacia') ? 'palmacia' : 'default');

  registrarAcessoSQL(tenantKey, 'geral');

  socket.emit('atualizar-fila', filaPacientes);
  socket.emit('atualizar-lista-medicos-geral', obterMedicosComStatusSQL(tenantKey));

  socket.on('medico-online', (medico) => {
    medicosOnline.set(socket.id, medico);
    io.emit('atualizar-lista-medicos-geral', obterMedicosComStatusSQL(tenantKey));
  });

  socket.on('medico-offline', () => {
    medicosOnline.delete(socket.id);
    io.emit('atualizar-lista-medicos-geral', obterMedicosComStatusSQL(tenantKey));
  });

  socket.on('entrar-fila', (dados) => {
    registrarAcessoSQL(tenantKey, 'pacientes');
    
    const dh = obterDataHoraBR();
    const paciente = { 
      id: socket.id, 
      ...dados, 
      horaEntrada: dh.hora, 
      status: 'Em Espera',
      ipConsentimento: socket.handshake.address 
    };
    filaPacientes.push(paciente);
    registroPacientesGeral.push(paciente);
    
    io.emit('atualizar-fila', filaPacientes);
  });

  socket.on('chamar-paciente', (dadosChamada) => {
    const { pacienteSocketId, medicoInfo, roomId } = dadosChamada;
    const paciente = filaPacientes.find(p => p.id === pacienteSocketId);
    if (paciente) paciente.status = 'Em Atendimento';
    
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

    io.emit('atualizar-fila', filaPacientes);
    io.to(pacienteSocketId).emit('chamado-para-consulta', { 
      medicoSocketId: socket.id, 
      sender: socket.id,
      sessionId,
      roomId,
      medicoInfo: dadosConsulta.medico
    });
  });

  // SINALIZAÇÃO WEBRTC
  socket.on('paciente-pronto-para-oferta', (data) => {
    const { targetId } = data;
    if (targetId) {
      io.to(targetId).emit('iniciar-criacao-oferta', { pacienteSocketId: socket.id });
    }
  });

  socket.on('webrtc-offer', (data) => {
    io.to(data.targetId).emit('webrtc-offer', { offer: data.offer, senderId: socket.id });
  });

  socket.on('webrtc-answer', (data) => {
    io.to(data.targetId).emit('webrtc-answer', { answer: data.answer, senderId: socket.id });
  });

  socket.on('webrtc-candidate', (data) => {
    io.to(data.targetId).emit('webrtc-candidate', { candidate: data.candidate, senderId: socket.id });
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

    io.emit('atualizar-fila', filaPacientes);
    io.emit('atualizar-lista-medicos-geral', statusMedicos => statusMedicos);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Servidor MedGo com Banco SQLite ativo na porta ${PORT}`));