const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();

app.use(express.json());

// Archivo para almacenar tickets
const DATA_FILE = path.join(__dirname, 'tickets.json');

// Inicializar archivo si no existe
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ tickets: [], lastUpdate: new Date().toISOString() }));
}

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ═══════════════════════════════════════════════════════════════
// ENDPOINT: Recibir webhook de Support Candy
// ═══════════════════════════════════════════════════════════════
app.post('/webhook', (req, res) => {
  try {
    const ticket = req.body;
    
    // Validar campos mínimos
    if (!ticket.id || !ticket.agente) {
      return res.status(400).json({ error: 'Falta ID o agente' });
    }
    
    // Leer datos actuales
    let data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    
    // Buscar si el ticket ya existe
    const index = data.tickets.findIndex(t => t.id === ticket.id);
    
    // Normalizar y guardar
    const ticketNormalizado = {
      id: String(ticket.id).trim(),
      asunto: ticket.asunto || ticket.subject || ticket.title || '(Sin asunto)',
      agente: String(ticket.agente || ticket.agent || ticket.assignee).trim(),
      clienteNombre: ticket.clienteNombre || ticket.client || ticket.company || '—',
      estado: ticket.estado || ticket.status || 'open',
      fechaCreacion: ticket.fechaCreacion || ticket.createdAt || new Date().toISOString(),
      fechaCierre: ticket.fechaCierre || ticket.closedAt || null,
      diasResolucion: ticket.diasResolucion || ticket.resolutionDays || null,
      horasResolucion: ticket.horasResolucion || ticket.resolutionHours || null,
      updateTime: new Date().toISOString()
    };
    
    // Calcular días/horas si faltan
    if (ticketNormalizado.fechaCierre && !ticketNormalizado.diasResolucion) {
      const created = new Date(ticketNormalizado.fechaCreacion);
      const closed = new Date(ticketNormalizado.fechaCierre);
      const msTime = closed - created;
      ticketNormalizado.horasResolucion = msTime / (1000 * 60 * 60);
      ticketNormalizado.diasResolucion = msTime / (1000 * 60 * 60 * 24);
    }
    
    if (index >= 0) {
      // Actualizar existente
      data.tickets[index] = { ...data.tickets[index], ...ticketNormalizado };
    } else {
      // Agregar nuevo
      data.tickets.push(ticketNormalizado);
    }
    
    data.lastUpdate = new Date().toISOString();
    
    // Guardar
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    
    console.log(`[${new Date().toISOString()}] Webhook recibido: Ticket ${ticketNormalizado.id} (${ticketNormalizado.agente})`);
    
    res.json({ success: true, ticket: ticketNormalizado.id });
  } catch (error) {
    console.error('Error en webhook:', error);
    res.status(500).json({ error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// ENDPOINT: Obtener tickets (con filtros opcionales)
// ═══════════════════════════════════════════════════════════════
app.get('/api/tickets', (req, res) => {
  try {
    let data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    let tickets = data.tickets || [];
    
    // Filtros
    const agente = req.query.agente;
    const from = req.query.from ? new Date(req.query.from) : null;
    const to = req.query.to ? new Date(req.query.to) : null;
    const estado = req.query.estado; // 'closed', 'open', etc.
    
    // Aplicar filtros
    tickets = tickets.filter(t => {
      // Filtro agente
      if (agente && !t.agente.toLowerCase().includes(agente.toLowerCase())) {
        return false;
      }
      
      // Filtro fechas (por fecha de cierre)
      if (t.fechaCierre) {
        const closed = new Date(t.fechaCierre);
        if (from && closed < from) return false;
        if (to) {
          const toEnd = new Date(to);
          toEnd.setHours(23, 59, 59, 999);
          if (closed > toEnd) return false;
        }
      }
      
      // Filtro estado
      if (estado && t.estado !== estado) {
        return false;
      }
      
      return true;
    });
    
    res.json({
      tickets: tickets,
      count: tickets.length,
      lastUpdate: data.lastUpdate
    });
  } catch (error) {
    console.error('Error en GET /api/tickets:', error);
    res.status(500).json({ error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// ENDPOINT: Health check
// ═══════════════════════════════════════════════════════════════
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ═══════════════════════════════════════════════════════════════
// ENDPOINT: Admin - Ver datos crudos (opcional)
// ═══════════════════════════════════════════════════════════════
app.get('/admin/data', (req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// ENDPOINT: Admin - Limpiar datos (opcional)
// ═══════════════════════════════════════════════════════════════
app.post('/admin/clear', (req, res) => {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ tickets: [], lastUpdate: new Date().toISOString() }));
    res.json({ success: true, message: 'Datos borrados' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Servidor escuchando en puerto ${PORT}`);
  console.log(`   POST /webhook - Recibir eventos de Support Candy`);
  console.log(`   GET  /api/tickets - Obtener tickets (con filtros)`);
  console.log(`   GET  /health - Verificar estado\n`);
});
